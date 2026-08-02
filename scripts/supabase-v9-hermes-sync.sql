-- Hermes sync support
-- Safe to run multiple times.

ALTER TABLE tokend_usage_events
  ADD COLUMN IF NOT EXISTS project TEXT;

ALTER TABLE tokend_sessions
  ADD COLUMN IF NOT EXISTS title TEXT;

CREATE OR REPLACE FUNCTION tokend_get_hermes_session_totals(
  p_token TEXT,
  p_session_ids TEXT[]
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_code TEXT;
  v_rows JSONB;
BEGIN
  SELECT member_code INTO v_code
    FROM tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  IF COALESCE(array_length(p_session_ids, 1), 0) = 0 THEN
    RETURN json_build_object('ok', true, 'sessions', '[]'::jsonb);
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'sessionId', session_id,
        'inputTokens', input_tokens,
        'outputTokens', output_tokens,
        'reasoningTokens', reasoning_tokens,
        'cacheReadTokens', cache_read_tokens,
        'cacheWriteTokens', cache_write_tokens
      )
      ORDER BY session_id
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT
      session_id,
      COALESCE(SUM(input_tokens), 0)::BIGINT      AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::BIGINT     AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::BIGINT  AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::BIGINT AS cache_write_tokens
    FROM tokend_usage_events
    WHERE member_code = v_code
      AND channel = 'hermes'
      AND session_id = ANY(p_session_ids)
    GROUP BY session_id
  ) totals;

  RETURN json_build_object('ok', true, 'sessions', v_rows);
END;
$$;

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
  v_title   TEXT;
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
      MIN(e.timestamp_ms) AS first_seen_at,
      MAX(e.timestamp_ms) AS last_seen_at,
      COUNT(*)::INTEGER AS call_count,
      COALESCE(SUM(e.total_tokens), 0)::INTEGER AS total_tokens,
      COALESCE(SUM(e.total_cost), 0)::REAL AS total_cost,
      (ARRAY_AGG(e.model ORDER BY e.timestamp_ms DESC, e.id DESC))[1] AS current_model,
      (ARRAY_AGG(e.agent ORDER BY e.timestamp_ms DESC, e.id DESC))[1] AS agent,
      (ARRAY_AGG(e.channel ORDER BY e.timestamp_ms DESC, e.id DESC))[1] AS channel,
      (ARRAY_AGG(e.session_key ORDER BY e.timestamp_ms DESC, e.id DESC))[1] AS session_key,
      (
        ARRAY_AGG(e.project ORDER BY e.timestamp_ms DESC, e.id DESC)
        FILTER (WHERE NULLIF(TRIM(e.project), '') IS NOT NULL)
      )[1] AS project
    INTO v_agg
    FROM tokend_usage_events e
    WHERE e.member_code = v_code
      AND e.session_id = v_sid;

    IF v_agg.call_count IS NULL OR v_agg.call_count = 0 THEN
      CONTINUE;
    END IF;

    v_title := COALESCE(
      NULLIF(TRIM(v_agg.project), ''),
      CASE
        WHEN v_agg.channel = 'hermes' THEN NULLIF(TRIM(v_agg.agent), '')
        ELSE NULL
      END
    );

    INSERT INTO tokend_sessions (
      session_id, member_code, session_key, agent, title, channel,
      first_seen_at, last_seen_at, current_model,
      call_count, total_tokens, total_cost, updated_at
    ) VALUES (
      v_sid, v_code, v_agg.session_key, v_agg.agent, v_title, v_agg.channel,
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
