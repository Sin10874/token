-- Pre-v15 helper. Run this file as a standalone statement stream; never wrap it
-- in an explicit transaction because CREATE INDEX CONCURRENTLY rejects it.
--
-- A valid exact same-name index makes this retry-safe. Missing is allowed before
-- CREATE INDEX. Invalid, unready, wrong-table, wrong-key, or wrong-predicate
-- indexes fail closed; run the independent cleanup script before retrying.
-- v15 rollback intentionally does not remove this performance index.

DO $$
DECLARE
  target_oid OID := to_regclass('public.idx_tokend_usage_events_v15_backfill_candidates');
  target_relid OID;
  target_valid BOOLEAN;
  target_ready BOOLEAN;
  target_keys TEXT[];
  target_predicate TEXT;
  normalized_predicate TEXT;
  expected_predicate CONSTANT TEXT := 'total_cost=0andtotal_tokens>0andmodel=anyarray[''claude-opus-5'',''claude-sonnet-5'',''kimi-k2.7-code'',''kimi-k3'',''deepseek-v4-flash'',''deepseek-v4-pro'',''mimo-v2.5'',''mimo-v2.5-pro'',''deepseek-chat'',''deepseek-reasoner'',''mimo-v2-flash'',''mimo-v2-omni'',''mimo-v2-pro'']';
BEGIN
  IF target_oid IS NULL THEN
    RETURN;
  END IF;

  SELECT
    index_meta.indrelid,
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
  INTO target_relid, target_valid, target_ready, target_keys, target_predicate
  FROM pg_index AS index_meta
  WHERE index_meta.indexrelid = target_oid;

  normalized_predicate := regexp_replace(lower(target_predicate), '::[a-z_ ]+', '', 'g');
  normalized_predicate := regexp_replace(normalized_predicate, '[[:space:]()]', '', 'g');

  IF target_relid <> 'public.tokend_usage_events'::REGCLASS
    OR target_valid IS DISTINCT FROM TRUE
    OR target_ready IS DISTINCT FROM TRUE
    OR target_keys IS DISTINCT FROM ARRAY['timestamp_ms', 'id', 'member_code']::TEXT[]
    OR normalized_predicate IS DISTINCT FROM expected_predicate
  THEN
    RAISE EXCEPTION 'v15 candidate index has an unsafe existing definition; run supabase-v15-backfill-candidate-index.cleanup.sql before retrying';
  END IF;
END
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tokend_usage_events_v15_backfill_candidates
  ON public.tokend_usage_events (timestamp_ms, id, member_code)
  WHERE total_cost = 0
    AND total_tokens > 0
    AND model IN (
      'claude-opus-5',
      'claude-sonnet-5',
      'kimi-k2.7-code',
      'kimi-k3',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'deepseek-chat',
      'deepseek-reasoner',
      'mimo-v2-flash',
      'mimo-v2-omni',
      'mimo-v2-pro'
    );

DO $$
DECLARE
  target_oid OID := to_regclass('public.idx_tokend_usage_events_v15_backfill_candidates');
  target_relid OID;
  target_valid BOOLEAN;
  target_ready BOOLEAN;
  target_keys TEXT[];
  target_predicate TEXT;
  normalized_predicate TEXT;
  expected_predicate CONSTANT TEXT := 'total_cost=0andtotal_tokens>0andmodel=anyarray[''claude-opus-5'',''claude-sonnet-5'',''kimi-k2.7-code'',''kimi-k3'',''deepseek-v4-flash'',''deepseek-v4-pro'',''mimo-v2.5'',''mimo-v2.5-pro'',''deepseek-chat'',''deepseek-reasoner'',''mimo-v2-flash'',''mimo-v2-omni'',''mimo-v2-pro'']';
BEGIN
  IF target_oid IS NULL THEN
    RAISE EXCEPTION 'v15 candidate index was not created';
  END IF;

  SELECT
    index_meta.indrelid,
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
  INTO target_relid, target_valid, target_ready, target_keys, target_predicate
  FROM pg_index AS index_meta
  WHERE index_meta.indexrelid = target_oid;

  normalized_predicate := regexp_replace(lower(target_predicate), '::[a-z_ ]+', '', 'g');
  normalized_predicate := regexp_replace(normalized_predicate, '[[:space:]()]', '', 'g');

  IF target_relid <> 'public.tokend_usage_events'::REGCLASS
    OR target_valid IS DISTINCT FROM TRUE
    OR target_ready IS DISTINCT FROM TRUE
    OR target_keys IS DISTINCT FROM ARRAY['timestamp_ms', 'id', 'member_code']::TEXT[]
    OR normalized_predicate IS DISTINCT FROM expected_predicate
  THEN
    RAISE EXCEPTION 'v15 candidate index was not created with the exact safe definition';
  END IF;
END
$$;
