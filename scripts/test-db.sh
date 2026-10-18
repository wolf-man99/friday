#!/usr/bin/env bash
# Applies the migrations to a throwaway local PostgreSQL database (with a
# stub of Supabase's auth schema and roles) and runs the SQL integration tests.
# Never point this at a Supabase project — the test files refuse to run there.
#
# Needs a local PostgreSQL superuser connection, configured with the usual
# PG* variables, e.g.  PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres
set -euo pipefail

cd "$(dirname "$0")/.."
DB="${FRIDAY_TEST_DB:-friday_test}"

psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists \"$DB\" with (force)" >/dev/null
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database \"$DB\"" >/dev/null

psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/db/local_supabase_stub.sql >/dev/null 2>&1
for migration in supabase/migrations/*.sql; do
  echo "applying $migration"
  # As a non-superuser, like Supabase's SQL editor, so permission gaps surface.
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -c "set role friday_owner" -f "$migration" >/dev/null
done

psql -v ON_ERROR_STOP=1 -q -t -A -d "$DB" -f tests/db/ledger_test.sql 2>&1 \
  | sed -e 's/^psql:[^ ]* NOTICE:  //' -e '/^$/d'
