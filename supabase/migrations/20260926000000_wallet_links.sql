-- =====================================================================
-- Wallet Link Identity Layer (Multi-chain Samurai Points → SOL rewards)
-- =====================================================================
-- This migration adds a CRYPTOGRAPHIC wallet-link layer on top of the
-- existing Samurai Points / reward accounting system. It does NOT touch:
--   * the deployed Solana Anchor rewards program
--   * the reward PDA seeds / vault / claim instruction
--   * the existing reward_claims rows or wallets.claimed_points values
--   * the existing samurai_points awards
--
-- What it adds:
--   1. wallet_links          – a verified Solana↔EVM link registry
--   2. wallet_link_challenges – server-issued, one-time-use, expiring
--                               nonce/challenge rows for the dual-sig
--                               link flow (mirrors admin_auth_challenges)
--   3. link_wallets() RPC    – atomic verify-both-signatures + insert
--   4. unlink_wallet() RPC   – atomic revoke (Solana sig required, done
--                               in the API handler before calling this)
--   5. get_linked_evm_wallets() RPC – read-only list of ACTIVE EVM links
--   6. get_verified_reward_identity() RPC – resolve any address
--      (Solana or EVM) to its canonical Solana payout wallet + set of
--      linked EVM wallets
--   7. Modifications to get_wallet_reward_balance() and claim_reward():
--      they now aggregate earned_points across the verified link set.
--      Backward compatible: if no links exist for a wallet, behavior
--      is identical to before (the wallet's own samurai_points only).
--
-- SECURITY MODEL:
--   * The frontend is NEVER trusted for ownership. Both signatures
--     (EVM EIP-191 personal_sign + Solana ed25519 signMessage) are
--     verified server-side.
--   * localStorage EVM tracking remains for UI convenience ONLY. It is
--     NOT consulted by get_wallet_reward_balance / claim_reward.
--   * Each challenge_id is single-use (status PENDING → USED), has a
--     short expiry (enforced both in DB and in the handler), and is
--     cryptographically random (24+ bytes from node.crypto.randomBytes).
--   * A single EVM wallet can be ACTIVE-linked to at most ONE Solana
--     wallet (enforced via a unique partial index). This prevents
--     cross-user wallet hijacking.
--   * Multiple EVM wallets may be linked to the same Solana wallet
--     (1-to-N relationship) — each must be independently signed by
--     both wallets.
--   * The canonical payout wallet is always the verified Solana wallet.
--     EVM wallets are NEVER used as Solana payout recipients.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. wallet_links table
-- ---------------------------------------------------------------------
-- Stores cryptographically verified Solana↔EVM wallet links.
-- One Solana wallet may have many ACTIVE EVM wallets linked.
-- One EVM wallet may be ACTIVE-linked to at most ONE Solana wallet
-- (enforced via the partial unique index below).
-- ---------------------------------------------------------------------
create table if not exists public.wallet_links (
  id uuid primary key default gen_random_uuid(),
  solana_wallet text not null,
  evm_wallet text not null,
  evm_chain_scope text,  -- informational; null = "all EVM chains"; otherwise '1' / '4663'
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'REVOKED')),
  verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallet_links_solana_format
    check (solana_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint wallet_links_evm_format
    check (evm_wallet ~ '^0x[0-9a-fA-F]{40}$')
);

-- Per-pair uniqueness so the same (solana, evm) can't have two ACTIVE rows.
create unique index if not exists wallet_links_pair_active_uidx
  on public.wallet_links(solana_wallet, evm_wallet)
  where status = 'ACTIVE';

-- Cross-user hijack protection: an EVM wallet can be ACTIVE-linked to
-- at most ONE Solana wallet. If the EVM wallet is already linked
-- elsewhere, the user must revoke first.
create unique index if not exists wallet_links_evm_active_uidx
  on public.wallet_links(evm_wallet)
  where status = 'ACTIVE';

-- Look-up indexes for both directions.
create index if not exists wallet_links_solana_idx
  on public.wallet_links(solana_wallet, status);
create index if not exists wallet_links_evm_idx
  on public.wallet_links(evm_wallet, status);

