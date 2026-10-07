create or replace function public.get_wallet_season_reward(p_wallet_address text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  identity jsonb;
  canonical_wallet text;
  v_canonical_wallet_id uuid;
  wallet_addresses text[];
  season_rewards jsonb;
  reserved_points numeric;
begin
  identity := public.get_verified_reward_identity(p_wallet_address);
  canonical_wallet := identity->>'solana_wallet';
  select array_agg(address::text)
  into wallet_addresses
  from jsonb_array_elements_text(coalesce(identity->'linked_evm_wallets', '[]'::jsonb)) as linked(address);

  if canonical_wallet is not null then
    wallet_addresses := array_append(coalesce(wallet_addresses, array[]::text[]), canonical_wallet);
    select id into v_canonical_wallet_id
    from public.wallets
    where wallet_address = canonical_wallet;
  else
    wallet_addresses := array[p_wallet_address];
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'season', jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'status', s.status,
        'start_at', s.start_at,
        'end_at', s.end_at,
        'reward_pool_status', s.reward_pool_status,
        'reward_pool_amount', s.reward_pool_amount,
        'reward_asset', 'SOL',
        'claim_window_start', s.claim_window_start,
        'claim_window_end', s.claim_window_end,
        'total_eligible_points', s.total_eligible_points,
        'eligible_wallet_count', s.eligible_wallet_count,
        'allocation_version', s.allocation_version
      ),
      'participation', jsonb_build_object(
        'status', 'PARTICIPATED',
        'samurai_points', participation.samurai_points,
        'qualifying_volume', participation.qualifying_volume,
        'qualifying_swaps', participation.qualifying_swaps,
        'eligibility_status', participation.eligibility_status,
        'rank', snapshot_points.rank,
        'campaigns', participation.campaigns
      ),
      'allocation', case when a.id is null then null else
        (to_jsonb(a) - 'reward_amount') || jsonb_build_object(
          'has_reward', coalesce(a.reward_amount, 0) > 0,
          'reward_amount', case
            when latest.claim->>'status' = 'COMPLETED' then a.reward_amount
            else null
          end
        )
      end,
      'claim', latest.claim,
      'claim_window_open', s.reward_pool_status = 'FINALIZED'
        and (
          (now() >= s.claim_window_start and now() < s.claim_window_end)
          or later_claim.id is not null
        ),
      'claim_window_via', case
        when s.reward_pool_status = 'FINALIZED'
          and now() >= s.claim_window_start and now() < s.claim_window_end
          then jsonb_build_object('id', s.id, 'name', s.name)
        when later_claim.id is not null
          then jsonb_build_object('id', later_claim.id, 'name', later_claim.name)
        else null
      end
    ) order by s.start_at desc
  ), '[]'::jsonb)
  into season_rewards
  from public.samurai_seasons s
  left join public.samurai_season_reward_allocations a
    on a.season_id = s.id
   and a.wallet_id = v_canonical_wallet_id
   and a.allocation_version = s.allocation_version
   and s.reward_pool_status = 'FINALIZED'
  left join lateral (
    select
      sum(ss.eligible_points)::numeric(30, 6) as points,
      sum(ss.verified_volume)::numeric(30, 6) as volume,
      sum(ss.qualifying_swaps)::bigint as qualifying_swaps,
      min(ss.rank)::bigint as rank
    from public.samurai_season_leaderboard_snapshots ss
    where ss.season_id = s.id
      and ss.snapshot_version = coalesce(nullif(s.allocation_version, 0), 1)
      and ss.eligible_points > 0
      and (
        ss.canonical_wallet_id = v_canonical_wallet_id
        or (
          ss.canonical_wallet_id is null
          and ss.wallet_address = any(coalesce(wallet_addresses, array[]::text[]))
        )
      )
  ) snapshot_points on s.frozen_at is not null
  left join lateral (
    select
      sum(sp.final_points)::numeric(30, 6) as points,
      sum(sp.qualifying_volume_usd)::numeric(30, 6) as volume,
      count(*)::bigint as qualifying_swaps,
      coalesce(
        jsonb_agg(distinct jsonb_build_object(
          'id', sp.campaign_id,
          'name', coalesce(nullif(campaign.value->>'name', ''), sp.campaign_id)
        )) filter (where sp.campaign_id is not null),
        '[]'::jsonb
      ) as campaigns
    from public.samurai_points sp
    join public.swap_transactions st
      on st.signature = sp.signature
     and st.verification_status = 'verified'
    join public.wallets point_wallet
      on point_wallet.id = sp.wallet_id
     and coalesce(point_wallet.flag_status, '') <> 'EXCLUDED'
    left join lateral (
      select c.value
      from public.samurai_admin_settings settings
      cross join lateral jsonb_array_elements(coalesce(settings.campaigns, '[]'::jsonb)) c(value)
      where settings.id = 'default'
        and c.value->>'id' = sp.campaign_id
      limit 1
    ) campaign on true
    where sp.season_id = s.id
      and sp.wallet_address = any(coalesce(wallet_addresses, array[]::text[]))
      and sp.eligibility_status = 'qualified'
      and coalesce(sp.flag_status, '') <> 'EXCLUDED'
      and sp.final_points > 0
      and (
        canonical_wallet is null
        or not exists (
          select 1
          from public.wallets canonical
          where canonical.wallet_address = canonical_wallet
            and coalesce(canonical.flag_status, '') = 'EXCLUDED'
        )
      )
  ) live_points on true
  cross join lateral (
    select
      case
        when s.frozen_at is not null then coalesce(snapshot_points.points, 0)
        else coalesce(live_points.points, 0)
      end::numeric(30, 6) as samurai_points,
      case
        when s.frozen_at is not null then coalesce(snapshot_points.volume, 0)
        else coalesce(live_points.volume, 0)
      end::numeric(30, 6) as qualifying_volume,
      case
        when s.frozen_at is not null then coalesce(snapshot_points.qualifying_swaps, 0)
        else coalesce(live_points.qualifying_swaps, 0)
      end::bigint as qualifying_swaps,
      case
        when s.frozen_at is not null or live_points.points > 0 then 'qualified'
        else null
      end as eligibility_status,
      coalesce(live_points.campaigns, '[]'::jsonb) as campaigns
  ) participation
  left join lateral (
    select later_season.id, later_season.name
    from public.samurai_seasons later_season
    where later_season.start_at > s.start_at
      and later_season.reward_pool_status = 'FINALIZED'
      and now() >= later_season.claim_window_start
      and now() < later_season.claim_window_end
    order by later_season.start_at desc
    limit 1
  ) later_claim on true
  left join lateral (
    select jsonb_build_object(
      'claim_id', rc.claim_id,
      'status', rc.status,
      'reward_amount', case when rc.status = 'COMPLETED' then rc.reward_amount else null end,
      'reward_asset', rc.reward_asset,
      'claim_tx_signature', rc.claim_tx_signature,
      'created_at', rc.created_at,
      'completed_at', rc.completed_at
    ) as claim
    from public.reward_claims rc
    where rc.season_reward_allocation_id = a.id
    order by rc.created_at desc
    limit 1
  ) latest on true
  where s.reward_pool_status in ('CONFIGURED', 'FINALIZED')
    and participation.samurai_points > 0;

  select coalesce(sum(wpc.points_consumed), 0)
  into reserved_points
  from public.wallet_point_consumption wpc
  join public.wallets w on w.id = wpc.wallet_id
  where wpc.source = 'SEASON_REWARD_RESERVATION'
    and w.wallet_address = any(coalesce(wallet_addresses, array[]::text[]));

  return jsonb_build_object(
    'season_rewards', season_rewards,
    'reserved_points', reserved_points
  );
