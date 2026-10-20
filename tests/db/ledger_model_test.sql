-- LOCAL TESTING ONLY — never run this in the Supabase dashboard or against a
-- hosted project. Runs after capture_test.sql (reuses its helpers).
--
-- Tests for the ledger model (migration 0003, docs/ledger-model.md): what each
-- entry type does to balances and insights, credit cards, refunds and
-- reversals and their shared cap, statuses and their transitions, provenance,
-- the import boundary and its review queue, and isolation between users.
-- Two new users (C and E) keep these totals independent of the earlier files.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'STOP: tests/db/ledger_model_test.sql is for local testing only. In Supabase, run only supabase/migrations/*.sql.';
  end if;
end
$$;

set client_min_messages = notice;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- A wall-clock time in India (every test user's time zone).
create function tests.ist(p_local timestamp) returns timestamptz language sql immutable as $$
  select p_local at time zone 'Asia/Kolkata';
$$;

-- Insights for one local calendar month, e.g. tests.month('2026-03').
create function tests.month(p_month text)
returns table (income bigint, spending bigint, refunds bigint, refund_count bigint, pending_count bigint, transfer_count bigint)
language sql stable as $$
  select income_minor, expense_minor, refund_minor, refund_count, pending_count, transfer_count
  from public.period_summary(tests.ist((p_month || '-01')::timestamp),
                             tests.ist((p_month || '-01')::timestamp + interval '1 month'));
$$;

-- Records an entry through record_entry as the signed-in user and remembers
-- its id as p_key. p_at is a local (IST) time.
create function tests.record(
  p_key text, p_kind text, p_amount bigint, p_account text, p_at text,
  p_category text default null, p_related text default null,
  p_status text default 'posted', p_destination text default null)
returns void language plpgsql as $$
begin
  insert into tests.ids
  select p_key, r.id from public.record_entry(
    gen_random_uuid(), p_kind, p_amount, tests.id(p_account),
    p_destination_account_id => tests.id(p_destination),
    p_category_id => tests.id(p_category),
    p_occurred_at => tests.ist(p_at::timestamp),
    p_related_transaction_id => tests.id(p_related),
    p_status => p_status) r;
end;
$$;

-- Submits an email's parsed facts as the signed-in user and remembers the
-- event id as 'ev:' || p_event.
create function tests.submit(
  p_event text, p_kind text, p_amount bigint, p_account text, p_at text,
  p_tx text default null, p_state text default 'posted', p_confidence numeric default 0.97,
  p_currency text default 'INR', p_category text default null, p_fingerprint text default null,
  p_merchant text default null)
returns table (status text, reason text, entry_kind text, entry_id uuid, replayed boolean)
language plpgsql as $$
declare
  r record;
begin
  select * into r from public.submit_source_event(
    'email', p_event,
    p_external_transaction_id => p_tx, p_payload_fingerprint => p_fingerprint,
    p_kind => p_kind, p_amount_minor => p_amount, p_currency => p_currency,
    p_occurred_at => tests.ist(p_at::timestamp), p_merchant => p_merchant,
    p_account_id => tests.id(p_account), p_category_id => tests.id(p_category),
    p_entry_status => p_state, p_confidence => p_confidence);
  insert into tests.ids values ('ev:' || p_event, r.event_id) on conflict (key) do nothing;
  return query select r.processing_status, r.review_reason, r.entry_kind, r.entry_id, r.replayed;
end;
$$;

-- Status of a transaction or transfer by key.
create function tests.status(p_key text) returns text language sql stable as $$
  select status from public.transactions where id = tests.id(p_key)
  union all
  select status from public.transfers where id = tests.id(p_key);
$$;

-- Runs a scenario (p_sql) and a check (p_check, a query returning true when
-- the rule holds), then rolls both back so later totals are unaffected.
-- Refusing the scenario outright is one way for the rule to hold.
create function tests.holds_after(p_sql text, p_check text, label text)
returns void language plpgsql as $$
declare
  v_holds boolean;
begin
  begin
    begin
      execute p_sql;
    exception when others then
      null;
    end;
    execute p_check into v_holds;
    raise exception 'undo the scenario' using errcode = 'TBUGX';
  exception when sqlstate 'TBUGX' then
    null;
  end;
  if v_holds then
    raise notice 'ok - %', label;
  else
    raise exception 'FAIL %', label;
  end if;
end;
$$;

grant usage on schema tests to service_role;
grant select on tests.ids to service_role;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- New users C and E; the seeded "Refunds" income category
-- -----------------------------------------------------------------------------

set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'chitra@example.com', '{"display_name":"Chitra"}'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'esha@example.com', '{}');
reset role;

insert into tests.ids values
  ('C', 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('D', 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  ('E', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');

select tests.eq((select string_agg(name, ', ' order by sort_order) from public.categories
                 where user_id = tests.id('C') and transaction_type = 'income'),
  'Salary, Freelance, Interest, Gifts received, Other income', 'new users get no "Refunds" income category');

-- D signed up before 0003 (tests/db/upgrade_fixture.sql) and was seeded one.
select tests.eq((select row(is_default, is_archived)::text from public.categories
                 where user_id = tests.id('D') and transaction_type = 'income' and name = 'Refunds'),
  row(true, true)::text, 'an existing user''s seeded "Refunds" category is archived, not deleted');
select tests.eq((select count(*) from public.transactions where user_id = tests.id('D')
                 and (updated_at <> created_at or status <> 'posted' or source_type <> 'manual'
                      or type not in ('income', 'expense') or related_transaction_id is not null)),
  0::bigint, 'existing entries are left as they were: posted, manual, never rewritten');

set role authenticated;
select tests.login(tests.id('D'));
update public.categories set is_archived = false where name = 'Refunds';
select tests.eq((select is_archived from public.categories where name = 'Refunds'), false,
  'the archived "Refunds" category can be restored from Categories');
update public.categories set is_archived = true where name = 'Refunds';

-- -----------------------------------------------------------------------------
-- Accounts: wallet type, credit limits, available credit
-- -----------------------------------------------------------------------------

select tests.login(tests.id('C'));

with a as (
  insert into public.accounts (name, type, opening_balance_minor, opening_date, institution_name, credit_limit_minor) values
    ('C bank',   'bank',        10000000, '2026-01-01', 'HDFC Bank', null),
    ('C card',   'credit_card',  -200000, '2026-01-01', 'HDFC Bank', 5000000),
    ('C wallet', 'wallet',         50000, '2026-01-01', 'Paytm',     null),
    ('C cash',   'cash',           20000, '2026-01-01', null,        null),
    ('C old',    'bank',          100000, '2026-01-01', null,        null)
  returning replace(name, ' ', ':') as key, id
)
insert into tests.ids select key, id from a;
insert into tests.ids select 'C:cat:' || name, id from public.categories where user_id = auth.uid();

select tests.eq((select type from public.accounts where id = tests.id('C:wallet')), 'wallet', 'wallet is an account type');
select tests.eq((select row(balance_minor, outstanding_minor, available_credit_minor)::text
                 from public.account_balances where id = tests.id('C:card')),
  row(-200000, 200000, 4800000)::text, 'a card opens owing what was owed that day; available credit = limit − outstanding');
select tests.eq((select row(outstanding_minor, available_credit_minor)::text
                 from public.account_balances where id = tests.id('C:bank')),
  row(null::bigint, null::bigint)::text, 'only cards have dues and available credit');

insert into public.accounts (name, type) values ('C store card', 'credit_card');
insert into tests.ids select 'C:storecard', id from public.accounts where name = 'C store card';
select tests.eq((select row(outstanding_minor, available_credit_minor)::text
                 from public.account_balances where id = tests.id('C:storecard')),
  row(0, null::bigint)::text, 'a card without a limit shows dues but no available credit');

select tests.throws($$insert into public.accounts (name, type, credit_limit_minor) values ('Limit on a bank', 'bank', 100000)$$,
  'accounts_credit_limit_valid', 'a credit limit only goes on a card');
select tests.throws($$insert into public.accounts (name, type, credit_limit_minor) values ('Zero limit', 'credit_card', 0)$$,
  'accounts_credit_limit_valid', 'a credit limit is more than zero');
select tests.throws($$insert into public.accounts (name, type) values ('Crypto', 'crypto')$$,
  'accounts_type_check', 'unknown account types are rejected');
select tests.throws($$insert into public.accounts (name, type, currency) values ('Dollar card', 'credit_card', 'USD')$$,
  'accounts_currency_supported', 'accounts are INR only for now');

-- E: one account and one purchase, for the cross-user checks below and the
-- concurrency checks in scripts/test-db.sh.
select tests.login(tests.id('E'));
insert into public.accounts (name, type, opening_balance_minor, opening_date) values ('E bank', 'bank', 500000, '2020-01-01');
insert into tests.ids select 'E:bank', id from public.accounts where name = 'E bank';
insert into tests.ids select 'E:cat:' || name, id from public.categories where user_id = auth.uid();
select tests.record('E:shoes', 'expense', 100000, 'E:bank', '2026-09-01 10:00', 'E:cat:Shopping');

-- -----------------------------------------------------------------------------
-- Expense, income, transfer (March 2026)
-- -----------------------------------------------------------------------------

select tests.login(tests.id('C'));

select tests.record('C:salary', 'income',   8000000, 'C:bank', '2026-03-01 10:00', 'C:cat:Salary');
select tests.record('C:dinner', 'expense',   120000, 'C:bank', '2026-03-05 21:00', 'C:cat:Food & dining');
select tests.record('C:atm',    'transfer',  500000, 'C:bank', '2026-03-06 09:00', p_destination => 'C:cash');
select tests.record('C:veg',    'expense',    30000, 'C:cash', '2026-03-07 09:00', 'C:cat:Groceries');
select tests.record('C:power',  'expense',     5000, 'C:old',  '2026-03-08 09:00', 'C:cat:Bills & utilities');

select tests.eq(tests.balance('C:bank'), 10000000 + 8000000 - 120000 - 500000::bigint, 'bank: opening + income − expense − transfer out');
select tests.eq(tests.balance('C:cash'), 20000 + 500000 - 30000::bigint, 'cash: opening + transfer in − expense');
select tests.eq((select row(income, spending, refunds, transfer_count)::text from tests.month('2026-03')),
  row(8000000, 155000, 0, 1)::text, 'March: income and spending each count once; the transfer is neither');
select tests.eq((select row(money_in_minor, money_out_minor, transfers_in_minor, transfers_out_minor, entry_count)::text
                 from public.account_activity(tests.ist('2026-03-01'), tests.ist('2026-04-01'))
                 where account_id = tests.id('C:bank')),
  row(8000000, 120000, 0, 500000, 3)::text, 'account activity: bank money in, money out and transfers out');
select tests.eq((select row(money_in_minor, money_out_minor, transfers_in_minor, transfers_out_minor, entry_count)::text
                 from public.account_activity(tests.ist('2026-03-01'), tests.ist('2026-04-01'))
                 where account_id = tests.id('C:cash')),
  row(0, 30000, 500000, 0, 2)::text, 'account activity: cash transfer in and spending');
select tests.eq((select string_agg(c.name || '=' || b.total_minor, ', ' order by b.total_minor desc)
                 from public.category_breakdown(tests.ist('2026-03-01'), tests.ist('2026-04-01')) b
                 join public.categories c on c.id = b.category_id),
  'Food & dining=120000, Groceries=30000, Bills & utilities=5000', 'March spending by category');
select tests.eq((select string_agg(c.name || '=' || b.total_minor, ', ')
                 from public.category_breakdown(tests.ist('2026-03-01'), tests.ist('2026-04-01'), 'income') b
                 join public.categories c on c.id = b.category_id),
  'Salary=8000000', 'March income by category');
select tests.eq((select row(kind, account_id = tests.id('C:bank'), counter_account_id = tests.id('C:cash'), category_id)::text
                 from public.ledger_entries where id = tests.id('C:atm')),
  row('transfer', true, true, null::uuid)::text, 'a transfer is one feed entry with both accounts and no category');

-- Archived accounts keep their history but take nothing new.
update public.accounts set status = 'archived' where id = tests.id('C:old');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'expense', 100, tests.id('C:old'))$$,
  'archived', 'an archived account takes no new entries');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'transfer', 100, tests.id('C:bank'), tests.id('C:old'))$$,
  'archived', 'nothing can be moved into an archived account');
