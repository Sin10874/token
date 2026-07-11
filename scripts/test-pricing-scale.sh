#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker_bin="${DOCKER_BIN:-docker}"
pg_container="${TOKEND_TEST_PG_CONTAINER:-tokend-pg17-scale}"
pg_user="${TOKEND_TEST_PGUSER:-postgres}"
pg_password="${TOKEND_TEST_PGPASSWORD:-postgres}"
scale_rows="${TOKEND_SCALE_ROWS:-700000}"
upload_clients="${TOKEND_SCALE_UPLOAD_CLIENTS:-4}"
upload_rate="${TOKEND_SCALE_UPLOAD_RATE:-20}"
freeze_load_seconds="${TOKEND_SCALE_FREEZE_LOAD_SECONDS:-90}"
backfill_load_seconds="${TOKEND_SCALE_BACKFILL_LOAD_SECONDS:-180}"
steady_load_seconds="${TOKEND_SCALE_STEADY_LOAD_SECONDS:-30}"
pre_rollout_load_seconds="${TOKEND_SCALE_PRE_ROLLOUT_LOAD_SECONDS:-30}"
min_overlap_samples="${TOKEND_SCALE_MIN_OVERLAP_SAMPLES:-100}"
database="tokend_pricing_scale_${scale_rows}_$$"
evidence_dir="${TOKEND_SCALE_EVIDENCE_DIR:-/tmp/tokend-pricing-scale-${scale_rows}-$(date +%Y%m%d-%H%M%S)}"
active_database=""
memory_sampler_pid=""
lock_holder_pid=""

mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"

now_ms() {
  python3 -c 'import time; print(time.time_ns() // 1000000)'
}

container_command() {
  "$docker_bin" exec -e PGPASSWORD="$pg_password" "$pg_container" "$@"
}

run_sql() {
  container_command psql -X -qAt -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p 5432 -U "$pg_user" -d "$active_database" -c "$1"
}

run_file() {
  local file="$1"
  shift
  "$docker_bin" exec -i -e PGPASSWORD="$pg_password" "$pg_container" \
    psql -X -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p 5432 -U "$pg_user" -d "$active_database" "$@" -f - \
    < "$repo_root/$file"
}

postgres_rss_kb() {
  container_command sh -c 'for pid in $(pgrep postgres); do
    if [ -r "/proc/$pid/status" ]; then
      awk "/^VmRSS:/ {print \$2}" "/proc/$pid/status" 2>/dev/null
    fi
  done | awk "{sum += \$1} END {print sum + 0}"'
}

container_memory_limit_kb() {
  local limit
  limit="$(container_command sh -c 'cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max')"
  if [[ "$limit" == "max" ]]; then
    container_command awk '/^MemTotal:/ {print $2}' /proc/meminfo
  else
    echo $((limit / 1024))
  fi
}

timed_sql() {
  local sql="$1"
  local started finished
  started="$(now_ms)"
  LAST_RESULT="$(run_sql "$sql")"
  finished="$(now_ms)"
  LAST_ELAPSED_MS=$((finished - started))
}

assert_le() {
  local label="$1" actual="$2" limit="$3"
  awk -v actual="$actual" -v limit="$limit" -v label="$label" 'BEGIN {
    if (actual + 0 > limit + 0) {
      printf "%s exceeded: %.3f > %.3f\n", label, actual, limit > "/dev/stderr"
      exit 1
    }
  }'
}

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label mismatch: $actual != $expected" >&2
    return 1
  fi
}

percentile_ms() {
  local file="$1" percentile="$2" sorted count index
  sorted="$evidence_dir/.latencies-$RANDOM"
  awk 'NF >= 3 && $3 ~ /^[0-9]+$/ { printf "%.6f\n", $3 / 1000 }' "$file" | sort -n > "$sorted"
  count="$(wc -l < "$sorted" | tr -d ' ')"
  if [[ "$count" -eq 0 ]]; then
    rm -f "$sorted"
    echo "No pgbench latencies found in $file" >&2
    return 1
  fi
  index=$(( (percentile * count + 99) / 100 ))
  sed -n "${index}p" "$sorted"
  rm -f "$sorted"
}

maximum_ms() {
  awk 'NF >= 3 && $3 ~ /^[0-9]+$/ { value = $3 / 1000; if (value > max) max = value } END { printf "%.6f\n", max }' "$1"
}

