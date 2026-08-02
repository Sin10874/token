-- Isolated PostgreSQL v15 contract fixture. Uses only synthetic values.
INSERT INTO tokend_members (member_code, phone, tagline, token)
VALUES ('CONTRACT_MEMBER', NULL, 'contract fixture', 'contract-auth-value')
ON CONFLICT (member_code) DO UPDATE
SET token = EXCLUDED.token;

SELECT tokend_upload_events(
  'contract-auth-value',
  $$[
    {"id":"sonnet-intro","timestampMs":1788220799999,"sessionId":"s-intro","provider":"anthropic","model":"claude-sonnet-5","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":1000000,"cacheReadTokens":1000000,"cacheWriteTokens":1000000,"totalTokens":5000000,"totalCost":0},
    {"id":"sonnet-standard","timestampMs":1788220800000,"sessionId":"s-standard","provider":"anthropic","model":"claude-sonnet-5","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":1000000,"cacheReadTokens":1000000,"cacheWriteTokens":1000000,"totalTokens":5000000,"totalCost":0},
    {"id":"deepseek-alias","timestampMs":1785000000000,"sessionId":"s-deepseek","provider":"deepseek","model":"deepseek-chat","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":1000000,"cacheReadTokens":1000000,"cacheWriteTokens":0,"totalTokens":4000000,"totalCost":0},
    {"id":"mimo-alias","timestampMs":1785000000000,"sessionId":"s-mimo","provider":"xiaomi","model":"mimo-v2-pro","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":1000000,"cacheReadTokens":1000000,"cacheWriteTokens":0,"totalTokens":4000000,"totalCost":0},
    {"id":"glm-alias","timestampMs":1785000000000,"sessionId":"s-glm","provider":"zhipu","model":"Pro/zai-org/GLM-5","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":2000000,"totalCost":0},
    {"id":"minimax-alias","timestampMs":1785000000000,"sessionId":"s-minimax","provider":"minimax","model":"minimax-m2.5","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":2000000,"totalCost":0},
    {"id":"kimi-cache-write","timestampMs":1785000000000,"sessionId":"s-kimi","provider":"moonshot","model":"kimi-k3","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":1000000,"cacheReadTokens":1000000,"cacheWriteTokens":1,"totalTokens":4000001,"totalCost":0},
    {"id":"reported","timestampMs":1785000000000,"sessionId":"s-reported","provider":"anthropic","model":"claude-opus-5","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":2000000,"inputCost":1,"outputCost":2,"reasoningCost":0,"cacheReadCost":0,"cacheWriteCost":0,"totalCost":7},
    {"id":"unknown","timestampMs":1785000000000,"sessionId":"s-unknown","provider":"unknown","model":"vendor-claude-opus-5","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":2000000,"totalCost":0}
  ]$$::jsonb,
  '[]'::jsonb
);

INSERT INTO tokend_usage_events (
  id, member_code, timestamp_ms, session_id, model,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, input_cost, output_cost, reasoning_cost, cache_read_cost, cache_write_cost, total_cost
) VALUES (
  'backfill-opus', 'CONTRACT_MEMBER', 1785000000000, 's-backfill', 'claude-opus-5',
  1000000, 1000000, 1000000, 1000000, 1000000,
  5000000, 0, 0, 0, 0, 0, 0
);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM tokend_model_price_versions) <> 9 THEN
    RAISE EXCEPTION 'expected 9 version rows';
  END IF;
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'sonnet-intro') NOT BETWEEN 24.699 AND 24.701 THEN
    RAISE EXCEPTION 'Sonnet introduction boundary cost mismatch';
  END IF;
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'sonnet-standard') NOT BETWEEN 37.049 AND 37.051 THEN
    RAISE EXCEPTION 'Sonnet standard boundary cost mismatch';
  END IF;
  IF (SELECT model FROM tokend_usage_events WHERE id = 'deepseek-alias') <> 'deepseek-v4-flash'
    OR (SELECT total_cost FROM tokend_usage_events WHERE id = 'deepseek-alias') NOT BETWEEN 0.7027 AND 0.7029 THEN
    RAISE EXCEPTION 'DeepSeek alias or cost mismatch';
  END IF;
  IF (SELECT model FROM tokend_usage_events WHERE id = 'mimo-alias') <> 'mimo-v2.5-pro'
    OR (SELECT total_cost FROM tokend_usage_events WHERE id = 'mimo-alias') NOT BETWEEN 2.1785 AND 2.1787 THEN
    RAISE EXCEPTION 'MiMo alias or cost mismatch';
  END IF;
  IF (SELECT model FROM tokend_usage_events WHERE id = 'glm-alias') <> 'glm-5'
    OR COALESCE((SELECT total_cost FROM tokend_usage_events WHERE id = 'glm-alias'), 0) <= 0 THEN
    RAISE EXCEPTION 'GLM alias or cost mismatch';
  END IF;
  IF (SELECT model FROM tokend_usage_events WHERE id = 'minimax-alias') <> 'MiniMax-M2.5'
    OR COALESCE((SELECT total_cost FROM tokend_usage_events WHERE id = 'minimax-alias'), 0) <= 0 THEN
    RAISE EXCEPTION 'MiniMax alias or cost mismatch';
  END IF;
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'kimi-cache-write') <> 0 THEN
    RAISE EXCEPTION 'Kimi cache-write must fail closed';
  END IF;
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'reported') <> 7 THEN
    RAISE EXCEPTION 'reported cost was overwritten';
  END IF;
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'unknown') <> 0
    OR (SELECT model FROM tokend_usage_events WHERE id = 'unknown') <> 'vendor-claude-opus-5' THEN
    RAISE EXCEPTION 'unknown model fuzzy matched';
  END IF;
END
$$;

DO $$
DECLARE
  target_oid OID := to_regprocedure('public.tokend_upload_events(text,jsonb,jsonb)');
  target_owner NAME;
  target_security_definer BOOLEAN;
  target_config TEXT[];
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'tokend_upload_events(text,jsonb,jsonb) is missing';
  END IF;

  SELECT pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
  INTO target_owner, target_security_definer, target_config
  FROM pg_proc AS p
  WHERE p.oid = target_oid;

  IF target_owner <> 'postgres' THEN
    RAISE EXCEPTION 'tokend_upload_events(text,jsonb,jsonb) has unexpected owner';
  END IF;
  IF target_security_definer IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tokend_upload_events(text,jsonb,jsonb) must remain SECURITY DEFINER';
  END IF;
  IF target_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::TEXT[] THEN
    RAISE EXCEPTION 'tokend_upload_events(text,jsonb,jsonb) search_path is not pinned';
  END IF;
END
$$;

SELECT tokend_backfill_versioned_model_costs_batch(100);
SELECT tokend_rebuild_session_costs();

DO $$
BEGIN
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'backfill-opus') NOT BETWEEN 61.749 AND 61.751 THEN
    RAISE EXCEPTION 'backfill cost mismatch';
  END IF;
  IF (SELECT total_cost FROM tokend_sessions WHERE member_code = 'CONTRACT_MEMBER' AND session_id = 's-backfill') NOT BETWEEN 61.749 AND 61.751 THEN
    RAISE EXCEPTION 'session cost was not rebuilt';
  END IF;
END
$$;
