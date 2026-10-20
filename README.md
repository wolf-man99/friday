# friday.

A mobile-first personal finance tracker. Record income, expenses and transfers in
a few taps, keep account balances that always reconcile, and see where the money
went — in a loud, tactile, Riff-inspired interface.

- **Quick add, amount first** — Expense / Income / Transfer, big amount field,
  smart account defaults, category suggestions from your own history (always
  marked as suggestions), drafts that survive reloads, retries that can never
  record an entry twice, and Edit / Undo after every save. Details in
  [`docs/quick-add.md`](docs/quick-add.md).
- **Accounts & balances** — bank accounts, credit cards, wallets and cash,
  grouped by type, with the bank or provider and (for cards) a credit limit.
  Balances are derived from the ledger, never stored; card dues are kept apart
  from available money, with available credit shown as an estimate.
- **Transfers** move money between accounts without touching income or
  spending — paying a card bill is a transfer, so a purchase is never counted
  twice.
- **Refunds and reversals** are recorded against the original purchase (or
  income): they reduce spending instead of counting as income, can be partial,
  and can never exceed the original.
- **Statuses** — posted, pending, needs review and voided, so a cancelled
  authorisation is never mistaken for a refund. Every change is in an audit
  trail with its reason.
- **Activity** — day-grouped feed with search and period / type / status /
  account / category filters, and a details page for every entry (source,
  related refunds, history, void / reverse / refund actions).
- **Review queue** — the landing place for future imports (email, bank,
  wallet): evidence waits there instead of touching balances until it is
  confirmed, linked to an existing entry or ignored. No importer is connected
  yet; see [`docs/ledger-model.md`](docs/ledger-model.md).
- **Gmail connection** — connect Gmail read-only (Google OAuth,
  `gmail.readonly` only), disconnect any time. The refresh token stays
  encrypted on the server. Import up to three past months: Friday finds your
  bank accounts, cards and wallets in the alert emails, you confirm each, it
  records what's clear and sends the rest to Review, with Undo. See [`docs/gmail-connection.md`](docs/gmail-connection.md).
- **Insights** — spending by category, monthly trend, comparisons with the
  previous period, plain-language observations; everything drills down.
- **Recurring** — rent, salary, subscriptions. Friday prompts when they're due;
  nothing is recorded until you confirm, and nothing can be recorded twice.
- **Your data** — CSV export of transactions and accounts, full JSON backup,
  and a delete-everything option.
