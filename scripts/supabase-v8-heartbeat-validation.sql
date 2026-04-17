-- ============================================================
-- Tokend V8 - heartbeat visibility validation helper
-- Paste into Supabase SQL Editor after applying:
--   scripts/supabase-v8-heartbeat-visibility.sql
--
-- Validation target:
--   member_code = 'TEST001'
-- ============================================================

-- 1. Confirm v4 functions exist
select proname
from pg_proc
where proname in (
  'tokend_is_internal_heartbeat',
  'tokend_is_user_visible_usage',
  'tokend_get_summary_v4',
  'tokend_get_daily_trend_v4',
  'tokend_get_top_projects_v2',
  'tokend_get_channel_breakdown_v3',
  'tokend_get_channel_detail_v2'
)
order by proname;

-- 2. Compare dashboard summary: v2 vs v4 (1d)
with target as (
  select token
  from tokend_members
  where member_code = 'TEST001'
  limit 1
)
select
  tokend_get_summary_v2((select token from target), '1d') as summary_v2,
  tokend_get_summary_v4((select token from target), '1d', 'Asia/Shanghai') as summary_v4;

-- 3. Compare dashboard summary: v2 vs v4 (7d)
with target as (
  select token
  from tokend_members
  where member_code = 'TEST001'
  limit 1
)
select
  tokend_get_summary_v2((select token from target), '7d') as summary_v2,
  tokend_get_summary_v4((select token from target), '7d', 'Asia/Shanghai') as summary_v4;

-- 4. Compare trend payload: v2 vs v4 (1d)
with target as (
  select token
  from tokend_members
  where member_code = 'TEST001'
  limit 1
)
select
  tokend_get_daily_trend_v2((select token from target), '1d') as trend_v2,
  tokend_get_daily_trend_v4((select token from target), '1d', 'Asia/Shanghai') as trend_v4;

-- 5. Compare trend payload: v2 vs v4 (7d)
with target as (
  select token
  from tokend_members
  where member_code = 'TEST001'
  limit 1
)
select
  tokend_get_daily_trend_v2((select token from target), '7d') as trend_v2,
  tokend_get_daily_trend_v4((select token from target), '7d', 'Asia/Shanghai') as trend_v4;

-- 6. Compare top projects: old vs heartbeat-aware
with target as (
  select token
  from tokend_members
  where member_code = 'TEST001'
  limit 1
)
select
  tokend_get_top_projects((select token from target), '7d') as projects_v1,
  tokend_get_top_projects_v2((select token from target), '7d') as projects_v2;

-- 7. Compare channel breakdown: old vs heartbeat-aware
with target as (
  select token
  from tokend_members
  where member_code = 'TEST001'
  limit 1
)
select
  tokend_get_channel_breakdown_v2((select token from target), '7d') as channels_v2,
  tokend_get_channel_breakdown_v3((select token from target), '7d') as channels_v3;

-- 8. Compare cron detail: old vs heartbeat-aware
with target as (
  select token
  from tokend_members
  where member_code = 'TEST001'
  limit 1
)
select
  tokend_get_channel_detail((select token from target), 'cron', '7d') as cron_v1,
  tokend_get_channel_detail_v2((select token from target), 'cron', '7d', 'Asia/Shanghai') as cron_v2;

-- 9. Inspect cron rows directly
select
  channel,
  session_key,
  project,
  agent,
  input_tokens,
  output_tokens,
  cache_read_tokens,
  total_tokens,
  total_cost,
  to_char(timezone('Asia/Shanghai', to_timestamp(timestamp_ms / 1000.0)), 'YYYY-MM-DD HH24:MI') as sh_time
from tokend_usage_events
where member_code = 'TEST001'
  and timestamp_ms >= (extract(epoch from (now() - interval '7 days')) * 1000)::bigint
  and channel = 'cron'
order by timestamp_ms desc
limit 200;

-- 10. Quantify heartbeat-only reduction for recent windows
with heartbeat as (
  select
    case
      when timestamp_ms >= (extract(epoch from (now() - interval '24 hours')) * 1000)::bigint then '1d'
      when timestamp_ms >= (extract(epoch from (now() - interval '7 days')) * 1000)::bigint then '7d'
      else null
    end as period,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    input_cost,
    output_cost,
    cache_read_cost
  from tokend_usage_events
  where member_code = 'TEST001'
    and channel = 'cron'
    and coalesce(session_key, '') = ''
    and timestamp_ms >= (extract(epoch from (now() - interval '7 days')) * 1000)::bigint
)
select
  period,
  (coalesce(sum(input_tokens), 0) + coalesce(sum(output_tokens), 0))::bigint as active_tokens,
  coalesce(sum(cache_read_tokens), 0)::bigint as cache_read_tokens,
  (coalesce(sum(input_cost), 0) + coalesce(sum(output_cost), 0) + coalesce(sum(cache_read_cost), 0))::real as estimated_cost_reduction
from heartbeat
where period is not null
group by period
order by period;