select tests.eq(tests.balance('C:old'), 100000 - 5000::bigint, 'an archived account keeps its history and balance');
select tests.eq(public.update_entry('expense', tests.id('C:power'), null, 'expense', 5000, tests.id('C:old'), null,
    tests.id('C:cat:Bills & utilities'), null, 'March bill') is not null,
  true, 'entries on an archived account stay editable');

-- -----------------------------------------------------------------------------
-- Credit card: purchase, refund, repayment (April 2026)
-- -----------------------------------------------------------------------------

insert into tests.nums values ('C:bank@card', tests.balance('C:bank'));

select tests.record('C:shoes', 'expense', 150000, 'C:card', '2026-04-03 18:00', 'C:cat:Shopping');
select tests.eq((select row(balance_minor, outstanding_minor, available_credit_minor)::text
                 from public.account_balances where id = tests.id('C:card')),
  row(-350000, 350000, 4650000)::text, 'a card purchase raises what is owed and lowers available credit');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@card'), 'a card purchase never touches the bank');
select tests.eq((select spending from tests.month('2026-04')), 150000::bigint, 'a card purchase is spending when it happens');

select tests.record('C:shoes-refund', 'refund', 50000, 'C:card', '2026-04-15 12:00', p_related => 'C:shoes');
select tests.eq((select row(balance_minor, outstanding_minor, available_credit_minor)::text
                 from public.account_balances where id = tests.id('C:card')),
  row(-300000, 300000, 4700000)::text, 'a refund to the card lowers what is owed');

select tests.record('C:card-bill', 'transfer', 300000, 'C:bank', '2026-04-20 09:00', p_destination => 'C:card');
select tests.eq((select row(balance_minor, outstanding_minor, available_credit_minor)::text
                 from public.account_balances where id = tests.id('C:card')),
  row(0, 0, 5000000)::text, 'paying the bill (a transfer bank → card) clears the dues');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@card') - 300000, 'paying the bill comes out of the bank once');
select tests.eq((select row(income, spending, refunds, transfer_count)::text from tests.month('2026-04')),
  row(0, 100000, 50000, 1)::text, 'paying the bill is not spending (the purchase was); the refund nets against it');

select tests.record('C:card-overpay', 'transfer', 10000, 'C:bank', '2026-04-21 09:00', p_destination => 'C:card');
select tests.eq((select row(balance_minor, outstanding_minor, available_credit_minor)::text
                 from public.account_balances where id = tests.id('C:card')),
  row(10000, 0, 5000000)::text, 'an overpaid card is in credit: nothing outstanding, full credit available');
select tests.eq((select row(expense_minor, refunds_minor, transfers_in_minor)::text
                 from public.account_balances where id = tests.id('C:card')),
  row(150000, 50000, 310000)::text, 'the card''s balance parts: purchases, refunds, payments');

-- -----------------------------------------------------------------------------
-- Refunds (purchase in September, refunds in October 2026)
-- -----------------------------------------------------------------------------

insert into tests.nums values ('C:bank@refunds', tests.balance('C:bank')), ('C:wallet@refunds', tests.balance('C:wallet'));

select tests.record('C:sofa',    'expense', 200000, 'C:bank', '2026-09-12 12:00', 'C:cat:Shopping');
select tests.record('C:sofa-r1', 'refund',   50000, 'C:bank', '2026-10-03 12:00', p_related => 'C:sofa');

select tests.eq((select row(category_id = tests.id('C:cat:Shopping'), base_type, related_transaction_id = tests.id('C:sofa'))::text
                 from public.transactions where id = tests.id('C:sofa-r1')),
  row(true, 'expense', true)::text, 'a refund takes its purchase''s category and sits on the spending side');
select tests.eq((select kind from public.ledger_entries where id = tests.id('C:sofa-r1')), 'refund', 'the feed shows it as a refund');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@refunds') - 200000 + 50000, 'a refund puts money back in the account');
select tests.eq((select row(income, spending, refunds)::text from tests.month('2026-09')),
  row(0, 200000, 0)::text, 'September: the purchase');
select tests.eq((select row(income, spending, refunds, refund_count)::text from tests.month('2026-10')),
  row(0, -50000, 50000, 1)::text, 'October: the refund lowers spending in its own month (here below zero), never income');
select tests.eq((select row(total_minor, transaction_count, gross_minor, refund_minor)::text
                 from public.category_breakdown(tests.ist('2026-10-01'), tests.ist('2026-11-01'))
                 where category_id = tests.id('C:cat:Shopping')),
  row(-50000, 0, 0, 50000)::text, 'October by category: Shopping is net −₹500 (gross 0, refunds ₹500)');
select tests.eq((select count(*) from public.category_breakdown(tests.ist('2026-10-01'), tests.ist('2026-11-01'), 'income')),
  0::bigint, 'a refund never shows up in income by category');
select tests.eq((select row(money_in_minor, money_out_minor)::text
                 from public.account_activity(tests.ist('2026-10-01'), tests.ist('2026-11-01'))
                 where account_id = tests.id('C:bank')),
  row(50000, 0)::text, 'account activity counts the refund as money in');

select tests.record('C:sofa-r2', 'refund', 30000, 'C:wallet', '2026-10-04 12:00', p_related => 'C:sofa');
select tests.eq(tests.balance('C:wallet'), tests.num('C:wallet@refunds') + 30000, 'a refund can land on another account');

select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 120001, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:sofa'))$$,
  'Only ₹1200.00 is left to refund', 'refunds never add up to more than the purchase');
select tests.record('C:sofa-r3', 'refund', 120000, 'C:bank', '2026-10-05 12:00', p_related => 'C:sofa');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 1, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:sofa'))$$,
  'Only ₹0.00 is left', 'a fully refunded purchase takes no more refunds');
select tests.eq((select spending from tests.month('2026-09')) + (select spending from tests.month('2026-10')), 0::bigint,
  'a fully refunded purchase nets to zero spending across the two months');

-- The refunds follow the purchase's category.
select tests.eq(public.update_entry('expense', tests.id('C:sofa'), null, 'expense', 200000, tests.id('C:bank'), null,
    tests.id('C:cat:Fun & leisure'), null, null, null, 'It was a gift') is not null,
  true, 're-categorise the purchase');
select tests.eq((select count(*) from public.transactions where related_transaction_id = tests.id('C:sofa')
                 and category_id = tests.id('C:cat:Fun & leisure')),
  3::bigint, 'its refunds move to the new category with it');
update public.transactions set category_id = tests.id('C:cat:Food & dining') where id = tests.id('C:sofa-r1');
select tests.eq((select category_id from public.transactions where id = tests.id('C:sofa-r1')), tests.id('C:cat:Fun & leisure'),
  'a refund''s category can''t drift from its purchase''s');
select tests.eq((select total_minor from public.category_breakdown(tests.ist('2026-10-01'), tests.ist('2026-11-01'))
                 where category_id = tests.id('C:cat:Fun & leisure')),
  -200000::bigint, 'October''s refunds now net against Fun & leisure');

