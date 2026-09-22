create table if not exists public.api_rate_limits (
  bucket text not null,
  identity text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  primary key (bucket, identity)
);

alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.api_rate_limits to service_role;

create or replace function public.consume_api_rate_limit(
  p_bucket text,
  p_identity text,
  p_max_requests integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.api_rate_limits;
  now_value timestamptz := now();
begin
  if length(coalesce(p_bucket, '')) = 0 or length(coalesce(p_identity, '')) = 0
    or p_max_requests < 1 or p_window_seconds < 1 then
    return false;
  end if;

  insert into public.api_rate_limits(bucket, identity, window_started_at, request_count)
  values (p_bucket, p_identity, now_value, 1)
  on conflict (bucket, identity) do update
    set window_started_at = case
          when public.api_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now_value then now_value
          else public.api_rate_limits.window_started_at
        end,
        request_count = case
          when public.api_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now_value then 1
          else public.api_rate_limits.request_count + 1
        end
  returning * into current_row;

  return current_row.request_count <= p_max_requests;
end;
$$;

revoke execute on function public.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer) to service_role;
