DO $$
BEGIN
  IF (SELECT COUNT(*) FROM tokend_model_price_versions) <> 9 THEN
    RAISE EXCEPTION 'expected 9 version rows after reapply';
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
    RAISE EXCEPTION 'tokend_upload_events(text,jsonb,jsonb) is missing after reapply';
  END IF;

  SELECT pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
  INTO target_owner, target_security_definer, target_config
  FROM pg_proc AS p
  WHERE p.oid = target_oid;

  IF target_owner <> 'postgres' THEN
    RAISE EXCEPTION 'tokend_upload_events(text,jsonb,jsonb) has unexpected owner after reapply';
  END IF;
  IF target_security_definer IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tokend_upload_events(text,jsonb,jsonb) must remain SECURITY DEFINER after reapply';
  END IF;
  IF target_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::TEXT[] THEN
    RAISE EXCEPTION 'tokend_upload_events(text,jsonb,jsonb) search_path is not pinned after reapply';
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
