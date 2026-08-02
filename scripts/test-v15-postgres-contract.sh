#!/usr/bin/env bash
# Runs only against a new, temporary PostgreSQL cluster on 127.0.0.1.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pg_config_bin="${PG_CONFIG:-pg_config}"
pg_bin="$($pg_config_bin --bindir)"
port="${TOKEND_PG_PORT:-55441}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/tokend-v15-postgres.XXXXXX")"
data_dir="$work_dir/data"
log_dir="$work_dir/logs"
database="tokend_v15_contract"
mkdir -p "$log_dir"

if [[ ! "$port" =~ ^[0-9]{4,5}$ ]]; then
  echo "TOKEND_PG_PORT must be a four- or five-digit port" >&2
  exit 2
fi

for binary in initdb pg_ctl psql; do
  if [[ ! -x "$pg_bin/$binary" ]]; then
    echo "missing PostgreSQL binary: $pg_bin/$binary" >&2
    exit 2
  fi
done

if command -v lsof >/dev/null 2>&1 \
  && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "refusing to use occupied port $port" >&2
  exit 2
fi

cleanup() {
  "$pg_bin/pg_ctl" -D "$data_dir" stop -m fast >>"$log_dir/postgres-stop.log" 2>&1 || true
  echo "PostgreSQL contract logs retained in a temporary directory."
}
trap cleanup EXIT

"$pg_bin/initdb" -D "$data_dir" --no-locale --encoding=UTF8 --auth=trust >"$log_dir/initdb.log"
"$pg_bin/pg_ctl" -D "$data_dir" -l "$log_dir/postgres.log" -o "-p $port -h 127.0.0.1" start >"$log_dir/postgres-start.log"

