# Friday — ledger model (Phase 1)

How Friday represents money movement, how every number is derived from it,
and where future imports (email, bank, wallet) plug in. The database enforces
these rules (`supabase/migrations/`); `tests/db/` proves them.

> An email is evidence that a transaction may have happened. It is not the
> transaction. Evidence lives in `source_events`; the ledger is `transactions`
> and `transfers`.

## Tables at a glance

| Concept in the brief | Where it lives | Notes |
| -------------------- | -------------- | ----- |
| Account | `accounts` | `type` ∈ bank, credit_card, wallet, cash, other. `status` active/archived is "is_active". `institution_name`, `credit_limit_minor` (cards only). No stored balance. |
| Transaction (expense, income, refund, reversal) | `transactions` | `type`, `amount_minor` (positive), `currency`, `occurred_at` (transaction date), `merchant` (merchant or description), `note`, `category_id`, `account_id`, `status`, `source_type`, `source_confidence`, `related_transaction_id`, `deleted_at`. |
| Transaction of type transfer | `transfers` | `source_account_id` → `destination_account_id`. Same `status` / `source_type` columns. Kept as its own table so a transfer can never be summed as income or spending. |
| Category | `categories` | Per user, editable, archivable. `transaction_type` is income or expense. Transfers have no category. |
| Source connection | `source_connections` | A future Gmail inbox / bank feed. Nothing creates these yet. |
| Import event | `source_events` | One row per piece of evidence. Links to the ledger entry it created or matched. |
| Audit | `ledger_audit` | Every create, edit, status change, delete and restore, with the reason and the values before the change. |

`ledger_entries` is the read model for feeds: one row per non-deleted
transaction or transfer with `kind` ∈ expense, income, refund, reversal,
transfer and its `status`.

## Amounts and currency

- Every amount is an integer of minor units (paise). Amounts are positive
  magnitudes; direction comes from the entry's type. No floats anywhere.
- Every account and entry stores its currency. An entry's currency must equal
  its account's; a transfer's two accounts must share one; a refund or reversal
  must match its original. v1 accepts INR only (`accounts_currency_supported`),
  so the summaries can sum amounts directly. Multi-currency would group every
  total by currency and keep original amount + currency + rate + rate date on
  any conversion — never mix them in one sum.

## Status: what counts

| Status | Meaning | In balances & insights |
| ------ | ------- | ---------------------- |
| `posted` | Happened and settled. Default for anything you enter. | Yes |
| `pending` | Authorised, not settled (a card hold, a UPI debit in flight). | Yes — the money is committed. Shown separately as "pending". |
| `needs_review` | Recorded, but something is uncertain (e.g. confirmed from an import as "check later"). | **No**, until you confirm it. Shown in the review queue. |
| `voided` | Cancelled — it never really happened (a cancelled authorisation, a failed payment that never settled, a duplicate). Stays in history, struck through. | No |

Deleting (`deleted_at`) is different: it removes an entry you added by
mistake. Deleted entries disappear from every list and total, and Undo
restores them. Voided entries stay visible.

**Counted** in this document means `deleted_at is null and status in
('posted', 'pending')`.

Allowed status changes (`set_entry_status`, enforced by triggers so a direct
table update can't skip them):
`pending → posted | voided`, `posted → voided`,
`needs_review → posted | pending | voided`, and **Restore**: `voided →` the
status it had before it was voided (`voided_from`), so a voided item from the
review queue can't come back counted without being confirmed.
An entry with counted refunds or reversals can't stop counting (void, delete,
or move to review) until those are removed first. Where an entry came from
(`source_type`, `created_via`, its request key) can't be changed.

Nothing in Phase 1 creates `needs_review` *entries* on its own — uncertain
imports wait as review-queue *events* with no ledger row. The status exists
for future import rules; the review queue lists any such entries with a
Confirm action, and they are excluded from every total until confirmed.

## Entry types and their effects

Each transaction also stores `base_type` — the income/expense side it belongs
to — so categories stay type-checked by a foreign key and every report is a
plain sum.

