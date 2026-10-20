# Gmail connection

Friday can connect a person's Gmail **read-only** and import the transaction
alerts their bank, card and wallet providers email them:

- connect (Google OAuth 2.0 authorization-code flow + PKCE, offline access,
  `https://www.googleapis.com/auth/gmail.readonly` and nothing else)
- store the refresh token **encrypted, server-side only**
- disconnect (delete the stored access and revoke it with Google)
- import past months on request (see *Importing past months* below): the
  Gmail page offers this month and the two before it as soon as Gmail is
  connected, and on every later visit until an import has run

It does **not** read mail continuously or use Pub/Sub.

## How a connection works

```
 Friday app (browser)          gmail-connection           Google            gmail-oauth-callback
 ────────────────────          ────────────────           ──────            ────────────────────
 Connect Gmail ──POST start──▶ state = 32 random bytes
   (Supabase session)          verifier = 48 random bytes
                               browser key = 32 random bytes
                               store sha256(state), verifier,
                               sha256(browser key), user id,
                               expires in 10 min
  keeps browser key ◀── { url, browserKey } ── consent URL (code,
                               S256 challenge, offline, consent)
 browser goes to Google ───────────────────────────────▶ person approves
                                                         redirect ─────────▶ consume state (one time,
                                                                             unexpired) → user id
                                                         ◀── code + secret + verifier (server-side)
                                                         ── tokens ────────▶ check gmail.readonly granted,
                                                                             refresh token present,
                                                                             read Gmail address;
                                                                             encrypt refresh token;
                                                                             park it as a pending grant
                                                                             (10 min) behind a one-time
                                                                             ticket
 /connections/gmail#ticket=… ◀──────────────────────────────── 303 ─────────
 POST complete ──────────────▶ grant.user == signed-in user and
   {ticket, browserKey}        sha256(browserKey) matches?
   (Supabase session)          yes → activate connection
                               no  → delete (+ revoke, see below)
```

Why the extra **ticket** step: Google's redirect carries no Friday session, so
the callback can't know whose browser it is. Without confirmation, someone
could start a connection from *their* Friday account and trick you into
approving it, attaching your Gmail to their account. The callback therefore
only parks the grant; it becomes a connection only when the same signed-in
Friday user, **in the same browser** (the key the app kept since *start*),
completes the ticket. Anyone else completing it destroys the grant — including
someone whose browser was signed in to the attacker's Friday account. The
ticket travels in the URL fragment, which browsers never send to servers, logs
or `Referer` headers, and the app removes it from the address bar immediately.

Callback failures redirect to `/connections/gmail?gmail_error=<code>`:
`access_denied`, `google_error`, `invalid_request`, `invalid_state`,
`link_expired`, `link_used`, `exchange_failed`, `scope_missing`,
`no_refresh_token`, `profile_failed`, `server_error`.

### When Friday revokes with Google

Revoking any token ends Friday's **whole** grant for that Gmail account —
every token, including one a working connection uses. So:

- **Disconnect** revokes, unless another Friday account has the same Gmail
  account connected (then the token is deleted but not revoked, and the
  response says `revoked: false`).
- **Switching** to a different Gmail address revokes the old address's
  access (same exception).
- **Reconnecting the same address** replaces the stored token without
  revoking the old one (that would end the new one too).
- **Refused or expired approvals** are deleted, and revoked only if no live
  connection uses that Gmail account.
- **Callback failures** (wrong scope, no refresh token, profile or database
  errors) drop the tokens without revoking them: they never left the function,
  so nobody holds them, and Friday can't always tell which account they're
  for.

## Where things are stored

| Where | What | Who can read it |
| ----- | ---- | --------------- |
| `public.source_connections` (from migration 0003) + new columns `provider`, `account_email`, `scopes`, `connected_at`, `disconnected_at`, `last_checked_at`, `last_error_code` | connection metadata — **no secrets** | its owner (RLS `select` policy); clients can't insert or update |
| `friday_private.gmail_oauth_states` | SHA-256 of the state, PKCE verifier, user, expiry, used-at | nobody via the API |
| `friday_private.gmail_pending_grants` | SHA-256 of the ticket, Gmail address, **encrypted** refresh token, expiry | nobody via the API |
| `friday_private.gmail_credentials` | **encrypted** refresh token per connection | nobody via the API |

