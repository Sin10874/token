-- ============================================================
-- Tokend V8 - heartbeat-aware dashboard shadow RPCs
-- Run manually in Supabase SQL Editor
--
-- Goal:
-- Exclude only OpenClaw internal heartbeat rows while keeping
-- user-visible OpenClaw traffic such as Feishu / Hermes / real cron jobs.
--
-- Scope:
-- 1. Add helper predicates for internal-heartbeat visibility
-- 2. Add heartbeat-aware shadow RPCs for dashboard, projects, and channels
-- 3. Preserve existing v2/v3 functions for safe rollback
-- ============================================================

DROP FUNCTION IF EXISTS tokend_get_summary_v4(text, text, text);
DROP FUNCTION IF EXISTS tokend_get_daily_trend_v4(text, text, text);
DROP FUNCTION IF EXISTS tokend_get_top_projects_v2(text, text);
DROP FUNCTION IF EXISTS tokend_get_channel_breakdown_v3(text, text);
DROP FUNCTION IF EXISTS tokend_get_channel_detail_v2(text, text, text, text);
DROP FUNCTION IF EXISTS tokend_is_user_visible_usage(text, text);
DROP FUNCTION IF EXISTS tokend_is_internal_heartbeat(text, text);

CREATE OR REPLACE FUNCTION tokend_is_internal_heartbeat(
  p_channel TEXT,
  p_session_key TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(p_channel, '') = 'cron' AND COALESCE(p_session_key, '') = ''
$$;

CREATE OR REPLACE FUNCTION tokend_is_user_visible_usage(
  p_channel TEXT,
  p_session_key TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    COALESCE(p_channel, '') NOT IN ('', 'unknown')
    AND NOT tokend_is_internal_heartbeat(p_channel, p_session_key)
$$;

CREATE OR REPLACE FUNCTION tokend_get_summary_v4(
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
    (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS total_tokens,
    (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
    COUNT(*)::INTEGER AS call_count,
    COUNT(DISTINCT session_id)::INTEGER AS session_count,
    COUNT(DISTINCT channel)::INTEGER AS channel_count
  INTO v_cur
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_from_ms
    AND tokend_is_user_visible_usage(channel, session_key);

  SELECT
    (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS total_tokens,
    (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
    COUNT(*)::INTEGER AS call_count,
    COUNT(DISTINCT session_id)::INTEGER AS session_count,
    COUNT(DISTINCT channel)::INTEGER AS channel_count
  INTO v_prev
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND timestamp_ms < v_prev_to
    AND tokend_is_user_visible_usage(channel, session_key);

  SELECT
    COUNT(*) FILTER (WHERE m.kind IN ('user', 'assistant'))::INTEGER AS total_messages,
    COUNT(*) FILTER (WHERE m.kind = 'user')::INTEGER AS user_messages
  INTO v_cur_msg
  FROM tokend_message_events m
  WHERE m.member_code = v_code
    AND m.timestamp_ms >= v_from_ms
    AND COALESCE(m.channel, '') NOT IN ('', 'unknown')
    AND EXISTS (
      SELECT 1
      FROM tokend_usage_events u
      WHERE u.member_code = m.member_code
        AND u.session_id = m.session_id
        AND tokend_is_user_visible_usage(u.channel, u.session_key)
    );

  SELECT
    COUNT(*) FILTER (WHERE m.kind IN ('user', 'assistant'))::INTEGER AS total_messages,
    COUNT(*) FILTER (WHERE m.kind = 'user')::INTEGER AS user_messages
  INTO v_prev_msg
  FROM tokend_message_events m
  WHERE m.member_code = v_code
    AND m.timestamp_ms >= v_prev_from
    AND m.timestamp_ms < v_prev_to
    AND COALESCE(m.channel, '') NOT IN ('', 'unknown')
    AND EXISTS (
      SELECT 1
      FROM tokend_usage_events u
      WHERE u.member_code = m.member_code
        AND u.session_id = m.session_id
        AND tokend_is_user_visible_usage(u.channel, u.session_key)
    );

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('model', m.model, 'tokens', m.tokens)
    ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_models
  FROM (
    SELECT
      model,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND tokend_is_user_visible_usage(channel, session_key)
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
      AND tokend_is_user_visible_usage(channel, session_key)
    GROUP BY session_id
    ORDER BY tokens DESC, cost DESC
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

CREATE OR REPLACE FUNCTION tokend_get_daily_trend_v4(
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
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens,
      (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS cost,
      COUNT(*)::INTEGER AS calls,
      COUNT(DISTINCT session_id)::INTEGER AS sessions,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(input_cost), 0)::REAL AS input_cost,
      COALESCE(SUM(output_cost), 0)::REAL AS output_cost
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND tokend_is_user_visible_usage(channel, session_key)
    GROUP BY 1
  ) d;

  RETURN json_build_object('ok', true, 'days', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION tokend_get_top_projects_v2(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_rows    JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'project',  p.agent_name,
      'channel',  p.channel,
      'tokens',   p.tokens,
      'cost',     p.cost,
      'calls',    p.calls,
      'sessions', p.sessions,
      'lastAt',   p.last_at
    ) ORDER BY p.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) AS agent_name,
      channel,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens,
      (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS cost,
      COUNT(*)::INTEGER AS calls,
      COUNT(DISTINCT session_id)::INTEGER AS sessions,
      MAX(timestamp_ms)::BIGINT AS last_at
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND tokend_is_user_visible_usage(channel, session_key)
      AND COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) IS NOT NULL
      AND COALESCE(NULLIF(TRIM(agent), ''), NULLIF(TRIM(project), '')) NOT IN ('unknown', '~', '')
    GROUP BY channel, agent_name
    ORDER BY tokens DESC, cost DESC
    LIMIT 8
  ) p;

  RETURN json_build_object('ok', true, 'projects', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION tokend_get_channel_breakdown_v3(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_days    INTEGER;
  v_from_ms BIGINT;
  v_rows    JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  v_days := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'channel',          c.channel,
      'tokens',           c.tokens,
      'cost',             c.cost,
      'calls',            c.calls,
      'sessions',         c.sessions,
      'inputTokens',      c.input_tokens,
      'outputTokens',     c.output_tokens,
      'cacheReadTokens',  c.cache_read_tokens,
      'messageCount',     COALESCE(c.msg_count, c.calls),
      'userMessageCount', c.user_msg_count,
      'lastSeen',         c.last_seen
    ) ORDER BY c.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      u.channel,
      (COALESCE(SUM(u.input_tokens), 0) + COALESCE(SUM(u.output_tokens), 0))::BIGINT AS tokens,
      (COALESCE(SUM(u.input_cost), 0) + COALESCE(SUM(u.output_cost), 0) + COALESCE(SUM(u.cache_read_cost), 0))::REAL AS cost,
      COUNT(*)::INTEGER AS calls,
      COUNT(DISTINCT u.session_id)::INTEGER AS sessions,
      COALESCE(SUM(u.input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(u.cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      MAX(u.timestamp_ms)::BIGINT AS last_seen,
      (
        SELECT COUNT(*)::INTEGER
        FROM tokend_message_events m
        WHERE m.member_code = v_code
          AND m.channel = u.channel
          AND m.timestamp_ms >= v_from_ms
          AND EXISTS (
            SELECT 1
            FROM tokend_usage_events ux
            WHERE ux.member_code = m.member_code
              AND ux.session_id = m.session_id
              AND ux.channel = m.channel
              AND ux.timestamp_ms >= v_from_ms
              AND tokend_is_user_visible_usage(ux.channel, ux.session_key)
          )
      ) AS msg_count,
      (
        SELECT COUNT(*)::INTEGER
        FROM tokend_message_events m
        WHERE m.member_code = v_code
          AND m.channel = u.channel
          AND m.timestamp_ms >= v_from_ms
          AND m.kind = 'user'
          AND EXISTS (
            SELECT 1
            FROM tokend_usage_events ux
            WHERE ux.member_code = m.member_code
              AND ux.session_id = m.session_id
              AND ux.channel = m.channel
              AND ux.timestamp_ms >= v_from_ms
              AND tokend_is_user_visible_usage(ux.channel, ux.session_key)
          )
      ) AS user_msg_count
    FROM tokend_usage_events u
    WHERE u.member_code = v_code
      AND u.timestamp_ms >= v_from_ms
      AND tokend_is_user_visible_usage(u.channel, u.session_key)
    GROUP BY u.channel
    ORDER BY tokens DESC
  ) c;

  RETURN json_build_object('ok', true, 'channels', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION tokend_get_channel_detail_v2(
  p_token    TEXT,
  p_channel  TEXT,
  p_period   TEXT DEFAULT '7d',
  p_timezone TEXT DEFAULT 'Asia/Shanghai'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code     TEXT;
  v_days     INTEGER;
  v_from_ms  BIGINT;
  v_fmt      TEXT;
  v_timezone TEXT := 'Asia/Shanghai';
  v_summary  RECORD;
  v_trend    JSONB;
  v_mix      JSONB;
  v_sessions JSONB;
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

  v_days := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;
  v_from_ms := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;
  v_fmt := CASE WHEN p_period = '1d' THEN 'YYYY-MM-DD HH24:00' ELSE 'YYYY-MM-DD' END;

  SELECT
    (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS total_tokens,
    (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS total_cost,
    COUNT(*)::INTEGER AS call_count,
    COUNT(DISTINCT session_id)::INTEGER AS session_count
  INTO v_summary
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND channel = p_channel
    AND timestamp_ms >= v_from_ms
    AND (p_channel != 'cron' OR tokend_is_user_visible_usage(channel, session_key));

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'day',          d.day,
      'tokens',       d.tokens,
      'cost',         d.cost,
      'inputTokens',  d.input_tokens,
      'outputTokens', d.output_tokens,
      'inputCost',    d.input_cost,
      'outputCost',   d.output_cost
    )
    ORDER BY d.day
  ), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT
      TO_CHAR(timezone(v_timezone, TO_TIMESTAMP(timestamp_ms / 1000.0)), v_fmt) AS day,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens,
      (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS cost,
      COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
      COALESCE(SUM(input_cost), 0)::REAL AS input_cost,
      COALESCE(SUM(output_cost), 0)::REAL AS output_cost
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND channel = p_channel
      AND timestamp_ms >= v_from_ms
      AND (p_channel != 'cron' OR tokend_is_user_visible_usage(channel, session_key))
    GROUP BY 1
  ) d;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('model', m.model, 'calls', m.calls, 'tokens', m.tokens)
    ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_mix
  FROM (
    SELECT
      model,
      COUNT(*)::INTEGER AS calls,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND channel = p_channel
      AND timestamp_ms >= v_from_ms
      AND (p_channel != 'cron' OR tokend_is_user_visible_usage(channel, session_key))
    GROUP BY model
  ) m;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sessionId',    s.session_id,
      'agent',        s.agent,
      'channel',      p_channel,
      'currentModel', s.current_model,
      'firstSeenAt',  s.first_seen,
      'lastSeenAt',   s.last_seen,
      'callCount',    s.calls,
      'totalTokens',  s.tokens,
      'totalCost',    s.cost
    ) ORDER BY s.tokens DESC
  ), '[]'::jsonb)
  INTO v_sessions
  FROM (
    SELECT
      session_id,
      MAX(agent) AS agent,
      MAX(model) AS current_model,
      MIN(timestamp_ms)::BIGINT AS first_seen,
      MAX(timestamp_ms)::BIGINT AS last_seen,
      COUNT(*)::INTEGER AS calls,
      (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::BIGINT AS tokens,
      (COALESCE(SUM(input_cost), 0) + COALESCE(SUM(output_cost), 0) + COALESCE(SUM(cache_read_cost), 0))::REAL AS cost
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND channel = p_channel
      AND timestamp_ms >= v_from_ms
      AND (p_channel != 'cron' OR tokend_is_user_visible_usage(channel, session_key))
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 20
  ) s;

  RETURN json_build_object(
    'ok', true,
    'summary', json_build_object(
      'channel',      p_channel,
      'totalTokens',  COALESCE(v_summary.total_tokens, 0),
      'totalCost',    COALESCE(v_summary.total_cost, 0),
      'callCount',    COALESCE(v_summary.call_count, 0),
      'sessionCount', COALESCE(v_summary.session_count, 0)
    ),
    'dailyTrend',  v_trend,
    'modelMix',    v_mix,
    'topSessions', v_sessions
  );
END;
$$;
