import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

// Phase 1 ledger behaviour through the real app and database, on an
// iPhone-sized screen: card purchases and repayments, refunds, voiding, the
// review queue (fed through the import boundary) and mobile navigation.

const email = 'ledger-model@example.com'
const password = 'correct-horse-battery'

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)
}

async function quickAdd(
  page: Page,
  entry: { kind?: 'Income' | 'Transfer'; amount: string; account?: string; to?: string; category?: string; note?: string },
) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add transaction' }).click()
  if (entry.kind) await page.getByRole('radio', { name: entry.kind }).click()
  await page.getByLabel(/amount in rupees/).fill(entry.amount)
  if (entry.kind === 'Transfer') {
    await page.getByRole('radiogroup', { name: 'From' }).getByRole('radio', { name: new RegExp(entry.account!) }).click()
    await page.getByRole('radiogroup', { name: 'To' }).getByRole('radio', { name: new RegExp(entry.to!) }).click()
  } else if (entry.account) {
    await page.getByRole('radio', { name: new RegExp(entry.account) }).click()
  }
  if (entry.category) await page.getByRole('button', { name: entry.category, exact: true }).click()
  if (entry.note) {
    await page.getByRole('button', { name: /Add details/ }).click()
    await page.getByLabel('Note').fill(entry.note)
  }
  await page.getByRole('button', { name: /^(Save expense|Save income|Record transfer)$/ }).click()
  await expect(page).toHaveURL(/\/$/)
}