filter_log_interval() {
  local input="$1" output="$2" started_ms="$3" finished_ms="$4"
  awk -v started="$started_ms" -v finished="$finished_ms" '
    NF >= 6 && $3 ~ /^[0-9]+$/ && $5 ~ /^[0-9]+$/ && $6 ~ /^[0-9]+$/ {
      completed_ms = ($5 * 1000) + ($6 / 1000)
      transaction_started_ms = completed_ms - ($3 / 1000)
      if (transaction_started_ms <= finished && completed_ms >= started) print
    }
  ' "$input" > "$output"
}

json_field() {
  node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(value[process.argv[2]])" "$1" "$2"
}

column_percentile_ms() {
  local file="$1" percentile="$2" sorted count index
  sorted="$evidence_dir/.batches-$RANDOM"
  awk -F '\t' 'NR > 1 { print $2 }' "$file" | sort -n > "$sorted"
  count="$(wc -l < "$sorted" | tr -d ' ')"
  index=$(( (percentile * count + 99) / 100 ))
  sed -n "${index}p" "$sorted"
  rm -f "$sorted"
}

column_maximum_ms() {
  awk -F '\t' 'NR > 1 && $2 > max { max = $2 } END { print max + 0 }' "$1"
}

start_pgbench() {
  local phase="$1" seconds="$2" script="$3"
  PGBENCH_PREFIX="/tmp/${database}_${phase}"
  PGBENCH_SCRIPT="${PGBENCH_PREFIX}.sql"
  PGBENCH_PHASE="$phase"
  container_command sh -c "rm -f ${PGBENCH_PREFIX}.*"
  "$docker_bin" cp "$repo_root/$script" "$pg_container:$PGBENCH_SCRIPT"
  container_command pgbench -h 127.0.0.1 -p 5432 -U "$pg_user" -d "$active_database" \
    -n -c "$upload_clients" -j "$upload_clients" -T "$seconds" -R "$upload_rate" \
    --exit-on-abort -l --log-prefix="$PGBENCH_PREFIX" -f "$PGBENCH_SCRIPT" \
    > "$evidence_dir/${phase}.out" 2>&1 &
  PGBENCH_PID=$!
}

finish_pgbench() {
  wait "$PGBENCH_PID"
  container_command sh -c "cat ${PGBENCH_PREFIX}.[0-9]*" > "$evidence_dir/${PGBENCH_PHASE}.log"
  container_command sh -c "rm -f ${PGBENCH_PREFIX}.*"
  grep -q 'number of failed transactions: 0' "$evidence_dir/${PGBENCH_PHASE}.out"
}

sample_memory() {
  while container_command true >/dev/null 2>&1; do
    printf '%s\t' "$(now_ms)"
    postgres_rss_kb
    sleep 1
  done
}

cleanup() {
  if [[ -n "$lock_holder_pid" ]]; then
    kill "$lock_holder_pid" >/dev/null 2>&1 || true
    wait "$lock_holder_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$memory_sampler_pid" ]]; then
    kill "$memory_sampler_pid" >/dev/null 2>&1 || true
    wait "$memory_sampler_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$active_database" ]]; then
    container_command dropdb -h 127.0.0.1 -p 5432 -U "$pg_user" \
      --if-exists --force "$active_database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if ! [[ "$scale_rows" =~ ^[1-9][0-9]*$ ]]; then
  echo "TOKEND_SCALE_ROWS must be a positive integer" >&2
  exit 2
fi
container_command pg_isready -h 127.0.0.1 -p 5432 -U "$pg_user" >/dev/null
container_command createdb -h 127.0.0.1 -p 5432 -U "$pg_user" "$database"
active_database="$database"

echo "scale: seed $scale_rows rows"
seed_started="$(now_ms)"
run_file supabase/tests/database/pricing-scale-fixture.sql -v "scale_rows=$scale_rows" \
  > "$evidence_dir/seed.out" 2>&1
seed_ms=$(( $(now_ms) - seed_started ))
baseline_rss_kb="$(postgres_rss_kb)"
memory_limit_kb="$(container_memory_limit_kb)"
sample_memory > "$evidence_dir/postgres-rss.tsv" &
memory_sampler_pid=$!

echo "scale: migration 001 under legacy uploads"
container_command psql -X -qAt -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p 5432 -U "$pg_user" -d "$active_database" \
  -c "BEGIN; LOCK TABLE public.tokend_usage_events IN ROW EXCLUSIVE MODE; SELECT pg_sleep(4); COMMIT" \
  > "$evidence_dir/migration-lock-holder.out" 2>&1 &
