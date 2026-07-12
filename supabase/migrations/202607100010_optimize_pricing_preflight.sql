-- Keep the authoritative admin preflight bounded at production scale. The
-- previous implementation resolved active revisions through the effective
-- relation twice. Resolve only the total cost and pricing status needed here
-- in one base-table pass, then persist a compact per-model rollup.

SET lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.tokend_pricing_preflight()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_event_count BIGINT := 0;
  v_eligible_event_count BIGINT := 0;
  v_eligible_zero_cost_count BIGINT := 0;
  v_zero_cost_by_model JSON := '[]'::JSON;
  v_zero_cost_model_count BIGINT := 0;
  v_zero_cost_other_event_count BIGINT := 0;
  v_legacy_price_row_count BIGINT := 0;
  v_status_counts JSON;
  v_unpriced_event_count BIGINT := 0;
  v_unpriced_share NUMERIC := 0;
  v_total_cost NUMERIC(20,10) := 0;
  v_post_snapshot_event_count BIGINT := 0;
  v_members_over_2x_count BIGINT := 0;
  v_active_catalog_version TEXT;
  v_catalog_hash TEXT;
  v_previous_catalog_version TEXT;
  v_active_run_id UUID;
  v_previous_run_id UUID;
  v_active_run_status TEXT;
  v_active_reconciliation_hash TEXT;
  v_snapshot_at TIMESTAMPTZ;
  v_snapshot_run_id UUID;
  v_target_ingest_epoch BIGINT;
  v_rollout_fixture_count BIGINT := 0;
