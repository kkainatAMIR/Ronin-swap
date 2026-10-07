drop function if exists public.update_reward_claim_broadcast_state(text, text, text);

drop trigger if exists reward_claim_broadcast_state_init on public.reward_claims;
drop function if exists public.initialize_reward_claim_broadcast_state();

alter table public.reward_claims
  drop column if exists broadcast_status,
  drop column if exists broadcast_attempted_at,
  drop column if exists broadcast_acknowledged_at;
