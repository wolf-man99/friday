# friday.

A mobile-first personal finance tracker. Record income, expenses and transfers in
a few taps, keep account balances that always reconcile, and see where the money
went — in a loud, tactile, Riff-inspired interface.

- **Quick add, amount first** — Expense / Income / Transfer, big amount field,
  smart account defaults, category suggestions from your own history (always
  marked as suggestions), drafts that survive reloads, retries that can never
  record an entry twice, and Edit / Undo after every save. Details in
  [`docs/quick-add.md`](docs/quick-add.md).
- **Accounts & balances** — cash, bank, credit cards and other accounts with
  opening balances. Balances are derived from the ledger, never stored.
- **Transfers** move money between accounts without touching income or spending.
- **Activity** — day-grouped feed with search and period / type / account /
  category filters.
- **Insights** — spending by category, monthly trend, comparisons with the
  previous period, plain-language observations; everything drills down.
- **Recurring** — rent, salary, subscriptions. Friday prompts when they're due;
  nothing is recorded until you confirm, and nothing can be recorded twice.
- **Your data** — CSV export of transactions and accounts, full JSON backup,
  and a delete-everything option.
- **PWA** — install to the home screen; the app shell works offline (saving
  needs a connection; v1 doesn't queue offline writes).

The rules behind every number are in [`docs/financial-rules.md`](docs/financial-rules.md).

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

## Testing

```bash
npm run typecheck   # TypeScript
npm test            # unit + component tests (money, dates, recurrence, CSV, quick add)
npm run build       # production build + service worker
```

**Database tests** apply the migrations to a throwaway local PostgreSQL (with a
stub of Supabase's `auth` schema and its non-superuser roles) and check ledger
maths, constraints, RLS isolation between users, sign-up as Supabase's auth role,
recurring idempotency, the capture service (idempotent saves, edit conflicts,
undo, audit), upgrading a database that already holds data, and 8 concurrent
replays of one save. Never point them at Supabase:

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
`CHROMIUM_PATH`).

## Project layout

```
supabase/migrations/   schema, RLS, views, RPCs — the only SQL to run in Supabase
tests/db/              local-only SQL integration tests + Supabase auth/role stub
src/lib/               money, dates/timezones, recurrence, CSV, validation, analytics (pure, tested)
src/features/capture/  Quick Add logic: account defaults, category suggestions, drafts
src/data/              typed data-access layer + React Query hooks
src/components/ui/     design-system primitives (Button, Card, PillSwitch, Dialog, Toast…)
src/components/finance/ finance components (TransactionRow, AccountCard, charts…)
src/pages/             screens
e2e/                   Playwright tests and the local fake Supabase gateway
docs/                  financial rules, Quick Add behaviour, backup and restore
```

## Backups

See [`docs/operations.md`](docs/operations.md) for backup, restore and data
deletion.