- `friday_private` is not an exposed API schema; `anon`, `authenticated` and
  even `service_role` have no privileges on it. RLS is on with no policies as a
  second lock. Only `security definer` functions reach it, and every one of
  them (`gmail_oauth_begin`, `gmail_oauth_consume`, `gmail_store_pending_grant`,
  `gmail_take_expired_grants`, `gmail_complete_grant`, `gmail_get_credentials`,
  `gmail_mark_needs_reconnect`, `gmail_record_check`, `gmail_disconnect`) is
  executable only by `service_role` **and** checks the caller's JWT role itself.
  The migration fails if any of that isn't true.
- Refresh tokens are sealed with **AES-256-GCM** in the Edge Function
  (`v1.<iv>.<ciphertext>`), with the owner's user id as additional
  authenticated data — a sealed token copied to another user's row won't
  decrypt. A check constraint refuses anything not in that format. The key is a
  function secret; it is never in the database or the app.
- One live Gmail connection per person (unique index). Connecting a different
  Gmail address disconnects the previous one; reconnecting the same address
  replaces the stored token and revokes the old one.
- *Delete all my data* removes every Gmail row (the app disconnects first, so
  Google revokes the access too). Deleting the login cascades everything.

Access tokens are never stored: each request gets a fresh one from the refresh
token and discards it.

## The preview (test fetch)

`gmail-connection` action `test-fetch`. The app no longer calls it: the Gmail
page used to have a *Preview recent alerts* button, but the raw emails it
listed (subjects and snippets, promotions included) read as noise next to the
import, so the page leads with the import instead. The action stays as a
diagnostic and is covered by the function tests:

- Gmail search: `from:(<senders>) (debited OR credited OR spent OR transaction
  OR txn OR upi OR purchase OR withdrawn OR refund OR reversed)
  newer_than:30d -category:promotions -category:social`
- senders: `GMAIL_ALERT_SENDERS` (domains or exact addresses) or the defaults
  in `supabase/functions/_shared/gmailQuery.ts`; rules are validated so no
  Gmail search operator can be injected
- at most 5 messages by default, never more than 20; look-back at most 90 days
- `messages.list` with `fields=messages/id,resultSizeEstimate`, then
  `messages.get` with `format=metadata`, `metadataHeaders=From,Subject,Date`
  and `fields=id,internalDate,snippet,payload/headers` — never the body or
  attachments
