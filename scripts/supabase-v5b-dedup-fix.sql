-- Fix: deduplicate within batch to avoid "ON CONFLICT DO UPDATE cannot affect row a second time"

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

  -- Bulk insert with dedup within batch
  WITH deduped AS (
    SELECT DISTINCT ON (x->>'id') x
    FROM jsonb_array_elements(p_events) AS x
    ORDER BY x->>'id'
  ),
  ins AS (
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
      d.x->>'id',
      v_code,
      (d.x->>'timestampMs')::BIGINT,
      d.x->>'sessionId',
      d.x->>'sessionKey',
      d.x->>'agent',
      d.x->>'provider',
      d.x->>'model',
      COALESCE(d.x->>'channel', 'unknown'),
      COALESCE((d.x->>'inputTokens')::INTEGER, 0),
      COALESCE((d.x->>'outputTokens')::INTEGER, 0),
      COALESCE((d.x->>'reasoningTokens')::INTEGER, 0),
      COALESCE((d.x->>'cacheReadTokens')::INTEGER, 0),
      COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0),
      COALESCE((d.x->>'totalTokens')::INTEGER, 0),
      COALESCE((d.x->>'inputCost')::REAL, 0),
      COALESCE((d.x->>'outputCost')::REAL, 0),
      COALESCE((d.x->>'reasoningCost')::REAL, 0),
      COALESCE((d.x->>'cacheReadCost')::REAL, 0),
      COALESCE((d.x->>'cacheWriteCost')::REAL, 0),
      COALESCE((d.x->>'totalCost')::REAL, 0),
      d.x->>'stopReason',
      d.x->>'project'
    FROM deduped d
    ON CONFLICT (id, member_code) DO UPDATE SET
      project = COALESCE(EXCLUDED.project, tokend_usage_events.project)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  -- Bulk upsert sync states (also dedup)
  WITH deduped_ss AS (
    SELECT DISTINCT ON (s->>'sourcePathHash') s
    FROM jsonb_array_elements(p_sync_states) AS s
    ORDER BY s->>'sourcePathHash'
  )
  INSERT INTO tokend_sync_state (
    member_code, source_path_hash, last_processed_lines,
    parser_version, last_sync_at
  )
  SELECT
    v_code,
    d.s->>'sourcePathHash',
    COALESCE((d.s->>'lastProcessedLines')::INTEGER, 0),
    COALESCE((d.s->>'parserVersion')::INTEGER, 1),
    now()
  FROM deduped_ss d
  ON CONFLICT (member_code, source_path_hash)
  DO UPDATE SET
    last_processed_lines = EXCLUDED.last_processed_lines,
    parser_version       = EXCLUDED.parser_version,
    last_sync_at         = now();

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;

-- Same fix for messages
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

  WITH deduped AS (
    SELECT DISTINCT ON (m->>'id') m
    FROM jsonb_array_elements(p_messages) AS m
    ORDER BY m->>'id'
  ),
  ins AS (
    INSERT INTO tokend_message_events (
      id, member_code, timestamp_ms, session_id,
      agent, channel, kind
    )
    SELECT
      d.m->>'id',
      v_code,
      (d.m->>'timestampMs')::BIGINT,
      d.m->>'sessionId',
      d.m->>'agent',
      COALESCE(d.m->>'channel', 'unknown'),
      d.m->>'kind'
    FROM deduped d
    ON CONFLICT (id, member_code) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  RETURN json_build_object('ok', true, 'inserted', v_count);
END;
$$;
