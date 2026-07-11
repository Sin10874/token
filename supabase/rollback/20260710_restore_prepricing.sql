BEGIN;

DROP FUNCTION IF EXISTS public.tokend_upload_events(TEXT, JSONB, JSONB);

CREATE FUNCTION public.tokend_upload_events(
  p_token       TEXT,
  p_events      JSONB,
  p_sync_states JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code  TEXT;
  v_count INTEGER;
BEGIN
  SELECT member_code INTO v_code
    FROM public.tokend_members
   WHERE token = p_token
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid_token');
  END IF;

  WITH deduped AS (
    SELECT DISTINCT ON (x->>'id') x
    FROM jsonb_array_elements(p_events) AS x
    ORDER BY x->>'id'
  ),
  -- 客户端报零成本但有 token 用量时，按服务端价格表计价
  enriched AS (
    SELECT d.x,
      (COALESCE((d.x->>'totalCost')::REAL, 0) = 0
        AND COALESCE((d.x->>'totalTokens')::INTEGER, 0) > 0
        AND pr.model_id IS NOT NULL)                          AS reprice,
      pr.input_price, pr.output_price, pr.cache_read_price,
      pr.cache_write_price, pr.per_tokens
    FROM deduped d
    LEFT JOIN LATERAL (
      SELECT p.* FROM public.tokend_model_prices p
      WHERE p.model_id = d.x->>'model'
         OR (d.x->>'model' ~ '-\d{8,}$'
             AND p.model_id = regexp_replace(d.x->>'model', '-\d{8,}$', ''))
      ORDER BY (p.model_id = d.x->>'model') DESC
      LIMIT 1
    ) pr ON TRUE
  ),
  ins AS (
    INSERT INTO public.tokend_usage_events (
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
      LEFT(d.x->>'sessionKey', 512),
      LEFT(d.x->>'agent', 512),
      LEFT(d.x->>'provider', 512),
      LEFT(d.x->>'model', 512),
      LEFT(COALESCE(d.x->>'channel', 'unknown'), 512),
      COALESCE((d.x->>'inputTokens')::INTEGER, 0),
      COALESCE((d.x->>'outputTokens')::INTEGER, 0),
      COALESCE((d.x->>'reasoningTokens')::INTEGER, 0),
      COALESCE((d.x->>'cacheReadTokens')::INTEGER, 0),
      COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0),
      COALESCE((d.x->>'totalTokens')::INTEGER, 0),
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'inputTokens')::INTEGER, 0) * d.input_price / d.per_tokens
        ELSE COALESCE((d.x->>'inputCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'outputTokens')::INTEGER, 0) * d.output_price / d.per_tokens
        ELSE COALESCE((d.x->>'outputCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'reasoningTokens')::INTEGER, 0) * d.output_price / d.per_tokens
        ELSE COALESCE((d.x->>'reasoningCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'cacheReadTokens')::INTEGER, 0) * d.cache_read_price / d.per_tokens
        ELSE COALESCE((d.x->>'cacheReadCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0) * d.cache_write_price / d.per_tokens
        ELSE COALESCE((d.x->>'cacheWriteCost')::REAL, 0) END,
      CASE WHEN d.reprice
        THEN (COALESCE((d.x->>'inputTokens')::INTEGER, 0) * d.input_price
            + COALESCE((d.x->>'outputTokens')::INTEGER, 0) * d.output_price
            + COALESCE((d.x->>'reasoningTokens')::INTEGER, 0) * d.output_price
            + COALESCE((d.x->>'cacheReadTokens')::INTEGER, 0) * d.cache_read_price
            + COALESCE((d.x->>'cacheWriteTokens')::INTEGER, 0) * d.cache_write_price
          ) / d.per_tokens
        ELSE COALESCE((d.x->>'totalCost')::REAL, 0) END,
      LEFT(d.x->>'stopReason', 512),
      LEFT(d.x->>'project', 256)
    FROM enriched d
    ON CONFLICT (id, member_code) DO UPDATE SET
      project = COALESCE(EXCLUDED.project, public.tokend_usage_events.project)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ins;

  WITH deduped_ss AS (
    SELECT DISTINCT ON (s->>'sourcePathHash') s
    FROM jsonb_array_elements(p_sync_states) AS s
    ORDER BY s->>'sourcePathHash'
  )
  INSERT INTO public.tokend_sync_state (
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

REVOKE ALL ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.tokend_upload_events_v2(TEXT, JSONB, JSONB);

DROP FUNCTION IF EXISTS public.tokend_pricing_create_backfill(TEXT);
DROP FUNCTION IF EXISTS public.tokend_pricing_backfill_batch(UUID, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.tokend_pricing_reconcile(UUID);
DROP FUNCTION IF EXISTS public.tokend_pricing_activate(UUID);
DROP FUNCTION IF EXISTS public.tokend_pricing_rollback(UUID);
DROP FUNCTION IF EXISTS public.tokend_pricing_get_backfill(UUID);
DROP FUNCTION IF EXISTS public.tokend_pricing_preflight();

DROP FUNCTION IF EXISTS public.tokend_get_summary_v5(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.tokend_get_daily_trend_v5(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.tokend_get_model_breakdown_v3(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.tokend_get_model_detail_v2(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.tokend_get_channel_breakdown_v4(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.tokend_get_channel_detail_v3(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.tokend_get_sessions_v2(TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.tokend_get_session_detail_v2(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.tokend_get_top_projects_v3(TEXT, TEXT);

DROP FUNCTION IF EXISTS public.tokend_price_event(JSONB, TEXT);
DROP VIEW IF EXISTS public.tokend_effective_usage_events;

NOTIFY pgrst, 'reload schema';

COMMIT;
