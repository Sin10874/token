DO $$
DECLARE
  target_oid OID := to_regclass('public.idx_tokend_usage_events_v15_backfill_candidates');
  target_valid BOOLEAN;
  target_ready BOOLEAN;
  target_keys TEXT[];
  target_predicate TEXT;
  target_model TEXT;
  batch_arguments TEXT;
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'v15 candidate index is missing';
  END IF;

  SELECT
    index_meta.indisvalid,
    index_meta.indisready,
    ARRAY(
      SELECT attribute.attname
      FROM unnest(index_meta.indkey) WITH ORDINALITY AS key_column(attnum, ordinal)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = index_meta.indrelid
       AND attribute.attnum = key_column.attnum
      ORDER BY key_column.ordinal
    ),
    pg_get_expr(index_meta.indpred, index_meta.indrelid)
  INTO target_valid, target_ready, target_keys, target_predicate
  FROM pg_index AS index_meta
  WHERE index_meta.indexrelid = target_oid;

  IF target_valid IS DISTINCT FROM TRUE OR target_ready IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'v15 candidate index must be valid and ready';
  END IF;
  IF target_keys IS DISTINCT FROM ARRAY['timestamp_ms', 'id', 'member_code']::TEXT[] THEN
    RAISE EXCEPTION 'v15 candidate index keys are wrong: %', target_keys;
  END IF;
  IF target_predicate !~ 'total_cost = .*0'
    OR target_predicate NOT LIKE '%total_tokens > 0%'
  THEN
    RAISE EXCEPTION 'v15 candidate index predicate lacks zero-cost/token guard: %', target_predicate;
  END IF;

  FOREACH target_model IN ARRAY ARRAY[
    'claude-opus-5', 'claude-sonnet-5', 'kimi-k2.7-code', 'kimi-k3',
    'deepseek-v4-flash', 'deepseek-v4-pro', 'mimo-v2.5', 'mimo-v2.5-pro',
    'deepseek-chat', 'deepseek-reasoner', 'mimo-v2-flash', 'mimo-v2-omni', 'mimo-v2-pro'
  ]::TEXT[]
  LOOP
    IF POSITION(quote_literal(target_model) IN target_predicate) = 0 THEN
      RAISE EXCEPTION 'v15 candidate index predicate lacks %', target_model;
    END IF;
  END LOOP;

  IF to_regprocedure('public.tokend_backfill_versioned_model_costs_batch(integer)') IS NOT NULL THEN
    SELECT pg_get_function_arguments(
      to_regprocedure('public.tokend_backfill_versioned_model_costs_batch(integer)')
    )
    INTO batch_arguments;

    IF batch_arguments IS DISTINCT FROM 'p_limit integer DEFAULT 1000' THEN
      RAISE EXCEPTION 'v15 backfill batch default must be 1000, got %', batch_arguments;
    END IF;
  END IF;

  IF to_regclass('public.tokend_model_price_versions') IS NOT NULL THEN
    IF EXISTS (
      WITH alias_map(raw_model, canonical_model) AS (
      VALUES
        ('k2p5', 'kimi-k2.5'),
        ('kimi-code/kimi-for-coding', 'kimi-k2.5'),
        ('kimi-for-coding', 'kimi-k2.5'),
        ('kimi-k2-thinking', 'kimi-k2.5'),
        ('deepseek-chat', 'deepseek-v4-flash'),
        ('deepseek-reasoner', 'deepseek-v4-flash'),
        ('mimo-v2-flash', 'mimo-v2.5'),
        ('mimo-v2-omni', 'mimo-v2.5'),
        ('mimo-v2-pro', 'mimo-v2.5-pro'),
        ('GLM-5.2', 'glm-5.2'),
        ('GLM-5.1', 'glm-5.1'),
        ('GLM-5-Turbo', 'glm-5-turbo'),
        ('GLM-5', 'glm-5'),
        ('GLM-4.7', 'glm-4.7'),
        ('GLM-4.5-Air', 'glm-4.5-air'),
        ('Pro/zai-org/GLM-5', 'glm-5'),
        ('zhanlu/glm-4.7', 'glm-4.7'),
        ('Pro/MiniMaxAI/MiniMax-M2.5', 'MiniMax-M2.5'),
        ('minimax-m2.5', 'MiniMax-M2.5'),
        ('minimax-m2.5-highspeed', 'MiniMax-M2.5-highspeed'),
        ('minimax-m2.7', 'MiniMax-M2.7'),
        ('minimax-m2.7-highspeed', 'MiniMax-M2.7-highspeed'),
        ('zhanlu/minimax-2.7', 'MiniMax-M2.7'),
        ('M-3', 'MiniMax-M3'),
        ('M-2.7', 'MiniMax-M2.7')
    ),
    original_candidates AS (
      SELECT event.id, event.member_code
      FROM tokend_usage_events AS event
      LEFT JOIN alias_map ON alias_map.raw_model = event.model
      JOIN tokend_model_price_versions AS price
        ON price.model_id = COALESCE(alias_map.canonical_model, event.model)
       AND event.timestamp_ms >= price.valid_from_ms
       AND (price.valid_to_ms IS NULL OR event.timestamp_ms < price.valid_to_ms)
      WHERE event.total_cost = 0
        AND event.total_tokens > 0
        AND NOT (price.cache_semantics = 'hit_miss' AND event.cache_write_tokens <> 0)
        AND NOT (price.cache_write_price IS NULL AND event.cache_write_tokens <> 0)
    ),
    indexed_candidates AS (
      SELECT event.id, event.member_code
      FROM tokend_usage_events AS event
      LEFT JOIN alias_map ON alias_map.raw_model = event.model
      JOIN tokend_model_price_versions AS price
        ON price.model_id = COALESCE(alias_map.canonical_model, event.model)
       AND event.timestamp_ms >= price.valid_from_ms
       AND (price.valid_to_ms IS NULL OR event.timestamp_ms < price.valid_to_ms)
      WHERE event.total_cost = 0
        AND event.total_tokens > 0
        AND event.model IN (
          'claude-opus-5', 'claude-sonnet-5', 'kimi-k2.7-code', 'kimi-k3',
          'deepseek-v4-flash', 'deepseek-v4-pro', 'mimo-v2.5', 'mimo-v2.5-pro',
          'deepseek-chat', 'deepseek-reasoner', 'mimo-v2-flash', 'mimo-v2-omni', 'mimo-v2-pro'
        )
        AND NOT (price.cache_semantics = 'hit_miss' AND event.cache_write_tokens <> 0)
        AND NOT (price.cache_write_price IS NULL AND event.cache_write_tokens <> 0)
    )
      SELECT 1 FROM (
        (SELECT * FROM original_candidates EXCEPT SELECT * FROM indexed_candidates)
        UNION ALL
        (SELECT * FROM indexed_candidates EXCEPT SELECT * FROM original_candidates)
      ) AS candidate_delta
    ) THEN
      RAISE EXCEPTION 'candidate model predicate changed the priceable event set';
    END IF;
  END IF;
END
$$;
