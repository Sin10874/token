-- ============================================================
-- Tokend V7 — dashboard timezone-aware shadow RPCs
-- Run manually in Supabase SQL Editor
--
-- WARNING:
-- This shadow migration targets an older "coding-only dashboard scope"
-- experiment. It is NOT the correct rollout artifact for the
-- 2026-04-14 internal-heartbeat visibility fix, which should exclude only
-- OpenClaw internal heartbeat rows while keeping user-visible OpenClaw
-- traffic such as Feishu / Hermes / real cron jobs.
--
-- Do not apply this file as-is for the heartbeat fix rollout.
-- ============================================================
--
-- Contract:
-- 1. New v3 RPCs are shadow-only in the first rollout. Do not replace
--    existing v2 callers until results are validated against real member data.
-- 2. Each v3 RPC accepts p_timezone TEXT. When it is missing or invalid,
--    the logic falls back to 'Asia/Shanghai' for backward-compatible buckets.
-- 3. Dashboard summary cards, message counts, model distribution, and daily
--    trend are filtered to coding channels only.
-- 4. Top conversations stay aligned with v2 for rollout stability.
-- ============================================================

DROP FUNCTION IF EXISTS tokend_get_summary_v3(text, text, text);
DROP FUNCTION IF EXISTS tokend_get_daily_trend_v3(text, text, text);