psql=("$pg_bin/psql" -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port")
"${psql[@]}" -d postgres -c "CREATE DATABASE $database" >"$log_dir/create-database.log"
"${psql[@]}" -d "$database" -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres SUPERUSER LOGIN; END IF; END \$\$; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE tokend_members (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone TEXT, member_code TEXT NOT NULL UNIQUE, tagline TEXT);" >"$log_dir/bootstrap.log"

history=(
  scripts/supabase-schema.sql
  scripts/supabase-v2-rpcs.sql
  scripts/supabase-v3-batch-fix.sql
  scripts/supabase-v3-patch.sql
  scripts/supabase-v4-fixes.sql
  scripts/supabase-v5-projects-fix.sql
  scripts/supabase-v5b-dedup-fix.sql
  scripts/supabase-v6-channel-trend-fields.sql
  scripts/supabase-v7-dashboard-timezone-scope.sql
  scripts/supabase-v8-heartbeat-visibility.sql
  scripts/supabase-v9-hermes-sync.sql
  scripts/supabase-v10-server-pricing.sql
  scripts/supabase-v11-longtail-prices.sql
  scripts/supabase-v12-truncate-project.sql
  scripts/supabase-v13-summary-perf.sql
  scripts/supabase-v14-summary-rewrite.sql
)

for migration in "${history[@]}"; do
  "${psql[@]}" -d "$database" -f "$repo_root/$migration"
done >"$log_dir/history-replay.log"

node --import tsx "$repo_root/tests/v15-backfill-index-contract.ts" >"$log_dir/backfill-index-static-contract.log"
"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.sql" >"$log_dir/backfill-index-create.log"
"${psql[@]}" -d "$database" -f "$repo_root/tests/postgres-v15-backfill-index.contract.sql" >"$log_dir/backfill-index-create-contract.log"

# v8/v9 *-validation.sql are manual validator scripts, not migrations.
"${psql[@]}" -d "$database" \
  -f "$repo_root/scripts/supabase-v15-versioned-model-prices.sql" \
  -f "$repo_root/scripts/supabase-v15-versioned-model-prices.sql" >"$log_dir/v15-apply-twice.log"
"${psql[@]}" -d "$database" -f "$repo_root/tests/postgres-v15-contract.initial.sql" >"$log_dir/contract-initial.log"

# CREATE INDEX IF NOT EXISTS would also skip a valid but wrong same-name index.
# The helper must reject that definition before the invalid-index retry case below.
"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.cleanup.sql" >"$log_dir/backfill-index-cleanup-before-wrong-valid.log"
if "${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.check.sql" >"$log_dir/backfill-index-missing-check.log" 2>&1; then
  echo "candidate index check accepted a missing index" >&2
  exit 1
fi
"${psql[@]}" -d "$database" -c "CREATE INDEX CONCURRENTLY idx_tokend_usage_events_v15_backfill_candidates ON public.tokend_usage_events (model)" >"$log_dir/backfill-index-wrong-valid-create.log"
if "${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.sql" >"$log_dir/backfill-index-wrong-valid-guard.log" 2>&1; then
  echo "candidate index script accepted a valid but wrong same-name index" >&2
  exit 1
fi
if "${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.check.sql" >"$log_dir/backfill-index-wrong-valid-check.log" 2>&1; then
  echo "candidate index check accepted a valid but wrong same-name index" >&2
  exit 1
fi
"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.cleanup.sql" >"$log_dir/backfill-index-cleanup-after-wrong-valid.log"
"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.sql" >"$log_dir/backfill-index-recreate-after-wrong-valid.log"
"${psql[@]}" -d "$database" -f "$repo_root/tests/postgres-v15-backfill-index.contract.sql" >"$log_dir/backfill-index-recreate-after-wrong-valid-contract.log"

# A failed concurrent unique build leaves an invalid same-name index. The helper
# must fail instead of letting CREATE INDEX IF NOT EXISTS silently skip it.
"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.cleanup.sql" >"$log_dir/backfill-index-cleanup-before-invalid.log"
if "${psql[@]}" -d "$database" -c "CREATE UNIQUE INDEX CONCURRENTLY idx_tokend_usage_events_v15_backfill_candidates ON public.tokend_usage_events (model)" >"$log_dir/backfill-index-invalid-create.log" 2>&1; then
  echo "expected duplicate-model concurrent index build to fail" >&2
  exit 1
fi
if "${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.sql" >"$log_dir/backfill-index-invalid-guard.log" 2>&1; then
  echo "candidate index script accepted an invalid same-name index" >&2
  exit 1
fi
if "${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.check.sql" >"$log_dir/backfill-index-invalid-check.log" 2>&1; then
  echo "candidate index check accepted an invalid same-name index" >&2
  exit 1
fi
"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.cleanup.sql" >"$log_dir/backfill-index-cleanup-after-invalid.log"
"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.sql" >"$log_dir/backfill-index-recreate.log"
"${psql[@]}" -d "$database" -f "$repo_root/tests/postgres-v15-backfill-index.contract.sql" >"$log_dir/backfill-index-recreate-contract.log"

"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-versioned-model-prices.rollback.sql" >"$log_dir/v15-rollback.log"
"${psql[@]}" -d "$database" -f "$repo_root/tests/postgres-v15-contract.rollback.sql" >"$log_dir/contract-rollback.log"
"${psql[@]}" -d "$database" -f "$repo_root/tests/postgres-v15-backfill-index.contract.sql" >"$log_dir/backfill-index-rollback-contract.log"

"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-versioned-model-prices.sql" >"$log_dir/v15-reapply.log"
"${psql[@]}" -d "$database" -f "$repo_root/tests/postgres-v15-contract.reapply.sql" >"$log_dir/contract-reapply.log"
"${psql[@]}" -d "$database" -f "$repo_root/tests/postgres-v15-backfill-index.contract.sql" >"$log_dir/backfill-index-reapply-contract.log"
"${psql[@]}" -d "$database" -f "$repo_root/scripts/supabase-v15-backfill-candidate-index.cleanup.sql" >"$log_dir/backfill-index-final-cleanup.log"

echo "v15 PostgreSQL contract passed"
