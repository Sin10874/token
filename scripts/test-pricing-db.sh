#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker_bin="${DOCKER_BIN:-docker}"
pg_image="${TOKEND_TEST_PG_IMAGE:-public.ecr.aws/supabase/pg_prove:3.36}"
pg_host="${TOKEND_TEST_PGHOST:-host.docker.internal}"
pg_port="${TOKEND_TEST_PGPORT:-56322}"
pg_user="${TOKEND_TEST_PGUSER:-postgres}"
pg_password="${TOKEND_TEST_PGPASSWORD:-postgres}"
database_prefix="tokend_pricing_test_$$"
active_database=""

database_command() {
  "$docker_bin" run --rm \
    -e PGPASSWORD="$pg_password" \
    "$pg_image" "$@"
}

cleanup() {
  if [[ -n "$active_database" ]]; then
    database_command dropdb \
      -h "$pg_host" -p "$pg_port" -U "$pg_user" \
      --if-exists --force "$active_database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

for pass in 1 2; do
  active_database="${database_prefix}_${pass}"
  database_command createdb \
    -h "$pg_host" -p "$pg_port" -U "$pg_user" "$active_database"

  "$docker_bin" run --rm \
    -e PGPASSWORD="$pg_password" \
    -v "$repo_root:/work:ro" \
    -w /work \
    "$pg_image" pg_prove \
    -h "$pg_host" -p "$pg_port" -U "$pg_user" -d "$active_database" \
    supabase/tests/database/pricing.test.sql

  database_command dropdb \
    -h "$pg_host" -p "$pg_port" -U "$pg_user" \
    --if-exists --force "$active_database"
  active_database=""
done

trap - EXIT INT TERM
