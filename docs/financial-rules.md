# Friday — financial rules

These are the rules the database enforces and the app displays. They are
implemented once, in `supabase/migrations/`, and covered by the SQL tests in
`tests/db/`. The full ledger model — statuses, refunds, reversals, imports and
the review queue — is in [`ledger-model.md`](ledger-model.md).

## Money

- Every amount is an integer number of **minor units** (paise for INR). No
  floating-point value is ever persisted or summed.
- Income and expense amounts are **positive magnitudes**. Direction comes from
  the entry's type, never from a sign.
- Each account and entry stores an ISO currency code. v1 accepts **INR only**
  (`accounts_currency_supported`); a transaction's currency must match its
  account, and both sides of a transfer must share a currency.
- Single entries are capped at ₹100 crore in the app and ₹10,000 crore in the
  database, as a guard against typos and tampered requests.

## Kinds of entry

| Kind     | Table          | Affects balances                      | Counts as                                   |
| -------- | -------------- | ------------------------------------- | ------------------------------------------- |
| Income   | `transactions` | + on its account                      | Income                                      |
| Expense  | `transactions` | − on its account                      | Spending                                    |
| Refund   | `transactions` | + on its account                      | Less spending (the purchase's category) — **never income** |
| Reversal | `transactions` | the opposite of what it reverses      | Cancels the original's income or spending   |
| Transfer | `transfers`    | − on the source, + on the destination | **Never** income or spending                |

A transfer is one row describing one logical movement. It cannot be split
into "an expense plus an income", and the reports never read the `transfers`
table for income or spending. A refund or reversal points at its original and
the total of them can never exceed it.

## Status

Only **posted** and **pending** entries count in balances and insights
(pending ones are marked). **Needs review** entries don't count until you
confirm them; **voided** ones are cancelled — kept for the record, never
counted. Deleting removes an entry you added by mistake (Undo restores it).

## Recording and correcting entries

- New entries go through `record_entry`, which takes a client-generated
  **idempotency key**. The same key always yields the same single entry, even
  when the request is retried after a lost response or sent twice at once.
- Edits go through `update_entry` with the version the form loaded; an entry
  changed elsewhere in the meantime is never silently overwritten. An edit can
  switch an entry between expense and income; a transfer stays a transfer
  (delete it and record the right entry instead).
- Delete/Undo and restore (`set_entry_deleted`; `set_entry_voided` is the
  same function under its pre-0003 name) are soft deletes and are idempotent.
- Status changes (`set_entry_status`), refunds and reversals follow the rules
  in `ledger-model.md` and are enforced by triggers, so even a hand-written
  request can't break them.
- Every create, edit, status change, delete and restore writes a row to
  `ledger_audit`, with the previous values and the reason when one was given.

## Balances

```
balance = opening balance + income − expenses + refunds and reversed purchases
        − reversed income + transfers in − transfers out      (counted entries)
```

Balances are always derived (the `account_balances` view); there is no stored
running total to drift out of sync. The account screen shows every term of
the formula. The opening balance is the balance before the entries recorded
in Friday; "Tracking since" is a label (imported evidence dated before it goes
to review, since it is probably already in the opening balance).

**Available money** on Home adds up active bank, wallet, cash and other
accounts. **Card dues** are shown separately and never folded into it; the
"after card dues" figure is labelled as such. It is deliberately not called
net worth: Friday doesn't know about accounts you haven't added.

### Credit cards

A credit card is a liability. Its `balance_minor` is the card's net position:

- **negative = amount owed** (shown as "Owed ₹X"),
- positive = in credit (you overpaid).

So:

| Event                                   | Recorded as                       | Effect on card       |
| --------------------------------------- | --------------------------------- | -------------------- |
| Buy something with the card             | Expense on the card account       | Owed goes up         |
| Merchant refunds it to the card         | Refund of that purchase           | Owed goes down       |
| The charge failed and was reversed      | Reversal of that purchase         | Owed goes back down  |
| Pay the card bill from your bank        | Transfer bank → card              | Owed goes down       |
| Cash withdrawal on the card             | Transfer card → cash              | Owed goes up         |

Spending is counted once, when you buy. Paying the bill is moving money, not
spending it again. When you create a card, Friday asks for the amount owed and
stores its negative as the opening balance. With a credit limit, available
credit = limit − owed, shown as an estimate based on what Friday knows.

## Reporting periods and timezones

- Instants are stored in UTC (`occurred_at`). Reports use `occurred_at`, never
  `created_at`.
- Day, week (Monday–Sunday) and month boundaries use the **profile timezone**
  (default `Asia/Kolkata`; change it under Profile).
- A period is an inclusive range of local dates, converted to a half-open UTC
  range `[start of first day, start of the day after the last day)`.
- An entry dated today keeps the current time; an entry dated another day is
  stored at 12:00 local time on that day so it can't slip across a boundary.
- Category breakdowns include **expenses only** unless labelled "Income", and
  are net of refunds. A refund counts in the period it happens; a reversal is
  reported in its original's period (what was reversed never really happened).
- Comparisons always name the exact comparison period (e.g. "vs September 2026").

## Deleting and archiving

- Transactions and transfers are **soft-deleted** (`deleted_at`). Deleted
  entries leave every balance, total and export immediately, and can be
  restored with Undo. The API has no hard-delete permission on them.
- Accounts and categories are **archived**, not deleted, once anything refers
  to them. Archived ones keep their history and labels on past entries; they
  just can't be chosen for new entries.
- Profile → "Delete all my data" permanently removes every financial record of
  the signed-in user (and resets categories to the defaults). The login itself
  is deleted from the Supabase dashboard.

## Recurring items

- A recurring rule is a **template**. It never creates a transaction by itself.
- When a due date arrives (in the profile timezone), opening the app turns it
  into a **due occurrence** — a prompt with Confirm and Skip.
- **Confirm** creates exactly one transaction and marks the occurrence
  confirmed, atomically. Confirming again returns the same transaction; a
  unique `(rule, due date)` key and a row lock prevent duplicates even with two
  taps or two devices.
- **Skip** records the decision and creates nothing.
- Due dates are computed from the first due date (`start + n × interval`), so
  a bill on the 31st lands on the last day of shorter months and returns to the
  31st afterwards. Feb 29 yearly items fall on Feb 28 in non-leap years.
- Pausing and resuming doesn't back-fill the paused period. Editing the
  schedule continues after the last date already generated.
- You can confirm an upcoming item early; Friday then moves on to the next date.

## Privacy

- Every user-owned row has a `user_id`, and row-level security limits every
  read and write to the signed-in user. Composite foreign keys on
  `(id, user_id)` make it impossible to attach an entry to someone else's
  account or category, even with a hand-crafted request.
- Anonymous visitors have no table or function access at all.
- Friday never asks for bank logins, card numbers, CVVs or passwords for
  other services.