lock_holder_pid=$!
sleep 0.5
migration_lock_started="$(now_ms)"
if run_file supabase/migrations/202607100001_pricing_core.sql --single-transaction \
  > "$evidence_dir/migration-001-lock-failure.out" 2>&1
then
  echo "Migration 001 unexpectedly succeeded under a conflicting lock" >&2
  exit 1
fi
migration_lock_failure_ms=$(( $(now_ms) - migration_lock_started ))
wait "$lock_holder_pid"
lock_holder_pid=""
grep -qi 'lock timeout\|canceling statement due to lock timeout' "$evidence_dir/migration-001-lock-failure.out"
assert_eq "migration lock rollback" "$(run_sql "
  SELECT CASE WHEN to_regclass('public.tokend_pricing_catalogs') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tokend_usage_events'
        AND column_name = 'pricing_ingest_epoch'
    ) THEN 'rolled_back' ELSE 'partial' END")" "rolled_back"
assert_le "migration lock failure ms" "$migration_lock_failure_ms" 3000
awk -v elapsed="$migration_lock_failure_ms" 'BEGIN { if (elapsed < 1800) exit 1 }'

start_pgbench migration_live 20 supabase/tests/database/pricing-scale-legacy-upload.sql
sleep 1
migration_started="$(now_ms)"
run_file supabase/migrations/202607100001_pricing_core.sql --single-transaction > "$evidence_dir/migration-001.out" 2>&1
migration_001_ms=$(( $(now_ms) - migration_started ))
finish_pgbench
for migration in \
  supabase/migrations/202607100002_pricing_upload.sql \
  supabase/migrations/202607100003_pricing_rpcs.sql \
  supabase/migrations/202607100004_pricing_backfill.sql \
  supabase/migrations/202607100005_optimize_sessions_v2.sql \
  supabase/migrations/202607100006_extend_reconcile_timeout.sql
do
  run_file "$migration" --single-transaction >> "$evidence_dir/migrations-002-006.out" 2>&1
done

echo "scale: sessions v2 sparse-member performance gate"
run_sql "
  INSERT INTO public.tokend_members (member_code, token)
  VALUES ('SCALE_RPC', 'scale-rpc-token');
  INSERT INTO public.tokend_usage_events (
    id, member_code, timestamp_ms, session_id, session_key, agent, provider, model, channel,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, project
  )
  SELECT
    'scale-rpc-event-' || series::TEXT,
    'SCALE_RPC',
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT - series,
    'scale-rpc-session',
    'scale-rpc-key',
    'scale-rpc-agent',
    'openai',
    'gpt-5.6-sol',
    'scale-rpc',
    100, 20, 10, 5, 135, 'scale-rpc-project'
  FROM generate_series(1, 3) AS series;" >/dev/null
rpc_concurrent_started="$(now_ms)"
rpc_concurrent_pids=()
(run_sql "SET statement_timeout = '10s'; SELECT public.tokend_get_summary_v5('scale-rpc-token', '7d', 'Asia/Shanghai')::JSONB->>'ok'" > "$evidence_dir/rpc-concurrent-summary.out") &
rpc_concurrent_pids+=("$!")
(run_sql "SET statement_timeout = '10s'; SELECT public.tokend_get_daily_trend_v5('scale-rpc-token', '7d', 'Asia/Shanghai')::JSONB->>'ok'" > "$evidence_dir/rpc-concurrent-daily.out") &
rpc_concurrent_pids+=("$!")
(run_sql "SET statement_timeout = '10s'; SELECT public.tokend_get_model_breakdown_v3('scale-rpc-token', '7d')::JSONB->>'ok'" > "$evidence_dir/rpc-concurrent-models.out") &
rpc_concurrent_pids+=("$!")
(run_sql "SET statement_timeout = '10s'; SELECT public.tokend_get_sessions_v2('scale-rpc-token', '7d', 50)::JSONB->>'ok'" > "$evidence_dir/rpc-concurrent-sessions.out") &
rpc_concurrent_pids+=("$!")
(run_sql "SET statement_timeout = '10s'; SELECT public.tokend_get_top_projects_v3('scale-rpc-token', '7d')::JSONB->>'ok'" > "$evidence_dir/rpc-concurrent-projects.out") &
rpc_concurrent_pids+=("$!")
rpc_concurrent_failed=0
for pid in "${rpc_concurrent_pids[@]}"; do
  if ! wait "$pid"; then rpc_concurrent_failed=1; fi