| Type | base_type | Account balance | Spending | Income | Category |
| ---- | --------- | --------------- | -------- | ------ | -------- |
| expense | expense | − amount | + amount | – | expense category or none |
| income | income | + amount | – | + amount | income category or none |
| refund | expense | + amount | − amount | – | the original purchase's |
| reversal of an expense | expense | + amount | − amount | – | the original's |
| reversal of income | income | − amount | – | − amount | the original's |
| transfer | – | − source, + destination | – | – | none |

So `spending = Σ expense − Σ refunds − Σ expense reversals` and
`income = Σ income − Σ income reversals`, over counted entries.

### Credit cards

A card's balance is its net position: **negative = you owe**. The opening
balance of a card is stored as minus what was owed that day.

- Spending ₹150 on the card: one ₹150 expense on the card. Spending +₹150;
  card balance −₹150 → "Owed ₹150". The bank is untouched.
- Paying the bill from the bank: one ₹150 **transfer** bank → card. Bank −₹150,
  card +₹150 → "Owed ₹0". Spending unchanged — the purchase was already counted.
- `outstanding = max(0, −balance)`. `available credit = credit limit −
  outstanding`, shown only when a limit is set. A positive card balance is
  "In credit" (overpaid).
- Home never adds card debt into "available money"; it shows it separately,
  and the optional net figure is labelled as such.

### Refunds

- A refund points at the purchase it refunds (`related_transaction_id`), which
  must be a counted, **posted expense** with the same currency.
- Refunds can be partial. The total of a purchase's counted refunds and
  reversals can never exceed its amount (checked under a row lock, so two
  concurrent refunds can't overshoot).
- The refund takes the purchase's category (kept in sync if the purchase is
  re-categorised) and reduces spending in that category **in the period the
  refund happens** (cash basis), so a September purchase refunded in October
  lowers October's net spending — which can make a category, or a whole
  period, net negative ("more came back than went out"). Screens show that in
  words instead of drawing negative chart slices.
- It may land on a different account than the purchase (same currency).
- A refund is never income. Friday no longer seeds an income category called
  "Refunds", and the migration **archives** the untouched seeded one (visible
  and reversible from Categories; entries already in it are not changed).
  Income that was really a refund can be corrected with `make_refund`, which
  turns it into a refund of the purchase (or an unlinked refund with an
  expense category) under the same checks.
- A refund without a known original (an imported one you can't match) is
  allowed: it then needs an expense category or none, and can be linked to its
  purchase once, later (`make_refund`).

### Reversals

- A reversal undoes a **posted** income or expense that the bank later pulled
  back (a failed payment credited back, a chargeback, a bounced credit). It
  must reference the original, sit on the same account, and is capped like a
  refund (together with refunds).
- It has the opposite effect of the original, so a fully reversed purchase nets
  to zero spending and zero balance change — never two lasting expenses.
- In insights a reversal is reported in **its original's period** (what was
  reversed never really happened), so a salary bounced the next day doesn't
  show as +₹X one month and −₹X the next. Balances use the reversal's own
  date.
- A cancelled **pending** authorisation is not a reversal: it is voided.
  That is how Friday tells a refund (money came back after a real purchase)
  from a failed or cancelled authorisation (the purchase never happened).

### Pending → posted

The same entry moves from `pending` to `posted` (and its amount may be
corrected, e.g. a tip). A pending event and a posted event about the same
purchase are never two purchases: when an import carries the same stable
external transaction id, the second event updates the first entry instead of
adding one. Matching amounts alone never merge anything.

### Edits

Edits keep the ledger consistent: the database refuses changes that would
break a relationship — changing the type, account or currency of an entry that
has reversals, lowering an amount below what was already refunded, or editing
a voided entry. Edits use optimistic concurrency (`update_entry` takes the
version you loaded) and accept a reason, stored in the audit trail with the
previous values.

## Balances

```
balance = opening
        + income − expenses
        + refunds and reversed purchases − reversed income
        + transfers in − transfers out          (counted entries only)
```

