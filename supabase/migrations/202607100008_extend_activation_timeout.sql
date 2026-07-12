-- Forward-only runtime budget for the service-only activation integrity gate.
-- Activation rechecks the complete frozen target, revision, shadow-session and
-- reconciliation hash before publishing pointers. The 700k-row rehearsal takes
-- about 4.3 seconds, beyond the production role's 3 second default.

SET lock_timeout = '2s';

ALTER FUNCTION public.tokend_pricing_activate(UUID)
  SET statement_timeout = '15s';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