done
rpc_concurrent_ms=$(( $(now_ms) - rpc_concurrent_started ))
if [[ "$rpc_concurrent_failed" -ne 0 ]]; then
  echo "Concurrent sparse-member dashboard RPC gate failed" >&2
  exit 1
fi
for result in "$evidence_dir"/rpc-concurrent-*.out; do
  assert_eq "concurrent RPC result $(basename "$result")" "$(tr -d '[:space:]' < "$result")" "true"
done
assert_le "concurrent sparse-member dashboard RPC latency ms" "$rpc_concurrent_ms" 10000
sessions_sparse_started="$(now_ms)"
sessions_sparse_result="$(run_sql "
  SET statement_timeout = '10s';
  WITH response AS MATERIALIZED (
    SELECT public.tokend_get_sessions_v2('scale-rpc-token', '7d', 50)::JSONB AS value
  )
  SELECT (value->>'ok') || '|' || jsonb_array_length(value->'sessions') || '|'
    || (value->'sessions'->0->>'callCount')
  FROM response")"
sessions_sparse_ms=$(( $(now_ms) - sessions_sparse_started ))
assert_eq "sessions v2 sparse result" "$sessions_sparse_result" "true|1|3"
assert_le "sessions v2 sparse latency ms" "$sessions_sparse_ms" 10000
run_sql "
  DELETE FROM public.tokend_usage_events WHERE member_code = 'SCALE_RPC';
  DELETE FROM public.tokend_members WHERE member_code = 'SCALE_RPC';" >/dev/null
run_sql "
  INSERT INTO public.tokend_usage_events (
    id, member_code, timestamp_ms, session_id, session_key, agent, provider, model, channel,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, project
  )
  SELECT
    'scale-rpc-touch-' || session.session_id,
    'SCALE001',
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
    session.session_id,
    'scale-key',
    'scale-agent',
    'openai',
    'gpt-5.6-sol',
    'scale',
    100, 20, 10, 5, 135, 'pricing-scale'
  FROM public.tokend_sessions AS session
  WHERE session.member_code = 'SCALE001'
    AND session.session_id ~ '^scale-session-[0-9]{7}$'
  ORDER BY session.session_id DESC
  LIMIT 200;" >/dev/null
sessions_dense_started="$(now_ms)"
sessions_dense_result="$(run_sql "
  SET statement_timeout = '10s';
  WITH response AS MATERIALIZED (
    SELECT public.tokend_get_sessions_v2('scale-token', '7d', 200)::JSONB AS value
  )
  SELECT (value->>'ok') || '|' || jsonb_array_length(value->'sessions') || '|'
    || (value->'sessions'->0->>'callCount')
  FROM response")"
sessions_dense_ms=$(( $(now_ms) - sessions_dense_started ))
IFS='|' read -r sessions_dense_ok sessions_dense_count sessions_dense_calls <<< "$sessions_dense_result"
assert_eq "sessions v2 dense ok" "$sessions_dense_ok" "true"
if [[ "$sessions_dense_count" -lt 1 || "$sessions_dense_count" -gt 200 || "$sessions_dense_calls" -lt 1 ]]; then
  echo "sessions v2 dense result is outside the bounded nonempty contract: $sessions_dense_result" >&2
  exit 1
fi
assert_le "sessions v2 dense latency ms" "$sessions_dense_ms" 10000
run_sql "
  DELETE FROM public.tokend_usage_events
  WHERE member_code = 'SCALE001' AND id LIKE 'scale-rpc-touch-%';" >/dev/null

create_request_id="$(run_sql "SELECT gen_random_uuid()")"
create_epoch_before="$(run_sql "SELECT current_ingest_epoch FROM public.tokend_pricing_state WHERE singleton")"
create_runs_before="$(run_sql "SELECT count(*) FROM public.tokend_pricing_backfill_runs")"
container_command psql -X -qAt -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p 5432 -U "$pg_user" -d "$active_database" \
  -c "BEGIN; LOCK TABLE public.tokend_usage_events IN ROW EXCLUSIVE MODE; SELECT pg_sleep(4); COMMIT" \
  > "$evidence_dir/create-lock-holder.out" 2>&1 &
lock_holder_pid=$!
sleep 0.5
create_lock_started="$(now_ms)"
if run_sql "SELECT public.tokend_pricing_create_backfill('2026-07-10', '$create_request_id'::UUID)" \
  > "$evidence_dir/create-lock-failure.out" 2>&1
then
  echo "Backfill create unexpectedly succeeded under a conflicting lock" >&2
  exit 1
