create or replace function public.guard_samurai_season_snapshot_immutability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'SEASON_SNAPSHOT_IMMUTABLE';
  end if;

  if not exists (
    select 1
    from public.samurai_seasons s
    where s.id = new.season_id
      and s.status = 'ENDED'
      and new.snapshot_version = coalesce(nullif(s.allocation_version, 0), 1)
  ) then
    raise exception 'SEASON_SNAPSHOT_NOT_WRITABLE';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_samurai_season_snapshot_immutability() from public, anon, authenticated;

drop trigger if exists samurai_season_snapshot_immutability
  on public.samurai_season_leaderboard_snapshots;
create trigger samurai_season_snapshot_immutability
  before insert or update or delete
  on public.samurai_season_leaderboard_snapshots
  for each row
  execute function public.guard_samurai_season_snapshot_immutability();

create or replace function public.guard_samurai_season_reward_allocation_immutability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  season_row public.samurai_seasons;
  snapshot_row public.samurai_season_leaderboard_snapshots;
  expected_reward_amount numeric(38, 9);
begin
  if tg_op = 'DELETE' then
    raise exception 'SEASON_REWARD_ALLOCATION_IMMUTABLE';
  end if;

  if tg_op = 'UPDATE' then
    if row(
      new.id,
      new.season_id,
      new.wallet_id,
      new.wallet_address,
      new.eligible_points,
      new.total_eligible_points,
      new.reward_pool_amount,
      new.reward_amount,
      new.reward_asset,
      new.allocation_version,
      new.created_at
    ) is distinct from row(
      old.id,
      old.season_id,
      old.wallet_id,
      old.wallet_address,
      old.eligible_points,
      old.total_eligible_points,
      old.reward_pool_amount,
      old.reward_amount,
      old.reward_asset,
      old.allocation_version,
      old.created_at
    ) then
      raise exception 'SEASON_REWARD_ALLOCATION_IMMUTABLE';
    end if;

    return new;
  end if;

  select *
  into season_row
  from public.samurai_seasons s
  where s.id = new.season_id;

  if not found
    or season_row.status <> 'FROZEN'
    or season_row.frozen_at is null
    or season_row.reward_pool_status <> 'CONFIGURED'
    or new.allocation_version <> coalesce(nullif(season_row.allocation_version, 0), 1)
    or new.reward_pool_amount is distinct from season_row.reward_pool_amount
    or new.reward_asset <> 'SOL'
    or new.claim_status <> 'AVAILABLE' then
    raise exception 'SEASON_REWARD_ALLOCATION_NOT_WRITABLE';
  end if;

  select *
  into snapshot_row
  from public.samurai_season_leaderboard_snapshots ss
  where ss.season_id = new.season_id
    and ss.snapshot_version = new.allocation_version
    and ss.canonical_wallet_id = new.wallet_id;

  if not found
    or new.wallet_address is distinct from snapshot_row.wallet_address
    or new.eligible_points is distinct from snapshot_row.eligible_points
    or new.total_eligible_points is distinct from snapshot_row.total_eligible_points
    or new.total_eligible_points is distinct from season_row.final_points then
    raise exception 'SEASON_REWARD_ALLOCATION_SNAPSHOT_MISMATCH';
  end if;

  expected_reward_amount := floor(
    season_row.reward_pool_amount * snapshot_row.eligible_points
    / nullif(snapshot_row.total_eligible_points, 0) * 1000000000
  ) / 1000000000;

  if new.reward_amount is distinct from expected_reward_amount then
    raise exception 'SEASON_REWARD_ALLOCATION_AMOUNT_MISMATCH';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_samurai_season_reward_allocation_immutability() from public, anon, authenticated;

drop trigger if exists samurai_season_reward_allocation_immutability
  on public.samurai_season_reward_allocations;
create trigger samurai_season_reward_allocation_immutability
  before insert or update or delete
  on public.samurai_season_reward_allocations
  for each row
  execute function public.guard_samurai_season_reward_allocation_immutability();