CREATE OR REPLACE FUNCTION tokend_get_summary_v3(
  p_token    TEXT,
  p_period   TEXT DEFAULT '7d',
  p_timezone TEXT DEFAULT 'Asia/Shanghai'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code       TEXT;
  v_timezone   TEXT := 'Asia/Shanghai';
  v_from_ms    BIGINT;
  v_prev_from  BIGINT;
  v_prev_to    BIGINT;
  v_cur        RECORD;
  v_prev       RECORD;
  v_cur_msg    RECORD;
  v_prev_msg   RECORD;
  v_models     JSONB;
  v_convos     JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT COALESCE((
    SELECT name
      FROM pg_timezone_names
     WHERE name = p_timezone
     LIMIT 1
  ), 'Asia/Shanghai')
  INTO v_timezone;

  IF p_period = '30d' THEN
    v_from_ms := (
      EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '29 days') AT TIME ZONE v_timezone)) * 1000
    )::BIGINT;
    v_prev_from := (
      EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '59 days') AT TIME ZONE v_timezone)) * 1000
    )::BIGINT;
    v_prev_to := v_from_ms;
  ELSIF p_period = '1d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
    v_prev_from := (EXTRACT(EPOCH FROM (now() - INTERVAL '48 hours')) * 1000)::BIGINT;
    v_prev_to := v_from_ms;
  ELSE
    v_from_ms := (
      EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '6 days') AT TIME ZONE v_timezone)) * 1000
    )::BIGINT;
    v_prev_from := (
      EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '13 days') AT TIME ZONE v_timezone)) * 1000
    )::BIGINT;
    v_prev_to := v_from_ms;
  END IF;

  SELECT
    COALESCE(SUM(total_tokens), 0)::BIGINT          AS total_tokens,
    COALESCE(SUM(total_cost), 0)::REAL              AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT          AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT         AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT     AS cache_read_tokens,
    COUNT(*)::INTEGER                               AS call_count,
    COUNT(DISTINCT session_id)::INTEGER             AS session_count,
    COUNT(DISTINCT channel)::INTEGER                AS channel_count
  INTO v_cur
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_from_ms
    AND channel IN ('claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'kimi-code', 'qwen-code');

  SELECT
    COALESCE(SUM(total_tokens), 0)::BIGINT          AS total_tokens,
    COALESCE(SUM(total_cost), 0)::REAL              AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT          AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT         AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT     AS cache_read_tokens,
    COUNT(*)::INTEGER                               AS call_count,
    COUNT(DISTINCT session_id)::INTEGER             AS session_count,
    COUNT(DISTINCT channel)::INTEGER                AS channel_count
  INTO v_prev
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND timestamp_ms < v_prev_to
    AND channel IN ('claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'kimi-code', 'qwen-code');

  SELECT
    COUNT(*)::INTEGER AS total_messages,
    COUNT(*) FILTER (WHERE kind = 'user')::INTEGER AS user_messages
  INTO v_cur_msg
  FROM tokend_message_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_from_ms
    AND channel IN ('claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'kimi-code', 'qwen-code');

  SELECT
    COUNT(*)::INTEGER AS total_messages,
    COUNT(*) FILTER (WHERE kind = 'user')::INTEGER AS user_messages
  INTO v_prev_msg
  FROM tokend_message_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND timestamp_ms < v_prev_to
    AND channel IN ('claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'kimi-code', 'qwen-code');

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('model', m.model, 'tokens', m.tokens)
    ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_models
  FROM (
    SELECT model, SUM(total_tokens)::BIGINT AS tokens
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND channel IN ('claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'kimi-code', 'qwen-code')
    GROUP BY model
    ORDER BY tokens DESC
    LIMIT 10
  ) m;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sessionId', c.session_id,
      'title',     COALESCE(NULLIF(c.project, ''), NULLIF(c.agent, ''), LEFT(c.session_id, 8)),
      'channel',   c.channel,
      'tokens',    c.tokens,
      'cost',      c.cost,
      'lastAt',    c.last_at
    ) ORDER BY c.tokens DESC
  ), '[]'::jsonb)
  INTO v_convos
  FROM (
    SELECT
      session_id,
      MAX(agent) AS agent,
      MAX(project) AS project,
      MAX(channel) AS channel,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens,
      (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS cost,
      MAX(timestamp_ms)::BIGINT AS last_at
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND channel != 'cron'
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 8
  ) c;

  RETURN json_build_object(
    'ok', true,
    'current', json_build_object(
      'totalTokens',      COALESCE(v_cur.total_tokens, 0),
      'totalCost',        COALESCE(v_cur.total_cost, 0),
      'inputTokens',      COALESCE(v_cur.input_tokens, 0),
      'outputTokens',     COALESCE(v_cur.output_tokens, 0),
      'cacheReadTokens',  COALESCE(v_cur.cache_read_tokens, 0),
      'callCount',        COALESCE(v_cur.call_count, 0),
      'sessionCount',     COALESCE(v_cur.session_count, 0),
      'channelCount',     COALESCE(v_cur.channel_count, 0),
      'messageCount',     CASE WHEN COALESCE(v_cur_msg.total_messages, 0) > 0 THEN v_cur_msg.total_messages ELSE COALESCE(v_cur.call_count, 0) END,
      'userMessageCount', CASE WHEN COALESCE(v_cur_msg.user_messages, 0) > 0 THEN v_cur_msg.user_messages ELSE NULL END
    ),
    'previous', json_build_object(
      'totalTokens',      COALESCE(v_prev.total_tokens, 0),
      'totalCost',        COALESCE(v_prev.total_cost, 0),
      'inputTokens',      COALESCE(v_prev.input_tokens, 0),
      'outputTokens',     COALESCE(v_prev.output_tokens, 0),
      'cacheReadTokens',  COALESCE(v_prev.cache_read_tokens, 0),
      'callCount',        COALESCE(v_prev.call_count, 0),
      'sessionCount',     COALESCE(v_prev.session_count, 0),
      'channelCount',     COALESCE(v_prev.channel_count, 0),
      'messageCount',     CASE WHEN COALESCE(v_prev_msg.total_messages, 0) > 0 THEN v_prev_msg.total_messages ELSE COALESCE(v_prev.call_count, 0) END,
      'userMessageCount', CASE WHEN COALESCE(v_prev_msg.user_messages, 0) > 0 THEN v_prev_msg.user_messages ELSE NULL END
    ),
    'modelDistribution', v_models,
    'topConversations',  v_convos
  );
END;
$$;

CREATE OR REPLACE FUNCTION tokend_get_daily_trend_v3(
  p_token    TEXT,
  p_period   TEXT DEFAULT '7d',
  p_timezone TEXT DEFAULT 'Asia/Shanghai'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code      TEXT;
  v_timezone  TEXT := 'Asia/Shanghai';
  v_from_ms   BIGINT;
  v_rows      JSONB;
  v_fmt       TEXT;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  SELECT COALESCE((
    SELECT name
      FROM pg_timezone_names
     WHERE name = p_timezone
     LIMIT 1
  ), 'Asia/Shanghai')
  INTO v_timezone;

  IF p_period = '30d' THEN
    v_from_ms := (
      EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '29 days') AT TIME ZONE v_timezone)) * 1000
    )::BIGINT;
  ELSIF p_period = '1d' THEN
    v_from_ms := (EXTRACT(EPOCH FROM (now() - INTERVAL '24 hours')) * 1000)::BIGINT;
  ELSE
    v_from_ms := (
      EXTRACT(EPOCH FROM ((date_trunc('day', timezone(v_timezone, now())) - INTERVAL '6 days') AT TIME ZONE v_timezone)) * 1000
    )::BIGINT;
  END IF;

  v_fmt := CASE WHEN p_period = '1d' THEN 'YYYY-MM-DD HH24:00' ELSE 'YYYY-MM-DD' END;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'day',          d.day,
      'tokens',       d.tokens,
      'cost',         d.cost,
      'calls',        d.calls,
      'sessions',     d.sessions,
      'inputTokens',  d.input_tokens,
      'outputTokens', d.output_tokens,
      'inputCost',    d.input_cost,
      'outputCost',   d.output_cost
    ) ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      TO_CHAR(timezone(v_timezone, TO_TIMESTAMP(timestamp_ms / 1000.0)), v_fmt) AS day,
      SUM(total_tokens)::BIGINT AS tokens,
      SUM(total_cost)::REAL AS cost,
      COUNT(*)::INTEGER AS calls,
      COUNT(DISTINCT session_id)::INTEGER AS sessions,
      SUM(input_tokens)::BIGINT AS input_tokens,
      SUM(output_tokens)::BIGINT AS output_tokens,
      SUM(input_cost)::REAL AS input_cost,
      SUM(output_cost)::REAL AS output_cost
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND channel IN ('claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'kimi-code', 'qwen-code')
    GROUP BY 1
  ) d;

  RETURN json_build_object('ok', true, 'days', v_rows);
END;
$$;
