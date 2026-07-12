-- Session detail resolves the active pricing view once for its aggregate and
-- once for its event list. Production load can exceed the anonymous role's
-- three-second REST budget, so bound this RPC to the eight-second UI gate.

SET lock_timeout = '2s';

ALTER FUNCTION public.tokend_get_session_detail_v2(TEXT, TEXT)
  SET statement_timeout = '8s';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
