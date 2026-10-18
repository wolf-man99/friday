#!/usr/bin/env bash
# Creates a fresh local database with the Supabase auth stub and all
# migrations applied (no test data). Used by the end-to-end tests.
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres scripts/setup-local-db.sh friday_e2e
set -euo pipefail

cd "$(dirname "$0")/.."
DB="${1:-friday_e2e}"

psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists \"$DB\" with (force)" >/dev/null
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database \"$DB\"" >/dev/null
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/db/local_supabase_stub.sql >/dev/null 2>&1
for migration in supabase/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -c "set role friday_owner" -f "$migration" >/dev/null
done
psql -v ON_ERROR_STOP=1 -q -d "$DB" -c "alter role authenticator password 'authenticator'" >/dev/null
echo "database $DB ready"