-- A purchase with counted refunds must stay consistent with them.
select tests.throws($$select public.set_entry_status('expense', tests.id('C:sofa'), 'voided')$$,
  'Delete or void those first', 'a refunded purchase can''t be voided');
select tests.throws($$select public.set_entry_deleted('expense', tests.id('C:sofa'), true)$$,
  'Delete or void those first', 'a refunded purchase can''t be deleted');
select tests.throws($$update public.transactions set status = 'voided' where id = tests.id('C:sofa')$$,
  'Delete or void those first', 'a refunded purchase can''t be voided by a direct update');
select tests.throws($$update public.transactions set deleted_at = now() where id = tests.id('C:sofa')$$,
  'Delete or void those first', 'a refunded purchase can''t be deleted by a direct update');
select tests.throws($$select public.update_entry('expense', tests.id('C:sofa'), null, 'expense', 150000, tests.id('C:bank'),
    null, tests.id('C:cat:Fun & leisure'))$$,
  'already refunded', 'a purchase can''t be lowered below what was refunded');
select tests.throws($$select public.update_entry('expense', tests.id('C:sofa'), null, 'income', 200000, tests.id('C:bank'))$$,
  'Remove them before changing its type', 'a refunded purchase can''t become income');

-- What can be refunded, and where.
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:salary'))$$,
  'Only a purchase (an expense) can be refunded', 'income can''t be refunded');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:sofa-r1'))$$,
  'only point at an income or an expense', 'a refund can''t be refunded');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 100, tests.id('C:old'),
    p_related_transaction_id => tests.id('C:power'))$$,
  'archived', 'a refund can''t land on an archived account');

-- A refund whose purchase isn't known yet.
select tests.record('C:refund-unlinked', 'refund', 15000, 'C:bank', '2026-10-06 12:00', 'C:cat:Food & dining');
select tests.eq((select row(related_transaction_id, category_id = tests.id('C:cat:Food & dining'), base_type)::text
                 from public.transactions where id = tests.id('C:refund-unlinked')),
  row(null::uuid, true, 'expense')::text, 'a refund without its purchase keeps an expense category');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 100, tests.id('C:bank'),
    p_category_id => tests.id('C:cat:Salary'))$$,
  'foreign key', 'a refund can''t take an income category');

-- The cap can't be beaten by bringing a refund back.
select tests.record('C:lamp',   'expense', 100000, 'C:bank', '2026-10-06 18:00', 'C:cat:Shopping');
select tests.record('C:lamp-a', 'refund',   60000, 'C:bank', '2026-10-07 12:00', p_related => 'C:lamp');
select tests.eq(public.set_entry_status('refund', tests.id('C:lamp-a'), 'voided') is not null, true, 'void the first ₹600 refund');
select tests.record('C:lamp-b', 'refund',   60000, 'C:bank', '2026-10-08 12:00', p_related => 'C:lamp');
select tests.throws($$select public.set_entry_status('refund', tests.id('C:lamp-a'), 'posted')$$,
  'Only ₹400.00 is left', 'restoring a voided refund can''t push refunds past the purchase');
select tests.eq(tests.status('C:lamp-a'), 'voided', 'the refused restore changed nothing');

select tests.record('C:lamp-c', 'refund',   40000, 'C:bank', '2026-10-09 12:00', p_related => 'C:lamp');
select tests.eq(public.set_entry_deleted('refund', tests.id('C:lamp-b'), true) is not null, true, 'delete the second ₹600 refund');
select tests.eq((select count(*) from public.ledger_entries where id = tests.id('C:lamp-b')), 0::bigint,
  'a deleted entry leaves the feed');
select tests.record('C:lamp-d', 'refund',   60000, 'C:bank', '2026-10-10 12:00', p_related => 'C:lamp');
select tests.throws($$select public.set_entry_deleted('refund', tests.id('C:lamp-b'), false)$$,
  'Only ₹0.00 is left', 'undoing a refund''s delete can''t push refunds past the purchase');
select tests.throws($$update public.transactions set deleted_at = null where id = tests.id('C:lamp-b')$$,
  'Only ₹0.00 is left', 'nor can a direct update');
select tests.eq((select sum(amount_minor) from public.transactions where related_transaction_id = tests.id('C:lamp')
                 and deleted_at is null and status in ('posted', 'pending')),
  100000::numeric, 'counted refunds add up to the purchase, never more');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'reversal', 1, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:lamp'))$$,
  'Only ₹0.00 is left', 'refunds and reversals share one cap');

-- A refund can't come back while its purchase is voided.
select tests.eq(public.set_entry_status('refund', tests.id('C:lamp-c'), 'voided') is not null, true, 'void the third refund');
select tests.eq(public.set_entry_status('refund', tests.id('C:lamp-d'), 'voided') is not null, true, 'void the fourth refund');
select tests.eq(public.set_entry_status('expense', tests.id('C:lamp'), 'voided') is not null, true,
  'a purchase with no counted refunds can be voided');
select tests.throws($$select public.set_entry_status('refund', tests.id('C:lamp-c'), 'posted')$$,
  'Only a posted entry can be refunded', 'a refund of a voided purchase can''t be restored');
select tests.eq(public.set_entry_status('expense', tests.id('C:lamp'), 'posted') is not null, true, 'restore the purchase');
select tests.eq(public.set_entry_status('refund', tests.id('C:lamp-c'), 'posted') is not null, true, 'then its ₹400 refund');

select tests.eq((select row(income, spending, refunds, refund_count)::text from tests.month('2026-10')),
  row(0, -155000, 255000, 5)::text, 'October counts only counted refunds (voided and deleted ones are out)');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@refunds') - 200000 + 50000 + 120000 + 15000 - 100000 + 40000,
  'bank balance after refunds, voids and deletes');

-- -----------------------------------------------------------------------------
-- make_refund: income that was really a refund (February 2026)
-- -----------------------------------------------------------------------------

insert into tests.nums values ('C:bank@make_refund', tests.balance('C:bank'));

select tests.record('C:jacket',      'expense', 300000, 'C:bank', '2026-02-10 12:00', 'C:cat:Shopping');
select tests.record('C:jacket-back', 'income',  100000, 'C:bank', '2026-02-14 12:00', 'C:cat:Other income');
select tests.eq((select row(income, spending)::text from tests.month('2026-02')),
  row(100000, 300000)::text, 'money back recorded as income inflates income');

select tests.eq(public.make_refund(tests.id('C:jacket-back'), tests.id('C:jacket')) is not null, true,
  'make_refund turns it into a refund of the purchase');
select tests.eq((select row(type, related_transaction_id = tests.id('C:jacket'), category_id = tests.id('C:cat:Shopping'))::text
                 from public.transactions where id = tests.id('C:jacket-back')),
  row('refund', true, true)::text, 'it is now a refund of the jacket, in the jacket''s category');
select tests.eq((select row(income, spending, refunds, refund_count)::text from tests.month('2026-02')),
  row(0, 200000, 100000, 1)::text, 'February: no income, spending net of the refund');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@make_refund') - 300000 + 100000,
  'the correction doesn''t move the balance');
select tests.eq((select row(action, reason, previous ->> 'type', snapshot ->> 'type')::text from public.ledger_audit
                 where entity_id = tests.id('C:jacket-back') order by id desc limit 1),
  row('update', 'Recorded as a refund', 'income', 'refund')::text, 'the correction is audited with the previous type');

select tests.record('C:jacket-extra', 'income', 250000, 'C:bank', '2026-02-15 12:00');
select tests.throws($$select public.make_refund(tests.id('C:jacket-extra'), tests.id('C:jacket'))$$,
  'Only ₹2000.00 is left', 'make_refund respects the refund cap');
select tests.throws($$update public.transactions set type = 'refund', related_transaction_id = tests.id('C:jacket')
    where id = tests.id('C:jacket-extra')$$,
  'can''t change type', 'income only becomes a refund through make_refund');
select tests.throws($$select public.make_refund(tests.id('C:jacket'))$$,
  'Only income, or a refund without its purchase', 'an expense can''t be made a refund');
select tests.eq(public.set_entry_deleted('income', tests.id('C:jacket-extra'), true) is not null, true, 'delete the extra income');

select tests.record('C:mystery', 'income', 15000, 'C:bank', '2026-02-20 12:00', 'C:cat:Other income');
select tests.throws($$select public.make_refund(tests.id('C:mystery'), null, tests.id('C:cat:Salary'))$$,
  'foreign key', 'an unlinked refund needs an expense category');
select tests.eq(public.make_refund(tests.id('C:mystery'), null, tests.id('C:cat:Food & dining')) is not null, true,
  'make_refund without a purchase: an unlinked refund in an expense category');
select tests.eq((select row(type, related_transaction_id, category_id = tests.id('C:cat:Food & dining'))::text
                 from public.transactions where id = tests.id('C:mystery')),
  row('refund', null::uuid, true)::text, 'it nets against Food & dining');
select tests.eq(public.make_refund(tests.id('C:mystery'), tests.id('C:jacket')) is not null, true,
  'link the refund to its purchase later');
select tests.eq((select row(related_transaction_id = tests.id('C:jacket'), category_id = tests.id('C:cat:Shopping'))::text
                 from public.transactions where id = tests.id('C:mystery')),
  row(true, true)::text, 'once linked it takes the purchase''s category');
select tests.throws($$select public.make_refund(tests.id('C:mystery'), tests.id('C:sofa'))$$,
  'Only income, or a refund without its purchase', 'a refund is linked only once');
select tests.throws($$update public.transactions set related_transaction_id = tests.id('C:sofa') where id = tests.id('C:mystery')$$,
  'can''t be moved to another entry', 'a linked refund can''t be moved by a direct update');