/** Delivers import evidence for this user the way a future importer would (as the signed-in user). */
function submitEvent(sql: string) {
  const user = psql(`select id from auth.users where email = '${email}'`)
  return psql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', false);
    ${sql}`)
}

function psql(sql: string) {
  return execFileSync('psql', ['-q', '-t', '-A', '-d', 'friday_e2e', '-c', sql], { encoding: 'utf8' }).trim().split('\n').pop()!
}

async function expectNoSideways(page: Page) {
  // A string runs in the page; the e2e TypeScript config has no DOM types.
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth')
  expect(overflow).toBeLessThanOrEqual(0)
}

test('set up a bank account and a credit card with a limit', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('radio', { name: 'Create account' }).click()
  await page.getByLabel('Your name').fill('Ledger')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByLabel('Name').fill('Savings')
  await page.getByLabel('Starting balance').fill('50000')
  await page.getByRole('button', { name: 'Start tracking' }).click()
  await expect(page).toHaveURL(/\/$/)

  await page.goto('/accounts/new')
  await page.locator('label').filter({ has: page.getByRole('radio', { name: 'Card' }) }).click()
  await page.getByLabel('Name').fill('Millennia')
  await page.getByLabel('Bank or provider (optional)').fill('HDFC Bank')
  await page.getByLabel('Credit limit (optional)').fill('50000')
  await page.getByRole('button', { name: 'Add account' }).click()
  await expect(page).toHaveURL(/\/accounts$/)
  await expect(page.getByRole('heading', { name: 'Credit cards' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Millennia, HDFC Bank, Credit card/ })).toBeVisible()
  await expectNoSideways(page)
})

test('a card purchase is spending once; paying the bill is a transfer, not more spending', async ({ page }) => {
  await signIn(page)
  await quickAdd(page, { amount: '150', account: 'Millennia', category: 'Food & dining', note: 'Cafe' })

  await page.goto('/accounts')
  const card = page.getByRole('link', { name: /Millennia, HDFC Bank, Credit card/ })
  await expect(card).toHaveAttribute('aria-label', /Owed ₹150/)
  await expect(card).toHaveAttribute('aria-label', /₹49,850 available/)
  await expect(page.getByRole('link', { name: /Savings, Bank account\. Balance ₹50,000/ })).toBeVisible()

  // Paying the card from the bank.
  await page.goto('/')
  await page.getByRole('button', { name: 'Add transaction' }).click()
  await page.getByRole('radio', { name: 'Transfer' }).click()
  await page.getByLabel(/amount in rupees/).fill('150')
  await page.getByRole('radiogroup', { name: 'From' }).getByRole('radio', { name: /Savings/ }).click()
  await page.getByRole('radiogroup', { name: 'To' }).getByRole('radio', { name: /Millennia/ }).click()
  await expect(page.getByText(/Card payment — not spending/)).toBeVisible()
  await page.getByRole('button', { name: 'Record transfer' }).click()
  await expect(page).toHaveURL(/\/$/)

  // Spending is still the one purchase; the card is paid off; the bank paid it.
  await expect(page.getByLabel('₹150', { exact: true })).toBeVisible()
  await page.goto('/accounts')
  await expect(page.getByRole('link', { name: /Millennia, HDFC Bank, Credit card/ })).toHaveAttribute('aria-label', /Nothing owed/)
  await expect(page.getByRole('link', { name: /Savings, Bank account\. Balance ₹49,850/ })).toBeVisible()
})

test('a partial refund reduces spending, is capped, and is never income', async ({ page }) => {
  await signIn(page)
  await quickAdd(page, { amount: '1000', account: 'Savings', category: 'Shopping', note: 'Shoes' })

  await page.goto('/activity?period=all&q=Shoes')
  await page.getByRole('link', { name: /Shoes/ }).click()
  await page.getByRole('button', { name: 'Record refund' }).click()
  const form = page.getByRole('dialog')
  await expect(form.getByLabel('Amount')).toHaveValue(/1,?000/)
  await form.getByLabel('Amount').fill('1200')
  await expect(form.getByText(/Only ₹1,000 is left to refund/)).toBeVisible()
  await form.getByLabel('Amount').fill('400')
  await form.getByRole('button', { name: 'Record refund' }).click()
  await expect(page.getByText(/Refund recorded/)).toBeVisible()
  await expect(page.getByText(/₹600 left/).first()).toBeVisible()

  // Home: spent = 150 + 1000 − 400; income untouched.
  await page.goto('/')
  await expect(page.getByLabel('₹750', { exact: true })).toBeVisible()
  await expect(page.getByText('after ₹400 in refunds')).toBeVisible()
  await expect(page.getByLabel('Received ₹0', { exact: true })).toBeVisible()

  // The refund shows as money back in the list, under the Refunds filter.
  await page.goto('/activity?period=all&kind=refund')
  await expect(page.getByRole('link', { name: /refunded ₹400/ })).toBeVisible()
})

test('voiding takes an entry out of every total, and Restore brings it back', async ({ page }) => {
  await signIn(page)
  await quickAdd(page, { amount: '99', account: 'Savings', category: 'Transport', note: 'Cab hold' })
  await page.goto('/activity?period=all&q=Cab')
  await page.getByRole('link', { name: /Cab hold/ }).click()
  await page.getByRole('button', { name: 'Void' }).click()
  await page.getByRole('dialog').getByLabel(/Reason/).fill('Ride cancelled')
  await page.getByRole('dialog').getByRole('button', { name: /^Void/ }).click()
  await expect(page.getByText('Voided', { exact: true }).first()).toBeVisible()

  await page.goto('/')
  await expect(page.getByLabel('₹750', { exact: true })).toBeVisible()

  await page.goto('/activity?period=all&q=Cab')
  await expect(page.getByRole('link', { name: /Cab hold.*voided/ })).toBeVisible()
  await page.getByRole('link', { name: /Cab hold/ }).click()
  await page.getByRole('button', { name: 'Restore' }).click()
  await page.goto('/')
  await expect(page.getByLabel('₹849', { exact: true })).toBeVisible()
})

test('the review queue holds uncertain imports without touching balances', async ({ page }) => {
  await signIn(page)
  await page.goto('/review')
  await expect(page.getByText('Nothing needs a look right now')).toBeVisible()

  const account = psql(`select id from public.accounts where name = 'Savings' and user_id = (select id from auth.users where email = '${email}')`)
  const occurred = new Date().toISOString()
  expect(
    submitEvent(`select processing_status || ':' || review_reason from public.submit_source_event('email', 'gmail-1',
      p_kind => 'expense', p_amount_minor => 25000, p_occurred_at => '${occurred}', p_merchant => 'Blue Tokai',
      p_account_id => '${account}', p_confidence => 0.6)`),
  ).toBe('needs_review:low_confidence')
  expect(
    submitEvent(`select processing_status from public.submit_source_event('email', 'promo-1',
      p_kind => 'expense', p_amount_minor => 99900, p_occurred_at => '${occurred}', p_merchant => 'Big Sale')`),
  ).toBe('needs_review')

  // Nothing reached the ledger yet; Home flags it.
  await page.goto('/')
  await expect(page.getByLabel('₹849', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /2 to review/ })).toBeVisible()

  await page.goto('/review')
  await expect(page.getByText(/wasn’t sure enough/)).toBeVisible()
  await expectNoSideways(page)

  await page.getByRole('button', { name: /^Ignore Big Sale/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Ignore/ }).click()
  await expect(page.getByText(/nothing was recorded/)).toBeVisible()

  await page.getByRole('button', { name: /^Confirm Blue Tokai/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Record expense' }).click()
  await expect(page.getByText('Nothing needs a look right now')).toBeVisible()

  // Exactly one entry, marked as imported; confirming again changes nothing.
  await page.goto('/activity?period=all&q=Blue')
  await expect(page.getByRole('link', { name: /Blue Tokai.*imported from email/ })).toHaveCount(1)
  const event = psql(`select id from public.source_events where external_event_id = 'gmail-1'`)
  submitEvent(`select * from public.confirm_source_event('${event}', 'expense', 25000, '${account}')`)
  expect(psql(`select count(*) from public.transactions where merchant = 'Blue Tokai'`)).toBe('1')
  // Redelivering the email is a no-op.
  expect(
    submitEvent(`select replayed from public.submit_source_event('email', 'gmail-1', p_kind => 'expense', p_amount_minor => 25000,
      p_occurred_at => '${occurred}', p_account_id => '${account}', p_confidence => 0.99)`),
  ).toBe('t')
})

test('the tab bar reaches every main screen without sideways scrolling', async ({ page }) => {
  await signIn(page)
  const nav = page.getByRole('navigation', { name: 'Main' })
  for (const [label, url, heading] of [
    ['Activity', /\/activity/, 'Activity'],
    ['Insights', /\/insights/, 'Insights'],
    ['Accounts', /\/accounts/, 'Accounts'],
  ] as const) {
    await nav.getByRole('link', { name: label }).click()
    await expect(page).toHaveURL(url)
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
    await expectNoSideways(page)
  }
  await nav.getByRole('link', { name: 'Home' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expectNoSideways(page)
  await page.getByRole('link', { name: 'Profile' }).click()
  await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeVisible()
  await page.goto('/activity?period=all&q=Shoes')
  await page.getByRole('link', { name: /Shoes/ }).click()
  await expectNoSideways(page)
})
