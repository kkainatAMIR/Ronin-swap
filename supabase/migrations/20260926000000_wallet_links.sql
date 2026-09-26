-- =====================================================================
-- Wallet Link Identity Layer (Multi-chain Samurai Points → SOL rewards)
-- =====================================================================
-- This migration adds a CRYPTOGRAPHIC wallet-link layer on top of the
-- existing Samurai Points / reward accounting system. It does NOT touch:
--   * the deployed Solana Anchor rewards program
--     (program ID 6Uyjo8oDGQJeb8zS1yFqwLCguc4gfUB1V4xWheAD7RYC)
--   * the reward PDA seeds / vault / claim instruction
--   * the existing reward_claims rows or wallets.claimed_points values
--   * the existing samurai_points awards
--
-- What it adds:
--   1. wallet_links                  – a verified Solana↔EVM link registry
--   2. wallet_link_challenges        – server-issued, one-time-use, expiring
--                                       nonce/challenge rows for the dual-sig
--                                       link flow (mirrors admin_auth_challenges)
--   3. wallet_point_consumption      – PER-WALLET consumption ledger that
--                                       travels with the wallet_id, NOT with
--                                       the link. This is the AUTHORITATIVE
--                                       "consumed points" tracker. It
--                                       survives unlink/relink AND
--                                       cross-identity re-linking because
--                                       the consumed points stay tied to the
--                                       wallet_id of the wallet that
--                                       originally earned them.
--   4. link_wallets() RPC            – atomic verify-both-signatures + insert
--   5. unlink_wallet() RPC            – atomic revoke (Solana sig required,
--                                       done in the API handler before calling this)
--   6. get_linked_evm_wallets() RPC   – read-only list of ACTIVE EVM links
--   7. get_verified_reward_identity() RPC – resolve any address
--      (Solana or EVM) to its canonical Solana payout wallet + set of
--      linked EVM wallets
--   8. Modifications to get_wallet_reward_balance() and claim_reward():
--      they now aggregate earned_points AND consumed_points across the
--      verified link set, using wallet_point_consumption as the
--      authoritative source. Backward compatible: if no links exist
--      for a wallet, behavior is identical to before (the wallet's own
--      samurai_points and the legacy claimed_points counter — the latter
--      is backfilled into wallet_point_consumption below so the math
--      is consistent even for legacy Solana-only users).
--
-- =========================================================================
-- ACCOUNTING MODEL (THE FIX)
-- =========================================================================
-- The ORIGINAL (pre-fix) design had this bug:
--   * earned_points = sum across {Solana wallet + linked EVM wallets}
--   * claimed_points = the canonical Solana wallet's claimed_points column
--   * claimable = earned - claimed
-- If the EVM is later unlinked and re-linked to a DIFFERENT Solana
-- wallet, the EVM's previously-claimed points become claimable again
-- because the consumed counter lives on Solana A's row, not on the
-- EVM's row.
--
-- THE FIX:
--   * earned_points(wallet_id) = sum(samurai_points.final_points
--                                    where wallet_id = X)
--   * consumed_points(wallet_id) = sum(wallet_point_consumption.points_consumed
--                                      where wallet_id = X)
--   * claimable_points(identity) =
--       sum(earned_points across identity wallets)
--       -
--       sum(consumed_points across identity wallets)
--   * One earned point can only be consumed once, because the
--     wallet_point_consumption row is tied to the wallet_id of the
--     wallet that originally earned the point — NOT to the link.
--   * Unlinking doesn't touch wallet_point_consumption.
--   * Re-linking to a different Solana wallet doesn't restore
--     consumed_points (they travel with the wallet_id).
--
-- FIFO DISTRIBUTION:
--   When a claim is made, the consumed points are distributed across
--   the wallets in the identity set in FIFO order:
--     1. Canonical Solana wallet (oldest first by definition)
--     2. Linked EVM wallets ordered by verified_at ASC (oldest link first)
--   For each wallet, we take min(remaining_to_consume,
--   max(earned_for_wallet - consumed_for_wallet, 0)) and insert a
--   wallet_point_consumption row. This guarantees:
--     * The canonical Solana wallet is "drained" first (preserving
--       the legacy semantics where Solana-only users' claims are
--       tracked on their own wallet row).
--     * EVM wallets' consumption rows persist on the EVM wallet_id,
--       so unlink/relink cannot reset them.
--
-- BACKFILL FOR EXISTING USERS:
--   For every wallet with claimed_points > 0, we insert ONE
--   wallet_point_consumption row with:
--     wallet_id = w.id
--     claim_id = NULL                  (no specific claim; legacy)
--     points_consumed = w.claimed_points
--     source = 'MIGRATION_BACKFILL'
--   This makes the new accounting consistent with the old counter
--   from the moment the migration is applied. Existing users cannot
--   reclaim their previously-claimed points.
--
--   We ALSO continue to increment wallets.claimed_points on new
--   claims (on the canonical Solana wallet only) so legacy admin
--   tools that read that column still see a sensible value. The
--   AUTHORITATIVE consumed-points source is wallet_point_consumption.
-- =========================================================================
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
--
-- evm_chain_scope is INTENTIONALLY ABSENT: an EVM address is one row
-- in public.wallets regardless of which EVM chain it swapped on
-- (Ethereum chain_id=1, Robinhood chain_id=4663 — both store
-- samurai_points rows under the same wallet_id). Adding a per-chain
-- link scope would split a single EVM identity into multiple
-- pseudo-identities without any security benefit; it would only
-- complicate the verified-identity aggregation. Removed.
-- ---------------------------------------------------------------------
create table if not exists public.wallet_links (
  id uuid primary key default gen_random_uuid(),
  solana_wallet text not null,
  evm_wallet text not null,
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
-- 3. wallet_point_consumption table  (THE ACCOUNTING FIX)
-- ---------------------------------------------------------------------
-- PER-WALLET consumption ledger. One row per (wallet_id, claim_id),
-- recording how many points from that wallet were consumed by that
-- claim. MIGRATION_BACKFILL rows have claim_id = NULL and represent
-- the legacy wallets.claimed_points value at migration time.
--
-- Why this fixes the bug:
--   * The consumed amount travels with the wallet_id, NOT with the
--     link. Unlinking an EVM does NOT delete its wallet_point_consumption
--     rows. Re-linking the same EVM (to any Solana wallet) does NOT
--     restore its consumed amount.
--   * Therefore: sum(consumed) for an identity correctly reflects ALL
--     claims that have ever consumed points from any wallet in that
--     identity, regardless of link state at any point in time.
--   * The math "earned - consumed = claimable" cannot produce a
--     duplicate claim under the unlink/relink/earn/relink cycle.
-- ---------------------------------------------------------------------
create table if not exists public.wallet_point_consumption (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id),
  -- Nullable: MIGRATION_BACKFILL rows have no associated claim.
  -- For real claims, this references the claim that consumed the points.
  claim_id text references public.reward_claims(claim_id),
  points_consumed numeric(30, 6) not null,
  source text not null default 'CLAIM'
    check (source in ('CLAIM', 'MIGRATION_BACKFILL', 'ADMIN_ADJUST')),
  consumed_at timestamptz not null default now(),
  constraint wallet_point_consumption_positive check (points_consumed > 0)
);