select tests.eq((select row(income, spending, refunds, refund_count)::text from tests.month('2026-02')),
  row(0, 185000, 115000, 2)::text, 'February after the corrections');

-- -----------------------------------------------------------------------------
-- Reversals (originals in July, reversals in August 2026)
-- -----------------------------------------------------------------------------

insert into tests.nums values ('C:bank@reversals', tests.balance('C:bank'));

select tests.record('C:gym', 'expense', 80000, 'C:bank', '2026-07-30 10:00', 'C:cat:Health');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'reversal', 80000, tests.id('C:wallet'),
    p_related_transaction_id => tests.id('C:gym'))$$,
  'stays on the original''s account', 'a reversal must be on the original''s account');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'reversal', 80000, tests.id('C:bank'))$$,
  'must point at the entry it reverses', 'a reversal needs its original');
select tests.record('C:gym-back', 'reversal', 80000, 'C:bank', '2026-08-02 10:00', p_related => 'C:gym');
select tests.eq((select row(base_type, reversal_of_type, category_id = tests.id('C:cat:Health'))::text
                 from public.transactions where id = tests.id('C:gym-back')),
  row('expense', 'expense', true)::text, 'a reversed purchase nets on the spending side, in its category');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@reversals'), 'a fully reversed purchase nets to zero on the balance');

select tests.record('C:bonus',      'income',   1000000, 'C:bank', '2026-07-31 10:00', 'C:cat:Salary');
select tests.record('C:bonus-back', 'reversal',  400000, 'C:bank', '2026-08-01 10:00', p_related => 'C:bonus');
select tests.eq((select row(base_type, category_id = tests.id('C:cat:Salary'))::text
                 from public.transactions where id = tests.id('C:bonus-back')),
  row('income', true)::text, 'a reversal of income nets on the income side');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@reversals') + 1000000 - 400000,
  'a reversal of income takes the money back out');
select tests.eq((select reversed_income_minor from public.account_balances where id = tests.id('C:bank')), 400000::bigint,
  'the account shows reversed income separately');

select tests.eq((select row(income, spending, refunds, refund_count)::text from tests.month('2026-07')),
  row(600000, 0, 80000, 1)::text, 'July: reversals are reported in their original''s month (spending 0, income net)');
select tests.eq((select row(income, spending, refunds, refund_count)::text from tests.month('2026-08')),
  row(0, 0, 0, 0)::text, 'August: the reversals, dated then, don''t show up again');
select tests.eq((select string_agg(income_minor || '/' || expense_minor, ', ' order by bucket_start)
                 from public.cashflow_trend(tests.ist('2026-07-01'), tests.ist('2026-09-01'), 'month')),
  '600000/0, 0/0', 'the trend reports reversals the same way');
select tests.eq((select row(money_in_minor, money_out_minor)::text
                 from public.account_activity(tests.ist('2026-08-01'), tests.ist('2026-09-01'))
                 where account_id = tests.id('C:bank')),
  row(80000, 400000)::text, 'account activity uses each reversal''s own date');
select tests.eq((select row(total_minor, gross_minor, refund_minor)::text
                 from public.category_breakdown(tests.ist('2026-07-01'), tests.ist('2026-08-01'), 'income')
                 where category_id = tests.id('C:cat:Salary')),
  row(600000, 1000000, 400000)::text, 'income by category is net of reversals');
select tests.eq((select row(total_minor, gross_minor, refund_minor)::text
                 from public.category_breakdown(tests.ist('2026-07-01'), tests.ist('2026-08-01'))
                 where category_id = tests.id('C:cat:Health')),
  row(0, 80000, 80000)::text, 'a fully reversed purchase nets to zero in its category');

select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'reversal', 1, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:gym'))$$,
  'Only ₹0.00 is left', 'a purchase can''t be reversed twice');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'reversal', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:sofa-r3'))$$,
  'only point at an income or an expense', 'a refund can''t be reversed');
select tests.throws($$select public.update_entry('expense', tests.id('C:gym'), null, 'expense', 80000, tests.id('C:wallet'),
    null, tests.id('C:cat:Health'))$$,
  'Remove the reversal before moving it', 'a reversed entry can''t move to another account');
select tests.throws($$select public.update_entry('reversal', tests.id('C:gym-back'), null, 'reversal', 80000, tests.id('C:wallet'))$$,
  'stays on the original''s account', 'a reversal can''t move off its original''s account');
select tests.throws($$select public.update_entry('reversal', tests.id('C:gym-back'), null, 'expense', 80000, tests.id('C:bank'))$$,
  'can''t change type', 'a reversal can''t become an expense');
select tests.throws($$select public.set_entry_status('income', tests.id('C:bonus'), 'voided')$$,
  'Delete or void those first', 'reversed income can''t be voided');

-- -----------------------------------------------------------------------------
-- Status: pending, posted, needs review, voided (June 2026)
-- -----------------------------------------------------------------------------

insert into tests.nums values ('C:bank@status', tests.balance('C:bank')), ('C:wallet@status', tests.balance('C:wallet'));
select tests.eq((select row(review_events, review_entries, pending_entries)::text from public.ledger_attention()),
  row(0, 0, 0)::text, 'nothing needs attention yet');

select tests.record('C:hotel', 'expense', 45000, 'C:bank', '2026-06-10 22:00', 'C:cat:Travel', p_status => 'pending');
select tests.eq((select row(balance_minor, pending_minor)::text from public.account_balances where id = tests.id('C:bank')),
  row(tests.num('C:bank@status') - 45000, -45000)::text, 'a pending purchase counts, and shows as pending');
select tests.eq((select row(spending, pending_count)::text from tests.month('2026-06')),
  row(45000, 1)::text, 'pending spending counts in insights');
select tests.eq((select pending_entries from public.ledger_attention()), 1::bigint, 'pending entries are listed for attention');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:hotel'))$$,
  'Only a posted entry', 'a pending purchase can''t be refunded (it is voided if cancelled)');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'reversal', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:hotel'))$$,
  'Only a posted entry', 'a pending purchase can''t be reversed');

select tests.eq(public.set_entry_status('expense', tests.id('C:hotel'), 'posted', 'Settled') is not null, true, 'pending → posted');
select tests.eq((select row(balance_minor, pending_minor)::text from public.account_balances where id = tests.id('C:bank')),
  row(tests.num('C:bank@status') - 45000, 0)::text, 'posting moves nothing; it just stops being pending');
select tests.eq((select row(spending, pending_count)::text from tests.month('2026-06')),
  row(45000, 0)::text, 'the posted purchase is counted once');
select tests.eq((select row(action, reason, previous ->> 'status', snapshot ->> 'status')::text from public.ledger_audit
                 where entity_id = tests.id('C:hotel') order by id desc limit 1),
  row('status', 'Settled', 'pending', 'posted')::text, 'status changes are audited with the reason and the previous status');

select tests.record('C:taxi', 'expense', 55000, 'C:bank', '2026-06-11 08:00', 'C:cat:Transport', p_status => 'pending');
select tests.eq(public.set_entry_status('expense', tests.id('C:taxi'), 'voided', 'Driver cancelled') is not null, true,
  'pending → voided');
select tests.eq((select row(status, voided_from)::text from public.ledger_entries where id = tests.id('C:taxi')),
  row('voided', 'pending')::text, 'a voided entry stays in the feed and remembers what it was');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@status') - 45000, 'a voided entry no longer counts');
select tests.eq((select spending from tests.month('2026-06')), 45000::bigint, 'nor in insights');
select tests.throws($$select public.set_entry_status('expense', tests.id('C:taxi'), 'posted')$$,
  'Restoring returns an entry to pending', 'restore can''t skip ahead to posted');
update public.transactions set voided_from = 'posted' where id = tests.id('C:taxi');
select tests.eq((select voided_from from public.transactions where id = tests.id('C:taxi')), 'pending',
  'what it was before voiding can''t be forged');
select tests.throws($$select public.update_entry('expense', tests.id('C:taxi'), null, 'expense', 1, tests.id('C:bank'))$$,
  'Restore this entry before editing it', 'a voided entry is frozen');
select tests.throws($$update public.transactions set amount_minor = 1 where id = tests.id('C:taxi')$$,
  'Restore this entry before editing it', 'a voided entry is frozen for direct updates too');
select tests.eq(public.set_entry_status('expense', tests.id('C:taxi'), 'pending') is not null, true,
  'restore returns it to pending');
select tests.eq((select row(balance_minor, pending_minor)::text from public.account_balances where id = tests.id('C:bank')),
  row(tests.num('C:bank@status') - 100000, -55000)::text, 'restored, it counts again');
select tests.eq(public.set_entry_status('expense', tests.id('C:taxi'), 'voided') is not null, true, 'void it again');

select tests.record('C:clinic', 'expense', 70000, 'C:bank', '2026-06-12 11:00', 'C:cat:Health', p_status => 'needs_review');
select tests.eq((select row(balance_minor, pending_minor, review_count)::text from public.account_balances where id = tests.id('C:bank')),
  row(tests.num('C:bank@status') - 45000, 0, 1)::text, 'an entry waiting for review doesn''t count yet');
select tests.eq((select spending from tests.month('2026-06')), 45000::bigint, 'nor in insights');
select tests.eq((select row(review_entries, pending_entries)::text from public.ledger_attention()),
  row(1, 0)::text, 'it waits in the review queue');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:clinic'))$$,
  'Only a posted entry', 'an unconfirmed purchase can''t be refunded');
select tests.eq(public.set_entry_status('expense', tests.id('C:clinic'), 'voided') is not null, true, 'needs review → voided');
select tests.throws($$select public.set_entry_status('expense', tests.id('C:clinic'), 'posted')$$,
  'Restoring returns an entry to needs review', 'a voided review item can''t come back counted');
