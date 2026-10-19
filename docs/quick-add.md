# Quick Add — how capture works

Quick Add (`/add`, the orange **+** on every screen) is the one place entries are
recorded. The amount comes first; everything else is prefilled and can be
changed.

## Defaults

**Account** — the first of these that is an active account (and, for a
transfer's source, not the destination):

1. the account you came from (*Accounts → Add entry here*, or `/add?account=…`)
2. your default account (*Accounts → Make default*), stored on the profile
3. the account you used last for that type (this device)
4. the first non-credit-card account

The chosen account is visible above the categories; *Default* is tagged.

**Category** — a suggestion is applied only when it is well supported by your
own history (last 200 entries, read from the database):

- **merchant match** — at least 2 earlier entries for the same merchant
  (case and spacing ignored), and ≥ 60% of them in one category
- **frequent** — at least 5 categorised entries of this type among the last 40,
  and ≥ 45% in one category

Otherwise nothing is preselected and the entry saves as *Uncategorised*. A
suggested tile has a dashed border, a *Suggested* badge and the hint "Suggested
from your history…" with a **Not this** button. Tapping any tile makes the
choice yours; suggestions never override it.

**Again?** shortcuts (up to four recent distinct entries) prefill amount,
category, merchant and account. They never save by themselves.

## Saving

- The amount is validated as text, then converted to integer paise (at most 2
  decimals, positive, ≤ ₹100 crore). Messages say exactly what's wrong.
- Every save calls `record_entry` with an **idempotency key** generated when the
  draft starts. The database stores the key with a unique index and serialises
  replays with an advisory lock, so a retry after a dropped connection — or a
  double tap — returns the entry already saved instead of creating a second one.
- If a replayed key arrives with different details (or for an entry that was
  undone), Friday doesn't guess: it offers *Open the saved entry* or *Save this
  as a separate entry* (a new key).
- After a network failure the draft stays on screen, the message stays pinned
  above the button, and the button becomes **Try again** (same key).
- **Offline:** nothing is sent and nothing is queued. The draft is kept on this
  device until you save it online.

## Drafts

The form is saved to `localStorage` (`friday:quick-add-draft:<user id>`) on every
change and restored on reopen with a "Picked up your unsaved …" banner and a
*Start fresh* button. Drafts expire after 7 days and are cleared after a
successful save or Discard. They stay on the device and include the note text,
so they're per user and per browser.

## After saving

The confirmation toast has **Edit** (opens the saved entry) and **Undo**
(soft-deletes it; balances update immediately). *Save & add another* keeps you
on the form with the same type and account.

Edits use optimistic concurrency: `update_entry` takes the `updated_at` the form
was loaded with, and refuses (error `PT409`) if the entry changed elsewhere in
the meantime. The form then offers *Load the latest version* instead of
overwriting.

Every create, edit, undo and restore is recorded in `ledger_audit` (changed
field names and amounts/ids — never the note or merchant text). Users can read
their own audit rows; nobody can write them through the API.

## Analytics

`src/lib/analytics.ts` defines the event names and fields and a sink interface;
**no vendor is wired up and nothing leaves the device.** Events:
`quick_add_opened`, `transaction_type_selected`, `transaction_save_attempted`,
`transaction_save_succeeded`, `transaction_save_failed`, `suggestion_shown`,
`suggestion_changed`, `transaction_undo_used`, `draft_recovered`.

`sanitise()` drops amounts, notes, merchants, names, emails and account or
category ids before any sink sees an event; only coarse fields (type, source,
error class, `has_note`, timings) pass. To watch events while developing, run
`localStorage.setItem('friday:debug-analytics', '1')` and reload. To send them
somewhere, register a sink with `addAnalyticsSink()`.