Always derived (`account_balances`), never stored or accepted from a client,
so a retry or a concurrent write can't double-apply anything.
`pending_minor` is the part of the balance that is still pending;
`review_count` counts entries waiting for review on the account.

**Opening balance.** The balance before the entries you record in Friday.
Every entry on the account counts, whatever its date ("Tracking since" is a
label), which keeps existing balances unchanged. Imported evidence dated
before "Tracking since" goes to the review queue instead of the ledger, since
it is most likely already inside the opening balance.

## Import boundary (built, not connected)

No Gmail, Pub/Sub or bank integration exists yet. What exists is the place
they will deliver to:

1. A future worker calls `ingest_source_event_for(user, …)` (service role
   only). Signed-in users can call `submit_source_event(…)` for their own data
   (used by tests and future file imports).
2. One `source_events` row per `(user, source type, connection, external event
   id)` — a database unique index, so a redelivered email or webhook is a no-op
   that returns the first result. Only the parsed facts needed for processing
   are kept (amount, currency, date, merchant, an account hint like "••1234",
   pending/posted). **No email bodies.**
3. Processing, in one transaction, under a per-user import lock (shared with
   every review action, so two pieces of evidence can never both create an
   entry):
   - **Same `external_transaction_id`** (within the same source and
     connection) as an earlier event that produced an entry → the same real
     transaction. Pending → posted (amount updated to the settled amount);
     cancelled/declined → the pending entry is voided; posted again → linked
     only. No new entry. It goes to review instead when the entry was deleted
     or voided, the direction or account differs (e.g. a failed UPI debit's
     credit-back shares its reference), or the settled amount differs by more
     than 25%.
   - **Review** (`needs_review`, **no ledger entry**): missing details,
     unsupported currency, a refund or reversal (needs its original), unknown
     account, money "received" on a credit card (usually a bill payment — a
     transfer), dated before the account's "Tracking since", confidence below
     0.90, the same transaction already waiting for review or ignored, a
     payload fingerprint seen before, or a lookalike: the same account, amount
     and direction within 3 days, a pending entry this could be the settlement
     of (within 50% and 7 days), or evidence already in review.
   - A cancellation or decline with nothing pending to cancel → `ignored`.
   - Otherwise → one ledger entry with `source_type`, `source_confidence`, and
     the event marked `imported` and linked. If the ledger refuses it, the
     evidence stays, in review, with the error code.
4. The review queue lists `needs_review` events (with the reason and the
   suggested account/category) and ledger entries in `needs_review`. Actions:
   confirm (creates exactly one entry, idempotent per event), correct and
   confirm (including as a refund of a chosen purchase), link to an existing
   entry of the same kind (it is that transaction), or ignore. Once an event
   is linked, ignore and link-elsewhere are refused.
5. Not built yet: Gmail OAuth, Pub/Sub, parsing, and mapping "HDFC ••1234" to
   an account. The worker must resolve the account itself and pass it in;
   a table of account identifiers is the next step.

`payload_fingerprint` is only a hint for "possible duplicate"; two real
purchases can look identical.

## Audit trail

`ledger_audit` records create, update, status change, delete and restore for
every transaction and transfer: which fields changed, the financial facts
after the change, the previous values for updates (`previous`), and the reason
given (`reason`). Note and merchant text are not copied. Users can read their
own audit rows; nobody can write them through the API. Import evidence keeps
`received_at`, `parsed_at`, `linked_at` and the link type (`created` /
`matched`).

## Security

- Every row has `user_id`; RLS limits reads and writes to the signed-in user.
  Composite foreign keys on `(id, user_id)` make it impossible to point an entry
  at another user's account, category, original transaction or event.
- `source_events` and `source_connections` are read-only to clients; only
  security-definer functions that scope every statement to `auth.uid()` write
  them. `ingest_source_event_for` refuses any caller but the service role (or
  the `submit_source_event` wrapper), even if a grant were added by mistake,
  and the migration fails if it, or any view without `security_invoker`, is
  exposed.
- Clients never send balances. The service-role key is never used by the app.
