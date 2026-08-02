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
