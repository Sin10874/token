-- ============================================================
-- Tokend V3 Patch — project field + message events + fixes
-- Run in Supabase SQL Editor (single shot, idempotent)
-- ============================================================

-- ============================================================
-- 1. Add project column to tokend_usage_events
-- ============================================================
ALTER TABLE tokend_usage_events ADD COLUMN IF NOT EXISTS project TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_events_project
  ON tokend_usage_events (member_code, project)
  WHERE project IS NOT NULL;

-- ============================================================
-- 2. Create tokend_message_events table
-- ============================================================
CREATE TABLE IF NOT EXISTS tokend_message_events (
  id              TEXT        NOT NULL,
  member_code     TEXT        NOT NULL
                    REFERENCES tokend_members(member_code),
  timestamp_ms    BIGINT      NOT NULL,
  session_id      TEXT        NOT NULL,
  agent           TEXT,
  channel         TEXT        DEFAULT 'unknown',
  kind            TEXT        NOT NULL,  -- user, assistant, tool_call, tool_result
  uploaded_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id, member_code)
);

ALTER TABLE tokend_message_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_message_events_member_ts
  ON tokend_message_events (member_code, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_message_events_member_session
  ON tokend_message_events (member_code, session_id);

-- ============================================================
-- 3. Updated tokend_upload_events — now handles project field
-- ============================================================
CREATE OR REPLACE FUNCTION tokend_upload_events(
  p_token       TEXT,
  p_events      JSONB,
  p_sync_states JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_evt     JSONB;
  v_ss      JSONB;
  v_count   INTEGER := 0;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events)
  LOOP
    INSERT INTO tokend_usage_events (
      id, member_code, timestamp_ms, session_id, session_key,
      agent, provider, model, channel,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, reasoning_cost,
      cache_read_cost, cache_write_cost, total_cost,
      stop_reason, project
    ) VALUES (
      v_evt->>'id',
      v_code,
      (v_evt->>'timestampMs')::BIGINT,
      v_evt->>'sessionId',
      v_evt->>'sessionKey',
      v_evt->>'agent',
      v_evt->>'provider',
      v_evt->>'model',
      COALESCE(v_evt->>'channel', 'unknown'),
      COALESCE((v_evt->>'inputTokens')::INTEGER, 0),
      COALESCE((v_evt->>'outputTokens')::INTEGER, 0),
      COALESCE((v_evt->>'reasoningTokens')::INTEGER, 0),
      COALESCE((v_evt->>'cacheReadTokens')::INTEGER, 0),
      COALESCE((v_evt->>'cacheWriteTokens')::INTEGER, 0),
      COALESCE((v_evt->>'totalTokens')::INTEGER, 0),
      COALESCE((v_evt->>'inputCost')::REAL, 0),
      COALESCE((v_evt->>'outputCost')::REAL, 0),
      COALESCE((v_evt->>'reasoningCost')::REAL, 0),
      COALESCE((v_evt->>'cacheReadCost')::REAL, 0),
      COALESCE((v_evt->>'cacheWriteCost')::REAL, 0),
      COALESCE((v_evt->>'totalCost')::REAL, 0),
      v_evt->>'stopReason',
      v_evt->>'project'
    )
    ON CONFLICT (id, member_code) DO UPDATE SET
      project = COALESCE(EXCLUDED.project, tokend_usage_events.project);

    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  FOR v_ss IN SELECT * FROM jsonb_array_elements(p_sync_states)
  LOOP
    INSERT INTO tokend_sync_state (
      member_code, source_path_hash, last_processed_lines,
      parser_version, last_sync_at
    ) VALUES (
      v_code,
      v_ss->>'sourcePathHash',
      COALESCE((v_ss->>'lastProcessedLines')::INTEGER, 0),
      COALESCE((v_ss->>'parserVersion')::INTEGER, 1),
      now()
    )
    ON CONFLICT (member_code, source_path_hash)
    DO UPDATE SET
      last_processed_lines = COALESCE((v_ss->>'lastProcessedLines')::INTEGER, 0),
      parser_version       = COALESCE((v_ss->>'parserVersion')::INTEGER, 1),
      last_sync_at         = now();
  END LOOP;

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;

-- ============================================================
-- 4. tokend_upload_messages — new RPC for message events
-- ============================================================
CREATE OR REPLACE FUNCTION tokend_upload_messages(
  p_token    TEXT,
  p_messages JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code  TEXT;
  v_msg   JSONB;
  v_count INTEGER := 0;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  FOR v_msg IN SELECT * FROM jsonb_array_elements(p_messages)
  LOOP
    INSERT INTO tokend_message_events (
      id, member_code, timestamp_ms, session_id,
      agent, channel, kind
    ) VALUES (
      v_msg->>'id',
      v_code,
      (v_msg->>'timestampMs')::BIGINT,
      v_msg->>'sessionId',
      v_msg->>'agent',
      COALESCE(v_msg->>'channel', 'unknown'),
      v_msg->>'kind'
    )
    ON CONFLICT (id, member_code) DO NOTHING;

    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;

-- ============================================================
-- 5. Updated tokend_rebuild_sessions — set title from project
-- ============================================================
CREATE OR REPLACE FUNCTION tokend_rebuild_sessions(
  p_token       TEXT,
  p_session_ids TEXT[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code    TEXT;
  v_sid     TEXT;
  v_count   INTEGER := 0;
  v_agg     RECORD;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  FOREACH v_sid IN ARRAY p_session_ids
  LOOP
    SELECT
      MIN(e.timestamp_ms)   AS first_seen_at,
      MAX(e.timestamp_ms)   AS last_seen_at,
      COUNT(*)::INTEGER      AS call_count,
      SUM(e.total_tokens)::INTEGER AS total_tokens,
      SUM(e.total_cost)::REAL      AS total_cost,
      (ARRAY_AGG(e.model ORDER BY e.timestamp_ms DESC))[1]       AS current_model,
      (ARRAY_AGG(e.agent ORDER BY e.timestamp_ms DESC))[1]       AS agent,
      (ARRAY_AGG(e.channel ORDER BY e.timestamp_ms DESC))[1]     AS channel,
      (ARRAY_AGG(e.session_key ORDER BY e.timestamp_ms DESC))[1] AS session_key,
      (ARRAY_AGG(e.project ORDER BY e.timestamp_ms DESC) FILTER (WHERE e.project IS NOT NULL))[1] AS project
    INTO v_agg
    FROM tokend_usage_events e
    WHERE e.member_code = v_code
      AND e.session_id  = v_sid;

    IF v_agg.call_count IS NULL OR v_agg.call_count = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO tokend_sessions (
      session_id, member_code, session_key, agent, title, channel,
      first_seen_at, last_seen_at, current_model,
      call_count, total_tokens, total_cost, updated_at
    ) VALUES (
      v_sid, v_code, v_agg.session_key, v_agg.agent,
      v_agg.project,
      v_agg.channel,
      v_agg.first_seen_at, v_agg.last_seen_at, v_agg.current_model,
      v_agg.call_count, v_agg.total_tokens, v_agg.total_cost, now()
    )
    ON CONFLICT (session_id, member_code)
    DO UPDATE SET
      session_key   = EXCLUDED.session_key,
      agent         = EXCLUDED.agent,
      title         = COALESCE(EXCLUDED.title, tokend_sessions.title),
      channel       = EXCLUDED.channel,
      first_seen_at = EXCLUDED.first_seen_at,
      last_seen_at  = EXCLUDED.last_seen_at,
      current_model = EXCLUDED.current_model,
      call_count    = EXCLUDED.call_count,
      total_tokens  = EXCLUDED.total_tokens,
      total_cost    = EXCLUDED.total_cost,
      updated_at    = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('ok', true, 'sessions_updated', v_count);
END;
$$;

-- ============================================================
-- 6. tokend_get_top_projects — new RPC
-- ============================================================
CREATE OR REPLACE FUNCTION tokend_get_top_projects(
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
      'project',  p.project,
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
      project,
      MAX(channel)                            AS channel,
      SUM(total_tokens)::BIGINT              AS tokens,
      SUM(total_cost)::REAL                  AS cost,
      COUNT(*)::INTEGER                      AS calls,
      COUNT(DISTINCT session_id)::INTEGER    AS sessions,
      MAX(timestamp_ms)::BIGINT              AS last_at
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND timestamp_ms >= v_from_ms
      AND project IS NOT NULL
    GROUP BY project
    ORDER BY tokens DESC
    LIMIT 20
  ) p;

  RETURN json_build_object('ok', true, 'projects', v_rows);
END;
$$;

-- ============================================================
-- 7. Updated tokend_get_summary_v2 — real message counts
-- ============================================================
CREATE OR REPLACE FUNCTION tokend_get_summary_v2(
  p_token  TEXT,
  p_period TEXT DEFAULT '7d'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code       TEXT;
  v_days       INTEGER;
  v_from_ms    BIGINT;
  v_prev_from  BIGINT;
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

  v_days := CASE p_period
    WHEN '1d'  THEN 1
    WHEN '7d'  THEN 7
    WHEN '30d' THEN 30
    ELSE 7
  END;

  v_from_ms   := (EXTRACT(EPOCH FROM (now() - (v_days || ' days')::INTERVAL)) * 1000)::BIGINT;
  v_prev_from := (EXTRACT(EPOCH FROM (now() - (v_days * 2 || ' days')::INTERVAL)) * 1000)::BIGINT;

  -- current period usage
  SELECT
    COALESCE(SUM(total_tokens), 0)::BIGINT         AS total_tokens,
    COALESCE(SUM(total_cost), 0)::REAL              AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT          AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT         AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT     AS cache_read_tokens,
    COUNT(*)::INTEGER                                AS call_count,
    COUNT(DISTINCT session_id)::INTEGER              AS session_count,
    COUNT(DISTINCT channel)::INTEGER                 AS channel_count
  INTO v_cur
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_from_ms;

  -- previous period usage
  SELECT
    COALESCE(SUM(total_tokens), 0)::BIGINT          AS total_tokens,
    COALESCE(SUM(total_cost), 0)::REAL               AS total_cost,
    COALESCE(SUM(input_tokens), 0)::BIGINT           AS input_tokens,
    COALESCE(SUM(output_tokens), 0)::BIGINT          AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0)::BIGINT      AS cache_read_tokens,
    COUNT(*)::INTEGER                                 AS call_count,
    COUNT(DISTINCT session_id)::INTEGER               AS session_count,
    COUNT(DISTINCT channel)::INTEGER                  AS channel_count
  INTO v_prev
  FROM tokend_usage_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND timestamp_ms <  v_from_ms;

  -- current period messages
  SELECT
    COUNT(*)::INTEGER AS total_messages,
    COUNT(*) FILTER (WHERE kind = 'user')::INTEGER AS user_messages
  INTO v_cur_msg
  FROM tokend_message_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_from_ms;

  -- previous period messages
  SELECT
    COUNT(*)::INTEGER AS total_messages,
    COUNT(*) FILTER (WHERE kind = 'user')::INTEGER AS user_messages
  INTO v_prev_msg
  FROM tokend_message_events
  WHERE member_code = v_code
    AND timestamp_ms >= v_prev_from
    AND timestamp_ms <  v_from_ms;

  -- model distribution
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('model', m.model, 'tokens', m.tokens)
    ORDER BY m.tokens DESC
  ), '[]'::jsonb)
  INTO v_models
  FROM (
    SELECT model, SUM(total_tokens)::BIGINT AS tokens
    FROM tokend_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
    GROUP BY model
    ORDER BY tokens DESC
    LIMIT 10
  ) m;

  -- top conversations (use project as title, fallback to agent)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sessionId', c.session_id,
      'title',     COALESCE(c.project, c.agent, 'unknown'),
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
      SUM(total_tokens)::BIGINT AS tokens,
      SUM(total_cost)::REAL AS cost,
      MAX(timestamp_ms)::BIGINT AS last_at
    FROM tokend_usage_events
    WHERE member_code = v_code AND timestamp_ms >= v_from_ms
    GROUP BY session_id
    ORDER BY tokens DESC
    LIMIT 10
  ) c;

  RETURN json_build_object(
    'ok', true,
    'current', json_build_object(
      'totalTokens',      v_cur.total_tokens,
      'totalCost',        v_cur.total_cost,
      'inputTokens',      v_cur.input_tokens,
      'outputTokens',     v_cur.output_tokens,
      'cacheReadTokens',  v_cur.cache_read_tokens,
      'callCount',        v_cur.call_count,
      'sessionCount',     v_cur.session_count,
      'channelCount',     v_cur.channel_count,
      'messageCount',     CASE WHEN v_cur_msg.total_messages > 0 THEN v_cur_msg.total_messages ELSE v_cur.call_count END,
      'userMessageCount', CASE WHEN v_cur_msg.user_messages > 0 THEN v_cur_msg.user_messages ELSE NULL END
    ),
    'previous', json_build_object(
      'totalTokens',      v_prev.total_tokens,
      'totalCost',        v_prev.total_cost,
      'inputTokens',      v_prev.input_tokens,
      'outputTokens',     v_prev.output_tokens,
      'cacheReadTokens',  v_prev.cache_read_tokens,
      'callCount',        v_prev.call_count,
      'sessionCount',     v_prev.session_count,
      'channelCount',     v_prev.channel_count,
      'messageCount',     CASE WHEN v_prev_msg.total_messages > 0 THEN v_prev_msg.total_messages ELSE v_prev.call_count END,
      'userMessageCount', CASE WHEN v_prev_msg.user_messages > 0 THEN v_prev_msg.user_messages ELSE NULL END
    ),
    'modelDistribution', v_models,
    'topConversations',  v_convos
  );
END;
$$;

-- ============================================================
-- 8. Updated tokend_get_channel_breakdown_v2 — real message counts
-- ============================================================
CREATE OR REPLACE FUNCTION tokend_get_channel_breakdown_v2(
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
      'channel',      c.channel,
      'tokens',       c.tokens,
      'cost',         c.cost,
      'calls',        c.calls,
      'sessions',     c.sessions,
      'inputTokens',  c.input_tokens,
      'outputTokens', c.output_tokens,
      'messageCount', COALESCE(c.msg_count, c.calls),
      'lastSeen',     c.last_seen
    ) ORDER BY c.tokens DESC
  ), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      u.channel,
      SUM(u.total_tokens)::BIGINT              AS tokens,
      SUM(u.total_cost)::REAL                  AS cost,
      COUNT(*)::INTEGER                        AS calls,
      COUNT(DISTINCT u.session_id)::INTEGER    AS sessions,
      SUM(u.input_tokens)::BIGINT              AS input_tokens,
      SUM(u.output_tokens)::BIGINT             AS output_tokens,
      MAX(u.timestamp_ms)::BIGINT              AS last_seen,
      (SELECT COUNT(*)::INTEGER FROM tokend_message_events m
       WHERE m.member_code = v_code
         AND m.channel = u.channel
         AND m.timestamp_ms >= v_from_ms) AS msg_count
    FROM tokend_usage_events u
    WHERE u.member_code = v_code
      AND u.timestamp_ms >= v_from_ms
    GROUP BY u.channel
    ORDER BY tokens DESC
  ) c;

  RETURN json_build_object('ok', true, 'channels', v_rows);
END;
$$;

-- ============================================================
-- Done. Run CLI re-sync after applying this patch:
--   DELETE FROM tokend_sync_state WHERE member_code = 'YOUR_CODE';
--   Then run: npx tokend-cli
-- ============================================================