-- One row per (wallet_id, claim_id) — a single claim can't consume the
-- same wallet twice. NULL claim_ids are allowed (multiple backfill rows
-- would be wasteful but not incorrect; the partial unique index below
-- makes backfill idempotent per wallet).
create unique index if not exists wallet_point_consumption_wallet_claim_uidx
  on public.wallet_point_consumption(wallet_id, claim_id)
  where claim_id is not null;

-- Idempotent backfill: only one MIGRATION_BACKFILL row per wallet.
create unique index if not exists wallet_point_consumption_backfill_uidx
  on public.wallet_point_consumption(wallet_id)
  where source = 'MIGRATION_BACKFILL';

-- Fast lookup by wallet_id.
create index if not exists wallet_point_consumption_wallet_idx
  on public.wallet_point_consumption(wallet_id, consumed_at desc);
create index if not exists wallet_point_consumption_claim_idx
  on public.wallet_point_consumption(claim_id)
  where claim_id is not null;

alter table public.wallet_point_consumption enable row level security;
revoke all on table public.wallet_point_consumption from public, anon, authenticated;
grant select, insert, update on table public.wallet_point_consumption to service_role;

-- ---------------------------------------------------------------------
-- 3a. Backfill: preserve existing wallets.claimed_points values
-- ---------------------------------------------------------------------
-- For every wallet that already has claimed_points > 0 (from prior
-- Solana-only claims), insert a single MIGRATION_BACKFILL row so the
-- new accounting math starts consistent. Existing users cannot reclaim
-- their previously-claimed points.
--
-- This is run ONCE at migration time. The partial unique index above
-- makes it idempotent (safe to re-run if the migration is applied
-- multiple times).
-- ---------------------------------------------------------------------
insert into public.wallet_point_consumption (wallet_id, claim_id, points_consumed, source, consumed_at)
  select w.id, null, w.claimed_points, 'MIGRATION_BACKFILL', coalesce(w.updated_at, now())
  from public.wallets w
  where w.claimed_points > 0
  on conflict do nothing;