BEGIN
  SELECT
    pricing_state.active_catalog_version,
    active_catalog.hash,
    pricing_state.previous_catalog_version,
    pricing_state.active_backfill_run_id,
    pricing_state.previous_backfill_run_id,
    active_run.status,
    active_run.reconciliation_hash,
    active_run.snapshot_at,
    active_run.run_id,
    active_run.target_ingest_epoch
  INTO
    v_active_catalog_version,
    v_catalog_hash,
    v_previous_catalog_version,
    v_active_run_id,
    v_previous_run_id,
    v_active_run_status,
    v_active_reconciliation_hash,
    v_snapshot_at,
    v_snapshot_run_id,
    v_target_ingest_epoch
  FROM public.tokend_pricing_state AS pricing_state
  LEFT JOIN public.tokend_pricing_backfill_runs AS active_run
    ON active_run.run_id = pricing_state.active_backfill_run_id
  LEFT JOIN public.tokend_pricing_catalogs AS active_catalog
    ON active_catalog.version = pricing_state.active_catalog_version
  WHERE pricing_state.singleton;

  IF v_target_ingest_epoch IS NULL THEN
    SELECT run.snapshot_at, run.run_id, run.target_ingest_epoch
    INTO v_snapshot_at, v_snapshot_run_id, v_target_ingest_epoch
    FROM public.tokend_pricing_backfill_runs AS run
    WHERE run.status IN ('freezing', 'staging', 'reconciled')
      AND run.snapshot_at <= clock_timestamp()
    ORDER BY run.snapshot_at DESC, run.created_at DESC, run.run_id DESC
    LIMIT 1;
  END IF;

  WITH selected AS (
    SELECT
      COALESCE(usage_event.model, 'unknown') AS model_label,
      usage_event.total_tokens,
      usage_event.total_cost AS base_total_cost,
      revision.total_cost AS revision_total_cost,
      revision.pricing_status AS revision_pricing_status,
      CASE
        WHEN usage_event.pricing_status = 'reported' THEN 'reported'
        WHEN usage_event.pricing_status = 'legacy'
          AND (
            COALESCE(usage_event.input_cost, 0) <> 0
            OR COALESCE(usage_event.output_cost, 0) <> 0
            OR COALESCE(usage_event.reasoning_cost, 0) <> 0
            OR COALESCE(usage_event.cache_read_cost, 0) <> 0
            OR COALESCE(usage_event.cache_write_cost, 0) <> 0
            OR COALESCE(usage_event.total_cost, 0) <> 0
            OR COALESCE(usage_event.unallocated_cost, 0) <> 0
          ) THEN 'legacy'
        WHEN usage_event.pricing_status IS NULL
          AND (
            COALESCE(usage_event.input_cost, 0) <> 0
            OR COALESCE(usage_event.output_cost, 0) <> 0
            OR COALESCE(usage_event.reasoning_cost, 0) <> 0
            OR COALESCE(usage_event.cache_read_cost, 0) <> 0
            OR COALESCE(usage_event.cache_write_cost, 0) <> 0
            OR COALESCE(usage_event.total_cost, 0) <> 0
            OR COALESCE(usage_event.unallocated_cost, 0) <> 0
          ) THEN 'legacy'
        WHEN revision.event_id IS NOT NULL THEN 'revision'
        ELSE 'unpriced'
      END AS effective_source
    FROM public.tokend_usage_events AS usage_event
    LEFT JOIN public.tokend_event_cost_revisions AS revision
      ON revision.version = v_active_catalog_version
     AND revision.member_code = usage_event.member_code
     AND revision.event_id = usage_event.id
  ), effective AS (
    SELECT
      selected.model_label,
      selected.total_tokens,
      CASE
        WHEN selected.effective_source = 'reported'
          THEN COALESCE(selected.base_total_cost, 0)::NUMERIC
        WHEN selected.effective_source = 'legacy'
          THEN COALESCE(selected.base_total_cost, 0)::NUMERIC
        WHEN selected.effective_source = 'revision'
          THEN COALESCE(selected.revision_total_cost, 0)::NUMERIC
        ELSE 0::NUMERIC
      END AS effective_total_cost,
      CASE
        WHEN selected.effective_source = 'reported' THEN 'reported'
        WHEN selected.effective_source = 'legacy' THEN 'legacy'
        WHEN selected.effective_source = 'revision'
          THEN COALESCE(selected.revision_pricing_status, 'unpriced')
        ELSE 'unpriced'
      END AS effective_pricing_status
    FROM selected
  ), model_rollup AS MATERIALIZED (
    SELECT
      effective.model_label AS model,
      count(*)::BIGINT AS event_count,
      count(*) FILTER (WHERE effective.total_tokens > 0)::BIGINT AS eligible_event_count,
      count(*) FILTER (
        WHERE effective.total_tokens > 0
          AND COALESCE(effective.effective_total_cost, 0) = 0
      )::BIGINT AS eligible_zero_cost_event_count,
      COALESCE(sum(effective.total_tokens) FILTER (
        WHERE effective.total_tokens > 0
          AND COALESCE(effective.effective_total_cost, 0) = 0
      ), 0)::BIGINT AS zero_cost_total_tokens,
      count(*) FILTER (
        WHERE effective.total_tokens > 0
          AND effective.effective_pricing_status = 'reported'
      )::BIGINT AS reported_count,
      count(*) FILTER (
        WHERE effective.total_tokens > 0
          AND effective.effective_pricing_status = 'estimated'
      )::BIGINT AS estimated_count,
      count(*) FILTER (
        WHERE effective.total_tokens > 0
          AND effective.effective_pricing_status = 'zero_rate'
      )::BIGINT AS zero_rate_count,
      count(*) FILTER (
        WHERE effective.total_tokens > 0
          AND effective.effective_pricing_status = 'unpriced'
      )::BIGINT AS unpriced_count,
      count(*) FILTER (
        WHERE effective.total_tokens > 0
          AND effective.effective_pricing_status = 'legacy'
      )::BIGINT AS legacy_count,
      count(*) FILTER (
        WHERE effective.total_tokens > 0
          AND effective.effective_pricing_status IS NULL
      )::BIGINT AS unset_count,
      COALESCE(sum(effective.effective_total_cost), 0)::NUMERIC AS total_cost
    FROM effective
    GROUP BY effective.model_label
  ), bounded_models AS MATERIALIZED (
    SELECT
      model_rollup.model,
      model_rollup.eligible_zero_cost_event_count AS event_count,
      model_rollup.zero_cost_total_tokens AS total_tokens
    FROM model_rollup
    WHERE model_rollup.eligible_zero_cost_event_count > 0
    ORDER BY model_rollup.eligible_zero_cost_event_count DESC, model_rollup.model
    LIMIT 100
  )
  SELECT
    COALESCE(sum(model_rollup.event_count), 0)::BIGINT,
    COALESCE(sum(model_rollup.eligible_event_count), 0)::BIGINT,
    COALESCE(sum(model_rollup.eligible_zero_cost_event_count), 0)::BIGINT,
    COALESCE(sum(model_rollup.unpriced_count), 0)::BIGINT,
    COALESCE(sum(model_rollup.total_cost), 0)::NUMERIC(20,10),
    json_build_object(
      'reported', COALESCE(sum(model_rollup.reported_count), 0)::BIGINT,
      'estimated', COALESCE(sum(model_rollup.estimated_count), 0)::BIGINT,
      'zero_rate', COALESCE(sum(model_rollup.zero_rate_count), 0)::BIGINT,
      'unpriced', COALESCE(sum(model_rollup.unpriced_count), 0)::BIGINT,
      'legacy', COALESCE(sum(model_rollup.legacy_count), 0)::BIGINT,
      'unset', COALESCE(sum(model_rollup.unset_count), 0)::BIGINT
    ),
    (SELECT count(*)::BIGINT
     FROM model_rollup AS zero_cost_model
     WHERE zero_cost_model.eligible_zero_cost_event_count > 0),
    (SELECT COALESCE(
      json_agg(
        json_build_object(
          'model', bounded_models.model,
          'eventCount', bounded_models.event_count,
          'totalTokens', bounded_models.total_tokens
        ) ORDER BY bounded_models.event_count DESC, bounded_models.model
      ),
      '[]'::JSON
    ) FROM bounded_models),
    GREATEST(
      COALESCE(sum(model_rollup.eligible_zero_cost_event_count), 0)
        - (SELECT COALESCE(sum(bounded_models.event_count), 0) FROM bounded_models),
      0
    )::BIGINT
  INTO
    v_event_count,
    v_eligible_event_count,
    v_eligible_zero_cost_count,
    v_unpriced_event_count,
    v_total_cost,
    v_status_counts,
    v_zero_cost_model_count,
    v_zero_cost_by_model,
    v_zero_cost_other_event_count
  FROM model_rollup;

  SELECT count(*)::BIGINT
  INTO v_legacy_price_row_count
  FROM public.tokend_model_prices;

  v_unpriced_share := CASE
    WHEN v_eligible_event_count = 0 THEN 0::NUMERIC
    ELSE round(v_unpriced_event_count::NUMERIC / v_eligible_event_count::NUMERIC, 10)
  END;

  IF v_target_ingest_epoch IS NOT NULL THEN
    SELECT COALESCE(sum(epoch_row.event_count), 0)::BIGINT
    INTO v_post_snapshot_event_count
    FROM public.tokend_pricing_ingest_epochs AS epoch_row
    WHERE epoch_row.epoch > v_target_ingest_epoch;
  END IF;

  IF v_active_catalog_version IS NOT NULL
    AND v_previous_catalog_version IS NOT NULL
    AND v_active_catalog_version <> v_previous_catalog_version
    AND EXISTS (
      SELECT 1 FROM public.tokend_event_cost_revisions
      WHERE version = v_active_catalog_version
    )
    AND EXISTS (
      SELECT 1 FROM public.tokend_event_cost_revisions
      WHERE version = v_previous_catalog_version
    ) THEN
    SELECT count(*)::BIGINT
    INTO v_members_over_2x_count
    FROM (
      SELECT revision.member_code
      FROM public.tokend_event_cost_revisions AS revision
      WHERE revision.version IN (v_active_catalog_version, v_previous_catalog_version)
      GROUP BY revision.member_code
      HAVING count(*) FILTER (WHERE revision.version = v_active_catalog_version) > 0
        AND count(*) FILTER (WHERE revision.version = v_previous_catalog_version) > 0
        AND COALESCE(sum(revision.total_cost) FILTER (
          WHERE revision.version = v_active_catalog_version
        ), 0) > 2 * COALESCE(sum(revision.total_cost) FILTER (
          WHERE revision.version = v_previous_catalog_version
        ), 0)
    ) AS member_rollup;
  END IF;

  SELECT count(*)::BIGINT
  INTO v_rollout_fixture_count
  FROM public.tokend_members
  WHERE member_code LIKE 'ROLL%';

  RETURN json_build_object(
    'authoritative', TRUE,
    'source', CASE
      WHEN v_active_run_status = 'active' AND v_active_reconciliation_hash IS NOT NULL
        THEN 'frozen_reconciled_run'
      ELSE 'admin_aggregate'
    END,
    'eventCount', v_event_count,
    'eligibleEventCount', v_eligible_event_count,
    'eligibleZeroCostEventCount', v_eligible_zero_cost_count,
    'zeroCostByModel', v_zero_cost_by_model,
    'zeroCostByModelTruncated', v_zero_cost_model_count > 100,
    'zeroCostOtherEventCount', v_zero_cost_other_event_count,
    'legacyPriceRowCount', v_legacy_price_row_count,
    'statusCounts', v_status_counts,
    'unpricedEventCount', v_unpriced_event_count,
    'unpricedShare', v_unpriced_share,
    'totalCost', v_total_cost,
    'postSnapshotEventCount', v_post_snapshot_event_count,
    'membersOver2xCount', v_members_over_2x_count,
    'activeRunStatus', v_active_run_status,
    'activeReconciliationHash', v_active_reconciliation_hash,
    'rolloutFixtureCount', v_rollout_fixture_count,
    'activeCatalogVersion', v_active_catalog_version,
    'catalogHash', v_catalog_hash,
    'activeRunId', v_active_run_id,
    'previousCatalogVersion', v_previous_catalog_version,
    'previousRunId', v_previous_run_id
  );
END
$function$;

REVOKE ALL ON FUNCTION public.tokend_pricing_preflight() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tokend_pricing_preflight() TO service_role;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