fi
create_lock_failure_ms=$(( $(now_ms) - create_lock_started ))
wait "$lock_holder_pid"
lock_holder_pid=""
grep -qi 'lock timeout\|canceling statement due to lock timeout' "$evidence_dir/create-lock-failure.out"
assert_le "create lock failure ms" "$create_lock_failure_ms" 3000
awk -v elapsed="$create_lock_failure_ms" 'BEGIN { if (elapsed < 1800) exit 1 }'
assert_eq "create lock epoch rollback" "$(run_sql "SELECT current_ingest_epoch FROM public.tokend_pricing_state WHERE singleton")" "$create_epoch_before"
assert_eq "create lock run rollback" "$(run_sql "SELECT count(*) FROM public.tokend_pricing_backfill_runs")" "$create_runs_before"

echo "scale: pre-rollout v2 upload baseline"
start_pgbench pre_rollout "$pre_rollout_load_seconds" supabase/tests/database/pricing-scale-upload.sql
finish_pgbench

echo "scale: create and freeze with v2 uploads"
start_pgbench freeze_live "$freeze_load_seconds" supabase/tests/database/pricing-scale-upload.sql
sleep 1
freeze_overlap_started="$(now_ms)"
timed_sql "SELECT public.tokend_pricing_create_backfill('2026-07-10', '$create_request_id'::UUID)->>'runId'"
run_id="$LAST_RESULT"
create_ms="$LAST_ELAPSED_MS"
expected_target_count="$(run_sql "
  SELECT count(*)::BIGINT
  FROM public.tokend_usage_events AS event
  CROSS JOIN public.tokend_pricing_backfill_runs AS run
  WHERE run.run_id = '$run_id'::UUID
    AND event.pricing_ingest_epoch <= run.target_ingest_epoch
    AND ROW(event.id, event.member_code) <= ROW(run.freeze_upper_event_id, run.freeze_upper_member_code)
    AND event.total_tokens > 0
    AND event.pricing_status IS DISTINCT FROM 'reported'
    AND NOT ((event.pricing_status IN ('legacy') OR event.pricing_status IS NULL)
      AND (COALESCE(event.input_cost, 0) <> 0 OR COALESCE(event.output_cost, 0) <> 0
        OR COALESCE(event.reasoning_cost, 0) <> 0 OR COALESCE(event.cache_read_cost, 0) <> 0
        OR COALESCE(event.cache_write_cost, 0) <> 0 OR COALESCE(event.total_cost, 0) <> 0
        OR COALESCE(event.unallocated_cost, 0) <> 0))")"
printf 'batch\telapsed_ms\tcomplete\n' > "$evidence_dir/freeze-batches.tsv"
freeze_started="$(now_ms)"
freeze_complete="f"
freeze_batches=0
while [[ "$freeze_complete" != "t" ]]; do
  timed_sql "SELECT (public.tokend_pricing_freeze_batch('$run_id'::UUID, 2000)->>'freezeComplete')::BOOLEAN"
  freeze_complete="$LAST_RESULT"
  freeze_batches=$((freeze_batches + 1))
  printf '%s\t%s\t%s\n' "$freeze_batches" "$LAST_ELAPSED_MS" "$freeze_complete" >> "$evidence_dir/freeze-batches.tsv"
  if [[ "$freeze_batches" -eq 5 ]]; then
    frozen_checkpoint="$(run_sql "SELECT frozen_count::TEXT FROM public.tokend_pricing_backfill_runs WHERE run_id = '$run_id'::UUID")"
    [[ "$frozen_checkpoint" -gt 0 ]]
  fi
  if [[ "$freeze_batches" -gt 1000 ]]; then
    echo "Freeze did not converge" >&2
    exit 1
  fi
done
freeze_overlap_finished="$(now_ms)"
freeze_ms=$(( $(now_ms) - freeze_started ))
finish_pgbench
timed_sql "SELECT public.tokend_pricing_finalize_backfill('$run_id'::UUID)->>'status'"
finalize_status="$LAST_RESULT"
finalize_ms="$LAST_ELAPSED_MS"
assert_eq "finalize status" "$finalize_status" "staging"