select tests.eq(public.set_entry_status('expense', tests.id('C:clinic'), 'needs_review') is not null, true,
  'restore returns it to the review queue');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@status') - 45000, 'still not counted');
select tests.eq(public.set_entry_status('expense', tests.id('C:clinic'), 'posted', 'Checked the bill') is not null, true,
  'confirm: needs review → posted');
select tests.eq((select row(balance_minor, review_count)::text from public.account_balances where id = tests.id('C:bank')),
  row(tests.num('C:bank@status') - 115000, 0)::text, 'confirmed, it counts');
select tests.eq((select spending from tests.month('2026-06')), 115000::bigint, 'and shows in insights');

select tests.throws($$select public.set_entry_status('expense', tests.id('C:clinic'), 'pending')$$,
  'can''t go from posted to pending', 'posted → pending is refused');
select tests.throws($$select public.set_entry_status('expense', tests.id('C:clinic'), 'needs_review')$$,
  'can''t go from posted to needs review', 'posted → needs review is refused');
select tests.throws($$update public.transactions set status = 'pending' where id = tests.id('C:clinic')$$,
  'can''t go from posted to pending', 'a direct update can''t skip the rules');
select tests.throws($$update public.transactions set status = 'needs_review' where id = tests.id('C:hotel')$$,
  'can''t go from posted to needs review', 'a direct update can''t send a posted entry back to review');
select tests.throws($$select public.set_entry_status('expense', tests.id('C:clinic'), 'deleted')$$,
  'Unknown status', 'unknown statuses are refused');
select tests.throws($$select public.set_entry_status('income', tests.id('C:jacket-extra'), 'voided')$$,
  'was deleted', 'a deleted entry has no status to change');
select tests.throws($$select public.set_entry_status('expense', tests.id('C:clinic'), 'voided', null, '2000-01-01'::timestamptz)$$,
  'changed somewhere else', 'a status change from a stale screen is refused');

select tests.record('C:topup', 'transfer', 100000, 'C:bank', '2026-06-15 09:00', p_destination => 'C:wallet', p_status => 'pending');
select tests.eq((select string_agg(pending_minor::text, ',' order by name) from public.account_balances
                 where id in (tests.id('C:bank'), tests.id('C:wallet'))),
  '-100000,100000', 'a pending transfer is pending on both sides');
select tests.throws($$update public.transfers set status = 'needs_review' where id = tests.id('C:topup')$$,
  'can''t go from pending to needs review', 'transfers follow the same rules');
select tests.eq(public.set_entry_status('transfer', tests.id('C:topup'), 'posted') is not null, true, 'pending transfer → posted');
select tests.eq(public.set_entry_status('transfer', tests.id('C:topup'), 'voided') is not null, true, 'posted transfer → voided');
select tests.eq(row(tests.balance('C:bank'), tests.balance('C:wallet'))::text,
  row(tests.num('C:bank@status') - 115000, tests.num('C:wallet@status'))::text, 'a voided transfer moves nothing');
select tests.throws($$select public.set_entry_status('transfer', tests.id('C:topup'), 'pending')$$,
  'Restoring returns an entry to posted', 'a voided transfer goes back to what it was');
select tests.eq(public.set_entry_status('transfer', tests.id('C:topup'), 'posted') is not null, true, 'restore the transfer');
select tests.eq((select row(spending, transfer_count, pending_count)::text from tests.month('2026-06')),
  row(115000, 1, 0)::text, 'June: the transfer is never spending');

-- Where an entry came from never changes.
select tests.throws($$update public.transactions set source_type = 'email' where id = tests.id('C:hotel')$$,
  'Where an entry came from can''t be changed', 'source_type is fixed');
select tests.throws($$update public.transactions set created_via = 'import' where id = tests.id('C:hotel')$$,
  'Where an entry came from', 'created_via is fixed');
select tests.throws($$update public.transactions set idempotency_key = gen_random_uuid() where id = tests.id('C:hotel')$$,
  'Where an entry came from', 'the request key is fixed');
select tests.throws($$update public.transfers set source_type = 'bank_import' where id = tests.id('C:topup')$$,
  'Where an entry came from', 'a transfer''s source is fixed too');

-- -----------------------------------------------------------------------------
-- Imports: evidence in, at most one entry out (May 2026)
-- -----------------------------------------------------------------------------

insert into tests.nums values ('C:bank@imports', tests.balance('C:bank'));

-- A confident, complete email becomes exactly one entry.
select tests.eq((select row(status, reason, entry_kind, replayed)::text from tests.submit('m-1', 'expense', 64900, 'C:bank',
    '2026-05-04 13:00', p_tx => 'UTR-1001', p_category => 'C:cat:Food & dining', p_merchant => 'Swiggy')),
  row('imported', null::text, 'expense', false)::text, 'a confident, complete email is imported');
insert into tests.ids select 'C:swiggy', resulting_transaction_id from public.source_events where id = tests.id('ev:m-1');
select tests.eq((select row(type, amount_minor, status, source_type, created_via, source_confidence, merchant,
                            category_id = tests.id('C:cat:Food & dining'), idempotency_key = tests.id('ev:m-1'))::text
                 from public.transactions where id = tests.id('C:swiggy')),
  row('expense', 64900, 'posted', 'email', 'import', 0.970, 'Swiggy', true, true)::text,
  'the entry records where it came from and how sure the parser was');
select tests.eq((select row(processing_status, link_type, linked_at is not null, parsed_at is not null)::text
                 from public.source_events where id = tests.id('ev:m-1')),
  row('imported', 'created', true, true)::text, 'the evidence is linked to the entry it created');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@imports') - 64900, 'the import moves the balance once');

select tests.eq((select row(status, entry_id = tests.id('C:swiggy'), replayed)::text
                 from tests.submit('m-1', 'expense', 99999, 'C:bank', '2026-05-04 13:00', p_tx => 'UTR-1001')),
  row('imported', true, true)::text, 'a redelivered email returns its first result');
select tests.eq((select count(*) from public.source_events where external_event_id = 'm-1'), 1::bigint,
  'a redelivery stores no new evidence');
select tests.eq((select count(*) from public.transactions where source_type = 'email' and amount_minor in (64900, 99999)), 1::bigint,
  'a redelivery creates no new entry');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@imports') - 64900, 'nor moves the balance again');

-- The same transaction id: pending, then settled.
select tests.eq((select row(status, entry_kind)::text from tests.submit('m-2', 'expense', 30000, 'C:bank', '2026-05-05 20:00',
    p_tx => 'UTR-2002', p_state => 'pending')),
  row('imported', 'expense')::text, 'a card authorisation is imported');
insert into tests.ids select 'C:dinner-hold', resulting_transaction_id from public.source_events where id = tests.id('ev:m-2');
select tests.eq(tests.status('C:dinner-hold'), 'pending', 'as pending');
select tests.eq((select row(status, entry_id = tests.id('C:dinner-hold'))::text
                 from tests.submit('m-3', 'expense', 31500, 'C:bank', '2026-05-06 09:00', p_tx => 'UTR-2002')),
  row('imported', true)::text, 'its settlement (same transaction id) is matched to the same entry');
select tests.eq((select row(status, amount_minor)::text from public.transactions where id = tests.id('C:dinner-hold')),
  row('posted', 31500)::text, 'which is now posted with the settled amount');
select tests.eq((select string_agg(link_type, ',' order by external_event_id) || ' → ' || count(distinct resulting_transaction_id)
                 from public.source_events where external_transaction_id = 'UTR-2002'),
  'created,matched → 1', 'two pieces of evidence, one entry');
select tests.eq((select row(action, reason, changed_fields)::text from public.ledger_audit
                 where entity_id = tests.id('C:dinner-hold') order by id desc limit 1),
  row('status', 'Posted, per email', array['amount_minor', 'status'])::text, 'the settlement is audited');

select tests.eq((select status from tests.submit('m-4', 'expense', 40000, 'C:bank', '2026-05-07 18:00',
    p_tx => 'UTR-3003', p_state => 'pending')), 'imported', 'another authorisation');
insert into tests.ids select 'C:ride-hold', resulting_transaction_id from public.source_events where id = tests.id('ev:m-4');
select tests.eq((select row(status, reason, entry_id)::text
                 from tests.submit('m-5', 'expense', 52000, 'C:bank', '2026-05-08 09:00', p_tx => 'UTR-3003')),
  row('needs_review', 'settlement_differs', null::uuid)::text, 'a settlement more than 25% off waits for review');
select tests.eq((select suggested_match_id from public.source_events where id = tests.id('ev:m-5')), tests.id('C:ride-hold'),
  'pointing at the pending entry');
select tests.eq((select row(status, amount_minor)::text from public.transactions where id = tests.id('C:ride-hold')),
  row('pending', 40000)::text, 'which is left as it was');

-- Cancelled authorisations are voided; there is nothing to reverse.
select tests.eq((select status from tests.submit('m-6', 'expense', 25500, 'C:bank', '2026-05-09 19:00',
    p_tx => 'UTR-4004', p_state => 'pending')), 'imported', 'a cinema authorisation');
insert into tests.ids select 'C:movie-hold', resulting_transaction_id from public.source_events where id = tests.id('ev:m-6');
select tests.eq((select row(status, entry_id = tests.id('C:movie-hold'))::text
                 from tests.submit('m-7', 'expense', 25500, 'C:bank', '2026-05-09 19:05', p_tx => 'UTR-4004', p_state => 'cancelled')),
  row('imported', true)::text, 'its cancellation is matched to it');