end;
$$;

revoke execute on function public.get_wallet_season_reward(text) from public, anon, authenticated;
grant execute on function public.get_wallet_season_reward(text) to service_role;

create table if not exists public.reward_viewer_auth_challenges (
  nonce text primary key,
  wallet_address text not null,
  message text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists reward_viewer_auth_challenges_expiry_idx
  on public.reward_viewer_auth_challenges(expires_at);

alter table public.reward_viewer_auth_challenges enable row level security;
revoke all on table public.reward_viewer_auth_challenges from public, anon, authenticated;
grant select, insert, update, delete on table public.reward_viewer_auth_challenges to service_role;

create or replace function public.consume_reward_viewer_auth_challenge(
  p_nonce text,
  p_wallet_address text
)
returns table(wallet_address text, message text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  challenge_row public.reward_viewer_auth_challenges;
begin
  update public.reward_viewer_auth_challenges challenge
  set used_at = clock_timestamp()
  where challenge.nonce = p_nonce
    and challenge.wallet_address = p_wallet_address
    and challenge.used_at is null
    and challenge.expires_at > clock_timestamp()
  returning challenge.* into challenge_row;

  if not found then
    raise exception 'REWARD_VIEWER_CHALLENGE_INVALID';
  end if;

  return query select challenge_row.wallet_address, challenge_row.message, challenge_row.expires_at;
end;
$$;

revoke execute on function public.consume_reward_viewer_auth_challenge(text, text) from public, anon, authenticated;
grant execute on function public.consume_reward_viewer_auth_challenge(text, text) to service_role;
