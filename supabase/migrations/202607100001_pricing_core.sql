-- Versioned pricing catalog and auditable backfill primitives.
-- This migration is additive to the existing production-compatible tokend schema.

CREATE TABLE IF NOT EXISTS public.tokend_pricing_catalogs (
  version TEXT NOT NULL,
  hash TEXT NOT NULL,
  source_checked_at DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_canonical_models (
  version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_models (
  version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  standard_input_rate NUMERIC(20,10) NOT NULL,
  standard_output_rate NUMERIC(20,10) NOT NULL,
  standard_cache_read_rate NUMERIC(20,10) NOT NULL,
  standard_cache_write_rate NUMERIC(20,10) NOT NULL,
  long_context_input_rate NUMERIC(20,10),
  long_context_output_rate NUMERIC(20,10),
  long_context_cache_read_rate NUMERIC(20,10),
  long_context_cache_write_rate NUMERIC(20,10),
  long_context_threshold BIGINT,
  source_checked_at DATE NOT NULL,
  source_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_aliases (
  version TEXT NOT NULL,
  alias TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_event_cost_revisions (
  version TEXT NOT NULL,
  member_code TEXT NOT NULL,
  event_id TEXT NOT NULL,
  backfill_run_id UUID,
  input_cost NUMERIC(20,10) NOT NULL,
  output_cost NUMERIC(20,10) NOT NULL,
  reasoning_cost NUMERIC(20,10) NOT NULL,
  cache_read_cost NUMERIC(20,10) NOT NULL,
  cache_write_cost NUMERIC(20,10) NOT NULL,
  unallocated_cost NUMERIC(20,10) NOT NULL,
  total_cost NUMERIC(20,10) NOT NULL,
  pricing_status TEXT NOT NULL,
  pricing_tier TEXT NOT NULL,
  matched_model_id TEXT,
  price_version TEXT,
  breakdown_status TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_state (
  singleton BOOLEAN NOT NULL,
  active_catalog_version TEXT,
  previous_catalog_version TEXT,
  active_backfill_run_id UUID,
  previous_backfill_run_id UUID,
  current_ingest_epoch BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_backfill_runs (
  run_id UUID NOT NULL,
  catalog_version TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  base_previous_catalog_version TEXT,
  base_previous_backfill_run_id UUID,
  target_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  before_total_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  target_ingest_epoch BIGINT NOT NULL DEFAULT 0,
  freeze_cursor_event_id TEXT,
  freeze_cursor_member_code TEXT,
  freeze_upper_event_id TEXT,
  freeze_upper_member_code TEXT,
  freeze_scanned_count BIGINT NOT NULL DEFAULT 0,
  frozen_count BIGINT NOT NULL DEFAULT 0,
  freeze_complete BOOLEAN NOT NULL DEFAULT FALSE,
  frozen_at TIMESTAMPTZ,
  priced_count BIGINT NOT NULL DEFAULT 0,
  post_snapshot_event_count BIGINT NOT NULL DEFAULT 0,
  members_over_2x_count BIGINT NOT NULL DEFAULT 0,
  cursor_member_code TEXT,
  cursor_event_id TEXT,
  reconciliation_hash TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_backfill_targets (
  run_id UUID NOT NULL,
  member_code TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_snapshot JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_ingest_epochs (
  epoch BIGINT NOT NULL,
  event_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_shadow_sessions (
  run_id UUID NOT NULL,
  member_code TEXT NOT NULL,
  session_id TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  input_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  output_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  reasoning_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  cache_read_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  cache_write_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  total_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  call_count BIGINT NOT NULL DEFAULT 0,
  reported_count BIGINT NOT NULL DEFAULT 0,
  estimated_count BIGINT NOT NULL DEFAULT 0,
  zero_rate_count BIGINT NOT NULL DEFAULT 0,
  unpriced_count BIGINT NOT NULL DEFAULT 0,
  legacy_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tokend_pricing_audit (
  audit_id UUID NOT NULL,
  run_id UUID,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  old_catalog_version TEXT,
  new_catalog_version TEXT,
  old_backfill_run_id UUID,
  new_backfill_run_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_catalogs_pkey'
      AND conrelid = 'public.tokend_pricing_catalogs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_catalogs
      ADD CONSTRAINT tokend_pricing_catalogs_pkey PRIMARY KEY (version);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_catalogs_hash_key'
      AND conrelid = 'public.tokend_pricing_catalogs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_catalogs
      ADD CONSTRAINT tokend_pricing_catalogs_hash_key UNIQUE (hash);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_catalogs_hash_format_check'
      AND conrelid = 'public.tokend_pricing_catalogs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_catalogs
      ADD CONSTRAINT tokend_pricing_catalogs_hash_format_check
      CHECK (hash ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_canonical_models_pkey'
      AND conrelid = 'public.tokend_pricing_canonical_models'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_canonical_models
      ADD CONSTRAINT tokend_pricing_canonical_models_pkey PRIMARY KEY (version, model_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_canonical_models_catalog_fkey'
      AND conrelid = 'public.tokend_pricing_canonical_models'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_canonical_models
      ADD CONSTRAINT tokend_pricing_canonical_models_catalog_fkey
      FOREIGN KEY (version) REFERENCES public.tokend_pricing_catalogs(version);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_models_pkey'
      AND conrelid = 'public.tokend_pricing_models'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_models
      ADD CONSTRAINT tokend_pricing_models_pkey PRIMARY KEY (version, model_id, valid_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_models_canonical_fkey'
      AND conrelid = 'public.tokend_pricing_models'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_models
      ADD CONSTRAINT tokend_pricing_models_canonical_fkey
      FOREIGN KEY (version, model_id)
      REFERENCES public.tokend_pricing_canonical_models(version, model_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_models_interval_check'
      AND conrelid = 'public.tokend_pricing_models'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_models
      ADD CONSTRAINT tokend_pricing_models_interval_check
      CHECK (valid_to IS NULL OR valid_to > valid_from);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_models_rates_check'
      AND conrelid = 'public.tokend_pricing_models'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_models
      ADD CONSTRAINT tokend_pricing_models_rates_check CHECK (
        standard_input_rate >= 0
        AND standard_output_rate >= 0
        AND standard_cache_read_rate >= 0
        AND standard_cache_write_rate >= 0
        AND (long_context_input_rate IS NULL OR long_context_input_rate >= 0)
        AND (long_context_output_rate IS NULL OR long_context_output_rate >= 0)
        AND (long_context_cache_read_rate IS NULL OR long_context_cache_read_rate >= 0)
        AND (long_context_cache_write_rate IS NULL OR long_context_cache_write_rate >= 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_models_long_context_check'
      AND conrelid = 'public.tokend_pricing_models'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_models
      ADD CONSTRAINT tokend_pricing_models_long_context_check CHECK (
        (
          long_context_input_rate IS NULL
          AND long_context_output_rate IS NULL
          AND long_context_cache_read_rate IS NULL
          AND long_context_cache_write_rate IS NULL
          AND long_context_threshold IS NULL
        ) OR (
          long_context_input_rate IS NOT NULL
          AND long_context_output_rate IS NOT NULL
          AND long_context_cache_read_rate IS NOT NULL
          AND long_context_cache_write_rate IS NOT NULL
          AND long_context_threshold > 0
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_aliases_pkey'
      AND conrelid = 'public.tokend_pricing_aliases'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_aliases
      ADD CONSTRAINT tokend_pricing_aliases_pkey PRIMARY KEY (version, alias);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_aliases_canonical_fkey'
      AND conrelid = 'public.tokend_pricing_aliases'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_aliases
      ADD CONSTRAINT tokend_pricing_aliases_canonical_fkey
      FOREIGN KEY (version, model_id)
      REFERENCES public.tokend_pricing_canonical_models(version, model_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_runs_pkey'
      AND conrelid = 'public.tokend_pricing_backfill_runs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_runs
      ADD CONSTRAINT tokend_pricing_backfill_runs_pkey PRIMARY KEY (run_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_runs_catalog_fkey'
      AND conrelid = 'public.tokend_pricing_backfill_runs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_runs
      ADD CONSTRAINT tokend_pricing_backfill_runs_catalog_fkey
      FOREIGN KEY (catalog_version) REFERENCES public.tokend_pricing_catalogs(version);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_runs_base_previous_catalog_fkey'
      AND conrelid = 'public.tokend_pricing_backfill_runs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_runs
      ADD CONSTRAINT tokend_pricing_backfill_runs_base_previous_catalog_fkey
      FOREIGN KEY (base_previous_catalog_version)
      REFERENCES public.tokend_pricing_catalogs(version);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_runs_base_previous_run_fkey'
      AND conrelid = 'public.tokend_pricing_backfill_runs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_runs
      ADD CONSTRAINT tokend_pricing_backfill_runs_base_previous_run_fkey
      FOREIGN KEY (base_previous_backfill_run_id)
      REFERENCES public.tokend_pricing_backfill_runs(run_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_runs_counts_check'
      AND conrelid = 'public.tokend_pricing_backfill_runs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_runs
      ADD CONSTRAINT tokend_pricing_backfill_runs_counts_check CHECK (
        target_count >= 0
        AND target_ingest_epoch >= 0
        AND freeze_scanned_count >= 0
        AND frozen_count >= 0
        AND priced_count >= 0
        AND post_snapshot_event_count >= 0
        AND members_over_2x_count >= 0
        AND input_tokens >= 0
        AND output_tokens >= 0
        AND reasoning_tokens >= 0
        AND cache_read_tokens >= 0
        AND cache_write_tokens >= 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_ingest_epochs_pkey'
      AND conrelid = 'public.tokend_pricing_ingest_epochs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_ingest_epochs
      ADD CONSTRAINT tokend_pricing_ingest_epochs_pkey PRIMARY KEY (epoch);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_ingest_epochs_counts_check'
      AND conrelid = 'public.tokend_pricing_ingest_epochs'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_ingest_epochs
      ADD CONSTRAINT tokend_pricing_ingest_epochs_counts_check
      CHECK (epoch >= 0 AND event_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_event_cost_revisions_pkey'
      AND conrelid = 'public.tokend_event_cost_revisions'::regclass
  ) THEN
    ALTER TABLE public.tokend_event_cost_revisions
      ADD CONSTRAINT tokend_event_cost_revisions_pkey PRIMARY KEY (version, member_code, event_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_event_cost_revisions_catalog_fkey'
      AND conrelid = 'public.tokend_event_cost_revisions'::regclass
  ) THEN
    ALTER TABLE public.tokend_event_cost_revisions
      ADD CONSTRAINT tokend_event_cost_revisions_catalog_fkey
      FOREIGN KEY (version) REFERENCES public.tokend_pricing_catalogs(version);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_event_cost_revisions_run_fkey'
      AND conrelid = 'public.tokend_event_cost_revisions'::regclass
  ) THEN
    ALTER TABLE public.tokend_event_cost_revisions
      ADD CONSTRAINT tokend_event_cost_revisions_run_fkey
      FOREIGN KEY (backfill_run_id) REFERENCES public.tokend_pricing_backfill_runs(run_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_event_cost_revisions_model_fkey'
      AND conrelid = 'public.tokend_event_cost_revisions'::regclass
  ) THEN
    ALTER TABLE public.tokend_event_cost_revisions
      ADD CONSTRAINT tokend_event_cost_revisions_model_fkey
      FOREIGN KEY (version, matched_model_id)
      REFERENCES public.tokend_pricing_canonical_models(version, model_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_event_cost_revisions_status_check'
      AND conrelid = 'public.tokend_event_cost_revisions'::regclass
  ) THEN
    ALTER TABLE public.tokend_event_cost_revisions
      ADD CONSTRAINT tokend_event_cost_revisions_status_check CHECK (
        pricing_status IN ('reported', 'estimated', 'zero_rate', 'unpriced', 'legacy')
        AND pricing_tier IN ('standard', 'long_context')
        AND breakdown_status IN ('reconciled', 'unallocated', 'invalid')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_state_pkey'
      AND conrelid = 'public.tokend_pricing_state'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_state
      ADD CONSTRAINT tokend_pricing_state_pkey PRIMARY KEY (singleton);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_state_singleton_check'
      AND conrelid = 'public.tokend_pricing_state'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_state
      ADD CONSTRAINT tokend_pricing_state_singleton_check CHECK (singleton);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_state_active_catalog_fkey'
      AND conrelid = 'public.tokend_pricing_state'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_state
      ADD CONSTRAINT tokend_pricing_state_active_catalog_fkey
      FOREIGN KEY (active_catalog_version) REFERENCES public.tokend_pricing_catalogs(version);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_state_previous_catalog_fkey'
      AND conrelid = 'public.tokend_pricing_state'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_state
      ADD CONSTRAINT tokend_pricing_state_previous_catalog_fkey
      FOREIGN KEY (previous_catalog_version) REFERENCES public.tokend_pricing_catalogs(version);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_state_active_run_fkey'
      AND conrelid = 'public.tokend_pricing_state'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_state
      ADD CONSTRAINT tokend_pricing_state_active_run_fkey
      FOREIGN KEY (active_backfill_run_id) REFERENCES public.tokend_pricing_backfill_runs(run_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_state_previous_run_fkey'
      AND conrelid = 'public.tokend_pricing_state'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_state
      ADD CONSTRAINT tokend_pricing_state_previous_run_fkey
      FOREIGN KEY (previous_backfill_run_id) REFERENCES public.tokend_pricing_backfill_runs(run_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_targets_pkey'
      AND conrelid = 'public.tokend_pricing_backfill_targets'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_targets
      ADD CONSTRAINT tokend_pricing_backfill_targets_pkey PRIMARY KEY (run_id, member_code, event_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_targets_run_fkey'
      AND conrelid = 'public.tokend_pricing_backfill_targets'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_targets
      ADD CONSTRAINT tokend_pricing_backfill_targets_run_fkey
      FOREIGN KEY (run_id) REFERENCES public.tokend_pricing_backfill_runs(run_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_targets_hash_check'
      AND conrelid = 'public.tokend_pricing_backfill_targets'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_targets
      ADD CONSTRAINT tokend_pricing_backfill_targets_hash_check
      CHECK (snapshot_hash ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_shadow_sessions_pkey'
      AND conrelid = 'public.tokend_pricing_shadow_sessions'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_shadow_sessions
      ADD CONSTRAINT tokend_pricing_shadow_sessions_pkey PRIMARY KEY (run_id, member_code, session_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_shadow_sessions_run_fkey'
      AND conrelid = 'public.tokend_pricing_shadow_sessions'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_shadow_sessions
      ADD CONSTRAINT tokend_pricing_shadow_sessions_run_fkey
      FOREIGN KEY (run_id) REFERENCES public.tokend_pricing_backfill_runs(run_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_audit_pkey'
      AND conrelid = 'public.tokend_pricing_audit'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_audit
      ADD CONSTRAINT tokend_pricing_audit_pkey PRIMARY KEY (audit_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_audit_run_fkey'
      AND conrelid = 'public.tokend_pricing_audit'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_audit
      ADD CONSTRAINT tokend_pricing_audit_run_fkey
      FOREIGN KEY (run_id) REFERENCES public.tokend_pricing_backfill_runs(run_id);
  END IF;

END
$constraints$;

CREATE INDEX IF NOT EXISTS tokend_pricing_models_effective_idx
  ON public.tokend_pricing_models (version, model_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS tokend_pricing_aliases_model_idx
  ON public.tokend_pricing_aliases (version, model_id);
CREATE INDEX IF NOT EXISTS tokend_event_cost_revisions_run_idx
  ON public.tokend_event_cost_revisions (backfill_run_id, member_code, event_id)
  WHERE backfill_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tokend_pricing_backfill_targets_pending_idx
  ON public.tokend_pricing_backfill_targets (run_id, member_code, event_id)
  WHERE processed_at IS NULL;

CREATE TEMP TABLE IF NOT EXISTS tokend_expected_pricing_models (
  version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  standard_input_rate NUMERIC(20,10) NOT NULL,
  standard_output_rate NUMERIC(20,10) NOT NULL,
  standard_cache_read_rate NUMERIC(20,10) NOT NULL,
  standard_cache_write_rate NUMERIC(20,10) NOT NULL,
  long_context_input_rate NUMERIC(20,10),
  long_context_output_rate NUMERIC(20,10),
  long_context_cache_read_rate NUMERIC(20,10),
  long_context_cache_write_rate NUMERIC(20,10),
  long_context_threshold BIGINT,
  source_checked_at DATE NOT NULL,
  source_url TEXT NOT NULL,
  PRIMARY KEY (version, model_id, valid_from)
);

CREATE TEMP TABLE IF NOT EXISTS tokend_expected_pricing_aliases (
  version TEXT NOT NULL,
  alias TEXT NOT NULL,
  model_id TEXT NOT NULL,
  PRIMARY KEY (version, alias)
);

CREATE OR REPLACE FUNCTION public.tokend_install_pricing_catalog(
  p_version TEXT,
  p_hash TEXT,
  p_source_checked_at DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing public.tokend_pricing_catalogs%ROWTYPE;
  v_hash_owner TEXT;
BEGIN
  IF p_version IS NULL OR btrim(p_version) = ''
    OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
    OR p_source_checked_at IS NULL THEN
    RAISE EXCEPTION 'Invalid pricing catalog header'
      USING ERRCODE = '22000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_temp.tokend_expected_pricing_models WHERE version = p_version
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.tokend_expected_pricing_models WHERE version <> p_version
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.tokend_expected_pricing_aliases WHERE version <> p_version
  ) THEN
    RAISE EXCEPTION 'Generated pricing rows do not match catalog version %', p_version
      USING ERRCODE = '22000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.tokend_expected_pricing_aliases AS alias_row
    LEFT JOIN pg_temp.tokend_expected_pricing_models AS model_row
      ON model_row.version = alias_row.version
     AND model_row.model_id = alias_row.model_id
    WHERE model_row.model_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Generated pricing alias references a missing canonical model'
      USING ERRCODE = '22000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.tokend_expected_pricing_models AS model_row
    WHERE model_row.valid_to IS NOT NULL
      AND model_row.valid_to <= model_row.valid_from
  ) OR EXISTS (
    SELECT 1
    FROM pg_temp.tokend_expected_pricing_models AS left_row
    JOIN pg_temp.tokend_expected_pricing_models AS right_row
      ON right_row.version = left_row.version
     AND right_row.model_id = left_row.model_id
     AND right_row.valid_from > left_row.valid_from
     AND right_row.valid_from < COALESCE(left_row.valid_to, 'infinity'::TIMESTAMPTZ)
  ) THEN
    RAISE EXCEPTION 'Generated pricing catalog contains an invalid or overlapping interval'
      USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_existing
  FROM public.tokend_pricing_catalogs
  WHERE version = p_version;

  IF FOUND THEN
    IF v_existing.hash <> p_hash
      OR v_existing.source_checked_at <> p_source_checked_at THEN
      RAISE EXCEPTION 'Published pricing catalog % conflicts with generated header', p_version
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (
        (
          SELECT model_id
          FROM public.tokend_pricing_canonical_models
          WHERE version = p_version
          EXCEPT
          SELECT model_id
          FROM pg_temp.tokend_expected_pricing_models
          WHERE version = p_version
        )
        UNION ALL
        (
          SELECT model_id
          FROM pg_temp.tokend_expected_pricing_models
          WHERE version = p_version
          EXCEPT
          SELECT model_id
          FROM public.tokend_pricing_canonical_models
          WHERE version = p_version
        )
      ) AS canonical_differences
    ) THEN
      RAISE EXCEPTION 'Published pricing catalog % has different canonical models', p_version
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (
        (
          SELECT
            version, model_id, provider, valid_from, valid_to,
            standard_input_rate, standard_output_rate,
            standard_cache_read_rate, standard_cache_write_rate,
            long_context_input_rate, long_context_output_rate,
            long_context_cache_read_rate, long_context_cache_write_rate,
            long_context_threshold, source_checked_at, source_url
          FROM public.tokend_pricing_models
          WHERE version = p_version
          EXCEPT
          SELECT
            version, model_id, provider, valid_from, valid_to,
            standard_input_rate, standard_output_rate,
            standard_cache_read_rate, standard_cache_write_rate,
            long_context_input_rate, long_context_output_rate,
            long_context_cache_read_rate, long_context_cache_write_rate,
            long_context_threshold, source_checked_at, source_url
          FROM pg_temp.tokend_expected_pricing_models
          WHERE version = p_version
        )
        UNION ALL
        (
          SELECT
            version, model_id, provider, valid_from, valid_to,
            standard_input_rate, standard_output_rate,
            standard_cache_read_rate, standard_cache_write_rate,
            long_context_input_rate, long_context_output_rate,
            long_context_cache_read_rate, long_context_cache_write_rate,
            long_context_threshold, source_checked_at, source_url
          FROM pg_temp.tokend_expected_pricing_models
          WHERE version = p_version
          EXCEPT
          SELECT
            version, model_id, provider, valid_from, valid_to,
            standard_input_rate, standard_output_rate,
            standard_cache_read_rate, standard_cache_write_rate,
            long_context_input_rate, long_context_output_rate,
            long_context_cache_read_rate, long_context_cache_write_rate,
            long_context_threshold, source_checked_at, source_url
          FROM public.tokend_pricing_models
          WHERE version = p_version
        )
      ) AS model_differences
    ) THEN
      RAISE EXCEPTION 'Published pricing catalog % has different model prices', p_version
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1 FROM (
        (
          SELECT version, alias, model_id
          FROM public.tokend_pricing_aliases
          WHERE version = p_version
          EXCEPT
          SELECT version, alias, model_id
          FROM pg_temp.tokend_expected_pricing_aliases
          WHERE version = p_version
        )
        UNION ALL
        (
          SELECT version, alias, model_id
          FROM pg_temp.tokend_expected_pricing_aliases
          WHERE version = p_version
          EXCEPT
          SELECT version, alias, model_id
          FROM public.tokend_pricing_aliases
          WHERE version = p_version
        )
      ) AS alias_differences
    ) THEN
      RAISE EXCEPTION 'Published pricing catalog % has different aliases', p_version
        USING ERRCODE = '55000';
    END IF;

    RETURN;
  END IF;

  SELECT version INTO v_hash_owner
  FROM public.tokend_pricing_catalogs
  WHERE hash = p_hash;
  IF FOUND THEN
    RAISE EXCEPTION 'Pricing catalog hash % is already owned by version %', p_hash, v_hash_owner
      USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('tokend.pricing_catalog_install', p_version, TRUE);
  BEGIN
    INSERT INTO public.tokend_pricing_catalogs (version, hash, source_checked_at)
    VALUES (p_version, p_hash, p_source_checked_at);

    INSERT INTO public.tokend_pricing_canonical_models (version, model_id)
    SELECT DISTINCT version, model_id
    FROM pg_temp.tokend_expected_pricing_models
    WHERE version = p_version;

    INSERT INTO public.tokend_pricing_models (
      version, model_id, provider, valid_from, valid_to,
      standard_input_rate, standard_output_rate,
      standard_cache_read_rate, standard_cache_write_rate,
      long_context_input_rate, long_context_output_rate,
      long_context_cache_read_rate, long_context_cache_write_rate,
      long_context_threshold, source_checked_at, source_url
    )
    SELECT
      version, model_id, provider, valid_from, valid_to,
      standard_input_rate, standard_output_rate,
      standard_cache_read_rate, standard_cache_write_rate,
      long_context_input_rate, long_context_output_rate,
      long_context_cache_read_rate, long_context_cache_write_rate,
      long_context_threshold, source_checked_at, source_url
    FROM pg_temp.tokend_expected_pricing_models
    WHERE version = p_version;

    INSERT INTO public.tokend_pricing_aliases (version, alias, model_id)
    SELECT version, alias, model_id
    FROM pg_temp.tokend_expected_pricing_aliases
    WHERE version = p_version;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('tokend.pricing_catalog_install', '', TRUE);
    RAISE;
  END;
  PERFORM set_config('tokend.pricing_catalog_install', '', TRUE);
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_reject_pricing_catalog_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Published pricing catalog headers are immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_guard_pricing_catalog_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_version TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_version := NEW.version;
    IF EXISTS (
      SELECT 1 FROM public.tokend_pricing_catalogs WHERE version = v_version
    ) AND current_setting('tokend.pricing_catalog_install', TRUE) IS DISTINCT FROM v_version THEN
      RAISE EXCEPTION 'Published pricing catalog % does not accept direct inserts', v_version
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Published pricing catalog content is immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION public.tokend_guard_pricing_backfill_target()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Backfill targets are immutable once captured'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.member_code IS DISTINCT FROM OLD.member_code
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.event_snapshot IS DISTINCT FROM OLD.event_snapshot
    OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (
      OLD.processed_at IS NOT NULL
      AND NEW.processed_at IS DISTINCT FROM OLD.processed_at
    ) THEN
    RAISE EXCEPTION 'Backfill target snapshots and completed state are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.tokend_install_pricing_catalog(TEXT, TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tokend_reject_pricing_catalog_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tokend_guard_pricing_catalog_content() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tokend_guard_pricing_backfill_target() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tokend_install_pricing_catalog(TEXT, TEXT, DATE) FROM service_role;
REVOKE ALL ON FUNCTION public.tokend_reject_pricing_catalog_mutation() FROM service_role;
REVOKE ALL ON FUNCTION public.tokend_guard_pricing_catalog_content() FROM service_role;
REVOKE ALL ON FUNCTION public.tokend_guard_pricing_backfill_target() FROM service_role;

DO $triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tokend_pricing_catalogs_immutable'
      AND tgrelid = 'public.tokend_pricing_catalogs'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tokend_pricing_catalogs_immutable
      BEFORE UPDATE OR DELETE ON public.tokend_pricing_catalogs
      FOR EACH ROW EXECUTE FUNCTION public.tokend_reject_pricing_catalog_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tokend_pricing_canonical_models_immutable'
      AND tgrelid = 'public.tokend_pricing_canonical_models'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tokend_pricing_canonical_models_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON public.tokend_pricing_canonical_models
      FOR EACH ROW EXECUTE FUNCTION public.tokend_guard_pricing_catalog_content();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tokend_pricing_models_immutable'
      AND tgrelid = 'public.tokend_pricing_models'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tokend_pricing_models_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON public.tokend_pricing_models
      FOR EACH ROW EXECUTE FUNCTION public.tokend_guard_pricing_catalog_content();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tokend_pricing_aliases_immutable'
      AND tgrelid = 'public.tokend_pricing_aliases'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tokend_pricing_aliases_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON public.tokend_pricing_aliases
      FOR EACH ROW EXECUTE FUNCTION public.tokend_guard_pricing_catalog_content();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tokend_pricing_backfill_targets_immutable'
      AND tgrelid = 'public.tokend_pricing_backfill_targets'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tokend_pricing_backfill_targets_immutable
      BEFORE UPDATE OR DELETE ON public.tokend_pricing_backfill_targets
      FOR EACH ROW EXECUTE FUNCTION public.tokend_guard_pricing_backfill_target();
  END IF;
END
$triggers$;

ALTER TABLE public.tokend_pricing_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_canonical_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_event_cost_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_backfill_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_ingest_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_shadow_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokend_pricing_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_catalogs FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_canonical_models FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_models FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_aliases FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_event_cost_revisions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_state FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_backfill_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_backfill_targets FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_ingest_epochs FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_shadow_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_audit FROM PUBLIC, anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_catalogs FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_canonical_models FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_models FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_aliases FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_event_cost_revisions FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_state FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_backfill_runs FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_backfill_targets FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_ingest_epochs FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_shadow_sessions FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.tokend_pricing_audit FROM service_role;

GRANT SELECT ON TABLE public.tokend_pricing_catalogs TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_canonical_models TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_models TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_aliases TO service_role;
GRANT SELECT ON TABLE public.tokend_event_cost_revisions TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_state TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_backfill_runs TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_backfill_targets TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_ingest_epochs TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_shadow_sessions TO service_role;
GRANT SELECT ON TABLE public.tokend_pricing_audit TO service_role;
GRANT DELETE ON TABLE public.tokend_event_cost_revisions TO service_role;

INSERT INTO public.tokend_pricing_state (
  singleton,
  active_catalog_version,
  previous_catalog_version,
  active_backfill_run_id,
  previous_backfill_run_id
)
VALUES (TRUE, NULL, NULL, NULL, NULL)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO public.tokend_pricing_ingest_epochs (epoch, event_count)
VALUES (0, 0)
ON CONFLICT (epoch) DO NOTHING;

-- BEGIN GENERATED PRICING CATALOG
-- Generated from cli/pricing/catalog.ts. Do not edit by hand.
TRUNCATE TABLE pg_temp.tokend_expected_pricing_models;
TRUNCATE TABLE pg_temp.tokend_expected_pricing_aliases;
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'MiniMax-M2.7', 'minimax', '2026-06-12T00:00:00Z', NULL, 0.3, 1.2, 0.06, 0.375, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'MiniMax-M3', 'minimax', '2026-06-12T00:00:00Z', NULL, 0.3, 1.2, 0.06, 0.375, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-fable-5', 'anthropic', '2026-06-09T00:00:00Z', NULL, 10, 50, 1, 12.5, NULL, NULL, NULL, NULL, NULL, '2026-07-10', 'https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-haiku-3', 'anthropic', '2026-06-12T00:00:00Z', NULL, 0.25, 1.25, 0.03, 0.3, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-haiku-3-5', 'anthropic', '2026-06-12T00:00:00Z', NULL, 0.8, 4, 0.08, 1, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-haiku-4-5', 'anthropic', '2026-06-12T00:00:00Z', NULL, 1, 5, 0.1, 1.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-haiku-4-5-20251001', 'anthropic', '2026-06-12T00:00:00Z', NULL, 1, 5, 0.1, 1.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-opus-4', 'anthropic', '2026-06-12T00:00:00Z', NULL, 15, 75, 1.5, 18.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-opus-4-1', 'anthropic', '2026-06-12T00:00:00Z', NULL, 15, 75, 1.5, 18.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-opus-4-5', 'anthropic', '2026-06-12T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-opus-4-6', 'anthropic', '2026-06-12T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-opus-4-7', 'anthropic', '2026-06-12T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-opus-4-8', 'anthropic', '2026-06-12T00:00:00Z', NULL, 5, 25, 0.5, 6.25, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-sonnet-3-7', 'anthropic', '2026-06-12T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-sonnet-4', 'anthropic', '2026-06-12T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-sonnet-4-5', 'anthropic', '2026-06-12T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'claude-sonnet-4-6', 'anthropic', '2026-06-12T00:00:00Z', NULL, 3, 15, 0.3, 3.75, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'codex-auto-review', 'openai', '2026-06-12T00:00:00Z', NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gemini-2.5-pro', 'google', '2026-06-12T00:00:00Z', NULL, 1.25, 10, 0.31, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gemini-3-pro-preview', 'google', '2026-06-12T00:00:00Z', NULL, 2, 12, 0.2, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'glm-4.5-air', 'zhipu', '2026-06-12T00:00:00Z', NULL, 0.2, 1.1, 0.03, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'glm-4.7', 'zhipu', '2026-06-12T00:00:00Z', NULL, 0.6, 2.2, 0.11, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'glm-4.7-flashx', 'zhipu', '2026-06-12T00:00:00Z', NULL, 0.07, 0.4, 0.01, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'glm-4.7-free', 'zhipu', '2026-06-12T00:00:00Z', NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'glm-5', 'zhipu', '2026-06-12T00:00:00Z', NULL, 1, 3.2, 0.2, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'glm-5-turbo', 'zhipu', '2026-06-12T00:00:00Z', NULL, 1.2, 4, 0.24, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'glm-5.1', 'zhipu', '2026-06-12T00:00:00Z', NULL, 1.4, 4.4, 0.26, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'glm-5.2', 'zhipu', '2026-06-12T00:00:00Z', NULL, 1.4, 4.4, 0.26, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-4o', 'openai', '2026-06-12T00:00:00Z', NULL, 2.5, 10, 1.25, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-5-codex', 'openai', '2026-06-12T00:00:00Z', NULL, 1.25, 10, 0.125, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-5.3-codex', 'openai', '2026-06-12T00:00:00Z', NULL, 1.75, 14, 0.175, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-5.3-codex-spark', 'openai', '2026-06-12T00:00:00Z', NULL, 1.75, 14, 0.175, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-5.4', 'openai', '2026-06-12T00:00:00Z', NULL, 2.5, 15, 0.25, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-5.5', 'openai', '2026-06-12T00:00:00Z', NULL, 5, 30, 0.5, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-5.6-luna', 'openai', '2026-06-26T00:00:00Z', NULL, 1, 6, 0.1, 1.25, 2, 9, 0.2, 2.5, 272000, '2026-07-10', 'https://developers.openai.com/api/docs/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-5.6-sol', 'openai', '2026-06-26T00:00:00Z', NULL, 5, 30, 0.5, 6.25, 10, 45, 1, 12.5, 272000, '2026-07-10', 'https://developers.openai.com/api/docs/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'gpt-5.6-terra', 'openai', '2026-06-26T00:00:00Z', NULL, 2.5, 15, 0.25, 3.125, 5, 22.5, 0.5, 6.25, 272000, '2026-07-10', 'https://developers.openai.com/api/docs/pricing');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'grok-code', 'xai', '2026-06-12T00:00:00Z', NULL, 0.2, 1.5, 0.02, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'kimi-k2-thinking', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.6, 2.5, 0.15, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'kimi-k2.5', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.6, 3, 0.1, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'kimi-k2.6', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.95, 4, 0.16, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'kimi-k2.7', 'moonshot', '2026-06-12T00:00:00Z', NULL, 0.95, 4, 0.19, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_models (
  version, model_id, provider, valid_from, valid_to,
  standard_input_rate, standard_output_rate,
  standard_cache_read_rate, standard_cache_write_rate,
  long_context_input_rate, long_context_output_rate,
  long_context_cache_read_rate, long_context_cache_write_rate,
  long_context_threshold, source_checked_at, source_url
) VALUES ('2026-07-10', 'minimax-m2.1-free', 'minimax', '2026-06-12T00:00:00Z', NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, '2026-06-12', 'legacy:tokend-cli-2.4.0');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'M-2.7', 'MiniMax-M2.7');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'M-3', 'MiniMax-M3');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'anthropic/claude-fable-5', 'claude-fable-5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'claude-fable-5-thinking', 'claude-fable-5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'fable-5', 'claude-fable-5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'gpt-5.6', 'gpt-5.6-sol');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'k2p5', 'kimi-k2.5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'k2p6', 'kimi-k2.6');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'k2p7', 'kimi-k2.7');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'kimi-code/kimi-for-coding', 'kimi-k2.5');
INSERT INTO pg_temp.tokend_expected_pricing_aliases (version, alias, model_id)
VALUES ('2026-07-10', 'kimi-for-coding', 'kimi-k2.5');
SELECT public.tokend_install_pricing_catalog('2026-07-10', 'c08b7254af1f5e8d29d12b565a560e1ead0b0f882657836ec20c605831a61955', '2026-07-10');
-- END GENERATED PRICING CATALOG

-- Keep the ACCESS EXCLUSIVE window on the existing 1.3 GB event table at the
-- very end of the migration. All additions are metadata-only on PostgreSQL 17;
-- existing rows are deliberately not scanned during the release transaction.
SET lock_timeout = '2s';

ALTER TABLE public.tokend_usage_events
  ADD COLUMN IF NOT EXISTS pricing_status TEXT,
  ADD COLUMN IF NOT EXISTS pricing_tier TEXT,
  ADD COLUMN IF NOT EXISTS price_version TEXT,
  ADD COLUMN IF NOT EXISTS matched_model_id TEXT,
  ADD COLUMN IF NOT EXISTS token_semantics TEXT,
  ADD COLUMN IF NOT EXISTS unallocated_cost NUMERIC(20,10),
  ADD COLUMN IF NOT EXISTS breakdown_status TEXT,
  ADD COLUMN IF NOT EXISTS pricing_ingest_epoch BIGINT NOT NULL DEFAULT 0,
  ALTER COLUMN uploaded_at SET DEFAULT clock_timestamp();

DO $usage_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_event_cost_revisions_event_fkey'
      AND conrelid = 'public.tokend_event_cost_revisions'::regclass
  ) THEN
    ALTER TABLE public.tokend_event_cost_revisions
      ADD CONSTRAINT tokend_event_cost_revisions_event_fkey
      FOREIGN KEY (event_id, member_code)
      REFERENCES public.tokend_usage_events(id, member_code);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_backfill_targets_event_fkey'
      AND conrelid = 'public.tokend_pricing_backfill_targets'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_backfill_targets
      ADD CONSTRAINT tokend_pricing_backfill_targets_event_fkey
      FOREIGN KEY (event_id, member_code)
      REFERENCES public.tokend_usage_events(id, member_code);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_pricing_shadow_sessions_session_fkey'
      AND conrelid = 'public.tokend_pricing_shadow_sessions'::regclass
  ) THEN
    ALTER TABLE public.tokend_pricing_shadow_sessions
      ADD CONSTRAINT tokend_pricing_shadow_sessions_session_fkey
      FOREIGN KEY (session_id, member_code)
      REFERENCES public.tokend_sessions(session_id, member_code);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_usage_events_pricing_status_check'
      AND conrelid = 'public.tokend_usage_events'::regclass
  ) THEN
    ALTER TABLE public.tokend_usage_events
      ADD CONSTRAINT tokend_usage_events_pricing_status_check
      CHECK (pricing_status IS NULL OR pricing_status IN ('reported', 'estimated', 'zero_rate', 'unpriced', 'legacy'))
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_usage_events_pricing_tier_check'
      AND conrelid = 'public.tokend_usage_events'::regclass
  ) THEN
    ALTER TABLE public.tokend_usage_events
      ADD CONSTRAINT tokend_usage_events_pricing_tier_check
      CHECK (pricing_tier IS NULL OR pricing_tier IN ('standard', 'long_context'))
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_usage_events_token_semantics_check'
      AND conrelid = 'public.tokend_usage_events'::regclass
  ) THEN
    ALTER TABLE public.tokend_usage_events
      ADD CONSTRAINT tokend_usage_events_token_semantics_check
      CHECK (token_semantics IS NULL OR token_semantics IN ('disjoint', 'unknown'))
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tokend_usage_events_breakdown_status_check'
      AND conrelid = 'public.tokend_usage_events'::regclass
  ) THEN
    ALTER TABLE public.tokend_usage_events
      ADD CONSTRAINT tokend_usage_events_breakdown_status_check
      CHECK (breakdown_status IS NULL OR breakdown_status IN ('reconciled', 'unallocated', 'invalid'))
      NOT VALID;
  END IF;
END
$usage_constraints$;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