- **PWA** — install to the home screen; the app shell works offline (saving
  needs a connection; v1 doesn't queue offline writes).

The rules behind every number are in [`docs/financial-rules.md`](docs/financial-rules.md)
and the full ledger model in [`docs/ledger-model.md`](docs/ledger-model.md).

## Stack

React 19 + TypeScript + Vite, Tailwind CSS v4 (design tokens in
`src/styles/index.css`), TanStack Query, React Router, Supabase (Postgres, Auth,
row-level security), vite-plugin-pwa. Tests: Vitest + Testing Library, SQL
integration tests, Playwright.

## Setup

### 1. Create the database schema

The schema — tables, constraints, row-level security, views and functions —
lives in `supabase/migrations/`, one file per change, applied **in filename
order**:

| File | What it adds |
| ---- | ------------ |
| `20261018000000_friday_init.sql` | the whole v1 schema. Run once, on an empty project. |
| `20261019000000_capture_service.sql` | Quick Add save service: merchant field, idempotent `record_entry`, `update_entry` with conflict detection, `set_entry_voided`, default account, audit trail. Additive — existing data is kept — and safe to re-run. |
| `20261020000000_ledger_model.sql` | Ledger model: refunds and reversals, statuses, sources, wallet accounts, institution and credit limit, the import boundary (`source_events`) and review-queue functions, net-of-refund reports. Additive and safe to re-run; existing entries become posted, manual entries with unchanged amounts and balances. It also archives the seeded "Refunds" **income** category (refunds now reduce spending); restore it from Categories if you want it back. |
| `20261021000000_gmail_connection.sql` | Gmail connection foundation: connection metadata on `source_connections`, a private schema for OAuth state and encrypted tokens, and server-only functions. Additive and safe to re-run. Only needed if you'll connect Gmail. |
| `20261022000000_gmail_import.sql` | Importing past months from Gmail: import jobs, remembered account links, balances that stay exact when older history arrives (`balance_from`), and server-only import steps. Additive and safe to re-run. |

**These are the only files to run in Supabase.** The SQL under `tests/db/` is for
local testing; it creates fake users and refuses to run in a Supabase project.

**Option A — SQL editor (simplest):** Supabase dashboard → *SQL Editor* → *New
query* → paste one file's contents → *Run*; repeat for the next file. Each file
runs as a single transaction, so a failure leaves the database unchanged.

**Already running Friday?** Run only the files you haven't run yet. If the app
is deployed before its migration, it shows *"Database needs an update"* instead
of failing halfway through a save; run the missing file and tap *Try again*.

**Option B — Supabase CLI:**

```bash
npx supabase link --project-ref <your-project-ref>   # asks for the database password
npx supabase db push
```

### 2. Configure Auth

In the Supabase dashboard → *Authentication*:

1. **URL configuration** → set *Site URL* to where Friday runs (e.g.
   `http://localhost:5173` while developing, your deployed URL later) and add
   the same URL plus `<url>/reset-password` under *Redirect URLs*. Confirmation
   and password-reset emails link there.
2. Sign up in the app, confirm your email, and sign in.
3. **Make it private:** *Sign In / Providers* → turn off *Allow new users to sign
   up*. Friday v1 is for one person; row-level security already keeps each
   user's data separate, but there's no reason to let strangers register.

### 3. Run the app

```bash
cp .env.example .env.local   # then fill in the two values below
npm install
npm run dev                  # http://localhost:5173
```

`.env.local` needs only the **Project URL** and the **publishable (anon) key**
from *Project Settings → API*. Never put the secret / service-role key or the
database password in the app or in git — the browser never needs them.

### 4. Deploy

`npm run build` produces a static site in `dist/`. Host it anywhere that serves
HTTPS with a single-page-app fallback to `index.html` (`vercel.json` and
`public/_redirects` cover Vercel and Netlify / Cloudflare Pages). Set the two
`VITE_SUPABASE_*` variables in the host's build settings, and add the deployed
URL to Supabase's *Site URL* / *Redirect URLs*.

### 5. Connect Gmail (optional)

Needs migration `20261021000000_gmail_connection.sql`, a Google Cloud OAuth
client, five function secrets and the two Edge Functions deployed — step by
step in [`docs/gmail-connection.md`](docs/gmail-connection.md#configuration).

## Testing

```bash
npm run typecheck   # TypeScript
npm test            # unit + component tests (money, dates, ledger rules, CSV, every screen)
npm run build       # production build + service worker
```

**Database tests** apply the migrations to a throwaway local PostgreSQL (with a
stub of Supabase's `auth` schema and its non-superuser roles) and check ledger
maths, constraints, RLS isolation between users, sign-up as Supabase's auth role,
recurring idempotency, the capture service (idempotent saves, edit conflicts,
undo, audit), the ledger model (card purchases and repayments, full and partial
refunds, reversals, statuses, imports and the review queue, cross-user access),
upgrading a database that already holds data, and concurrent saves, refunds and
imports, and the Gmail connection's private storage (no client access, one-time
OAuth state, grants only the starting user can complete, disconnect). Never
point them at Supabase:

```bash
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:db
```

**End-to-end tests** run the real app against local PostgreSQL + PostgREST
(behind a small fake auth gateway in `e2e/fake-supabase.mjs`) and walk the full
path: sign up → accounts → income, expense, transfer → summaries → edit →
delete/undo → CSV export, plus recurring confirm/skip. The Quick Add suite
drops requests and responses mid-save, reloads with a draft, edits one entry
from two browsers and checks suggestions.

```bash
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
POSTGREST_BIN=/path/to/postgrest \
npm run test:e2e
```

Needs a [PostgREST](https://github.com/PostgREST/postgrest/releases) binary and
Playwright's Chromium (`npx playwright install chromium`, or set
`CHROMIUM_PATH`). With `DENO_BIN` set, it also runs the Gmail suite: the real
Edge Function code under Deno against a local fake Google (`e2e/fake-google.mjs`).

**Edge Function tests** (Deno 2) cover OAuth state validation, every callback
failure, cross-user isolation, token secrecy (nothing secret in responses, logs
or storage) and disconnected accounts, with fakes for Google and the database:

```bash
deno test --config supabase/functions/tests/deno.json --allow-env supabase/functions/tests/
```

## Project layout

```
supabase/migrations/   schema, RLS, views, RPCs — the only SQL to run in Supabase
supabase/functions/    Edge Functions (gmail-connection, gmail-oauth-callback), shared code, Deno tests
tests/db/              local-only SQL integration tests + Supabase auth/role stub
src/lib/               money, dates/timezones, recurrence, CSV, validation, analytics (pure, tested)
src/features/capture/  Quick Add logic: account defaults, category suggestions, drafts
src/lib/ledger.ts      accounting rules for display: signs, statuses, card figures, balance summary
src/data/              typed data-access layer + React Query hooks
src/components/ui/     design-system primitives (Button, Card, PillSwitch, Dialog, Toast…)
src/components/finance/ finance components (TransactionRow, AccountCard, charts…)
src/pages/             screens
e2e/                   Playwright tests, the local fake Supabase gateway and a fake Google
docs/                  ledger model, financial rules, Quick Add, Gmail connection, backup and restore
```

## Backups

See [`docs/operations.md`](docs/operations.md) for backup, restore and data
deletion.