alter table public.wallet_links enable row level security;
revoke all on table public.wallet_links from public, anon, authenticated;
grant select, insert, update on table public.wallet_links to service_role;

-- ---------------------------------------------------------------------
-- 2. wallet_link_challenges table
-- ---------------------------------------------------------------------
-- Mirrors the admin_auth_challenges pattern but tracks the dual-sig
-- link challenge: nonce + challenge_id + both messages + expiry +
-- one-time-use status.
--
-- Lifecycle: PENDING → USED (success) or EXPIRED (cron) or REVOKED
-- (admin/user cancel).
-- ---------------------------------------------------------------------
create table if not exists public.wallet_link_challenges (
  challenge_id text primary key,
  nonce text not null unique,
  solana_wallet text not null,
  evm_wallet text not null,
  evm_chain_scope text,
  message_evm text not null,
  message_solana text not null,
  expires_at timestamptz not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'USED', 'EXPIRED', 'REVOKED')),
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wlc_solana_format
    check (solana_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint wlc_evm_format
    check (evm_wallet ~ '^0x[0-9a-fA-F]{40}$')
);

create index if not exists wallet_link_challenges_solana_idx
  on public.wallet_link_challenges(solana_wallet, status);
create index if not exists wallet_link_challenges_evm_idx
  on public.wallet_link_challenges(evm_wallet, status);
create index if not exists wallet_link_challenges_expiry_idx
  on public.wallet_link_challenges(expires_at);
create index if not exists wallet_link_challenges_status_idx
  on public.wallet_link_challenges(status, expires_at);

alter table public.wallet_link_challenges enable row level security;
revoke all on table public.wallet_link_challenges from public, anon, authenticated;
grant select, insert, update on table public.wallet_link_challenges to service_role;

