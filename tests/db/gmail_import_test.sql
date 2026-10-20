-- LOCAL TESTING ONLY — never run this in the Supabase dashboard or against a
-- hosted project. Runs after gmail_test.sql (reuses its helpers).
--
-- Tests for importing past months from Gmail (migrations 0005, 0006): choosing
-- months, reading results, discovering accounts and cards, the person's
-- choices (link / create / ignore / review), balances kept exactly when older
-- history arrives, what gets recorded vs sent to review, re-imports that never
-- duplicate, undo, cancel, isolation and deletion. Dates are relative to today
-- (in India), so the tests pass whenever they run. New users: M and N.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'STOP: tests/db/gmail_import_test.sql is for local testing only. In Supabase, run only supabase/migrations/*.sql.';
  end if;
end
$$;

set client_min_messages = notice;

-- 'YYYY-MM' of the month n months ago, and an instant in it (local IST time).
create function tests.mo(n integer) returns text language sql stable as $$
  select to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - make_interval(months => n), 'YYYY-MM');
$$;
create function tests.at(n integer, p_day integer, p_time text default '10:00') returns timestamptz language sql stable as $$
  select ((date_trunc('month', now() at time zone 'Asia/Kolkata') - make_interval(months => n))::date + (p_day - 1)
          + p_time::time) at time zone 'Asia/Kolkata';
$$;
-- One email's parsed facts, as the Edge Function sends them.
create function tests.alert(
  p_id text, p_inst text, p_instrument text, p_mask text, p_kind text, p_amount bigint, p_at timestamptz,
  p_merchant text default null, p_ref text default null, p_conf numeric default 0.97, p_hint text default null,
  p_status text default 'posted', p_transfer text default null)
returns jsonb language sql immutable as $$
  select jsonb_build_object('messageId', p_id, 'alert', jsonb_strip_nulls(jsonb_build_object(
    'institutionKey', p_inst,
    'institutionName', case p_inst when 'hdfc' then 'HDFC Bank' when 'icici' then 'ICICI Bank' when 'paytm' then 'Paytm'
                                   when 'yes' then 'Yes Bank' when 'phonepe' then 'PhonePe' else initcap(p_inst) end,
    'instrument', p_instrument, 'accountMask', p_mask, 'kind', p_kind, 'transferHint', p_transfer,
    'amountMinor', p_amount, 'currency', 'INR', 'occurredAt', p_at, 'merchant', p_merchant, 'reference', p_ref,
    'entryStatus', p_status, 'categoryHint', p_hint, 'confidence', p_conf, 'senderVerified', true)));
$$;
create function tests.items_of(p_job text) returns table (message_id text, outcome text) language sql stable security definer as $$
  select message_id, outcome from friday_private.gmail_import_items where job_id = tests.id(p_job) order by message_id;
$$;
create function tests.job(p_job text) returns public.gmail_import_jobs language sql stable security definer as $$
  select * from public.gmail_import_jobs where id = tests.id(p_job);
$$;
create function tests.entries_of(p_user text) returns bigint language sql stable security definer as $$
  select count(*) from public.transactions where user_id = tests.id(p_user) and deleted_at is null;
$$;
-- The account a number seen in email is linked to.
create function tests.linked(p_user text, p_inst text, p_instrument text, p_mask text) returns uuid language sql stable security definer as $$
  select account_id from public.import_account_aliases
  where user_id = tests.id(p_user) and institution_key = p_inst and instrument = p_instrument and account_mask = p_mask;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
grant select on tests.nums to service_role;

set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data) values
  ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'meera@example.com', '{}'),
  ('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2', 'nikhil@example.com', '{}');
