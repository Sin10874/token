-- Read-only preflight/postflight. Missing, invalid, unready, or wrong-definition
-- candidate indexes fail nonzero instead of silently returning no rows.
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
    RAISE EXCEPTION 'v15 candidate index is missing';
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
    RAISE EXCEPTION 'v15 candidate index has an unsafe definition';
  END IF;
END
$$;

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
  ) AS key_columns,
  pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
FROM pg_class AS index_class
JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
JOIN pg_index AS index_meta ON index_meta.indexrelid = index_class.oid
WHERE index_namespace.nspname = 'public'
  AND index_class.relname = 'idx_tokend_usage_events_v15_backfill_candidates';
