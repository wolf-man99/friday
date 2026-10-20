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

for test in ledger_test capture_test ledger_model_test upgrade_check; do
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

# The next checks act as user E (from ledger_model_test.sql) on "E bank".
E=eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee
E_BANK="(select id from public.accounts where name = 'E bank')"
as_e() {
  psql -q -t -A -d "$DB" <<SQL
set role authenticated;
set request.jwt.claims = '{"sub":"$E","role":"authenticated"}';
$1
SQL
}

# Concurrency: 8 sessions each refund 60% of one purchase at once → the cap,
# checked under a lock on the purchase, lets exactly one through.
echo "concurrent refunds of one purchase"
PURCHASE=$(as_e "select id from public.record_entry(gen_random_uuid(), 'expense', 100000, $E_BANK);")
results=$(for _ in 1 2 3 4 5 6 7 8; do
  as_e "select created from public.record_entry(gen_random_uuid(), 'refund', 60000, $E_BANK,
    p_related_transaction_id => '$PURCHASE');" 2>&1 &
done; wait)
accepted=$(grep -c '^t$' <<<"$results" || true)
refused=$(grep -c 'is left to refund' <<<"$results" || true)
refunded=$(psql -q -t -A -d "$DB" -c "select coalesce(sum(amount_minor), 0) from public.transactions
  where related_transaction_id = '$PURCHASE' and deleted_at is null and status in ('posted', 'pending')")
if [[ "$accepted" == 1 && "$refused" == 7 && "$refunded" == 60000 ]]; then
  echo "ok - 8 concurrent 60% refunds: 1 accepted, 7 refused, never more than the purchase"
else
  echo "FAIL concurrent refunds: accepted=$accepted refused=$refused refunded=$refunded" >&2
  exit 1
fi

# Concurrency: 6 settlements of one pending import arrive at once (distinct
# event ids, the same transaction id) → still one ledger entry, now posted.
echo "concurrent settlements of one pending import"
settle() {
  as_e "select processing_status from public.submit_source_event('bank_import', '$1',
    p_external_transaction_id => 'CONC-UTR-1', p_kind => 'expense', p_amount_minor => $3,
    p_occurred_at => now(), p_account_id => $E_BANK, p_entry_status => '$2', p_confidence => 0.99);"
}
first=$(settle conc-pending pending 43210 2>&1)
results=$(for i in 1 2 3 4 5 6; do settle "conc-settled-$i" posted 44000 2>&1 & done; wait)
imported=$(grep -c '^imported$' <<<"$results" || true)
entries=$(psql -q -t -A -d "$DB" -c "
  select count(distinct e.resulting_transaction_id) || ' entry, '
      || (select count(*) from public.transactions t join public.source_events x on t.idempotency_key = x.id
          where x.external_transaction_id = 'CONC-UTR-1') || ' created, '
      || (select string_agg(t.status || ' ' || t.amount_minor, ',') from public.transactions t
          where t.id in (select resulting_transaction_id from public.source_events
                         where external_transaction_id = 'CONC-UTR-1'))
  from public.source_events e where e.external_transaction_id = 'CONC-UTR-1'")
if [[ "$first" == imported && "$imported" == 6 && "$entries" == "1 entry, 1 created, posted 44000" ]]; then
  echo "ok - 6 concurrent settlements of one pending import: all matched, 1 entry, posted once"
else
  echo "FAIL concurrent settlements: first=$first imported=$imported entries=$entries" >&2
  exit 1
fi

echo "concurrent first deliveries of one new transaction"
# Nothing imported yet: six pieces of evidence for one transaction race each
# other. Only the per-user import lock stops two of them creating entries.
first_seen() {
  as_e "select processing_status from public.submit_source_event('bank_import', '$1',
    p_external_transaction_id => 'CONC-UTR-2', p_kind => 'expense', p_amount_minor => 51234,
    p_occurred_at => now(), p_account_id => $E_BANK, p_entry_status => 'posted', p_confidence => 0.99);"
}
results=$(for i in 1 2 3 4 5 6; do first_seen "conc-first-$i" 2>&1 & done; wait)
imported=$(grep -c '^imported$' <<<"$results" || true)
entries=$(psql -q -t -A -d "$DB" -c "
  select count(*) from public.transactions t join public.source_events x on t.idempotency_key = x.id
  where x.external_transaction_id = 'CONC-UTR-2'")
if [[ "$imported" == 6 && "$entries" == 1 ]]; then
  echo "ok - 6 concurrent first deliveries of one transaction: 1 entry, 5 linked to it"
else
  echo "FAIL concurrent first deliveries: imported=$imported entries=$entries results=$results" >&2
  exit 1
fi