reset role;
insert into tests.ids values ('M', 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'), ('N', 'a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2');

-- M's Friday: HDFC savings started this month with ₹50,000; a cash wallet;
-- one entry this month and one backdated into last month.
set role authenticated;
select tests.login(tests.id('M'));
with made as (
  insert into public.accounts (name, type, opening_balance_minor, opening_date, institution_name) values
    ('HDFC Savings', 'bank', 5000000, (date_trunc('month', now() at time zone 'Asia/Kolkata'))::date, 'HDFC Bank'),
    ('Cash',         'cash', 0,       (date_trunc('month', now() at time zone 'Asia/Kolkata'))::date, null)
  returning case name when 'HDFC Savings' then 'M:hdfc' else 'M:cash' end as key, id
)
insert into tests.ids select key, id from made;
insert into tests.ids select 'M:cat:' || name, id from public.categories where user_id = tests.id('M');
insert into tests.ids select 'M:manual-now', id from public.record_entry(gen_random_uuid(), 'expense', 10000, tests.id('M:hdfc'),
  p_occurred_at => tests.at(0, 1, '00:30'), p_category_id => tests.id('M:cat:Other'));
insert into tests.ids select 'M:manual-old', id from public.record_entry(gen_random_uuid(), 'expense', 45000, tests.id('M:hdfc'),
  p_occurred_at => tests.at(1, 15, '18:00'), p_category_id => tests.id('M:cat:Groceries'), p_merchant => 'DMart');
reset role;
-- Every entry counts today, whatever its date: 50,000 − 100 − 450.
select tests.eq(tests.balance('M:hdfc'), 4945000::bigint, 'before importing, HDFC shows ₹49,450');

-- M has Gmail connected (as 0004 leaves it).
insert into public.source_connections (user_id, source_type, label, status, provider, account_email, scopes, connected_at)
values (tests.id('M'), 'email', 'meera@gmail.com', 'active', 'gmail', 'meera@gmail.com',
        array['https://www.googleapis.com/auth/gmail.readonly'], now());
insert into tests.ids select 'M:gmail', id from public.source_connections where user_id = tests.id('M');

-- -----------------------------------------------------------------------------
-- Who may run imports
-- -----------------------------------------------------------------------------

set role authenticated;
select tests.login(tests.id('M'));
select tests.throws($$select * from public.gmail_import_begin(tests.id('M'), array[tests.mo(0)])$$, 'permission denied',
  'a signed-in user can''t drive an import directly (only through Friday''s server)');
select tests.throws($$insert into public.gmail_import_jobs (user_id, connection_id, months) values (tests.id('M'), tests.id('M:gmail'), array['2026-01'])$$,
  'permission denied', 'or write import jobs');
select tests.throws($$insert into public.import_account_aliases (user_id, institution_key, institution_name, instrument) values (tests.id('M'), 'x', 'X', 'bank')$$,
  'permission denied', 'or account links');
reset role;
set role anon;
select tests.throws($$select * from public.gmail_import_jobs$$, 'permission denied', 'visitors see no imports');
reset role;

-- -----------------------------------------------------------------------------
-- Choosing months
-- -----------------------------------------------------------------------------

set role service_role;
select tests.as_server();
select tests.throws($$select * from public.gmail_import_begin(tests.id('N'), array[tests.mo(0)])$$, 'Connect Gmail first',
  'importing needs a connected Gmail');
select tests.throws($$select * from public.gmail_import_begin(tests.id('M'), array[tests.mo(3)])$$, 'this month and the two before it',
  'at most three months back');
select tests.throws($$select * from public.gmail_import_begin(tests.id('M'), array['2026-13'])$$, 'this month and the two before it',
  'months must be real');
select tests.throws($$select * from public.gmail_import_begin(tests.id('M'), array[]::text[])$$, 'at least one month',
  'and there must be one');

insert into tests.ids
select distinct 'M:job1', job_id from public.gmail_import_begin(tests.id('M'), array[tests.mo(1), tests.mo(2), tests.mo(1)]);
select tests.eq((select months from tests.job('M:job1')), array[tests.mo(2), tests.mo(1)],
  'months are kept once each, oldest first');
select tests.throws($$select * from public.gmail_import_begin(tests.id('M'), array[tests.mo(0)])$$, 'already in progress',
  'one import at a time');

-- -----------------------------------------------------------------------------
-- Reading: results for each email
-- -----------------------------------------------------------------------------

select tests.eq(public.gmail_import_add_messages(tests.id('M'), tests.id('M:job1'),
  array['a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1', 'i1', 'j1', 'k1', 'l1', 'a1']), 12,
  'the emails found are queued once each');
select tests.eq((select status from tests.job('M:job1')), 'scanning', 'and the import starts reading');
select tests.eq((select count(*) from public.gmail_import_pending(tests.id('M'), tests.id('M:job1'), 5)), 5::bigint,
  'emails are read in small batches');
select tests.throws($$select * from public.gmail_import_pending(tests.id('N'), tests.id('M:job1'), 5)$$, 'no longer exists',
  'another user can''t read someone else''s import');

select tests.eq((select status from public.gmail_import_save(tests.id('M'), tests.id('M:job1'), jsonb_build_array(
  tests.alert('a1', 'hdfc',    'bank',        '1234', 'expense', 25000,  tests.at(1, 5, '09:00'),  'Blue Tokai', 'UTR4291', 0.97, 'Food & dining'),
  tests.alert('b1', 'hdfc',    'bank',        '1234', 'income',  500000, tests.at(2, 3, '11:00'),  'ACME PAYROLL', null, 0.97, 'Salary'),
  tests.alert('c1', 'icici',   'credit_card', '9001', 'expense', 149900, tests.at(1, 7, '12:30'),  'AMAZON', 'RRN77', 0.97, 'Shopping'),
  tests.alert('d1', 'icici',   'credit_card', '9001', 'transfer', 149900, tests.at(1, 20, '08:00'), null, null, 0.7, null, 'posted', 'card_payment'),
  tests.alert('e1', 'hdfc',    'bank',        '1234', 'expense', 30000,  tests.at(1, 8, '20:00'),  'SOMETHING', null, 0.6),
  tests.alert('f1', 'paytm',   'wallet',      null,   'expense', 12000,  tests.at(2, 10, '13:00'), 'Chai Point', null, 0.97)
))), 'scanning', 'a partial batch keeps reading');
select tests.eq((select row(status, scanned, total)::text from public.gmail_import_save(tests.id('M'), tests.id('M:job1'), jsonb_build_array(
  tests.alert('g1', 'yes',     'bank',        '5678', 'expense', 99900,  tests.at(1, 9)),
  jsonb_build_object('messageId', 'h1', 'skip', 'otp'),
  tests.alert('i1', 'phonepe', 'unknown',     null,   'expense', 25000,  tests.at(1, 5, '09:01'),  'Blue Tokai', 'UTR4291', 0.6),
  tests.alert('j1', 'hdfc',    'bank',        '1234', 'expense', 45000,  tests.at(1, 15, '18:05'), 'DMART', 'UTR5555', 0.97),
  tests.alert('k1', 'hdfc',    'bank',        '1234', 'expense', 70000,  tests.at(1, 16), 'Flipkart', null, 0.97, null, 'declined'),
  tests.alert('l1', 'hdfc',    'bank',        '1234', 'transfer', 200000, tests.at(1, 18), null, null, 0.7, null, 'posted', 'cash_withdrawal')
))), row('confirm_accounts', 12, 12)::text, 'once every email is read, the import asks about accounts');
select tests.eq((select row(skipped)::text from tests.job('M:job1')), row(1)::text, 'the OTP email was skipped');

-- -----------------------------------------------------------------------------
-- Accounts and cards found in the emails
-- -----------------------------------------------------------------------------

select tests.eq((select string_agg(institution_key || '/' || instrument || '/' || account_mask || ':' || messages, ', ' order by institution_key, instrument)
                 from public.gmail_import_accounts(tests.id('M'), tests.id('M:job1'))),
  'hdfc/bank/1234:6, icici/credit_card/9001:2, paytm/wallet/:1, phonepe/unknown/:1, yes/bank/5678:1',
  'each bank account, card and wallet the emails mention, with how many emails');
select tests.eq((select suggested_account_id from public.gmail_import_accounts(tests.id('M'), tests.id('M:job1')) where institution_key = 'hdfc'),
  tests.id('M:hdfc'), 'HDFC ••1234 is suggested as the HDFC account already in Friday');
select tests.eq((select row(suggested_account_id, suggested_name, suggested_type)::text
                 from public.gmail_import_accounts(tests.id('M'), tests.id('M:job1')) where institution_key = 'icici'),
  row(null::uuid, 'ICICI Bank card ••9001', 'credit_card')::text, 'a card Friday doesn''t know is suggested as a new card');
select tests.eq((select row(suggested_name, suggested_type)::text
                 from public.gmail_import_accounts(tests.id('M'), tests.id('M:job1')) where institution_key = 'paytm'),
  row('Paytm wallet', 'wallet')::text, 'a wallet as a new wallet');
select tests.eq((select suggested_type from public.gmail_import_accounts(tests.id('M'), tests.id('M:job1')) where institution_key = 'phonepe'),
  null::text, 'a payment app without an account number gets no account suggestion');

select tests.throws($$select * from public.gmail_import_apply_accounts(tests.id('M'), tests.id('M:job1'), '[]'::jsonb)$$,
  'Choose what to do with', 'every account needs a choice');
select tests.throws($$select * from public.gmail_import_apply_accounts(tests.id('M'), tests.id('M:job1'), jsonb_build_array(
    jsonb_build_object('institutionKey', 'hdfc', 'instrument', 'bank', 'accountMask', '1234', 'action', 'link', 'accountId', gen_random_uuid()),
    jsonb_build_object('institutionKey', 'icici', 'instrument', 'credit_card', 'accountMask', '9001', 'action', 'ignore'),
    jsonb_build_object('institutionKey', 'paytm', 'instrument', 'wallet', 'accountMask', '', 'action', 'ignore'),
    jsonb_build_object('institutionKey', 'yes', 'instrument', 'bank', 'accountMask', '5678', 'action', 'ignore'),
    jsonb_build_object('institutionKey', 'phonepe', 'instrument', 'unknown', 'accountMask', '', 'action', 'review')))$$,
  'Choose one of your active accounts', 'linking needs one of the person''s own accounts');
select tests.eq(tests.balance('M:hdfc'), 4945000::bigint, '(that changed nothing)');

select tests.eq((select row(created_accounts, linked_accounts, kept_balances)::text
                 from public.gmail_import_apply_accounts(tests.id('M'), tests.id('M:job1'), jsonb_build_array(
    jsonb_build_object('institutionKey', 'hdfc', 'instrument', 'bank', 'accountMask', '1234', 'action', 'link', 'accountId', tests.id('M:hdfc')),
    jsonb_build_object('institutionKey', 'icici', 'instrument', 'credit_card', 'accountMask', '9001', 'action', 'create',
                       'name', 'ICICI Amazon Pay card', 'type', 'credit_card'),
    jsonb_build_object('institutionKey', 'paytm', 'instrument', 'wallet', 'accountMask', '', 'action', 'create',
                       'name', 'Paytm wallet', 'type', 'wallet', 'openingBalanceMinor', 100000),
    jsonb_build_object('institutionKey', 'yes', 'instrument', 'bank', 'accountMask', '5678', 'action', 'ignore'),
    jsonb_build_object('institutionKey', 'phonepe', 'instrument', 'unknown', 'accountMask', '', 'action', 'review')))),
  row(2, 1, 1)::text, 'two accounts created, one linked; its balance kept as it is');
insert into tests.ids select 'M:card', tests.linked('M', 'icici', 'credit_card', '9001');
insert into tests.ids select 'M:paytm', tests.linked('M', 'paytm', 'wallet', '');

select tests.eq(tests.balance('M:hdfc'), 4945000::bigint, 'linking older history doesn''t move HDFC''s balance');
select tests.eq((select row(opening_date, balance_from)::text from public.accounts where id = tests.id('M:hdfc')),
  row((date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '2 months')::date,
      (date_trunc('month', now() at time zone 'Asia/Kolkata'))::date)::text,
  'HDFC now tracks history from the first imported month; its balance counts from its old start');
select tests.eq((select row(name, type, institution_name, opening_balance_minor, opening_date)::text from public.accounts where id = tests.id('M:card')),
  row('ICICI Amazon Pay card', 'credit_card', 'ICICI Bank', 0::bigint, (date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '2 months')::date)::text,
  'a new card starts on the first imported day');
select tests.eq((select ignored from public.import_account_aliases where user_id = tests.id('M') and institution_key = 'yes'), true,
  'Yes Bank ••5678 is remembered as ignored');
select tests.eq((select count(*) from public.import_account_aliases where user_id = tests.id('M') and institution_key = 'phonepe'), 0::bigint,
  'and nothing is remembered for "send to review"');

-- -----------------------------------------------------------------------------
-- Importing: recorded, matched, reviewed, skipped
-- -----------------------------------------------------------------------------

select tests.eq((select row(processed, remaining, status)::text from public.gmail_import_run(tests.id('M'), tests.id('M:job1'), 4)),
  row(4, 7, 'importing')::text, 'imports run in batches');
select tests.eq((select row(remaining, status)::text from public.gmail_import_run(tests.id('M'), tests.id('M:job1'))),
  row(0, 'done')::text, 'until nothing is left');

select tests.eq((select string_agg(message_id || ':' || outcome, ', ') from tests.items_of('M:job1') where outcome is not null),
  'a1:recorded, b1:recorded, c1:recorded, d1:needs_review, e1:needs_review, f1:recorded, g1:skipped_account, i1:matched, j1:needs_review, k1:ignored, l1:needs_review',
  'each email''s outcome');
select tests.eq((select row(recorded, matched, review, ignored, declined, failed, skipped)::text from tests.job('M:job1')),
  row(4, 1, 4, 1, 1, 0, 1)::text, 'the import''s summary adds up');
select tests.eq((select skip_reasons from tests.job('M:job1')), '{"otp": 1}'::jsonb, 'and says why emails were left out');

select tests.eq((select row(t.type, t.amount_minor, t.merchant, c.name, t.status, t.source_type, t.created_via)::text
                 from public.source_events e join public.transactions t on t.id = e.resulting_transaction_id
                 left join public.categories c on c.id = t.category_id
                 where e.external_event_id = 'a1' and e.user_id = tests.id('M')),
  row('expense', 25000::bigint, 'Blue Tokai', 'Food & dining', 'posted', 'email', 'import')::text,
  'a confident debit is recorded as an expense, in the suggested category');
select tests.eq((select row(t.type, c.name)::text from public.source_events e join public.transactions t on t.id = e.resulting_transaction_id
                 left join public.categories c on c.id = t.category_id where e.external_event_id = 'b1' and e.user_id = tests.id('M')),
  row('income', 'Salary')::text, 'a salary credit as income');
select tests.eq((select t.account_id from public.source_events e join public.transactions t on t.id = e.resulting_transaction_id
                 where e.external_event_id = 'c1' and e.user_id = tests.id('M')), tests.id('M:card'),
  'the card spend lands on the new card');
select tests.eq((select row(review_reason, suggested_account_id)::text from public.source_events where external_event_id = 'd1' and user_id = tests.id('M')),
  row('possible_transfer', tests.id('M:card'))::text, 'a payment received on the card waits as a possible bill payment');
select tests.eq((select review_reason from public.source_events where external_event_id = 'e1' and user_id = tests.id('M')),
  'low_confidence', 'an email Friday wasn''t sure about waits for review');
select tests.eq((select row(link_type, resulting_transaction_id = (select resulting_transaction_id from public.source_events
                                                                     where external_event_id = 'a1' and user_id = tests.id('M')))::text
                 from public.source_events where external_event_id = 'i1' and user_id = tests.id('M')),
  row('matched', true)::text, 'a payment app''s email about the same UPI payment is linked to it, not counted twice');
select tests.eq((select row(review_reason, suggested_match_id)::text from public.source_events where external_event_id = 'j1' and user_id = tests.id('M')),
  row('possible_duplicate', tests.id('M:manual-old'))::text, 'an email matching an entry already typed in by hand waits as a possible duplicate');
select tests.eq((select processing_status from public.source_events where external_event_id = 'k1' and user_id = tests.id('M')),
  'ignored', 'a declined payment records nothing');
select tests.eq((select row(review_reason, suggested_destination_account_id)::text from public.source_events where external_event_id = 'l1' and user_id = tests.id('M')),
  row('low_confidence', tests.id('M:cash'))::text, 'a cash withdrawal waits for review, suggested as a transfer into Cash');
select tests.eq((select count(*) from public.source_events where external_event_id in ('g1', 'h1') and user_id = tests.id('M')), 0::bigint,
  'nothing is kept from ignored accounts or non-transaction emails');

select tests.eq(tests.balance('M:hdfc'), 4945000::bigint, 'HDFC''s balance is still exactly what it was');
select tests.eq(tests.balance('M:card'), -149900::bigint, 'the card owes the purchase');
select tests.eq(tests.balance('M:paytm'), 88000::bigint, 'the wallet: ₹1,000 starting balance less ₹120');

set role authenticated;
select tests.login(tests.id('M'));
select tests.eq((select row(income, spending)::text from tests.month(tests.mo(1))),
  row(0::bigint, 45000 + 25000 + 149900::bigint)::text, 'last month''s spending now includes the imported purchases (and the hand-typed one once)');
select tests.eq((select row(income, spending)::text from tests.month(tests.mo(2))),
  row(500000::bigint, 12000::bigint)::text, 'and the month before: the salary and the wallet payment');
select tests.eq((select count(*) from public.gmail_import_jobs), 1::bigint, 'M sees M''s import');
select tests.eq((select count(*) from public.import_account_aliases), 4::bigint, 'and M''s account links');
select tests.login(tests.id('N'));
select tests.eq((select count(*) from public.gmail_import_jobs) + (select count(*) from public.import_account_aliases), 0::bigint,
  'N sees none of it');
reset role;

-- -----------------------------------------------------------------------------
-- Importing the same months again changes nothing
-- -----------------------------------------------------------------------------

insert into tests.nums values ('M:entries', tests.entries_of('M'));
set role service_role;
select tests.as_server();
insert into tests.ids select distinct 'M:job2', job_id from public.gmail_import_begin(tests.id('M'), array[tests.mo(1)]);
select tests.eq(public.gmail_import_add_messages(tests.id('M'), tests.id('M:job2'), array['a1', 'c1']), 2, 'two emails again');
select tests.eq((select status from public.gmail_import_save(tests.id('M'), tests.id('M:job2'), jsonb_build_array(
  tests.alert('a1', 'hdfc',  'bank',        '1234', 'expense', 25000,  tests.at(1, 5, '09:00'), 'Blue Tokai', 'UTR4291', 0.97, 'Food & dining'),
  tests.alert('c1', 'icici', 'credit_card', '9001', 'expense', 149900, tests.at(1, 7, '12:30'), 'AMAZON', 'RRN77', 0.97, 'Shopping')))),
  'confirm_accounts', 'a second import of last month');
select tests.eq((select string_agg(institution_key || ':' || (linked_account_id is not null)::text, ', ' order by institution_key)
                 from public.gmail_import_accounts(tests.id('M'), tests.id('M:job2'))),
  'hdfc:true, icici:true', 'already knows both accounts');
select tests.eq((select row(created_accounts, linked_accounts, kept_balances)::text
                 from public.gmail_import_apply_accounts(tests.id('M'), tests.id('M:job2'), jsonb_build_array(
  jsonb_build_object('institutionKey', 'hdfc', 'instrument', 'bank', 'accountMask', '1234', 'action', 'link', 'accountId', tests.id('M:hdfc')),
  jsonb_build_object('institutionKey', 'icici', 'instrument', 'credit_card', 'accountMask', '9001', 'action', 'link', 'accountId', tests.id('M:card'))))),
  row(0, 2, 0)::text, 'confirmed as before (balances already kept)');
select tests.eq((select status from public.gmail_import_run(tests.id('M'), tests.id('M:job2'))), 'done', 'it runs');
select tests.eq((select row(recorded, matched)::text from tests.job('M:job2')), row(0, 2)::text,
  'and finds both already in Friday');
select tests.eq(tests.entries_of('M'), tests.num('M:entries'), 'no entry was added twice');

-- Undoing the re-import leaves the first import's entries alone.
select tests.eq((select row(removed_entries, removed_events)::text from public.gmail_import_undo(tests.id('M'), tests.id('M:job2'))),
  row(0, 0)::text, 'undoing a re-import removes nothing the first import made');
select tests.eq(tests.entries_of('M'), tests.num('M:entries'), '(every entry is still there)');

-- -----------------------------------------------------------------------------
-- Undo
-- -----------------------------------------------------------------------------

-- A refund now depends on the imported Amazon purchase: that one stays.
reset role;
set role authenticated;
select tests.login(tests.id('M'));
select tests.eq((select count(*) from public.record_entry(gen_random_uuid(), 'refund', 49900, tests.id('M:card'),
  p_occurred_at => tests.at(1, 10), p_related_transaction_id =>
    (select resulting_transaction_id from public.source_events where external_event_id = 'c1' and user_id = tests.id('M')))),
  1::bigint, 'M records a partial refund of the imported Amazon purchase');
reset role;
set role service_role;
select tests.as_server();
select tests.throws($$select * from public.gmail_import_undo(tests.id('N'), tests.id('M:job1'))$$, 'no longer exists',
  'nobody else can undo M''s import');
select tests.eq((select row(removed_entries, kept_entries, removed_events)::text from public.gmail_import_undo(tests.id('M'), tests.id('M:job1'))),
  row(3, 1, 9)::text, 'undo removes what the import recorded, except what a refund depends on, and its evidence');
select tests.eq((select status from tests.job('M:job1')), 'undone', 'the import is marked undone');
select tests.eq((select count(*) from public.source_events where user_id = tests.id('M') and processing_status = 'needs_review'), 0::bigint,
  'its items leave the review queue');
select tests.eq(tests.balance('M:hdfc'), 4945000::bigint, 'HDFC''s balance is unchanged throughout');
select tests.eq((select count(*) from public.transactions where id in (tests.id('M:manual-now'), tests.id('M:manual-old')) and deleted_at is null),
  2::bigint, 'hand-typed entries are never touched');
select tests.throws($$select * from public.gmail_import_undo(tests.id('M'), tests.id('M:job1'))$$, 'is undone',
  'an import can only be undone once');

-- Undone months can be imported again from scratch.
insert into tests.ids select distinct 'M:job3', job_id from public.gmail_import_begin(tests.id('M'), array[tests.mo(1)]);
select tests.eq(public.gmail_import_add_messages(tests.id('M'), tests.id('M:job3'), array['a1']), 1, 'one email');
select tests.eq((select status from public.gmail_import_save(tests.id('M'), tests.id('M:job3'), jsonb_build_array(
  tests.alert('a1', 'hdfc', 'bank', '1234', 'expense', 25000, tests.at(1, 5, '09:00'), 'Blue Tokai', 'UTR4291', 0.97, 'Food & dining')))),
  'confirm_accounts', 'a fresh import of the undone month');
select tests.eq((select linked_accounts from public.gmail_import_apply_accounts(tests.id('M'), tests.id('M:job3'), jsonb_build_array(
  jsonb_build_object('institutionKey', 'hdfc', 'instrument', 'bank', 'accountMask', '1234', 'action', 'link', 'accountId', tests.id('M:hdfc'))))),
  1, 'HDFC confirmed');
select tests.eq((select status from public.gmail_import_run(tests.id('M'), tests.id('M:job3'))), 'done', 'runs');
select tests.eq((select recorded from tests.job('M:job3')), 1, 'and records it again');

-- -----------------------------------------------------------------------------
-- Cancel, failures, stale imports
-- -----------------------------------------------------------------------------

insert into tests.ids select distinct 'M:job4', job_id from public.gmail_import_begin(tests.id('M'), array[tests.mo(0)]);
select tests.eq(public.gmail_import_add_messages(tests.id('M'), tests.id('M:job4'), array['z1', 'z2']), 2, 'two emails');
select public.gmail_import_cancel(tests.id('M'), tests.id('M:job4'));
select tests.eq((select status from tests.job('M:job4')), 'cancelled', 'an import can be cancelled before it records anything');
select tests.eq((select count(*) from tests.items_of('M:job4')), 0::bigint, 'and forgets what it read');

insert into tests.ids select distinct 'M:job5', job_id from public.gmail_import_begin(tests.id('M'), array[tests.mo(0)]);
select public.gmail_import_fail(tests.id('M'), tests.id('M:job5'), 'gmail_unavailable');
select tests.eq((select row(status, error_code)::text from tests.job('M:job5')), row('failed', 'gmail_unavailable')::text,
  'a Gmail failure ends the import with a short code');
select tests.throws($$select public.gmail_import_fail(tests.id('M'), tests.id('M:job5'), 'Bearer abc')$$, 'is failed',
  'and it stays ended');

insert into tests.ids select distinct 'M:job6', job_id from public.gmail_import_begin(tests.id('M'), array[tests.mo(0)]);
reset role;
-- (bypassing the updated_at trigger to age it)
set session_replication_role = replica;
update public.gmail_import_jobs set updated_at = now() - interval '2 days' where id = tests.id('M:job6');
set session_replication_role = origin;
set role service_role;
select tests.eq((select count(distinct job_id) from public.gmail_import_begin(tests.id('M'), array[tests.mo(0)])), 1::bigint,
  'an import abandoned a day ago doesn''t block a new one');
select tests.eq((select status from tests.job('M:job6')), 'cancelled', '(it was cancelled)');
reset role;

-- -----------------------------------------------------------------------------
-- Every transaction is recorded or reviewed, never dropped (0006)
-- -----------------------------------------------------------------------------

reset role;
-- Stand-ins for anything in an email's facts that the import boundary might
-- reject: a reference it can't take (q3), or an email it can't take at all (q4).
create function tests.reject_some_events() returns trigger language plpgsql as $$
begin
  if new.external_transaction_id = 'BOOM123456' or new.external_event_id = 'q4' then
    raise exception 'rejected for the test';
  end if;
  return new;
end;
$$;
create trigger tests_reject_some_events before insert on public.source_events
  for each row execute function tests.reject_some_events();

set role service_role;
select tests.as_server();
select public.gmail_import_cancel(tests.id('M'), id) from public.gmail_import_jobs
where user_id = tests.id('M') and status = 'listing';
insert into tests.ids select distinct 'M:job7', job_id from public.gmail_import_begin(tests.id('M'), array[tests.mo(0)]);
select tests.eq(public.gmail_import_add_messages(tests.id('M'), tests.id('M:job7'),
  array['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']), 7, 'seven emails');
select tests.eq((select status from public.gmail_import_save(tests.id('M'), tests.id('M:job7'), jsonb_build_array(
  -- An amount, but no debit or credit Friday could read.
  tests.alert('q1', 'hdfc', 'bank', '1234', null,      52000, tests.at(0, 1, '10:00'), 'SOMEWHERE', null, 0.3),
  -- "Your account was debited", with no amount Friday could read.
  tests.alert('q2', 'hdfc', 'bank', '1234', 'expense', null,  tests.at(0, 1, '11:00'), null, null, 0.3),
  tests.alert('q3', 'hdfc', 'bank', '1234', 'expense', 9900,  tests.at(0, 1, '12:00'), 'CAFE', 'BOOM123456', 0.97),
  tests.alert('q4', 'hdfc', 'bank', '1234', 'expense', 9900,  tests.at(0, 1, '13:00'), 'CAFE', null, 0.97),
  jsonb_build_object('messageId', 'q5', 'skip', 'promotion'),
  jsonb_build_object('messageId', 'q6', 'skip', 'promotion'),
  jsonb_build_object('messageId', 'q7', 'skip', 'statement')))),
  'confirm_accounts', 'emails with a missing direction or amount are kept, not dropped');
select tests.eq((select skip_reasons from tests.job('M:job7')), '{"promotion": 2, "statement": 1}'::jsonb,
  'what was left out is counted by reason');
select tests.eq((select linked_accounts from public.gmail_import_apply_accounts(tests.id('M'), tests.id('M:job7'), jsonb_build_array(
  jsonb_build_object('institutionKey', 'hdfc', 'instrument', 'bank', 'accountMask', '1234', 'action', 'link', 'accountId', tests.id('M:hdfc'))))),
  1, 'HDFC confirmed');
reset role;
insert into tests.nums values ('M:entries7', tests.entries_of('M'));
set role service_role;
select tests.as_server();
select tests.eq((select status from public.gmail_import_run(tests.id('M'), tests.id('M:job7'))), 'done', 'runs');
select tests.eq((select row(review_reason, parsed_kind, parsed_amount_minor, suggested_account_id)::text
                 from public.source_events where external_event_id = 'q1' and user_id = tests.id('M')),
  row('missing_details', null::text, 52000::bigint, tests.id('M:hdfc'))::text,
  'an amount without a direction waits in review, on the right account, for the person to say which way');
select tests.eq((select row(review_reason, parsed_kind, parsed_amount_minor)::text
                 from public.source_events where external_event_id = 'q2' and user_id = tests.id('M')),
  row('missing_details', 'expense', null::bigint)::text, 'a debit without a readable amount waits in review for the amount');
select tests.eq((select row(processing_status, review_reason, parsed_amount_minor)::text
                 from public.source_events where external_event_id = 'q3' and user_id = tests.id('M')),
  row('needs_review', 'missing_details', 9900::bigint)::text,
  'an email the import boundary rejected goes to review with its plainest facts instead of being lost');
select tests.eq((select string_agg(message_id || ':' || outcome, ', ') from tests.items_of('M:job7') where outcome is not null),
  'q1:needs_review, q2:needs_review, q3:needs_review, q4:failed', 'each email''s outcome');
select tests.eq((select row(recorded, review, failed, skipped)::text from tests.job('M:job7')), row(0, 3, 1, 3)::text,
  'and nothing failed silently: one email that couldn''t be imported at all is counted as such');
select tests.eq(tests.entries_of('M'), tests.num('M:entries7'), 'nothing unclear was recorded');
select tests.eq((select count(*) from public.gmail_import_undo(tests.id('M'), tests.id('M:job7'))), 1::bigint, 'it can be undone');
select tests.eq((select count(*) from public.source_events where user_id = tests.id('M') and external_event_id like 'q%'), 0::bigint,
  'taking its items out of review');
reset role;
drop trigger tests_reject_some_events on public.source_events;

-- -----------------------------------------------------------------------------
-- Deleting all data
-- -----------------------------------------------------------------------------

set role authenticated;
select tests.login(tests.id('M'));
select public.delete_all_my_data();
reset role;
select tests.eq((select count(*) from public.gmail_import_jobs where user_id = tests.id('M'))
              + (select count(*) from public.import_account_aliases where user_id = tests.id('M'))
              + (select count(*) from friday_private.gmail_import_items where user_id = tests.id('M')), 0::bigint,
  'deleting all my data removes imports and account links');
select tests.eq((select count(*) from public.accounts where user_id = tests.id('M')), 0::bigint, 'and the accounts they made');

\echo All Gmail import tests passed.
