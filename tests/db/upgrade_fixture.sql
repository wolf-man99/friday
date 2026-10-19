-- LOCAL TESTING ONLY. Data written with only migration 0001 applied, to prove
-- later migrations keep existing users' data intact. See scripts/test-db.sh.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'STOP: tests/db/upgrade_fixture.sql is for local testing only.';
  end if;
end
$$;

set role supabase_auth_admin;
insert into auth.users (id, email) values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'legacy@example.com');
reset role;

insert into public.accounts (id, user_id, name, type, opening_balance_minor) values
  ('d0000000-0000-0000-0000-000000000001', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'Legacy bank', 'bank', 1000000),
  ('d0000000-0000-0000-0000-000000000002', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'Legacy cash', 'cash', 50000);
insert into public.transactions (id, user_id, account_id, type, amount_minor, occurred_at, note) values
  ('d0000000-0000-0000-0000-000000000011', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000001', 'expense', 12345, '2026-09-01T06:30:00Z', 'Old groceries'),
  ('d0000000-0000-0000-0000-000000000012', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000001', 'income', 500000, '2026-09-01T06:30:00Z', 'Old salary');
insert into public.transfers (id, user_id, source_account_id, destination_account_id, amount_minor, occurred_at) values
  ('d0000000-0000-0000-0000-000000000021', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'd0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 20000, '2026-09-02T06:30:00Z');
