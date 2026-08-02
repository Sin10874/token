-- ============================================================
-- Tokend V3 batch performance fix
-- Replaces row-by-row loops with bulk INSERT ... SELECT
-- ============================================================

-- 1. tokend_upload_events — bulk insert
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
  v_code  TEXT;
  v_count INTEGER;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  -- Bulk insert events
  WITH ins AS (
    INSERT INTO tokend_usage_events (
      id, member_code, timestamp_ms, session_id, session_key,
      agent, provider, model, channel,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, reasoning_cost,
      cache_read_cost, cache_write_cost, total_cost,
      stop_reason, project
    )
    SELECT
      x->>'id',
      v_code,
      (x->>'timestampMs')::BIGINT,
      x->>'sessionId',
      x->>'sessionKey',
      x->>'agent',
      x->>'provider',
      x->>'model',
      COALESCE(x->>'channel', 'unknown'),
      COALESCE((x->>'inputTokens')::INTEGER, 0),
      COALESCE((x->>'outputTokens')::INTEGER, 0),
      COALESCE((x->>'reasoningTokens')::INTEGER, 0),
      COALESCE((x->>'cacheReadTokens')::INTEGER, 0),
      COALESCE((x->>'cacheWriteTokens')::INTEGER, 0),
      COALESCE((x->>'totalTokens')::INTEGER, 0),
      COALESCE((x->>'inputCost')::REAL, 0),
      COALESCE((x->>'outputCost')::REAL, 0),
      COALESCE((x->>'reasoningCost')::REAL, 0),
      COALESCE((x->>'cacheReadCost')::REAL, 0),
      COALESCE((x->>'cacheWriteCost')::REAL, 0),
      COALESCE((x->>'totalCost')::REAL, 0),
      x->>'stopReason',
      x->>'project'
    FROM jsonb_array_elements(p_events) AS x
    ON CONFLICT (id, member_code) DO UPDATE SET
      project = COALESCE(EXCLUDED.project, tokend_usage_events.project)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  -- Bulk upsert sync states
  INSERT INTO tokend_sync_state (
    member_code, source_path_hash, last_processed_lines,
    parser_version, last_sync_at
  )
  SELECT
    v_code,
    s->>'sourcePathHash',
    COALESCE((s->>'lastProcessedLines')::INTEGER, 0),
    COALESCE((s->>'parserVersion')::INTEGER, 1),
    now()
  FROM jsonb_array_elements(p_sync_states) AS s
  ON CONFLICT (member_code, source_path_hash)
  DO UPDATE SET
    last_processed_lines = EXCLUDED.last_processed_lines,
    parser_version       = EXCLUDED.parser_version,
    last_sync_at         = now();

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;

-- 2. tokend_upload_messages — bulk insert
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
  v_count INTEGER;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  WITH ins AS (
    INSERT INTO tokend_message_events (
      id, member_code, timestamp_ms, session_id,
      agent, channel, kind
    )
    SELECT
      m->>'id',
      v_code,
      (m->>'timestampMs')::BIGINT,
      m->>'sessionId',
      m->>'agent',
      COALESCE(m->>'channel', 'unknown'),
      m->>'kind'
    FROM jsonb_array_elements(p_messages) AS m
    ON CONFLICT (id, member_code) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;

-- 3. tokend_rebuild_sessions — bulk upsert
CREATE OR REPLACE FUNCTION tokend_rebuild_sessions(
  p_token       TEXT,
  p_session_ids TEXT[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code  TEXT;
  v_count INTEGER;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  WITH agg AS (
    SELECT
      e.session_id,
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
    FROM tokend_usage_events e
    WHERE e.member_code = v_code
      AND e.session_id = ANY(p_session_ids)
    GROUP BY e.session_id
    HAVING COUNT(*) > 0
  ),
  ups AS (
    INSERT INTO tokend_sessions (
      session_id, member_code, session_key, agent, title, channel,
      first_seen_at, last_seen_at, current_model,
      call_count, total_tokens, total_cost, updated_at
    )
    SELECT
      a.session_id, v_code, a.session_key, a.agent, a.project, a.channel,
      a.first_seen_at, a.last_seen_at, a.current_model,
      a.call_count, a.total_tokens, a.total_cost, now()
    FROM agg a
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
      updated_at    = now()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ups;

  RETURN json_build_object('ok', true, 'sessions_updated', v_count);
END;
$$;