select tests.eq((select row(status, voided_from)::text from public.transactions where id = tests.id('C:movie-hold')),
  row('voided', 'pending')::text, 'a cancelled authorisation is voided');
select tests.eq((select reason from tests.submit('m-7b', 'expense', 25500, 'C:bank', '2026-05-09 19:20', p_tx => 'UTR-4004')),
  'linked_entry_removed', 'more evidence for a voided entry waits for review');
select tests.eq((select row(status, reason)::text from tests.submit('m-8', 'expense', 1234, 'C:bank', '2026-05-09 19:30',
    p_tx => 'UTR-4005', p_state => 'declined')),
  row('ignored', null::text)::text, 'a decline with nothing pending changes nothing');

-- Money back with the same reference is not a new entry.
select tests.eq((select status from tests.submit('m-9', 'expense', 77700, 'C:bank', '2026-05-10 12:00', p_tx => 'UTR-5005')),
  'imported', 'a UPI payment');
insert into tests.ids select 'C:recharge', resulting_transaction_id from public.source_events where id = tests.id('ev:m-9');
insert into tests.nums values ('C:entries@m-10', (select count(*) from public.transactions));
select tests.eq((select row(status, reason)::text from tests.submit('m-10', 'income', 77700, 'C:bank', '2026-05-11 12:00',
    p_tx => 'UTR-5005')),
  row('needs_review', 'needs_link')::text, 'its credit-back (same reference, opposite direction) waits for review');
select tests.eq((select suggested_match_id from public.source_events where id = tests.id('ev:m-10')), tests.id('C:recharge'),
  'suggesting the payment it belongs to');
select tests.eq((select count(*) from public.transactions), tests.num('C:entries@m-10'), 'and creates no entry');

-- Anything uncertain waits for review, with no ledger entry.
select tests.eq((select row(status, reason)::text from tests.submit('m-11', 'expense', 11100, 'C:bank', '2026-05-06 12:00',
    p_confidence => 0.6)),
  row('needs_review', 'low_confidence')::text, 'review: low confidence');
select tests.eq((select reason from tests.submit('m-12', 'expense', 11200, 'C:bank', '2026-05-06 13:00', p_confidence => null)),
  'low_confidence', 'review: no confidence given');
select tests.eq((select reason from tests.submit('m-13', null, 5000, 'C:bank', '2026-05-06 14:00')),
  'missing_details', 'review: kind unknown');
select tests.eq((select reason from tests.submit('m-14', 'expense', null, 'C:bank', '2026-05-06 15:00')),
  'missing_details', 'review: amount unknown');
select tests.eq((select reason from tests.submit('m-15', 'expense', 11500, 'C:bank', null)),
  'missing_details', 'review: date unknown');
select tests.eq((select reason from tests.submit('m-16', 'expense', 10000000000001, 'C:bank', '2026-05-06 16:00')),
  'missing_details', 'review: an impossible amount');
select tests.eq((select parsed_amount_minor from public.source_events where id = tests.id('ev:m-16')), null::bigint,
  'an impossible amount is not stored');
select tests.eq((select reason from tests.submit('m-17', 'expense', 13300, null, '2026-05-06 17:00')),
  'unknown_account', 'review: no account');
select tests.eq((select reason from tests.submit('m-18', 'expense', 13400, 'E:bank', '2026-05-06 18:00')),
  'unknown_account', 'review: someone else''s account');
select tests.eq((select suggested_account_id from public.source_events where id = tests.id('ev:m-18')), null::uuid,
  'someone else''s account is never suggested');
select tests.eq((select reason from tests.submit('m-19', 'expense', 13500, 'C:old', '2026-05-06 19:00')),
  'unknown_account', 'review: an archived account');
select tests.eq((select reason from tests.submit('m-20', 'expense', 14400, 'C:bank', '2026-05-06 20:00', p_currency => 'USD')),
  'unsupported_currency', 'review: a foreign currency');
select tests.eq((select reason from tests.submit('m-21', 'refund', 5000, 'C:bank', '2026-05-06 21:00',
    p_category => 'C:cat:Food & dining')),
  'needs_link', 'review: a refund needs its purchase');
select tests.eq((select reason from tests.submit('m-22', 'reversal', 5100, 'C:bank', '2026-05-06 22:00')),
  'needs_link', 'review: a reversal needs its original');
select tests.eq((select reason from tests.submit('m-23', 'income', 15500, 'C:card', '2026-05-07 09:00')),
  'possible_transfer', 'review: money "received" on a card is probably a bill payment');
select tests.eq((select reason from tests.submit('m-24', 'expense', 16600, 'C:bank', '2025-12-15 10:00')),
  'before_tracking_start', 'review: dated before the account''s tracking start');

-- Lookalikes are never merged automatically.
select tests.record('C:market', 'expense', 88800, 'C:bank', '2026-05-12 10:00', 'C:cat:Groceries');
select tests.eq((select row(status, reason)::text from tests.submit('m-25', 'expense', 88800, 'C:bank', '2026-05-13 10:00',
    p_confidence => 0.99)),
  row('needs_review', 'possible_duplicate')::text, 'review: same account and amount as an entry 1 day earlier');
select tests.eq((select row(suggested_match_kind, suggested_match_id = tests.id('C:market'))::text
                 from public.source_events where id = tests.id('ev:m-25')),
  row('transaction', true)::text, 'suggesting that entry');
select tests.record('C:fuel-hold', 'expense', 60000, 'C:bank', '2026-05-14 10:00', 'C:cat:Transport', p_status => 'pending');
select tests.eq((select row(status, reason)::text from tests.submit('m-26', 'expense', 75000, 'C:bank', '2026-05-15 10:00')),
  row('needs_review', 'possible_duplicate')::text, 'review: could settle a pending entry (within 50%)');
select tests.eq((select suggested_match_id from public.source_events where id = tests.id('ev:m-26')), tests.id('C:fuel-hold'),
  'suggesting the pending entry');
select tests.eq((select status from tests.submit('m-27', 'expense', 95000, 'C:bank', '2026-05-15 11:00')),
  'imported', 'more than 50% away from the pending entry is another purchase');
select tests.eq((select status from tests.submit('m-28', 'expense', 17700, 'C:bank', '2026-05-22 10:00', p_fingerprint => 'fp-same')),
  'imported', 'an email with a fingerprint');
select tests.eq((select reason from tests.submit('m-29', 'expense', 17800, 'C:bank', '2026-05-22 11:00', p_fingerprint => 'fp-same')),
  'possible_duplicate', 'review: a payload seen before');
select tests.eq((select reason from tests.submit('m-30', 'expense', 18800, 'C:bank', '2026-05-23 10:00',
    p_tx => 'UTR-6006', p_confidence => 0.5)),
  'low_confidence', 'an unsure email about a transaction');
select tests.eq((select reason from tests.submit('m-31', 'expense', 18800, 'C:bank', '2026-05-23 10:00',
    p_tx => 'UTR-6006', p_confidence => 0.99)),
  'possible_duplicate', 'review: the same transaction is already waiting for review');

-- The review queue: confirm, link, ignore.
select tests.eq((select kind from public.confirm_source_event(tests.id('ev:m-11'), 'expense', 11100, tests.id('C:bank'),
    p_category_id => tests.id('C:cat:Food & dining'))),
  'expense', 'confirm records the reviewed evidence');
insert into tests.ids select 'C:confirmed', resulting_transaction_id from public.source_events where id = tests.id('ev:m-11');
select tests.eq((select row(processing_status, link_type, review_reason)::text from public.source_events where id = tests.id('ev:m-11')),
  row('imported', 'created', null::text)::text, 'the event leaves the queue, linked to its new entry');
select tests.eq((select row(status, source_type, created_via, source_confidence, idempotency_key = tests.id('ev:m-11'))::text
                 from public.transactions where id = tests.id('C:confirmed')),
  row('posted', 'email', 'import', 0.600, true)::text, 'the confirmed entry keeps its provenance');
select tests.eq((select id from public.confirm_source_event(tests.id('ev:m-11'), 'expense', 99, tests.id('C:wallet'))),
  tests.id('C:confirmed'), 'confirming again returns the same entry');
select tests.eq((select count(*) from public.transactions where idempotency_key = tests.id('ev:m-11')), 1::bigint,
  'confirm creates exactly one entry');
select tests.throws($$select * from public.confirm_source_event(tests.id('ev:m-12'), 'expense', 11200, tests.id('C:bank'),
    p_status => 'needs_review')$$,
  'Confirmed entries are posted or pending', 'confirm can''t create an unconfirmed entry');

