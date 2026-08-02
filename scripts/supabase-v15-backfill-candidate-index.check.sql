-- Read-only preflight/postflight for the independent v15 candidate index.
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
