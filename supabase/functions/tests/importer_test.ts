// Importing past months through gmail-connection: finding the emails, reading
// them (keeping only the facts), the account step, batches, undo, and every
// way it can be refused. The database rules themselves are tested in
// tests/db/gmail_import_test.sql.

import assert from 'node:assert/strict'
import { IMPORT_MAX_MESSAGES } from '../_shared/importer.ts'
import { refreshTokenContext } from '../_shared/crypto.ts'
import type { Mail } from './fakes.ts'
import { USERS } from './fakes.ts'
import { setup, type Harness } from './harness.ts'

const DAY = 86_400_000
const now = new Date()
/** The previous calendar month (always fully in the past). */
const prevStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
const PREV = new Date(prevStart).toISOString().slice(0, 7)
const OLDER = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 7)

function ddmmyy(ms: number): string {
  const d = new Date(ms + 5.5 * 3_600_000)
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCFullYear()).slice(2)}`
}

const SENTINEL = 'PRIVATE-BODY-SENTINEL'

function hdfcDebit(id: string, at: number, rupees: number, payee: string): Mail {
  return {
    id,
    from: 'HDFC Bank InstaAlerts <alerts@hdfcbank.net>',
    subject: 'You have done a UPI txn. Check details!',
    snippet: '',
    body: `Dear Customer, Rs.${rupees}.00 has been debited from account **1234 to VPA shop@okaxis ${payee} on ${ddmmyy(at)}. Your UPI transaction reference number is 4291${id.padStart(8, '0').slice(-8)}. ${SENTINEL} Never share your OTP.`,
    internalDate: String(at),
  }
}

function iciciCard(id: string, at: number, rupees: number, merchant: string): Mail {
  return {
    id,
    from: 'ICICI Bank <credit_cards@icicibank.com>',
    subject: 'Transaction alert for your ICICI Bank Credit Card',
    snippet: '',
    body: `<p>Dear Customer, Your ICICI Bank Credit Card XX9001 has been used for a transaction of INR ${rupees}.00 on ${ddmmyy(at)}. Info: ${merchant}.</p><p>${SENTINEL}</p>`,
    internalDate: String(at),
    html: true,
  }
}

async function connected(): Promise<Harness> {
  const h = await setup()
  await h.connect('session-a', { email: 'asha@gmail.com' })
  return h
}

async function startImport(h: Harness, months: string[] = [PREV]) {
  const response = await h.call('session-a', { action: 'import-start', months })
  return { response, body: await response.json() }
}

async function scanAll(h: Harness, jobId: string) {
  for (let i = 0; i < 20; i++) {
    const body = await (await h.call('session-a', { action: 'import-scan', jobId })).json()
    if (body.status !== 'scanning') return body
  }
  throw new Error('scan never finished')
}

Deno.test('start: finds alert emails in the chosen months only', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', [
    hdfcDebit('p1', prevStart + 2 * DAY, 250, 'BLUE TOKAI'),
    hdfcDebit('p2', prevStart + 5 * DAY, 450, 'DMART'),
    iciciCard('p3', prevStart + 9 * DAY, 1499, 'AMAZON'),
    hdfcDebit('o1', prevStart - 3 * DAY, 99, 'OLDER'),
  ])
  const { response, body } = await startImport(h)
  assert.equal(response.status, 200)
  assert.equal(body.total, 3)
  assert.equal(body.truncated, false)

  const list = h.google.requests.find((r) => r.url.pathname.endsWith('/messages'))!
  const q = list.url.searchParams.get('q')!
  // Banks' new .bank.in addresses too, and no required words: an alert worded
  // unexpectedly is still found (the reader decides what's a transaction).
  assert.match(q, /^from:\(bank\.in OR fin\.in OR hdfcbank\.net OR .*\) after:/)
  assert.match(q, new RegExp(`after:${prevStart / 1000} before:\\d+ -category:social$`))
  assert.ok(!q.includes('category:promotions'), 'alerts filed under Promotions are still found')
  assert.equal(list.url.searchParams.get('fields'), 'messages/id,nextPageToken')
})

Deno.test('scan: reads each email in full but keeps only what it says', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', [
    hdfcDebit('p1', prevStart + 2 * DAY, 250, 'BLUE TOKAI'),
    iciciCard('p3', prevStart + 9 * DAY, 1499, 'AMAZON'),
    { id: 'otp1', from: 'HDFC Bank <alerts@hdfcbank.net>', subject: 'OTP', snippet: '', body: '482913 is the OTP for your transaction of Rs.1,499.00. Do not share.', internalDate: String(prevStart + DAY) },
  ])
  const { body: started } = await startImport(h)
  const done = await scanAll(h, started.jobId)
  assert.deepEqual(done, { scanned: 3, total: 3, status: 'confirm_accounts' })

  for (const r of h.google.requests.filter((r) => /\/messages\/\w+$/.test(r.url.pathname))) {
    assert.equal(r.url.searchParams.get('format'), 'full')
  }
  const job = h.store.jobs.get(started.jobId)!
  const p1 = job.items.get('p1')!
  assert.ok(p1 && 'alert' in p1)
  assert.equal(p1.alert.amountMinor, 25000)
  assert.equal(p1.alert.accountMask, '1234')
  assert.equal(p1.alert.merchant, 'BLUE TOKAI')
  assert.equal(p1.alert.senderVerified, true)
  const p3 = job.items.get('p3')!
  assert.ok(p3 && 'alert' in p3 && p3.alert.instrument === 'credit_card' && p3.alert.amountMinor === 149900, 'HTML emails too')
  assert.deepEqual(job.items.get('otp1'), { messageId: 'otp1', skip: 'otp' })

  assert.ok(!h.store.dump().includes(SENTINEL), 'no email text is stored')
  assert.ok(!JSON.stringify(h.lines).includes(SENTINEL) && !JSON.stringify(h.lines).includes('BLUE TOKAI'), 'or logged')
})

Deno.test('scan: an email that\'s only partly readable is kept for review, not dropped', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', [
    // A bank's new address; an amount with no debit or credit.
    { id: 'u1', from: 'HDFC Bank <alerts@hdfcbank.bank.in>', subject: 'Transaction alert', snippet: '', body: `Dear Customer, Rs.1,250.00 at DMART on card xx1234 on ${ddmmyy(prevStart + 3 * DAY)}.`, internalDate: String(prevStart + 3 * DAY) },
    // "Debited", with no amount Friday can read.
    { id: 'u2', from: 'HDFC Bank <alerts@hdfcbank.bank.in>', subject: 'Account update', snippet: '', body: 'Dear Customer, your A/c XX1234 has been debited. Visit NetBanking for details.', internalDate: String(prevStart + 4 * DAY) },
  ])
  const { body: started } = await startImport(h)
  assert.equal(started.total, 2, 'the new .bank.in addresses are searched')
  assert.deepEqual(await scanAll(h, started.jobId), { scanned: 2, total: 2, status: 'confirm_accounts' })
  const job = h.store.jobs.get(started.jobId)!
  const u1 = job.items.get('u1')!
  const u2 = job.items.get('u2')!
  assert.ok('alert' in u1 && u1.alert.institutionKey === 'hdfc' && u1.alert.kind === null && u1.alert.amountMinor === 125000)
  assert.ok('alert' in u2 && u2.alert.kind === 'expense' && u2.alert.amountMinor === null)
})

Deno.test('accounts → confirm → run → undo', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', [hdfcDebit('p1', prevStart + 2 * DAY, 250, 'BLUE TOKAI'), iciciCard('p3', prevStart + 9 * DAY, 1499, 'AMAZON')])
  const { body: started } = await startImport(h)
  const jobId = started.jobId
  await scanAll(h, jobId)

  const { accounts } = await (await h.call('session-a', { action: 'import-accounts', jobId })).json()
  assert.deepEqual(
    accounts.map((a: { institutionKey: string; instrument: string; accountMask: string }) => `${a.institutionKey}/${a.instrument}/${a.accountMask}`).sort(),
    ['hdfc/bank/1234', 'icici/credit_card/9001'],
  )

  const partial = await h.call('session-a', {
    action: 'import-confirm', jobId,
    decisions: [{ institutionKey: 'hdfc', instrument: 'bank', accountMask: '1234', action: 'create', name: 'HDFC', type: 'bank' }],
  })
  assert.equal(partial.status, 400)
  assert.match((await partial.json()).message, /Choose what to do with ICICI Bank/)

  const bad = await h.call('session-a', { action: 'import-confirm', jobId, decisions: [{ institutionKey: 'hdfc', instrument: 'bank', action: 'link', accountId: 'not-a-uuid' }] })
  assert.equal(bad.status, 400)

  const confirmed = await h.call('session-a', {
    action: 'import-confirm', jobId,
    decisions: [
      { institutionKey: 'hdfc', instrument: 'bank', accountMask: '1234', action: 'create', name: 'HDFC', type: 'bank' },
      { institutionKey: 'icici', instrument: 'credit_card', accountMask: '9001', action: 'ignore' },
    ],
  })
  assert.deepEqual(await confirmed.json(), { created: 1, linked: 0, kept: 0 })
  assert.equal((await (await h.call('session-a', { action: 'import-run', jobId })).json()).status, 'done')
  assert.deepEqual(await (await h.call('session-a', { action: 'import-undo', jobId })).json(), { removed: 2, kept: 0 })
  const again = await h.call('session-a', { action: 'import-undo', jobId })
  assert.equal(again.status, 409, 'once only')
})

Deno.test('refusals: bad months, one at a time, not connected, someone else\'s import', async () => {
  const h = await connected()
  for (const months of [[], ['2026-1'], [PREV, OLDER, 'x'], 'October', [PREV, OLDER, PREV, OLDER]]) {
    assert.equal((await h.call('session-a', { action: 'import-start', months })).status, 400, JSON.stringify(months))
  }
  h.google.mailboxes.set('asha@gmail.com', [hdfcDebit('p1', prevStart + 2 * DAY, 250, 'BLUE TOKAI')])
  const { body: first } = await startImport(h)
  const second = await h.call('session-a', { action: 'import-start', months: [OLDER] })
  assert.equal(second.status, 409)
  assert.equal((await second.json()).message, 'An import is already in progress')

  const other = await h.call('session-b', { action: 'import-scan', jobId: first.jobId })
  assert.equal(other.status, 404, 'B can\'t touch A\'s import')
  assert.equal((await h.call('session-a', { action: 'import-scan', jobId: 'nope' })).status, 400)

  const fresh = await setup()
  const notConnected = await fresh.call('session-a', { action: 'import-start', months: [PREV] })
  assert.equal(notConnected.status, 409)
  assert.equal((await notConnected.json()).error, 'not_connected')
  assert.equal(fresh.store.jobs.size, 0, 'nothing was started')
})

Deno.test('access revoked during an import: reconnect, nothing deleted on a hunch', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', [hdfcDebit('p1', prevStart + 2 * DAY, 250, 'BLUE TOKAI')])
  const { body: started } = await startImport(h)
  const refresh = await h.cipher.decrypt(h.store.credentials.get('conn-1')!.enc, refreshTokenContext(USERS.a))
  h.google.revoked.add(refresh)
  const scan = await h.call('session-a', { action: 'import-scan', jobId: started.jobId })
  assert.equal(scan.status, 409)
  assert.equal((await scan.json()).error, 'needs_reconnect')
  assert.equal(h.store.connections[0].status, 'needs_reconnect')
})

Deno.test('an email deleted since it was found is skipped', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', [hdfcDebit('p1', prevStart + 2 * DAY, 250, 'BLUE TOKAI'), hdfcDebit('p2', prevStart + 3 * DAY, 300, 'X SHOP')])
  const { body: started } = await startImport(h)
  h.google.mailboxes.set('asha@gmail.com', [hdfcDebit('p1', prevStart + 2 * DAY, 250, 'BLUE TOKAI')])
  await scanAll(h, started.jobId)
  assert.deepEqual(h.store.jobs.get(started.jobId)!.items.get('p2'), { messageId: 'p2', skip: 'not_found' })
})

Deno.test('Gmail failing while listing ends that import, and a new one can start', async () => {
  const h = await connected()
  h.google.failures.set('/messages', { status: 500 })
  const failed = await startImport(h)
  assert.equal(failed.response.status, 502)
  assert.equal([...h.store.jobs.values()][0].status, 'failed')
  assert.equal((await startImport(h)).response.status, 200)
})

Deno.test(`one import reads at most ${IMPORT_MAX_MESSAGES} emails (the newest)`, async () => {
  const h = await connected()
  h.google.mailboxes.set(
    'asha@gmail.com',
    Array.from({ length: IMPORT_MAX_MESSAGES + 20 }, (_, i) => hdfcDebit(`m${i}`, prevStart + DAY + i * 60_000, 100 + i, 'SHOP')),
  )
  const { body } = await startImport(h)
  assert.equal(body.total, IMPORT_MAX_MESSAGES)
  assert.equal(body.truncated, true)
  assert.ok(h.store.jobs.get(body.jobId)!.items.has(`m${IMPORT_MAX_MESSAGES + 19}`), 'the newest are kept')
})