select tests.eq((select kind from public.confirm_source_event(tests.id('ev:m-21'), 'refund', 5000, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:swiggy'))),
  'refund', 'a refund email is confirmed as a refund of the purchase');
select tests.eq((select row(t.related_transaction_id = tests.id('C:swiggy'), t.category_id = tests.id('C:cat:Food & dining'),
                            t.occurred_at = tests.ist('2026-05-06 21:00'))::text
                 from public.transactions t join public.source_events e on e.resulting_transaction_id = t.id
                 where e.id = tests.id('ev:m-21')),
  row(true, true, true)::text, 'linked to the purchase, in its category, on the email''s date');
select tests.eq((select kind from public.confirm_source_event(tests.id('ev:m-10'), 'reversal', 77700, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:recharge'))),
  'reversal', 'the credit-back is confirmed as a reversal of the failed payment');

insert into tests.nums values ('C:entries@link', (select count(*) from public.transactions));
select public.link_source_event(tests.id('ev:m-25'), 'expense', tests.id('C:market'));
select tests.eq((select row(processing_status, link_type, resulting_transaction_id = tests.id('C:market'))::text
                 from public.source_events where id = tests.id('ev:m-25')),
  row('imported', 'matched', true)::text, 'link: the evidence is that existing entry');
select public.link_source_event(tests.id('ev:m-5'), 'expense', tests.id('C:ride-hold'));
select tests.eq((select row(status, amount_minor)::text from public.transactions where id = tests.id('C:ride-hold')),
  row('posted', 40000)::text, 'linking settlement evidence to a pending entry posts it');
select tests.eq((select count(*) from public.transactions), tests.num('C:entries@link'), 'linking creates no entry');
select tests.throws($$select public.link_source_event(tests.id('ev:m-23'), 'expense', tests.id('C:shoes'))$$,
  'confirm it as a refund instead', 'link refuses an entry of a different kind');
select tests.throws($$select public.link_source_event(tests.id('ev:m-25'), 'expense', tests.id('C:swiggy'))$$,
  'already linked to another entry', 'linked evidence can''t move to another entry');
select tests.throws($$select public.link_source_event(tests.id('ev:m-26'), 'expense', tests.id('C:movie-hold'))$$,
  'was voided', 'link refuses a voided entry');
select tests.throws($$select public.ignore_source_event(tests.id('ev:m-1'))$$,
  'already recorded', 'ignore refuses evidence that created an entry');
select tests.throws($$select public.ignore_source_event(tests.id('ev:m-25'))$$,
  'already recorded', 'ignore refuses evidence linked to an entry');
select public.ignore_source_event(tests.id('ev:m-13'));
select tests.eq((select processing_status from public.source_events where id = tests.id('ev:m-13')), 'ignored',
  'ignore: not a transaction');

-- Clients only read evidence.
select tests.throws($$insert into public.source_events (user_id, source_type, external_event_id) values (auth.uid(), 'email', 'forged')$$,
  'permission denied for table source_events', 'clients can''t write evidence directly');
select tests.throws($$update public.source_events set processing_status = 'ignored' where id = tests.id('ev:m-12')$$,
  'permission denied for table source_events', 'clients can''t change evidence directly');
select tests.throws($$delete from public.source_events where id = tests.id('ev:m-12')$$,
  'permission denied for table source_events', 'clients can''t delete evidence');
select tests.throws($$select * from public.ingest_source_event_for(auth.uid(), 'email', 'direct', p_kind => 'expense', p_amount_minor => 100)$$,
  'permission denied for function ingest_source_event_for', 'signed-in users can''t call the import service''s entry point');

-- The import service delivers as the service role.
reset role;
set role service_role;
set request.jwt.claims = '{"role":"service_role"}';
select tests.eq((select row(processing_status, entry_kind, replayed)::text from public.ingest_source_event_for(
    tests.id('C'), 'bank_import', 'stmt-0525-7', p_external_transaction_id => 'BNK-7',
    p_kind => 'expense', p_amount_minor => 42100, p_occurred_at => tests.ist('2026-05-25 10:00'),
    p_merchant => 'Amazon', p_account_hint => 'HDFC ••1234', p_account_id => tests.id('C:bank'),
    p_confidence => 0.99)),
  row('imported', 'expense', false)::text, 'the import service (service role) delivers evidence for a user');
select tests.eq((select row(processing_status, replayed)::text from public.ingest_source_event_for(
    tests.id('C'), 'bank_import', 'stmt-0525-7', p_kind => 'expense', p_amount_minor => 42100)),
  row('imported', true)::text, 'its redelivery is a no-op');
reset role;

set role authenticated;
select tests.login(tests.id('C'));
select tests.eq((select row(t.source_type, t.created_via, t.merchant, e.parsed_account_hint)::text
                 from public.transactions t join public.source_events e on e.resulting_transaction_id = t.id
                 where e.external_event_id = 'stmt-0525-7'),
  row('bank_import', 'import', 'Amazon', 'HDFC ••1234')::text, 'a bank import is marked as one; only parsed facts are kept');

-- What the import section adds up to.
select tests.eq((select count(*) from public.source_events where processing_status = 'needs_review'), 16::bigint,
  '16 pieces of evidence wait for review');
select tests.eq((select row(review_events, review_entries, pending_entries)::text from public.ledger_attention()),
  row(16, 0, 1)::text, 'attention: 16 events to review, the pending fuel hold');
select tests.eq((select row(pending_minor, review_count)::text from public.account_balances where id = tests.id('C:bank')),
  row(-60000, 0)::text, 'the bank shows the pending fuel hold');
select tests.eq((select row(income, spending, refunds, refund_count, pending_count)::text from tests.month('2026-05')),
  row(0, 446100, 82700, 2, 1)::text, 'May: every purchase counted once, however much evidence arrived');
select tests.eq(tests.balance('C:bank'), tests.num('C:bank@imports') - 446100, 'the bank moved by exactly May''s net spending');

-- link_source_event checks the linked entry's own type, so income evidence
-- can't be swallowed by a purchase whatever kind the caller names.
select tests.holds_after(
  $$select * from public.link_source_event(tests.id('ev:m-23'), 'income', tests.id('C:shoes'))$$,
  $$select processing_status = 'needs_review' from public.source_events where id = tests.id('ev:m-23')$$,
  'link checks the linked entry''s real kind, not the kind the caller names');

select tests.eq((select status from tests.submit('m-32', 'expense', 10000, 'C:wallet', '2026-05-27 10:00',
    p_tx => 'UTR-7007', p_state => 'pending')), 'imported', 'a pending authorisation in rupees');
insert into tests.ids select 'C:usd-hold', resulting_transaction_id from public.source_events where id = tests.id('ev:m-32');
-- A settlement reported in another currency never rewrites a rupee entry.
select tests.holds_after(
  $$select * from tests.submit('m-33', 'expense', 9500, 'C:wallet', '2026-05-27 11:00', p_tx => 'UTR-7007', p_currency => 'USD')$$,
  $$select row(status, amount_minor)::text = row('pending', 10000)::text from public.transactions where id = tests.id('C:usd-hold')$$,
  'a settlement in another currency never rewrites a rupee entry');
select tests.eq((select row(e.processing_status, t.status, t.amount_minor, (select count(*) from public.source_events where external_event_id = 'm-33'))::text
                 from public.source_events e, public.transactions t
                 where e.id = tests.id('ev:m-23') and t.id = tests.id('C:usd-hold')),
  row('needs_review', 'pending', 10000, 0)::text, 'the rolled-back scenarios left nothing behind');
select tests.eq(public.set_entry_status('expense', tests.id('C:usd-hold'), 'voided') is not null, true, 'void the rupee hold');

-- -----------------------------------------------------------------------------
-- Rejected input and other users' things (as C)
-- -----------------------------------------------------------------------------

select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'expense', 0, tests.id('C:bank'))$$,
  'more than zero', 'zero amount rejected');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', -100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:lamp'))$$,
  'more than zero', 'negative refund rejected');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'income', 10000000000001, tests.id('C:bank'))$$,
  'check constraint', 'amount over the cap rejected');
select tests.throws($$insert into public.transactions (account_id, type, amount_minor, related_transaction_id)
    values (tests.id('C:bank'), 'refund', 0, tests.id('C:lamp'))$$,
  'check constraint', 'the table refuses a zero refund too');
select tests.throws($$insert into public.transfers (source_account_id, destination_account_id, amount_minor)
    values (tests.id('C:bank'), tests.id('C:cash'), -1)$$,
  'check constraint', 'a negative transfer is refused');
select tests.throws($$insert into public.transactions (account_id, type, amount_minor, currency) values (tests.id('C:bank'), 'expense', 100, 'USD')$$,
  'must match the account currency', 'an entry uses its account''s currency');
select tests.throws($$insert into public.transfers (source_account_id, destination_account_id, amount_minor, currency)
    values (tests.id('C:bank'), tests.id('C:cash'), 100, 'USD')$$,
  'must match the accounts', 'a transfer uses its accounts'' currency');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'expense', 100, tests.id('C:bank'), p_status => 'voided')$$,
  'posted, pending or waiting for review', 'a new entry can''t start voided');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'expense', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('C:lamp'))$$,
  'Only refunds and reversals point at another entry', 'an expense can''t point at another entry');

select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'expense', 100, tests.id('E:bank'))$$,
  'Choose one of your accounts', 'C can''t record on E''s account');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'transfer', 100, tests.id('C:bank'), tests.id('E:bank'))$$,
  'Choose a destination account', 'C can''t transfer into E''s account');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'transfer', 100, tests.id('E:bank'), tests.id('C:bank'))$$,
  'Choose a source account', 'C can''t transfer out of E''s account');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'expense', 100, tests.id('C:bank'),
    p_category_id => tests.id('E:cat:Shopping'))$$,
  'foreign key', 'C can''t use E''s category');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('E:shoes'))$$,
  'The original entry doesn''t exist', 'C can''t refund E''s purchase');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'reversal', 100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('E:shoes'))$$,
  'The original entry doesn''t exist', 'C can''t reverse E''s entry');
select tests.throws($$select public.make_refund(tests.id('C:refund-unlinked'), tests.id('E:shoes'))$$,
  'The original entry doesn''t exist', 'C can''t link a refund to E''s purchase');
select tests.throws($$select public.update_entry('expense', tests.id('C:lamp'), null, 'expense', 100000, tests.id('E:bank'))$$,
  'Choose one of your accounts', 'C can''t move an entry onto E''s account');
select tests.throws($$select * from public.confirm_source_event(tests.id('ev:m-12'), 'expense', 11200, tests.id('E:bank'))$$,
  'Choose one of your accounts', 'confirming evidence can''t reach E''s account');