echo "scale: price with v2 uploads"
start_pgbench backfill_live "$backfill_load_seconds" supabase/tests/database/pricing-scale-upload.sql
printf 'batch\telapsed_ms\tprocessed\tremaining\n' > "$evidence_dir/backfill-batches.tsv"
backfill_started="$(now_ms)"
backfill_overlap_started="$backfill_started"
remaining="$expected_target_count"
backfill_batches=0
while [[ "$remaining" != "0" ]]; do
  timed_sql "
    WITH response AS MATERIALIZED (
      SELECT public.tokend_pricing_backfill_batch('$run_id'::UUID, '', '', 5000)::JSONB AS value
    )
    SELECT (value->>'processed') || '|' || (value->>'remainingCount') FROM response"
  IFS='|' read -r processed remaining <<< "$LAST_RESULT"
  backfill_batches=$((backfill_batches + 1))
  printf '%s\t%s\t%s\t%s\n' "$backfill_batches" "$LAST_ELAPSED_MS" "$processed" "$remaining" >> "$evidence_dir/backfill-batches.tsv"
  if [[ "$backfill_batches" -eq 5 ]]; then
    persisted_progress="$(run_sql "SELECT priced_count::TEXT FROM public.tokend_pricing_backfill_runs WHERE run_id = '$run_id'::UUID")"
    [[ "$persisted_progress" -gt 0 ]]
  fi
  if [[ "$backfill_batches" -gt 1000 ]]; then
    echo "Backfill did not converge" >&2
    exit 1
  fi
done
backfill_overlap_finished="$(now_ms)"
backfill_ms=$(( $(now_ms) - backfill_started ))
finish_pgbench

echo "scale: reconcile, activate, rollback, reactivate"
timed_sql "
  SELECT public.tokend_pricing_reconcile('$run_id'::UUID)::TEXT"
reconcile_report="$LAST_RESULT"
reconcile_ms="$LAST_ELAPSED_MS"
printf '%s\n' "$reconcile_report" > "$evidence_dir/reconcile.json"
reconcile_status="$(run_sql "SELECT status FROM public.tokend_pricing_backfill_runs WHERE run_id = '$run_id'::UUID")"
assert_eq "reconcile status" "$reconcile_status" "reconciled"
target_hash_one="$(run_sql "SELECT public.tokend_pricing_compute_target_hash('$run_id'::UUID)")"
target_hash_two="$(run_sql "SELECT public.tokend_pricing_compute_target_hash('$run_id'::UUID)")"
reconciliation_hash_one="$(run_sql "SELECT public.tokend_pricing_compute_reconciliation_hash('$run_id'::UUID, '2026-07-10')")"
reconciliation_hash_two="$(run_sql "SELECT public.tokend_pricing_compute_reconciliation_hash('$run_id'::UUID, '2026-07-10')")"
assert_eq "target hash stability" "$target_hash_one" "$target_hash_two"
assert_eq "reconciliation hash stability" "$reconciliation_hash_one" "$reconciliation_hash_two"

timed_sql "SELECT public.tokend_pricing_activate('$run_id'::UUID)->>'status'"
first_activation_ms="$LAST_ELAPSED_MS"
assert_eq "first activation" "$LAST_RESULT" "active"
timed_sql "SELECT public.tokend_pricing_rollback('$run_id'::UUID)->>'status'"
rollback_ms="$LAST_ELAPSED_MS"
assert_eq "rollback" "$LAST_RESULT" "rolled_back"
timed_sql "SELECT public.tokend_pricing_activate('$run_id'::UUID)->>'status'"
second_activation_ms="$LAST_ELAPSED_MS"
assert_eq "second activation" "$LAST_RESULT" "active"

echo "scale: steady upload and health baseline"
start_pgbench steady "$steady_load_seconds" supabase/tests/database/pricing-scale-upload.sql
printf 'sample\telapsed_ms\n' > "$evidence_dir/health.tsv"
for sample in $(seq 1 20); do
  timed_sql "SELECT public.tokend_pricing_health() IS NOT NULL"
  printf '%s\t%s\n' "$sample" "$LAST_ELAPSED_MS" >> "$evidence_dir/health.tsv"
done
finish_pgbench

IFS='|' read -r actual_target_count actual_revision_count <<< "$(run_sql "
  SELECT run.target_count, run.priced_count
  FROM public.tokend_pricing_backfill_runs AS run
  WHERE run.run_id = '$run_id'::UUID")"
