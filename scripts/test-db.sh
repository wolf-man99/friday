#!/usr/bin/env bash
# Applies the migrations to a throwaway local PostgreSQL database (with a
# stub of Supabase's auth schema and roles) and runs the SQL integration tests.
# Never point this at a Supabase project — the test files refuse to run there.
#
# The first migration is applied alone and loaded with fixture data, then the
# remaining migrations are applied (the latest one twice, to prove it can be
# re-run), so upgrades are tested against existing data.
#
# Needs a local PostgreSQL superuser connection, configured with the usual
# PG* variables, e.g.  PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres
set -euo pipefail

cd "$(dirname "$0")/.."
DB="${FRIDAY_TEST_DB:-friday_test}"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists \"$DB\" with (force)" >/dev/null
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database \"$DB\"" >/dev/null
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/db/local_supabase_stub.sql >/dev/null 2>&1

apply() {
  echo "applying $1"
  # As a non-superuser, like Supabase's SQL editor, so permission gaps surface.
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -c "set role friday_owner" -f "$1" >/dev/null
}

migrations=(supabase/migrations/*.sql)
apply "${migrations[0]}"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/db/upgrade_fixture.sql >/dev/null
for migration in "${migrations[@]:1}"; do
  apply "$migration"
done
if (( ${#migrations[@]} > 1 )); then
  echo "re-applying ${migrations[-1]}"
  apply "${migrations[-1]}" >/dev/null
fi

for test in ledger_test capture_test upgrade_check; do
  psql -v ON_ERROR_STOP=1 -q -t -A -d "$DB" -f "tests/db/$test.sql" 2>&1 \
    | sed -e 's/^psql:[^ ]* NOTICE:  //' -e '/^$/d'
done

# Concurrency: 8 sessions replay the same request at once → one entry.
echo "concurrent replays of one request"
KEY=77777777-7777-4777-8777-777777777777
replay() {
  psql -q -t -A -d "$DB" <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', false);
select created from public.record_entry('$KEY', 'expense', 4242,
  (select id from public.accounts where name = 'Wallet' and user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
SQL
}
results=$(for _ in 1 2 3 4 5 6 7 8; do replay & done; wait)
created=$(grep -c '^t$' <<<"$results" || true)
replayed=$(grep -c '^f$' <<<"$results" || true)
rows=$(psql -q -t -A -d "$DB" -c "select count(*) from public.transactions where idempotency_key = '$KEY'")
if [[ "$created" == 1 && "$replayed" == 7 && "$rows" == 1 ]]; then
  echo "ok - 8 concurrent replays: 1 created, 7 returned the original, 1 row"
else
  echo "FAIL concurrent replays: created=$created replayed=$replayed rows=$rows" >&2
  exit 1
fi