select tests.throws($$select * from public.confirm_source_event(tests.id('ev:m-22'), 'reversal', 5100, tests.id('C:bank'),
    p_related_transaction_id => tests.id('E:shoes'))$$,
  'The original entry doesn''t exist', 'confirming evidence can''t reach E''s entry');
select tests.throws($$select public.link_source_event(tests.id('ev:m-12'), 'expense', tests.id('E:shoes'))$$,
  'no longer exists', 'evidence can''t be linked to E''s entry');
select tests.throws($$insert into public.transactions (user_id, account_id, type, amount_minor)
    values (tests.id('E'), tests.id('E:bank'), 'expense', 100)$$,
  'Choose one of your accounts', 'C can''t write entries as E');

reset role;

-- -----------------------------------------------------------------------------
-- E sees and changes nothing of C's
-- -----------------------------------------------------------------------------

set role authenticated;
select tests.login(tests.id('E'));

select tests.eq((select count(*) from public.transactions where user_id = tests.id('C')), 0::bigint, 'E sees none of C''s transactions');
select tests.eq((select count(*) from public.transfers where user_id = tests.id('C')), 0::bigint, 'E sees none of C''s transfers');
select tests.eq((select count(*) from public.source_events where user_id = tests.id('C')), 0::bigint, 'E sees none of C''s evidence');
select tests.eq((select count(*) from public.ledger_audit where user_id = tests.id('C')), 0::bigint, 'E sees none of C''s audit trail');
select tests.eq((select count(*) from public.ledger_entries where user_id = tests.id('C')), 0::bigint, 'E sees none of C''s feed');
select tests.eq((select count(*) from public.account_balances where user_id = tests.id('C')), 0::bigint, 'E sees none of C''s balances');
select tests.eq((select row(income_minor, expense_minor)::text from public.period_summary('-infinity', 'infinity')),
  row(0, 100000)::text, 'E''s insights are E''s alone');
select tests.eq((select row(review_events, review_entries, pending_entries)::text from public.ledger_attention()),
  row(0, 0, 0)::text, 'E''s review queue is E''s alone');

with u as (update public.transactions set amount_minor = 1 where id = tests.id('C:sofa') returning 1)
select tests.eq(count(*), 0::bigint, 'E can''t update C''s transaction') from u;
with u as (update public.transfers set amount_minor = 1 where id = tests.id('C:atm') returning 1)
select tests.eq(count(*), 0::bigint, 'E can''t update C''s transfer') from u;
select tests.throws($$update public.source_events set processing_status = 'ignored' where user_id = tests.id('C')$$,
  'permission denied for table source_events', 'E can''t change C''s evidence');
select tests.throws($$delete from public.ledger_audit where user_id = tests.id('C')$$,
  'permission denied for table ledger_audit', 'E can''t touch C''s audit trail');
select tests.throws($$select public.set_entry_status('expense', tests.id('C:swiggy'), 'voided')$$,
  'no longer exists', 'E can''t void C''s entry');
select tests.throws($$select public.set_entry_deleted('expense', tests.id('C:swiggy'), true)$$,
  'no longer exists', 'E can''t delete C''s entry');
select tests.throws($$select public.update_entry('expense', tests.id('C:swiggy'), null, 'expense', 1, tests.id('E:bank'))$$,
  'no longer exists', 'E can''t edit C''s entry');
select tests.throws($$select public.make_refund(tests.id('C:refund-unlinked'), tests.id('E:shoes'))$$,
  'no longer exists', 'E can''t relink C''s refund');
select tests.throws($$select * from public.record_entry(gen_random_uuid(), 'refund', 100, tests.id('E:bank'),
    p_related_transaction_id => tests.id('C:sofa'))$$,
  'The original entry doesn''t exist', 'E can''t refund C''s purchase');
select tests.throws($$select * from public.confirm_source_event(tests.id('ev:m-12'), 'expense', 11200, tests.id('E:bank'))$$,
  'no longer in your review queue', 'E can''t confirm C''s evidence');
select tests.throws($$select public.link_source_event(tests.id('ev:m-12'), 'expense', tests.id('E:shoes'))$$,
  'no longer in your review queue', 'E can''t link C''s evidence');
select tests.throws($$select public.ignore_source_event(tests.id('ev:m-12'))$$,
  'no longer in your review queue', 'E can''t ignore C''s evidence');
select tests.throws($$select * from public.ingest_source_event_for(tests.id('C'), 'email', 'forged-1', p_kind => 'expense', p_amount_minor => 100)$$,
  'permission denied for function ingest_source_event_for', 'E can''t deliver evidence for C');
set friday.ingest_caller = 'submit';
set request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"service_role"}';
select tests.throws($$select * from public.ingest_source_event_for(tests.id('C'), 'email', 'forged-2', p_kind => 'expense', p_amount_minor => 100)$$,
  'permission denied for function ingest_source_event_for', 'nor by forging the caller flag or the role claim');
reset friday.ingest_caller;
select tests.login(tests.id('E'));
select tests.eq((select row(status, reason)::text from public.submit_source_event('email', 'e-1', p_kind => 'expense',
    p_amount_minor => 100, p_occurred_at => now(), p_account_id => tests.id('C:bank'), p_confidence => 0.99) as s (event_id, status, reason, k, i, r)),
  row('needs_review', 'unknown_account')::text, 'E''s evidence naming C''s account finds no account');

reset role;

select tests.eq((select row(amount_minor, status)::text from public.transactions where id = tests.id('C:sofa')),
  row(200000, 'posted')::text, 'C''s purchase untouched by E');
select tests.eq((select row(amount_minor, status)::text from public.transactions where id = tests.id('C:swiggy')),
  row(64900, 'posted')::text, 'C''s import untouched by E');
select tests.eq((select row(processing_status, user_id = tests.id('C'))::text from public.source_events where id = tests.id('ev:m-12')),
  row('needs_review', true)::text, 'C''s evidence untouched by E');
select tests.eq((select count(*) from public.source_events where user_id = tests.id('C') and external_event_id like 'forged%'), 0::bigint,
  'no evidence was delivered for C by anyone else');

-- -----------------------------------------------------------------------------
-- Anonymous visitors get nothing
-- -----------------------------------------------------------------------------

set role anon;
select tests.throws($$select * from public.transactions$$, 'permission denied for table transactions', 'anon can''t read transactions');
select tests.throws($$select * from public.transfers$$, 'permission denied for table transfers', 'anon can''t read transfers');
select tests.throws($$select * from public.source_events$$, 'permission denied for table source_events', 'anon can''t read evidence');
select tests.throws($$select * from public.source_connections$$, 'permission denied for table source_connections', 'anon can''t read connections');
select tests.throws($$select * from public.ledger_audit$$, 'permission denied for table ledger_audit', 'anon can''t read the audit trail');
select tests.throws($$select * from public.ledger_entries$$, 'permission denied for view ledger_entries', 'anon can''t read the feed');
select tests.throws($$select * from public.account_balances$$, 'permission denied for view account_balances', 'anon can''t read balances');
select tests.throws($$select * from public.ledger_attention()$$, 'permission denied for function ledger_attention', 'anon can''t read attention counts');
select tests.throws($$select * from public.account_activity(now(), now())$$, 'permission denied for function account_activity', 'anon can''t read account activity');
select tests.throws($$select * from public.submit_source_event('email', 'anon-1', p_kind => 'expense', p_amount_minor => 100)$$,
  'permission denied for function submit_source_event', 'anon can''t submit evidence');
select tests.throws($$select * from public.ingest_source_event_for(gen_random_uuid(), 'email', 'anon-2')$$,
  'permission denied for function ingest_source_event_for', 'anon can''t deliver evidence');
select tests.throws($$select * from public.confirm_source_event(gen_random_uuid(), 'expense', 100, gen_random_uuid())$$,
  'permission denied for function confirm_source_event', 'anon can''t confirm evidence');
select tests.throws($$select public.link_source_event(gen_random_uuid(), 'expense', gen_random_uuid())$$,
  'permission denied for function link_source_event', 'anon can''t link evidence');
select tests.throws($$select public.ignore_source_event(gen_random_uuid())$$,
  'permission denied for function ignore_source_event', 'anon can''t ignore evidence');
select tests.throws($$select public.set_entry_status('expense', gen_random_uuid(), 'voided')$$,
  'permission denied for function set_entry_status', 'anon can''t change a status');
select tests.throws($$select public.set_entry_deleted('expense', gen_random_uuid(), true)$$,
  'permission denied for function set_entry_deleted', 'anon can''t delete');
select tests.throws($$select public.make_refund(gen_random_uuid(), gen_random_uuid())$$,
  'permission denied for function make_refund', 'anon can''t make refunds');
select tests.throws($$select public.delete_all_my_data()$$,
  'permission denied for function delete_all_my_data', 'anon can''t wipe data');
reset role;

-- -----------------------------------------------------------------------------
-- Deleting everything, imports included
-- -----------------------------------------------------------------------------

set role authenticated;
select tests.login(tests.id('C'));
select public.delete_all_my_data();
select tests.eq(row((select count(*) from public.source_events), (select count(*) from public.transactions),
                    (select count(*) from public.transfers), (select count(*) from public.ledger_audit),
                    (select count(*) from public.accounts))::text,
  row(0, 0, 0, 0, 0)::text, 'delete_all_my_data removes imported entries and their evidence too');
select tests.eq((select count(*) from public.categories), 19::bigint, 'and starts again from the default categories');
reset role;

select tests.eq((select count(*) from public.source_events where user_id = tests.id('C')), 0::bigint, 'no evidence is left for C');
select tests.eq((select count(*) from public.transactions where user_id = tests.id('E')), 1::bigint, 'E''s entries survive C''s wipe');

do $$ begin raise notice 'All ledger model tests passed.'; end $$;
