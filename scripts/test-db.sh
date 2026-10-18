#!/usr/bin/env bash
# Applies the migrations to a throwaway local PostgreSQL database (with a
# stub of Supabase's auth schema) and runs the SQL integration tests.
#
# Needs a local PostgreSQL superuser connection, configured with the usual
# PG* variables, e.g.  PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres
set -euo pipefail

cd "$(dirname "$0")/.."
DB="${FRIDAY_TEST_DB:-friday_test}"

psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists \"$DB\" with (force)" >/dev/null
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database \"$DB\"" >/dev/null

psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/supabase_stub.sql >/dev/null
for migration in supabase/migrations/*.sql; do
  echo "applying $migration"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$migration" >/dev/null
done

psql -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/ledger_test.sql 2>&1 \
  | sed -e 's/^psql:[^ ]* NOTICE:  //' -e '/^$/d'
