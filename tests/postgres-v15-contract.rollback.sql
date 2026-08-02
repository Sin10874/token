DO $$
BEGIN
  IF to_regclass('public.tokend_model_price_versions') IS NOT NULL
    OR to_regclass('public.tokend_model_price_backfills') IS NOT NULL THEN
    RAISE EXCEPTION 'v15 tables remain after rollback';
  END IF;
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'backfill-opus') <> 0 THEN
    RAISE EXCEPTION 'backfilled cost was not restored';
  END IF;
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'reported') <> 7 THEN
    RAISE EXCEPTION 'reported cost changed during rollback';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM tokend_model_prices
    WHERE model_id = 'deepseek-v4-flash'
      AND provider = 'deepseek'
      AND ABS(input_price - 0.14) < 0.000001
      AND ABS(output_price - 0.28) < 0.000001
      AND ABS(cache_read_price - 0.028) < 0.000001
      AND ABS(cache_write_price - 0) < 0.000001
  ) THEN
    RAISE EXCEPTION 'deepseek-v4-flash was not restored';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM tokend_model_prices
    WHERE model_id = 'deepseek-v4-pro'
      AND provider = 'deepseek'
      AND ABS(input_price - 1.74) < 0.000001
      AND ABS(output_price - 3.48) < 0.000001
      AND ABS(cache_read_price - 0.145) < 0.000001
      AND ABS(cache_write_price - 0) < 0.000001
  ) THEN
    RAISE EXCEPTION 'deepseek-v4-pro was not restored';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM tokend_model_prices
    WHERE model_id = 'mimo-v2.5'
      AND provider = 'xiaomi'
      AND ABS(input_price - 0.435) < 0.000001
      AND ABS(output_price - 0.87) < 0.000001
      AND ABS(cache_read_price - 0.004) < 0.000001
      AND ABS(cache_write_price - 0) < 0.000001
  ) THEN
    RAISE EXCEPTION 'mimo-v2.5 was not restored';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM tokend_model_prices
    WHERE model_id = 'mimo-v2.5-pro'
      AND provider = 'xiaomi'
      AND ABS(input_price - 0.435) < 0.000001
      AND ABS(output_price - 0.87) < 0.000001
      AND ABS(cache_read_price - 0.004) < 0.000001
      AND ABS(cache_write_price - 0) < 0.000001
  ) THEN
    RAISE EXCEPTION 'mimo-v2.5-pro was not restored';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM tokend_model_prices
    WHERE model_id = 'MiniMax-M2.5'
      AND provider = 'minimax'
      AND ABS(input_price - 0.15) < 0.000001
      AND ABS(output_price - 0.9) < 0.000001
      AND ABS(cache_read_price - 0.03) < 0.000001
      AND ABS(cache_write_price - 0) < 0.000001
  ) THEN
    RAISE EXCEPTION 'MiniMax-M2.5 was not restored';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM tokend_model_prices
    WHERE model_id = 'MiniMax-M2.7-highspeed'
      AND provider = 'minimax'
      AND ABS(input_price - 0.6) < 0.000001
      AND ABS(output_price - 2.4) < 0.000001
      AND ABS(cache_read_price - 0.06) < 0.000001
      AND ABS(cache_write_price - 0.375) < 0.000001
  ) THEN
    RAISE EXCEPTION 'MiniMax-M2.7-highspeed was not restored';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tokend_model_prices WHERE model_id = 'MiniMax-M2.5-highspeed'
  ) THEN
    RAISE EXCEPTION 'MiniMax-M2.5-highspeed should have been removed';
  END IF;
END
$$;

SELECT tokend_upload_events(
  'contract-auth-value',
  jsonb_build_array(
    jsonb_build_object(
      'id', 'post-rollback-smoke',
      'timestampMs', 1785000000000,
      'sessionId', 's-post-rollback',
      'provider', 'deepseek',
      'model', 'deepseek-chat',
      'inputTokens', 1000000,
      'outputTokens', 1000000,
      'reasoningTokens', 1000000,
      'cacheReadTokens', 1000000,
      'cacheWriteTokens', 0,
      'totalTokens', 4000000,
      'totalCost', 0,
      'project', repeat('rollback-project-', 30)
    )
  ),
  '[]'::jsonb
);

DO $$
BEGIN
  IF (SELECT char_length(project) FROM tokend_usage_events WHERE id = 'post-rollback-smoke') <> 256 THEN
    RAISE EXCEPTION 'rollback did not restore tokend_upload_events project truncation';
  END IF;
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'post-rollback-smoke') NOT BETWEEN 1.1479 AND 1.1481 THEN
    RAISE EXCEPTION 'rollback did not restore flat pricing behavior';
  END IF;
END
$$;

SELECT tokend_rebuild_session_costs();

DO $$
BEGIN
  IF (SELECT total_cost FROM tokend_sessions WHERE member_code = 'CONTRACT_MEMBER' AND session_id = 's-backfill') <> 0 THEN
    RAISE EXCEPTION 'session cost was not restored';
  END IF;
END
$$;