- every result's `From` address is checked against the allowlist again
  (Gmail's `from:` match is loose), so look-alike domains are dropped
- the result goes back to the signed-in user only; nothing is stored except
  `last_checked_at`. No transaction or review item is created.
- if Google refuses the refresh token (`invalid_grant`, e.g. access removed at
  myaccount.google.com, or a Testing-mode token's 7 days are up), that exact
  credential is deleted and the connection shows *Needs reconnecting*.
- a server problem never deletes anyone's access: a wrong client ID/secret
  (`invalid_client`) answers *not set up* (503), and a credential that won't
  decrypt (e.g. a changed `GMAIL_TOKEN_ENCRYPTION_KEY`) answers
  `credential_unreadable` and is kept; reconnecting replaces it.

## Importing past months

Right after connecting (and any time later on the Gmail page), Friday offers to
import **this month and the two before it** — the person picks any of them.

1. **Find** (`import-start`): one Gmail search per month — every email from
   the allowlisted senders between `after:`/`before:` the month's bounds in
   the person's time zone, with no required words (an alert worded in a way
   Friday doesn't expect must still be found). The senders include `bank.in`
   and `fin.in`: since 2025 Indian banks send from `<name>.bank.in`, which only
   RBI-regulated banks can hold. At most 1,500 emails per import (the
   newest).
2. **Read** (`import-scan`, 15 emails per request): each email is fetched in
   full, read in memory by `supabase/functions/_shared/alerts.ts`, and only
   the facts are stored (`friday_private.gmail_import_items`): bank or card,
   last digits, amount, direction, date, merchant, reference, sender check.
   Only emails that clearly aren't transactions are left out — OTPs,
   statements and bill reminders, offers, account notices (logins, KYC,
   mandates), emails with no amount — and the import counts them by reason
   (`gmail_import_jobs.skip_reasons`) so the summary shows what was left out
   and why.
3. **Confirm accounts** (`import-accounts`, `import-confirm`): the bank
   accounts, cards and wallets the emails mention, each with a suggestion —
   the Friday account it was linked to before or looks like, or a new one.
   The person links, creates (optionally with the balance on the first
   imported day), ignores, or sends a number's transactions to Review. Links
   are remembered (`import_account_aliases`), so a later import only asks
   about new numbers (a new bank shows up as a new account to confirm).
4. **Record** (`import-run`, 40 per request): every email goes through the
   ledger's import boundary (`ingest_source_event_for`), which records what is
   confident and complete and sends the rest to Review with a reason —
   refunds, transfers and card bill payments, unknown accounts, unverified
   senders, low confidence, and likely duplicates of entries already in
   Friday. The same email is never recorded twice, however many imports
   include it; a payment app's email about a bank's UPI payment is linked to
   it by the UPI reference instead of being counted again.
5. **Undo** (`import-undo`): deletes the entries that import recorded (except
   any a refund now depends on), takes its items out of Review and forgets its
   evidence, so the months can be imported again. Hand-typed entries are never
   touched; accounts it created stay.

Each step is a short request, driven from the Gmail page while it's open. If a
request fails (a dropped connection, a function timeout) the page says so with
*Try again*, which carries on where it stopped; leaving the page and coming
back carries on too. An import interrupted while finding, reading or before
its accounts are confirmed can be cancelled (nothing is recorded), and the
months are offered again.

**Balances stay right.** When older history is imported into an account that
started tracking later, the account gets a `balance_from` date (its old start)
and its starting balance is restated as of that date, so today's balance is
unchanged; entries before it count in spending, not in the balance. New
accounts start on the first imported day.

**Every transaction is recorded or reviewed, never dropped.** Reading alerts
(`alerts.ts`) knows the common wordings of ~35 Indian banks, card issuers and
wallets, and treats any other `<name>.bank.in` sender as a bank. A transaction
is recorded automatically only when the sender's domain signed the email
(DKIM/DMARC), the account number, amount, direction and date are clear and
there's one transaction amount; everything else waits in Review. An email that
looks like a transaction but can't be read completely — an amount with no
clear debit or credit, or "debited" with no readable amount — is kept with
what was read and waits in Review as *Some details couldn't be read*, where
the person sets the type and amount and records it, or ignores it. If the
import boundary rejects what was read, the email goes to Review with its
plainest facts instead; one that can't be kept at all is counted as
*Couldn't be imported* (never silently). A declined or failed payment (said in
the subject or the transaction's own sentence) records nothing and is counted
as such.

## Logging

Functions log one JSON line per event with an allowlist of fields (`action`,
`outcome`, `status`, `failure`, `count`, `revoked`, `reason`) — never codes,
tokens, states, tickets, email addresses or message content. Google error
bodies are reduced to a failure code. Missing configuration is logged by
setting name only.

Supabase's own platform request logs may record the callback's URL, which
includes Google's one-time `code` and `state` (Google always sends them in the
query string). Neither is usable from a log: the code needs the PKCE verifier
and the client secret and is redeemed within seconds, and the state is
single-use.

## Configuration

### Function secrets

Set on the Supabase project (Edge Functions → Secrets, or
`npx supabase secrets set …`). Template: `supabase/functions/.env.example`.

| Secret | Required | Value |
| ------ | -------- | ----- |
| `GOOGLE_OAUTH_CLIENT_ID` | yes | the Web client's ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes | the Web client's secret |
| `GMAIL_OAUTH_REDIRECT_URI` | yes | `https://sjxomdhbvwvmvdlqwbic.supabase.co/functions/v1/gmail-oauth-callback` (must match Google exactly) |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | yes | `openssl rand -base64 32` — keep a copy somewhere safe; changing it makes stored access unreadable (people reconnect) |
| `FRIDAY_APP_URL` | yes | the deployed app's https origin, e.g. `https://<your-app>.vercel.app` |
| `FRIDAY_ALLOWED_ORIGINS` | no | extra browser origins, comma-separated (e.g. `http://localhost:5173`) |
| `GMAIL_ALERT_SENDERS` | no | sender domains/addresses, comma-separated; empty = defaults |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | provided | injected into hosted functions by Supabase; not set by you |
| `FRIDAY_GOOGLE_TEST_ORIGIN` | **never in production** | local tests only; accepted only for `http://localhost` |

The browser app needs nothing new: it calls the function through
`supabase.functions.invoke` with the user's session.

### Google Cloud (manual)

1. Create (or pick) a Google Cloud project → *APIs & Services → Library* →
   enable the **Gmail API**.
2. *Google Auth Platform* (OAuth consent screen):
   - **Branding**: app name, support email, developer contact.
   - **Audience**: *External*, publishing status **Testing**; add each Gmail
     address that may connect as a **test user** (up to 100).
   - **Data access**: add the scope `…/auth/gmail.readonly` only.
3. *Clients → Create client → Web application*. Authorised redirect URI:
   `https://sjxomdhbvwvmvdlqwbic.supabase.co/functions/v1/gmail-oauth-callback`.
   No JavaScript origins are needed (the browser never talks to Google's token
   endpoint). Copy the client ID and secret into the function secrets.
4. Don't publish the app. While it's in Testing, Google shows an "unverified
   app" warning, only test users can connect, and **refresh tokens expire after
   7 days** — Friday then shows *Needs reconnecting*. Going to production with
   `gmail.readonly` (a restricted scope) needs Google's OAuth verification and,
   because tokens are stored server-side, a third-party security assessment.

### Deploy

```bash
# 1. Database: run supabase/migrations/20261021000000_gmail_connection.sql
#    in the Supabase SQL editor (or: npx supabase db push).
# 2. Secrets
npx supabase login                       # or export SUPABASE_ACCESS_TOKEN
cp supabase/functions/.env.example supabase/functions/.env   # fill in
npx supabase secrets set --env-file supabase/functions/.env --project-ref sjxomdhbvwvmvdlqwbic
# 3. Functions (checks the CLI login and secrets first)
SUPABASE_PROJECT_REF=sjxomdhbvwvmvdlqwbic scripts/deploy-gmail-functions.sh
```

**Without the CLI (dashboard editor):** `DENO_BIN=deno scripts/bundle-gmail-functions.sh`
writes `dist-functions/gmail-connection.ts` and `dist-functions/gmail-oauth-callback.ts`
— the same code with the shared modules inlined. In the dashboard: *Edge
Functions → Deploy a new function → Via Editor*, name it exactly
`gmail-connection`, replace the editor's code with the first file, deploy;
repeat for `gmail-oauth-callback`. Then open each function's settings and turn
**Verify JWT** off. Regenerate and redeploy whenever the function code changes.

Both functions are deployed with `--no-verify-jwt` on purpose:
`gmail-connection` verifies the caller's Supabase session itself
(`auth.getUser`), and Google's redirect to `gmail-oauth-callback` carries no
session — the one-time state is what proves who started it.

Then in Friday: *Profile → Gmail → Connect Gmail*.

## Testing

```bash
# Function logic with fakes (state, callback errors, cross-user, secrecy, disconnects)
DENO_CERT=/path/to/ca.pem deno test --config supabase/functions/tests/deno.json --allow-env supabase/functions/tests/
deno check --config supabase/functions/tests/deno.json supabase/functions/*/index.ts

# Database: privileges, one-time state, grants, isolation, disconnect (part of the suite)
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:db

# Browser end to end: the real function code under Deno + real database + a
# local fake Google (e2e/fake-google.mjs)
DENO_BIN=$(which deno) PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
POSTGREST_BIN=/path/to/postgrest npm run test:e2e -- e2e/gmail.spec.ts
```

## Known limits and next steps

- **Continuous sync**: past months are imported on request; new alerts are
  not yet picked up automatically (Gmail push notifications via Pub/Sub +
  `history.list`). Not started.
- **Sender authenticity**: the `From` address (the real one, not a look-alike
  display name) is checked against the allowlist, and an import records
  automatically only from senders whose DKIM/DMARC passed in Gmail's
  `Authentication-Results`; the rest wait in Review.
- **Abandoned approvals** are swept (and revoked where safe) when their owner
  next starts a connection; a scheduled sweep across all users would tighten
  that.
- **Deleting the login** in the Supabase dashboard deletes Gmail access from
  Friday without revoking it at Google; use *Delete all my data* (which
  disconnects first) or remove Friday at myaccount.google.com/permissions.
- **Key rotation**: ciphertexts are versioned (`v1.`); rotation would add a
  second key and re-seal on use.
- If the project's legacy API keys are ever disabled, `SUPABASE_SERVICE_ROLE_KEY`
  may no longer be injected; the functions would then report "not set up" and
  need to read the new secret key instead.
