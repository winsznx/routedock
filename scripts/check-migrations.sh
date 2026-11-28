#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
SEED_FILE="$ROOT/supabase/seed.sql"

: "${DATABASE_URL:?set DATABASE_URL to a disposable Postgres database}"

run_sql() {
  local label="$1"
  shift
  echo "==> $label"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"
}

bootstrap_supabase() {
  run_sql "Bootstrapping Supabase roles and publication" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'CREATE ROLE anon NOLOGIN NOINHERIT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'CREATE ROLE authenticated NOLOGIN NOINHERIT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'CREATE PUBLICATION supabase_realtime';
  END IF;
END
$$;
SQL
}

assert_schema() {
  run_sql "Verifying migration results" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tx_log'
  ) THEN
    RAISE EXCEPTION 'tx_log is missing from supabase_realtime';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sessions'
  ) THEN
    RAISE EXCEPTION 'sessions must not be in supabase_realtime';
  END IF;
  IF to_regclass('public.settlements') IS NULL THEN
    RAISE EXCEPTION 'settlements table is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sessions'
      AND column_name = 'reconcile_attempts'
  ) THEN
    RAISE EXCEPTION 'sessions.reconcile_attempts is missing';
  END IF;
END
$$;
SQL
}

apply_all() {
  bootstrap_supabase
  for migration in "$MIGRATIONS_DIR"/*.sql; do
    run_sql "Applying $(basename "$migration")" -f "$migration"
  done
  run_sql "Applying seed.sql" -f "$SEED_FILE"
  assert_schema
}

reapply_new() {
  local base="${1:-}"
  if [[ -z "$base" || "$base" =~ ^0+$ ]]; then
    base="$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)"
  fi

  local migration relative
  local added=()
  while IFS= read -r relative; do
    [[ -n "$relative" ]] && added+=("$ROOT/$relative")
  done < <(git diff --name-only --diff-filter=A "$base" HEAD -- supabase/migrations)

  bootstrap_supabase
  if (( ${#added[@]} == 0 )); then
    echo "==> No new migration files to re-apply"
  else
    for migration in "${added[@]}"; do
      run_sql "Re-applying $(basename "$migration")" -f "$migration"
    done
  fi
  assert_schema
}

case "${1:-}" in
  "")
    apply_all
    ;;
  --reapply-new)
    shift
    reapply_new "${1:-}"
    ;;
  *)
    echo "usage: $0 [--reapply-new BASE_REF]" >&2
    exit 2
    ;;
esac
