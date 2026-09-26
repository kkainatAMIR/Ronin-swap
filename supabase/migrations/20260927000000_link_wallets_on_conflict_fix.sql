-- =====================================================================
-- Fix link_wallets() ON CONFLICT clause — partial-index predicate
-- =====================================================================
-- BUG
---
-- The link_wallets() RPC raised this error on every verify call:
--
--   there is no unique or exclusion constraint matching the
--   ON CONFLICT specification
--
-- ROOT CAUSE
-- ---------
-- The RPC used:
--
--   INSERT INTO public.wallet_links (solana_wallet, evm_wallet, ...)
--   VALUES (...)
--   ON CONFLICT (solana_wallet, evm_wallet)
--   DO UPDATE SET ...
--
-- But the unique constraint on (solana_wallet, evm_wallet) is a
-- PARTIAL index — it only applies WHERE status = 'ACTIVE':
--
--   create unique index wallet_links_pair_active_uidx
--     on public.wallet_links(solana_wallet, evm_wallet)
--     where status = 'ACTIVE';
--
-- Postgres can't use a partial unique index for ON CONFLICT unless
-- you include the index predicate in the ON CONFLICT clause. Without
-- the predicate, Postgres looks for a non-partial UNIQUE constraint
-- on (solana_wallet, evm_wallet) — doesn't find one — raises the
-- 'no unique or exclusion constraint matching the ON CONFLICT
-- specification' error.
--
-- THE FIX
-- -------
-- Add the WHERE status = 'ACTIVE' predicate to the ON CONFLICT
-- clause so Postgres knows to use the partial unique index:
--
--   ON CONFLICT (solana_wallet, evm_wallet) WHERE status = 'ACTIVE'
--   DO UPDATE SET ...
--
-- This is a pure PL/pgSQL function definition update — no schema
-- changes, no table changes, no data changes. The migration is
-- idempotent (uses CREATE OR REPLACE FUNCTION) and safe to re-run.
--
-- This fix does NOT touch:
--   * the deployed Solana Anchor rewards program
--   * the reward PDA seeds / vault / claim instruction
--   * existing reward_claims rows or wallets.claimed_points values
--   * existing samurai_points awards
--   * the existing wallet_links or wallet_link_challenges tables
--   * the existing wallet_point_consumption ledger
-- =====================================================================

create or replace function public.link_wallets(
  p_challenge_id text,
  p_evm_signature text,
  p_solana_signature text,
  p_evm_signer text,
  p_solana_signer text
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

  if p_challenge_id is null
     or p_challenge_id = ''
  then
    raise exception 'CHALLENGE_ID_REQUIRED';
  end if;


  if p_evm_signature is null
     or p_evm_signature = ''
  then
    raise exception 'EVM_SIGNATURE_REQUIRED';
  end if;


  if p_solana_signature is null
     or p_solana_signature = ''
  then
    raise exception 'SOLANA_SIGNATURE_REQUIRED';
  end if;


  -- Lock challenge to prevent replay/concurrent use.
  select *
    into challenge_row
  from public.wallet_link_challenges
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


  if lower(p_evm_signer)
     <> lower(challenge_row.evm_wallet)
  then
    raise exception 'EVM_SIGNER_MISMATCH';
  end if;


  if p_solana_signer
     <> challenge_row.solana_wallet
  then
    raise exception 'SOLANA_SIGNER_MISMATCH';
  end if;

  -- Cross-user hijack protection.
  select *
    into conflicting_link
  from public.wallet_links
  where evm_wallet = lower(challenge_row.evm_wallet)
    and status = 'ACTIVE'
    and solana_wallet <> challenge_row.solana_wallet
  for update;


  if found then
    raise exception 'EVM_ALREADY_LINKED_ELSEWHERE';
  end if;

  -- Ensure canonical Solana wallet exists.
  insert into public.wallets (
    wallet_address,
    wallet_chain_id
  )
  values (
    challenge_row.solana_wallet,
    101
  )
  on conflict (wallet_address)
  do nothing;

  -- ===================================================================
  -- INSERT or REACTIVATE link.
  -- ===================================================================
  -- THE FIX: the ON CONFLICT clause now includes the index predicate
  -- `WHERE status = 'ACTIVE'` so Postgres uses the partial unique
  -- index wallet_links_pair_active_uidx (which was always defined
  -- with `where status = 'ACTIVE'`).
  --
  -- Without the predicate, Postgres raised:
  --   "there is no unique or exclusion constraint matching the
  --    ON CONFLICT specification"
  -- because it was looking for a NON-partial unique constraint on
  -- (solana_wallet, evm_wallet) — and the only such constraint is
  -- the partial index, which requires the WHERE clause to match.
  --
  -- Behavior with the fix:
  --   * If an ACTIVE link exists for the same (solana, evm) pair,
  --     the ON CONFLICT DO UPDATE fires — reactivates the existing
  --     row (sets verified_at = now(), revoked_at = null).
  --   * If only REVOKED rows exist for the same pair, the partial
  --     index has no entry for them, so no conflict — a fresh ACTIVE
  --     row is inserted. (This is correct: REVOKED history is
  --     preserved as separate rows for audit purposes.)
  -- ===================================================================
  insert into public.wallet_links (
    solana_wallet,
    evm_wallet,
    status,
    verified_at,
    revoked_at
  )
  values (
    challenge_row.solana_wallet,
    lower(challenge_row.evm_wallet),
    'ACTIVE',
    now(),
    null
  )
  on conflict (
    solana_wallet,
    evm_wallet
  ) where status = 'ACTIVE'
  do update
  set
    status = 'ACTIVE',
    verified_at = now(),
    revoked_at = null,
    updated_at = now()
  returning *
  into new_link;

  -- Challenge becomes permanently USED.
  update public.wallet_link_challenges
  set
    status = 'USED',
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