missing_count="$(json_field "$evidence_dir/reconcile.json" missingRevisionCount)"
duplicate_count="$(json_field "$evidence_dir/reconcile.json" duplicateRevisionCount)"
invalid_count="$(json_field "$evidence_dir/reconcile.json" breakdownInvalidCount)"
unexplained_count="$(json_field "$evidence_dir/reconcile.json" unexplainedMemberCount)"
assert_eq "target count" "$actual_target_count" "$expected_target_count"
assert_eq "revision count" "$actual_revision_count" "$expected_target_count"
assert_eq "missing revisions" "$missing_count" "0"
assert_eq "duplicate revisions" "$duplicate_count" "0"
assert_eq "invalid breakdowns" "$invalid_count" "0"
assert_eq "unexplained members" "$unexplained_count" "0"

preflight="$(run_sql "SELECT (value->>'authoritative') || '|' || (value->>'source') FROM (SELECT public.tokend_pricing_preflight()::JSONB AS value) AS result")"
assert_eq "authoritative preflight" "$preflight" "true|frozen_reconciled_run"

filter_log_interval "$evidence_dir/freeze_live.log" "$evidence_dir/freeze-overlap.log" "$freeze_overlap_started" "$freeze_overlap_finished"
filter_log_interval "$evidence_dir/backfill_live.log" "$evidence_dir/backfill-overlap.log" "$backfill_overlap_started" "$backfill_overlap_finished"
cat "$evidence_dir/freeze-overlap.log" "$evidence_dir/backfill-overlap.log" > "$evidence_dir/live-combined.log"
live_overlap_samples="$(wc -l < "$evidence_dir/live-combined.log" | tr -d ' ')"
freeze_overlap_samples="$(wc -l < "$evidence_dir/freeze-overlap.log" | tr -d ' ')"
backfill_overlap_samples="$(wc -l < "$evidence_dir/backfill-overlap.log" | tr -d ' ')"
min_phase_samples=$(( (min_overlap_samples + 1) / 2 ))
if [[ "$live_overlap_samples" -lt "$min_overlap_samples"
  || "$freeze_overlap_samples" -lt "$min_phase_samples"
  || "$backfill_overlap_samples" -lt "$min_phase_samples" ]]; then
  echo "Insufficient upload samples overlapped rollout work: $live_overlap_samples" >&2
  exit 1
fi
migration_p95_ms="$(percentile_ms "$evidence_dir/migration_live.log" 95)"
migration_max_ms="$(maximum_ms "$evidence_dir/migration_live.log")"
live_p95_ms="$(percentile_ms "$evidence_dir/live-combined.log" 95)"
live_max_ms="$(maximum_ms "$evidence_dir/live-combined.log")"
freeze_upload_p95_ms="$(percentile_ms "$evidence_dir/freeze-overlap.log" 95)"
freeze_upload_max_ms="$(maximum_ms "$evidence_dir/freeze-overlap.log")"
backfill_upload_p95_ms="$(percentile_ms "$evidence_dir/backfill-overlap.log" 95)"
backfill_upload_max_ms="$(maximum_ms "$evidence_dir/backfill-overlap.log")"
steady_p95_ms="$(percentile_ms "$evidence_dir/steady.log" 95)"
pre_rollout_p95_ms="$(percentile_ms "$evidence_dir/pre_rollout.log" 95)"
freeze_batch_p95_ms="$(column_percentile_ms "$evidence_dir/freeze-batches.tsv" 95)"
freeze_batch_max_ms="$(column_maximum_ms "$evidence_dir/freeze-batches.tsv")"
backfill_batch_p95_ms="$(column_percentile_ms "$evidence_dir/backfill-batches.tsv" 95)"
backfill_batch_max_ms="$(column_maximum_ms "$evidence_dir/backfill-batches.tsv")"
health_p95_ms="$(column_percentile_ms "$evidence_dir/health.tsv" 95)"

peak_rss_kb="$(awk 'NF >= 2 && $2 > max { max = $2 } END { print max + 0 }' "$evidence_dir/postgres-rss.tsv")"
rss_delta_kb=$((peak_rss_kb - baseline_rss_kb))
if [[ "$rss_delta_kb" -lt 0 ]]; then rss_delta_kb=0; fi
rss_quarter_limit_kb=$((memory_limit_kb / 4))
disk_free_percent="$(container_command sh -c "df -Pk /var/lib/postgresql/data | awk 'NR == 2 {gsub(/%/, \"\", \$5); print 100 - \$5}'")"

