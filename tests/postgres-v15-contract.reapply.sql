DO $$
BEGIN
  IF (SELECT COUNT(*) FROM tokend_model_price_versions) <> 9 THEN
    RAISE EXCEPTION 'expected 9 version rows after reapply';
  END IF;
END
$$;

SELECT tokend_upload_events(
  'contract-auth-value',
  $$[{"id":"reapply-opus","timestampMs":1785000000000,"sessionId":"s-reapply","provider":"anthropic","model":"claude-opus-5","inputTokens":1000000,"outputTokens":1000000,"reasoningTokens":1000000,"cacheReadTokens":1000000,"cacheWriteTokens":1000000,"totalTokens":5000000,"totalCost":0}]$$::jsonb,
  '[]'::jsonb
);

DO $$
BEGIN
  IF (SELECT total_cost FROM tokend_usage_events WHERE id = 'reapply-opus') NOT BETWEEN 61.749 AND 61.751 THEN
    RAISE EXCEPTION 'v15 RPC did not work after reapply';
  END IF;
END
$$;