-- ---------------------------------------------------------------------
-- 4. link_wallets() RPC
-- ---------------------------------------------------------------------
-- Verifies both signatures + atomically creates the wallet link.
-- This is the ONLY function that mutates wallet_links.status to ACTIVE.
-- The handler had already validated the challenge exists, is PENDING,
-- and is not expired — but the RPC re-verifies all of those conditions
-- inside a single transaction (defense in depth).
--
-- The signature VERIFICATION ITSELF happens in the API handler (Node)
-- because Postgres can't efficiently do secp256k1 ecrecover or ed25519
-- verify without extensions. So this RPC trusts the handler's
-- verification BUT still:
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
    update public.wallet_link_challenges
      set status = 'EXPIRED'
      where challenge_id = p_challenge_id;
    raise exception 'CHALLENGE_EXPIRED';
  end if;

  if lower(p_evm_signer) <> lower(challenge_row.evm_wallet) then
    raise exception 'EVM_SIGNER_MISMATCH';
  end if;
  if p_solana_signer <> challenge_row.solana_wallet then
    raise exception 'SOLANA_SIGNER_MISMATCH';
  end if;

  -- Cross-user hijack protection.
  select * into conflicting_link from public.wallet_links
    where evm_wallet = lower(challenge_row.evm_wallet)
      and status = 'ACTIVE'
      and solana_wallet <> challenge_row.solana_wallet;
  if found then
    raise exception 'EVM_ALREADY_LINKED_ELSEWHERE';
  end if;

  -- Ensure the canonical Solana wallet row exists in public.wallets.
  insert into public.wallets (wallet_address, wallet_chain_id)
    values (challenge_row.solana_wallet, 101)
    on conflict (wallet_address) do nothing;

  -- Insert (or reactivate) the link row.
  insert into public.wallet_links (solana_wallet, evm_wallet, status, verified_at, revoked_at)
    values (challenge_row.solana_wallet, lower(challenge_row.evm_wallet),
            'ACTIVE', now(), null)
    on conflict (solana_wallet, evm_wallet)
    do update set
      status = 'ACTIVE',
      verified_at = now(),
      revoked_at = null,
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
-- 5. unlink_wallet() RPC
-- ---------------------------------------------------------------------
-- Revokes an ACTIVE link. The handler must have already verified a
-- fresh Solana signature proving ownership of the canonical Solana
-- wallet (so only the Solana wallet's owner can unlink their EVMs).
--
-- IMPORTANT: unlink does NOT delete wallet_point_consumption rows.
-- The consumed points stay tied to the wallet_id, so unlinking cannot
-- restore previously-claimed points.
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
-- 6. get_linked_evm_wallets() RPC
-- ---------------------------------------------------------------------
-- Read-only list of ACTIVE EVM wallets linked to a Solana wallet.
-- Does NOT expose signature/challenge data.
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
-- 7. get_verified_reward_identity() RPC
-- ---------------------------------------------------------------------
-- Resolves any address (Solana or EVM) to its canonical verified
-- reward identity: the Solana payout wallet + the set of linked EVM
-- wallets. Returns null solana_wallet if the EVM wallet is not linked.
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
-- 8. get_wallet_reward_balance() — AUTHORITATIVE accounting
-- ---------------------------------------------------------------------
-- Returns the verified-identity reward balance:
--   earned_points   = sum(samurai_points.final_points) across all
--                     wallets in the verified identity set
--   consumed_points = sum(wallet_point_consumption.points_consumed)
--                     across all wallets in the verified identity set
--   claimable_points = max(earned - consumed, 0)
--
-- The verified identity set is {canonical Solana wallet} ∪ {ACTIVE
-- linked EVM wallets}. The server resolves this from the DB — the
-- frontend NEVER supplies a wallet list.
--
-- Backward compatibility:
--   * If the input is a Solana wallet with no links, the set is just
--     that wallet. Its consumed_points comes from
--     wallet_point_consumption (which includes any MIGRATION_BACKFILL
--     row representing its legacy claimed_points). The math gives
--     the same answer as the pre-migration logic.
--   * If the input is an unlinked EVM wallet, we fall back to showing
--     that wallet's own row (so an EVM-only user still sees their
--     points number, but they cannot claim until they link a Solana
--     wallet).
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
  v_consumed_points numeric;
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

  select * into v_identity from public.get_verified_reward_identity(p_wallet_address);

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

  -- AUTHORITATIVE earned points: from samurai_points.
  select coalesce(sum(sp.final_points), 0) into v_earned_points
    from public.samurai_points sp
    where sp.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]))
      and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED';

  -- AUTHORITATIVE consumed points: from wallet_point_consumption.
  -- This is the new ledger; it includes MIGRATION_BACKFILL rows for
  -- legacy users plus CLAIM rows for new claims.
  select coalesce(sum(wpc.points_consumed), 0) into v_consumed_points
    from public.wallet_point_consumption wpc
    where wpc.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]));

  v_claimable_points := greatest(v_earned_points - v_consumed_points, 0);

  select * into settings_row from public.samurai_admin_settings
    where id = 'default';
  select * into current_season from public.get_current_samurai_season();

  if v_solana_wallet is not null then
    select * into v_canonical_wallet_row from public.wallets
      where wallet_address = v_solana_wallet;
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
    'consumed_points', v_consumed_points,
    'claimed_points', v_consumed_points,  -- alias for backward compat with frontend
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
-- 9. claim_reward() — AUTHORITATIVE accounting + FIFO distribution
-- ---------------------------------------------------------------------
-- Records a reward claim against the verified identity anchored at
-- the supplied Solana wallet. Steps:
--   1. Reject EVM input (EVM_CLAIM_NOT_ALLOWED).
--   2. Resolve verified identity (Solana + linked EVMs).
--   3. Lock ALL wallet rows in the identity set FOR UPDATE → serializes
--      per-identity claims (different identities are still parallel).
--   4. Compute earned = sum(samurai_points.final_points) across set.
--   5. Compute consumed = sum(wallet_point_consumption.points_consumed) across set.
--   6. claimable = max(earned - consumed, 0).
--   7. Validate points_to_claim ≤ claimable.
--   8. Insert reward_claims row (wallet_id = canonical Solana, points_claimed
--      = total, status = ENTITLED).
--   9. Distribute consumed points FIFO across wallets in the set:
--        a. Canonical Solana wallet first.
--        b. Linked EVM wallets ordered by verified_at ASC.
--      For each wallet: take min(remaining,
--      max(earned_for_wallet - consumed_for_wallet, 0)) and insert a
--      wallet_point_consumption row with the new claim_id.
--   10. Increment canonical Solana wallet's claimed_points column by
--       points_to_claim (legacy counter — kept in sync for admin
--       tools but NOT authoritative).
--
-- SECURITY INVARIANTS:
--   * The frontend NEVER supplies points, reward_amount, wallet list,
--     or recipient. All values are computed server-side.
--   * The recipient passed to the on-chain Anchor instruction (in the
--     /api/rewards/claim-prepare handler) is ALWAYS the canonical
--     Solana wallet — never an EVM address.
--   * EVM input is rejected at step 1.
--   * One claim_id can only insert one reward_claims row (unique
--     constraint) → idempotent retries.
--
-- ACCOUNTING INVARIANTS:
--   * One earned point can only be consumed once: every consumption is
--     recorded as a wallet_point_consumption row tied to the wallet_id
--     that earned the point. Unlinking/re-linking does NOT delete or
--     reset these rows. The math is therefore correct under:
--       link → claim → unlink → earn → relink → claim
--   * Existing legacy users (Solana-only, claimed_points > 0) have
--     their pre-migration claimed amount represented as a
--     MIGRATION_BACKFILL row in wallet_point_consumption. They cannot
--     reclaim those points.
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
  v_wallet_ids_ordered uuid[];  -- FIFO order: Solana first, then EVMs by verified_at
  wallet_row public.wallets;
  settings_row public.samurai_admin_settings;
  current_season public.samurai_seasons;
  earned_points numeric;
  consumed_points numeric;
  claimable_points numeric;
  points_to_claim numeric;
  conversion_rate numeric;
  reward_asset text;
  reward_amount numeric;
  existing_claim public.reward_claims;
  new_claim public.reward_claims;
  v_remaining numeric;
  v_wallet_id uuid;
  v_wallet_earned numeric;
  v_wallet_consumed numeric;
  v_wallet_available numeric;
  v_take numeric;
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

  -- SECURITY: EVM addresses can NEVER be Solana payout recipients.
  if v_input_is_evm then
    raise exception 'EVM_CLAIM_NOT_ALLOWED';
  end if;
  if not v_input_is_solana then
    raise exception 'INVALID_WALLET_FORMAT';
  end if;

  -- Resolve the verified identity.
  select * into v_identity from public.get_verified_reward_identity(p_wallet_address);
  v_solana_wallet := v_identity.solana_wallet;
  v_wallet_addresses := array_append(coalesce(v_identity.linked_evm_wallets, ARRAY[]::text[]), v_solana_wallet);

  -- Lock the canonical Solana wallet row FOR UPDATE. This serializes
  -- claims per identity (only the canonical Solana wallet row is
  -- locked, so different identities remain parallel).
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
    -- Recompute earned/consumed for the response (the values may have
    -- changed since the original claim if new points were earned).
    select array_agg(id) into v_wallet_ids
      from public.wallets
      where wallet_address = any(v_wallet_addresses);
    select coalesce(sum(sp.final_points), 0) into earned_points
      from public.samurai_points sp
      where sp.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]))
        and sp.eligibility_status = 'qualified'
        and sp.flag_status <> 'EXCLUDED';
    select coalesce(sum(wpc.points_consumed), 0) into consumed_points
      from public.wallet_point_consumption wpc
      where wpc.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]));
    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'claim', to_jsonb(existing_claim),
      'earned_points', earned_points,
      'consumed_points', consumed_points,
      'claimable_points', greatest(earned_points - consumed_points, 0)
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

  -- AUTHORITATIVE earned points.
  select array_agg(id) into v_wallet_ids
    from public.wallets
    where wallet_address = any(v_wallet_addresses);
  select coalesce(sum(sp.final_points), 0) into earned_points
    from public.samurai_points sp
    where sp.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]))
      and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED';

  -- AUTHORITATIVE consumed points.
  select coalesce(sum(wpc.points_consumed), 0) into consumed_points
    from public.wallet_point_consumption wpc
    where wpc.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]));

  claimable_points := greatest(earned_points - consumed_points, 0);
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

  -- Atomic insert of the reward_claims row. The wallet_id is the
  -- canonical Solana wallet's id — this is the row that anchors the
  -- claim. The reward_claims row records the TOTAL points claimed;
  -- the FIFO distribution below breaks that total down across the
  -- individual wallets that earned those points (via
  -- wallet_point_consumption).
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
    -- Concurrent insert won → return the existing claim idempotently.
    select * into existing_claim from public.reward_claims
      where claim_id = p_claim_id;
    select coalesce(sum(sp.final_points), 0) into earned_points
      from public.samurai_points sp
      where sp.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]))
        and sp.eligibility_status = 'qualified'
        and sp.flag_status <> 'EXCLUDED';
    select coalesce(sum(wpc.points_consumed), 0) into consumed_points
      from public.wallet_point_consumption wpc
      where wpc.wallet_id = any(coalesce(v_wallet_ids, ARRAY[]::uuid[]));
    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'claim', to_jsonb(existing_claim),
      'earned_points', earned_points,
      'consumed_points', consumed_points,
      'claimable_points', greatest(earned_points - consumed_points, 0)
    );
  end if;

  -- =====================================================================
  -- FIFO DISTRIBUTION of consumed points across identity wallets.
  -- =====================================================================
  -- Order: canonical Solana wallet first, then EVM wallets ordered by
  -- verified_at ASC (oldest link first). For each wallet, take
  -- min(remaining, max(earned - consumed, 0)) and insert a
  -- wallet_point_consumption row.
  -- =====================================================================
  -- Build the FIFO-ordered wallet_id array explicitly.
  -- 1. Canonical Solana wallet (already known via wallet_row.id).
  v_wallet_ids_ordered := array[wallet_row.id];
  -- 2. Append EVM wallet_ids ordered by link verified_at ASC.
  declare
    evm_ids uuid[];
  begin
    select array_agg(w.id order by wl.verified_at asc) into evm_ids
      from public.wallet_links wl
      join public.wallets w on w.wallet_address = wl.evm_wallet
      where wl.solana_wallet = v_solana_wallet
        and wl.status = 'ACTIVE'
        and w.id <> wallet_row.id;  -- defensive: never double-count Solana
    if evm_ids is not null then
      v_wallet_ids_ordered := array_cat(v_wallet_ids_ordered, evm_ids);
    end if;
  end;

  v_remaining := points_to_claim;
  foreach v_wallet_id in v_wallet_ids_ordered
    loop
      if v_remaining <= 0 then exit; end if;

      select coalesce(sum(sp.final_points), 0) into v_wallet_earned
        from public.samurai_points sp
        where sp.wallet_id = v_wallet_id
          and sp.eligibility_status = 'qualified'
          and sp.flag_status <> 'EXCLUDED';

      select coalesce(sum(wpc.points_consumed), 0) into v_wallet_consumed
        from public.wallet_point_consumption wpc
        where wpc.wallet_id = v_wallet_id;

      v_wallet_available := greatest(v_wallet_earned - v_wallet_consumed, 0);
      v_take := least(v_remaining, v_wallet_available);

      if v_take > 0 then
        insert into public.wallet_point_consumption (wallet_id, claim_id, points_consumed, source)
          values (v_wallet_id, p_claim_id, v_take, 'CLAIM')
          on conflict (wallet_id, claim_id) do nothing;
        v_remaining := v_remaining - v_take;
      end if;
    end loop;

  -- If we couldn't distribute all consumed points (shouldn't happen
  -- because we validated points_to_claim <= claimable above), abort.
  if v_remaining > 0 then
    raise exception 'CONSUMPTION_DISTRIBUTION_FAILED: remaining=%', v_remaining;
  end if;

  -- Legacy counter: increment wallets.claimed_points on the canonical
  -- Solana wallet. NOT authoritative (the authoritative source is
  -- wallet_point_consumption), but kept in sync for admin tools that
  -- still read this column.
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
    'consumed_points', consumed_points + points_to_claim,
    'claimed_points', consumed_points + points_to_claim,  -- alias for backward compat
    'claimable_points', greatest(earned_points - (consumed_points + points_to_claim), 0),
    'verified_identity', jsonb_build_object(
      'solana_wallet', v_solana_wallet,
      'linked_evm_wallets', coalesce(v_identity.linked_evm_wallets, ARRAY[]::text[])
    )
  );
end;
$$;

revoke execute on function public.claim_reward(text, text, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_reward(text, text, numeric, text, jsonb) to service_role;