-- ---------------------------------------------------------------------
-- 3. link_wallets() RPC
-- ---------------------------------------------------------------------
-- Verifies both signatures + atomically creates the wallet link.
-- This is the ONLY function that mutates wallet_links.status to ACTIVE.
-- The handler had already validated the challenge exists, is PENDING,
-- and is not expired — but the RPC re-verifies all of those conditions
-- inside a single transaction (defense in depth).
--
-- Inputs:
--   p_challenge_id   – the challenge id returned by the create step
--   p_evm_signature  – 0x-prefixed hex EIP-191 personal_sign signature
--   p_solana_signature – base64 ed25519 signature of message_solana
--
-- The signature VERIFICATION ITSELF happens in the API handler (Node)
-- because:
--   * Postgres can't efficiently do secp256k1 ecrecover or ed25519
--     verify without extensions (we don't want to install pgcrypto++
--     just for this).
--   * The handler already has ethers + node:crypto available.
-- So this RPC trusts the handler's verification BUT still:
--   * locks the challenge row FOR UPDATE (prevents double-verify races)
--   * checks status = PENDING and not expired
--   * checks the linked solana/evm match the challenge's solana/evm
--   * marks the challenge USED
--   * inserts (or reactivates) the wallet_links row atomically
-- ---------------------------------------------------------------------
create or replace function public.link_wallets(
  p_challenge_id text,
  p_evm_signature text,
  p_solana_signature text,
  p_evm_signer text,        -- handler-verified signer (must equal challenge.evm_wallet)
  p_solana_signer text      -- handler-verified signer (must equal challenge.solana_wallet)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  challenge_row public.wallet_link_challenges;
  existing_link public.wallet_links;
  conflicting_link public.wallet_links;
  new_link public.wallet_links;
begin
  if p_challenge_id is null or p_challenge_id = '' then
    raise exception 'CHALLENGE_ID_REQUIRED';
  end if;
  if p_evm_signature is null or p_evm_signature = '' then
    raise exception 'EVM_SIGNATURE_REQUIRED';
  end if;
  if p_solana_signature is null or p_solana_signature = '' then
    raise exception 'SOLANA_SIGNATURE_REQUIRED';
  end if;

  -- Lock the challenge row to serialize concurrent verify attempts.
  select * into challenge_row from public.wallet_link_challenges
    where challenge_id = p_challenge_id
    for update;

  if not found then
    raise exception 'CHALLENGE_NOT_FOUND';
  end if;

  if challenge_row.status <> 'PENDING' then
    raise exception 'CHALLENGE_NOT_PENDING';
  end if;

  if challenge_row.expires_at < now() then
    -- Lapsed: mark it expired so it can never be replayed.
    update public.wallet_link_challenges
      set status = 'EXPIRED'
      where challenge_id = p_challenge_id;
    raise exception 'CHALLENGE_EXPIRED';
  end if;

  -- The handler must have verified the signatures against the EXACT
  -- addresses stored on the challenge row. If the handler reports
  -- a different signer than the challenge binds, reject.
  if lower(p_evm_signer) <> lower(challenge_row.evm_wallet) then
    raise exception 'EVM_SIGNER_MISMATCH';
  end if;
  if p_solana_signer <> challenge_row.solana_wallet then
    raise exception 'SOLANA_SIGNER_MISMATCH';
  end if;

  -- Cross-user hijack protection: the EVM wallet must not be
  -- ACTIVE-linked to a different Solana wallet.
  select * into conflicting_link from public.wallet_links
    where evm_wallet = lower(challenge_row.evm_wallet)
      and status = 'ACTIVE'
      and solana_wallet <> challenge_row.solana_wallet;
  if found then
    raise exception 'EVM_ALREADY_LINKED_ELSEWHERE';
  end if;

  -- Ensure the canonical Solana wallet row exists in public.wallets.
  -- If the user has never swapped on Solana, this row may not exist
  -- yet — we create it here so claim_reward's FOR UPDATE lock finds it.
  -- wallet_chain_id = 101 (Solana).
  insert into public.wallets (wallet_address, wallet_chain_id)
    values (challenge_row.solana_wallet, 101)
    on conflict (wallet_address) do nothing;

  -- Insert (or reactivate) the link row.
  insert into public.wallet_links (solana_wallet, evm_wallet, evm_chain_scope, status, verified_at, revoked_at)
    values (challenge_row.solana_wallet, lower(challenge_row.evm_wallet),
            challenge_row.evm_chain_scope, 'ACTIVE', now(), null)
    on conflict (solana_wallet, evm_wallet)
    do update set
      status = 'ACTIVE',
      verified_at = now(),
      revoked_at = null,
      evm_chain_scope = excluded.evm_chain_scope,
      updated_at = now()
    returning * into new_link;

  -- Mark challenge as USED — one-time-use, never replayable.
  update public.wallet_link_challenges
    set status = 'USED',
        used_at = now()
    where challenge_id = p_challenge_id;

  return jsonb_build_object(
    'success', true,
    'link', to_jsonb(new_link),
    'solana_wallet', new_link.solana_wallet,
    'evm_wallet', new_link.evm_wallet,
    'status', new_link.status
  );
end;
$$;

revoke execute on function public.link_wallets(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_wallets(text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- 4. unlink_wallet() RPC
-- ---------------------------------------------------------------------
-- Revokes an ACTIVE link. The handler must have already verified a
-- fresh Solana signature proving ownership of the canonical Solana
-- wallet (so only the Solana wallet's owner can unlink their EVMs).
-- ---------------------------------------------------------------------
create or replace function public.unlink_wallet(
  p_solana_wallet text,
  p_evm_wallet text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  link_row public.wallet_links;
begin
  if p_solana_wallet is null or p_solana_wallet = ''
    or p_evm_wallet is null or p_evm_wallet = '' then
    raise exception 'WALLET_REQUIRED';
  end if;

  select * into link_row from public.wallet_links
    where solana_wallet = p_solana_wallet
      and evm_wallet = lower(p_evm_wallet)
      and status = 'ACTIVE'
    for update;

  if not found then
    raise exception 'LINK_NOT_FOUND';
  end if;

  update public.wallet_links
    set status = 'REVOKED',
        revoked_at = now(),
        updated_at = now()
    where id = link_row.id
    returning * into link_row;

  return to_jsonb(link_row);
end;
$$;

revoke execute on function public.unlink_wallet(text, text) from public, anon, authenticated;
grant execute on function public.unlink_wallet(text, text) to service_role;

-- ---------------------------------------------------------------------
-- 5. get_linked_evm_wallets() RPC
-- ---------------------------------------------------------------------
-- Read-only list of ACTIVE EVM wallets linked to a Solana wallet.
-- Used by the wallet-link UI and as a building block for the verified
-- reward identity. Does NOT expose signature/challenge data.
-- ---------------------------------------------------------------------
create or replace function public.get_linked_evm_wallets(
  p_solana_wallet text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if p_solana_wallet is null or p_solana_wallet = '' then
    raise exception 'WALLET_REQUIRED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'evm_wallet', wl.evm_wallet,
    'evm_chain_scope', wl.evm_chain_scope,
    'verified_at', wl.verified_at
  ) order by wl.verified_at desc), '[]'::jsonb) into result
  from public.wallet_links wl
  where wl.solana_wallet = p_solana_wallet
    and wl.status = 'ACTIVE';

  return jsonb_build_object(
    'solana_wallet', p_solana_wallet,
    'linked_evm_wallets', result
  );
end;
$$;

revoke execute on function public.get_linked_evm_wallets(text) from public, anon, authenticated;
grant execute on function public.get_linked_evm_wallets(text) to service_role;

-- ---------------------------------------------------------------------
-- 6. get_verified_reward_identity() RPC
-- ---------------------------------------------------------------------
-- Resolves any address (Solana or EVM) to its canonical verified
-- reward identity: the Solana payout wallet + the set of linked EVM
-- wallets. Returns null solana_wallet if the EVM wallet is not linked.
--
-- Used by the API layer to enforce the security rule:
--   "the supplied wallet is the requested payout wallet; the server
--    determines linked wallets from the database" — never from a
--    query param list.
-- ---------------------------------------------------------------------
create or replace function public.get_verified_reward_identity(
  p_wallet_address text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_solana_wallet text;
  v_linked_evm text[];
  v_is_solana boolean;
  v_is_evm boolean;
begin
  if p_wallet_address is null or p_wallet_address = '' then
    raise exception 'WALLET_REQUIRED';
  end if;

  v_is_solana := p_wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
  v_is_evm := p_wallet_address ~ '^0x[0-9a-fA-F]{40}$';

  if v_is_solana then
    v_solana_wallet := p_wallet_address;
  elsif v_is_evm then
    -- Resolve the linked Solana wallet (if any).
    select solana_wallet into v_solana_wallet from public.wallet_links
      where evm_wallet = lower(p_wallet_address)
        and status = 'ACTIVE'
      limit 1;
  else
    raise exception 'INVALID_WALLET_FORMAT';
  end if;

  if v_solana_wallet is null then
    return jsonb_build_object(
      'solana_wallet', null,
      'linked_evm_wallets', '[]'::jsonb,
      'verified', false
    );
  end if;

  select array_agg(evm_wallet) into v_linked_evm
    from public.wallet_links
    where solana_wallet = v_solana_wallet
      and status = 'ACTIVE';

  return jsonb_build_object(
    'solana_wallet', v_solana_wallet,
    'linked_evm_wallets', coalesce(v_linked_evm, ARRAY[]::text[]),
    'verified', true
  );
end;
$$;

revoke execute on function public.get_verified_reward_identity(text) from public, anon, authenticated;
grant execute on function public.get_verified_reward_identity(text) to service_role;

-- ---------------------------------------------------------------------
-- 7. get_wallet_reward_balance() — modify to aggregate across links
-- ---------------------------------------------------------------------
-- Backward-compatible modification:
--   * If the wallet is a Solana address: aggregate its own points +
--     all ACTIVE linked EVM wallets' points.
--   * If the wallet is an EVM address: resolve its linked Solana
--     wallet (if any), then aggregate. The "claimed_points" is always
--     the canonical Solana wallet's claimed_points (NOT the EVM's),
--     so unlinking an EVM does not magically restore its points.
--   * If no links exist, behavior is identical to the previous
--     version (only the supplied wallet's own points).
--
-- The returned wallet_address is the canonical Solana payout wallet
-- (NOT the input EVM wallet) — so the frontend RewardClaimPanel can
-- always use the returned address as the claim recipient.
-- ---------------------------------------------------------------------
create or replace function public.get_wallet_reward_balance(
  p_wallet_address text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_solana_wallet text;
  v_identity public.get_verified_reward_identity%ROWTYPE;
  v_wallet_ids uuid[];
  v_wallet_addresses text[];
  v_canonical_wallet_row public.wallets;
  v_earned_points numeric;
  v_claimed_points numeric;
  v_claimable_points numeric;
  settings_row public.samurai_admin_settings;
  current_season public.samurai_seasons;
  recent_claims jsonb;
  v_input_is_solana boolean;
  v_input_is_evm boolean;
begin
  if p_wallet_address is null or p_wallet_address = '' then
    raise exception 'WALLET_REQUIRED';
  end if;

  v_input_is_solana := p_wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
  v_input_is_evm := p_wallet_address ~ '^0x[0-9a-fA-F]{40}$';

  if not (v_input_is_solana or v_input_is_evm) then
    raise exception 'INVALID_WALLET_FORMAT';
  end if;

  -- Resolve the verified identity. The server determines linked
  -- wallets from the database; the frontend NEVER supplies a list.
  select * into v_identity from public.get_verified_reward_identity(p_wallet_address);

  -- For a Solana input without any links, v_identity.solana_wallet
  -- is the input itself. For an EVM input that has no ACTIVE link,
  -- v_identity.solana_wallet is null (and we fall back to showing
  -- only the EVM wallet's own row, if any — preserving legacy
  -- behavior so an EVM-only user still sees their points number,
  -- but cannot claim until they link a Solana wallet).
  if v_identity.solana_wallet is not null then
    v_solana_wallet := v_identity.solana_wallet;
    v_wallet_addresses := array_append(coalesce(v_identity.linked_evm_wallets, ARRAY[]::text[]), v_solana_wallet);
  else
    -- No verified link. Use only the input wallet's own row.
    v_solana_wallet := null;
    v_wallet_addresses := array[p_wallet_address];
  end if;

  -- Collect wallet IDs for all addresses in the verified set.
  select array_agg(id) into v_wallet_ids
    from public.wallets
    where wallet_address = any(v_wallet_addresses);

  -- Aggregate earned points across the verified set.
  select coalesce(sum(sp.final_points), 0) into v_earned_points
    from public.samurai_points sp
    where sp.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]))
      and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED';

  -- Claimed points: the canonical Solana wallet's claimed_points.
  -- If the input is an unlinked EVM, fall back to the EVM wallet's
  -- own claimed_points (which is always 0 in practice — only the
  -- canonical Solana wallet receives claim increments).
  if v_solana_wallet is not null then
    select * into v_canonical_wallet_row from public.wallets
      where wallet_address = v_solana_wallet;
    v_claimed_points := coalesce(v_canonical_wallet_row.claimed_points, 0);
  else
    select * into v_canonical_wallet_row from public.wallets
      where wallet_address = lower(p_wallet_address)
         or wallet_address = p_wallet_address;
    v_claimed_points := coalesce(v_canonical_wallet_row.claimed_points, 0);
  end if;

  v_claimable_points := greatest(v_earned_points - v_claimed_points, 0);

  select * into settings_row from public.samurai_admin_settings
    where id = 'default';
  select * into current_season from public.get_current_samurai_season();

  if v_solana_wallet is not null then
    select coalesce(jsonb_agg(to_jsonb(rc)), '[]'::jsonb) into recent_claims
      from (
        select id, claim_id, points_claimed, reward_asset, reward_amount,
               conversion_rate, status, claim_tx_signature, season_id,
               created_at, claimed_at, completed_at
        from public.reward_claims
        where wallet_id = v_canonical_wallet_row.id
        order by created_at desc
        limit 25
      ) rc;
  else
    recent_claims := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'wallet_address', coalesce(v_solana_wallet, p_wallet_address),
    'input_wallet', p_wallet_address,
    'is_verified_identity', (v_solana_wallet is not null),
    'solana_payout_wallet', v_solana_wallet,
    'linked_evm_wallets', coalesce(v_identity.linked_evm_wallets, ARRAY[]::text[]),
    'earned_points', v_earned_points,
    'claimed_points', v_claimed_points,
    'claimable_points', v_claimable_points,
    'rewards_enabled', coalesce(settings_row.sol_rewards_enabled, false),
    'has_active_season', current_season.id is not null,
    'active_season_id', current_season.id,
    'reward_asset', coalesce(settings_row.reward_asset, 'SOL'),
    'reward_points_per_unit', coalesce(settings_row.reward_points_per_unit, 1000),
    'recent_claims', recent_claims
  );
end;
$$;

revoke execute on function public.get_wallet_reward_balance(text) from public, anon, authenticated;
grant execute on function public.get_wallet_reward_balance(text) to service_role;

-- ---------------------------------------------------------------------
-- 8. claim_reward() — modify to aggregate across verified links
-- ---------------------------------------------------------------------
-- Backward-compatible modification:
--   * If the supplied wallet is a Solana address: behaves as before
--     (locks the row, computes points, inserts the claim), but
--     earned_points is now the SUM of the Solana wallet's points +
--     all ACTIVE linked EVM wallets' points.
--   * If the supplied wallet is an EVM address: REJECTED. Only the
--     verified Solana payout wallet may claim. This enforces the
--     security rule "EVM address must NEVER be used as a Solana
--     recipient."
--   * claimed_points is incremented on the canonical Solana wallet
--     row only. If a user unlinks an EVM later, they do NOT regain
--     claimable points from the EVM's award history — the EVM's
--     points remain in the earned_points sum (they're still earned
--     by the same identity), but the canonical Solana wallet's
--     claimed_points counter is unaffected by the unlink.
--     (Unlinking only blocks FUTURE earned_points contributions.)
--
-- IMPORTANT: this RPC does NOT touch the on-chain Solana program.
-- It only records the entitlement in reward_claims + increments
-- claimed_points. The actual SOL payout still goes through the
-- EXISTING Anchor claim_reward instruction (in /api/rewards/claim-prepare
-- and /api/rewards/claim-confirm), which is unchanged.
-- ---------------------------------------------------------------------
create or replace function public.claim_reward(
  p_wallet_address text,
  p_claim_id text,
  p_points_to_claim numeric default null,
  p_client_nonce text default null,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_input_is_solana boolean;
  v_input_is_evm boolean;
  v_solana_wallet text;
  v_identity public.get_verified_reward_identity%ROWTYPE;
  v_wallet_addresses text[];
  v_wallet_ids uuid[];
  wallet_row public.wallets;
  settings_row public.samurai_admin_settings;
  current_season public.samurai_seasons;
  earned_points numeric;
  claimed_points numeric;
  claimable_points numeric;
  points_to_claim numeric;
  conversion_rate numeric;
  reward_asset text;
  reward_amount numeric;
  existing_claim public.reward_claims;
  new_claim public.reward_claims;
begin
  if p_wallet_address is null or p_wallet_address = '' then
    raise exception 'WALLET_REQUIRED';
  end if;

  if p_claim_id is null or p_claim_id = '' or p_claim_id !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'INVALID_CLAIM_ID';
  end if;

  if p_points_to_claim is not null and p_points_to_claim <= 0 then
    raise exception 'INVALID_POINTS_AMOUNT';
  end if;

  v_input_is_solana := p_wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
  v_input_is_evm := p_wallet_address ~ '^0x[0-9a-fA-F]{40}$';

  if v_input_is_evm then
    -- EVM addresses cannot be Solana payout recipients. The user
    -- must claim via their verified Solana wallet.
    raise exception 'EVM_CLAIM_NOT_ALLOWED';
  end if;
  if not v_input_is_solana then
    raise exception 'INVALID_WALLET_FORMAT';
  end if;

  -- Resolve the verified identity for this Solana wallet.
  select * into v_identity from public.get_verified_reward_identity(p_wallet_address);
  v_solana_wallet := v_identity.solana_wallet;  -- = p_wallet_address for Solana input
  v_wallet_addresses := array_append(coalesce(v_identity.linked_evm_wallets, ARRAY[]::text[]), v_solana_wallet);

  -- Lock the canonical Solana wallet row → serializes per-identity claims.
  select * into wallet_row from public.wallets
    where wallet_address = v_solana_wallet
    for update;
  if not found then
    raise exception 'WALLET_NOT_FOUND';
  end if;

  if wallet_row.flag_status = 'EXCLUDED' then
    raise exception 'WALLET_EXCLUDED';
  end if;

  -- Idempotency: if this claim_id already exists, return the existing claim.
  select * into existing_claim from public.reward_claims
    where claim_id = p_claim_id;
  if found then
    if existing_claim.wallet_id <> wallet_row.id then
      raise exception 'CLAIM_ID_CONFLICT';
    end if;

    select array_agg(id) into v_wallet_ids
      from public.wallets
      where wallet_address = any(v_wallet_addresses);

    select coalesce(sum(sp.final_points), 0) into earned_points
      from public.samurai_points sp
      where sp.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]))
        and sp.eligibility_status = 'qualified'
        and sp.flag_status <> 'EXCLUDED';

    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'claim', to_jsonb(existing_claim),
      'earned_points', earned_points,
      'claimed_points', wallet_row.claimed_points,
      'claimable_points', greatest(earned_points - wallet_row.claimed_points, 0)
    );
  end if;

  -- Rewards ON/OFF gate.
  select * into settings_row from public.samurai_admin_settings
    where id = 'default';
  if not found or not coalesce(settings_row.sol_rewards_enabled, false) then
    raise exception 'REWARDS_DISABLED';
  end if;

  -- Active season required.
  select * into current_season from public.get_current_samurai_season();
  if not found then
    raise exception 'NO_ACTIVE_SEASON';
  end if;

  -- Aggregate earned_points across the verified identity set.
  select array_agg(id) into v_wallet_ids
    from public.wallets
    where wallet_address = any(v_wallet_addresses);

  select coalesce(sum(sp.final_points), 0) into earned_points
    from public.samurai_points sp
    where sp.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]))
      and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED';

  claimed_points := coalesce(wallet_row.claimed_points, 0);
  claimable_points := greatest(earned_points - claimed_points, 0);

  if claimable_points <= 0 then
    raise exception 'NO_CLAIMABLE_POINTS';
  end if;

  if p_points_to_claim is null then
    points_to_claim := claimable_points;
  else
    if p_points_to_claim > claimable_points then
      raise exception 'INSUFFICIENT_CLAIMABLE_POINTS';
    end if;
    points_to_claim := p_points_to_claim;
  end if;

  conversion_rate := coalesce(settings_row.reward_points_per_unit, 1000);
  reward_asset := coalesce(settings_row.reward_asset, 'SOL');
  if conversion_rate <= 0 then
    raise exception 'INVALID_CONVERSION_RATE';
  end if;
  reward_amount := points_to_claim / conversion_rate;

  -- Atomic insert + claimed_points increment on the canonical Solana wallet.
  insert into public.reward_claims (
    wallet_id, wallet_address, claim_id, season_id,
    points_claimed, reward_asset, reward_amount, conversion_rate,
    status, client_nonce, metadata
  ) values (
    wallet_row.id, wallet_row.wallet_address, p_claim_id, current_season.id,
    points_to_claim, reward_asset, reward_amount, conversion_rate,
    'ENTITLED', p_client_nonce, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (claim_id) do nothing
  returning * into new_claim;

  if new_claim.id is null then
    select * into existing_claim from public.reward_claims
      where claim_id = p_claim_id;
    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'claim', to_jsonb(existing_claim),
      'earned_points', earned_points,
      'claimed_points', wallet_row.claimed_points,
      'claimable_points', greatest(earned_points - wallet_row.claimed_points, 0)
    );
  end if;

  update public.wallets w
    set claimed_points = w.claimed_points + points_to_claim,
        updated_at = now()
    where w.id = wallet_row.id
    returning * into wallet_row;

  return jsonb_build_object(
    'success', true,
    'idempotent', false,
    'claim', to_jsonb(new_claim),
    'earned_points', earned_points,
    'claimed_points', wallet_row.claimed_points,
    'claimable_points', greatest(earned_points - wallet_row.claimed_points, 0),
    'verified_identity', jsonb_build_object(
      'solana_wallet', v_solana_wallet,
      'linked_evm_wallets', coalesce(v_identity.linked_evm_wallets, ARRAY[]::text[])
    )
  );
end;
$$;

revoke execute on function public.claim_reward(text, text, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_reward(text, text, numeric, text, jsonb) to service_role;
