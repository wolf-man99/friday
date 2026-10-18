# Operations: backup, restore and deletion

Friday's data lives in your Supabase project's Postgres database. The app adds
user-level exports on top of whatever your Supabase plan provides.

## Backups

| What                          | How                                                         | Restorable how                       |
| ----------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| Transactions CSV              | Profile → Your data → *Transactions (CSV)*                  | Spreadsheet / manual re-entry        |
| Accounts & balances CSV       | Profile → Your data → *Accounts & balances (CSV)*           | Reference / reconciliation           |
| Full JSON backup              | Profile → Your data → *Full backup (JSON)*                  | Every row you own (no in-app import yet) |
| Database dump                 | `npx supabase db dump --data-only -f friday-data.sql` (linked project) | `psql` into a project with the migration applied |
| Supabase managed backups      | Dashboard → *Database → Backups* (depends on your plan)     | Dashboard restore                    |

Suggested routine for the personal MVP: download the JSON backup weekly and keep
a monthly database dump somewhere private. Treat both files as sensitive — they
contain your full financial history.

## Restore drill (test environment)

Do this once before relying on Friday, and again after schema changes:

1. Create a separate Supabase project (never restore into production to test).
2. Apply `supabase/migrations/*.sql` (SQL editor or `supabase db push`).
3. Create the same login there, then load the dump:
   `psql "<test project connection string>" -f friday-data.sql`.
4. Sign in to a local build pointed at the test project and check that every
   account balance and the current month's totals match production.

## Deleting data

- **One entry:** delete it in the app (soft delete — Undo is available right
  after, and it leaves all totals immediately).
- **Everything:** Profile → *Delete all my data…* permanently removes accounts,
  transactions, transfers and recurring items for the signed-in user and resets
  categories to the defaults.
- **The login itself:** Supabase dashboard → *Authentication → Users* → delete
  the user. Database rows cascade from `auth.users`.

Deleted data may still exist in Supabase's managed backups until they expire
under your plan's retention period.

## Secrets

- The browser app only ever uses the project URL and the publishable (anon) key.
  Row-level security is what protects the data.
- Keep the secret / service-role key and the database password out of the app,
  the repository and the hosting provider's client-side environment variables.
  If either has been shared somewhere it shouldn't have been, rotate it in the
  Supabase dashboard (*Project Settings → API keys* / *Database*).
