-- Reconciliation is a bounded, service-only aggregate over the frozen target
-- set. At production scale it legitimately exceeds the role's 10 second
-- default, so give this one audited function a larger transaction budget.

SET lock_timeout = '2s';

ALTER FUNCTION public.tokend_pricing_reconcile(UUID)
  SET statement_timeout = '45s';

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