assert_le "migration upload max latency ms" "$migration_max_ms" 2000
assert_le "migration 001 success ms" "$migration_001_ms" 1000
assert_le "backfill create success ms" "$create_ms" 2000
assert_le "freeze total ms" "$freeze_ms" 900000
assert_le "freeze batch p95 ms" "$freeze_batch_p95_ms" 30000
assert_le "freeze batch max ms" "$freeze_batch_max_ms" 45000
assert_le "finalize ms" "$finalize_ms" 900000
assert_le "backfill total ms" "$backfill_ms" 3600000
assert_le "backfill batch p95 ms" "$backfill_batch_p95_ms" 30000
assert_le "backfill batch max ms" "$backfill_batch_max_ms" 45000
assert_le "reconcile ms" "$reconcile_ms" 45000
assert_le "first activation ms" "$first_activation_ms" 30000
assert_le "rollback ms" "$rollback_ms" 2000
assert_le "second activation ms" "$second_activation_ms" 30000
assert_le "health p95 ms" "$health_p95_ms" 3000
assert_le "live upload p95 ms" "$live_p95_ms" 2000
assert_le "live upload p95 ratio" "$live_p95_ms" "$(awk -v baseline="$pre_rollout_p95_ms" 'BEGIN { print baseline * 2 }')"
assert_le "freeze upload p95 ms" "$freeze_upload_p95_ms" 2000
assert_le "freeze upload p95 ratio" "$freeze_upload_p95_ms" "$(awk -v baseline="$pre_rollout_p95_ms" 'BEGIN { print baseline * 2 }')"
assert_le "backfill upload p95 ms" "$backfill_upload_p95_ms" 2000
assert_le "backfill upload p95 ratio" "$backfill_upload_p95_ms" "$(awk -v baseline="$pre_rollout_p95_ms" 'BEGIN { print baseline * 2 }')"
assert_le "postgres RSS delta KiB" "$rss_delta_kb" 524288
assert_le "postgres RSS delta versus 25% memory KiB" "$rss_delta_kb" "$rss_quarter_limit_kb"
if [[ "$disk_free_percent" -lt 30 ]]; then
  echo "Database disk reserve below 30%: ${disk_free_percent}%" >&2
  exit 1
fi

cat > "$evidence_dir/summary.json" <<JSON
{
  "rows": $scale_rows,
  "targetCount": $actual_target_count,
  "revisionCount": $actual_revision_count,
  "seedMs": $seed_ms,
  "migration001Ms": $migration_001_ms,
  "migrationLockFailureMs": $migration_lock_failure_ms,
  "migrationUploadP95Ms": $migration_p95_ms,
  "migrationUploadMaxMs": $migration_max_ms,
  "sessionsV2SparseMs": $sessions_sparse_ms,
  "sessionsV2DenseMs": $sessions_dense_ms,
  "concurrentDashboardRpcMs": $rpc_concurrent_ms,
  "createMs": $create_ms,
  "createLockFailureMs": $create_lock_failure_ms,
  "freezeMs": $freeze_ms,
  "freezeBatchP95Ms": $freeze_batch_p95_ms,
  "freezeBatchMaxMs": $freeze_batch_max_ms,
  "finalizeMs": $finalize_ms,
  "backfillMs": $backfill_ms,
  "backfillBatchP95Ms": $backfill_batch_p95_ms,
  "backfillBatchMaxMs": $backfill_batch_max_ms,
  "reconcileMs": $reconcile_ms,
  "firstActivationMs": $first_activation_ms,
  "rollbackMs": $rollback_ms,
  "secondActivationMs": $second_activation_ms,
  "liveUploadP95Ms": $live_p95_ms,
  "liveUploadMaxMs": $live_max_ms,
  "liveUploadOverlapSamples": $live_overlap_samples,
  "freezeUploadP95Ms": $freeze_upload_p95_ms,
  "freezeUploadMaxMs": $freeze_upload_max_ms,
  "freezeUploadOverlapSamples": $freeze_overlap_samples,
  "backfillUploadP95Ms": $backfill_upload_p95_ms,
  "backfillUploadMaxMs": $backfill_upload_max_ms,
  "backfillUploadOverlapSamples": $backfill_overlap_samples,
  "preRolloutUploadP95Ms": $pre_rollout_p95_ms,
  "steadyUploadP95Ms": $steady_p95_ms,
  "healthP95Ms": $health_p95_ms,
  "postgresRssDeltaKiB": $rss_delta_kb,
  "containerMemoryLimitKiB": $memory_limit_kb,
  "diskFreePercent": $disk_free_percent,
  "targetHash": "$target_hash_one",
  "reconciliationHash": "$reconciliation_hash_one",
  "passed": true
}
JSON

echo "scale: PASS $evidence_dir/summary.json"
trap - EXIT INT TERM
cleanup
