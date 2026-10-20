import { expect, test, type Page } from '@playwright/test'

// Quick Add against the real database service: failure handling, idempotent
// retries, drafts, Edit/Undo and concurrent edits.

const email = 'quick-add@example.com'
const password = 'correct-horse-battery'

test.describe.configure({ mode: 'serial' })

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)
}

async function openQuickAdd(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add transaction' }).click()
  await expect(page).toHaveURL(/\/add/)
}

async function countInActivity(page: Page, query: string) {
  await page.goto(`/activity?period=all&q=${encodeURIComponent(query)}`)
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  return page.getByRole('link', { name: new RegExp(query) }).count()
}

test('set up an account', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('radio', { name: 'Create account' }).click()
  await page.getByLabel('Your name').fill('Quick')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByLabel('Name').fill('Savings')
  await page.getByLabel('Starting balance').fill('10000')
  await page.getByRole('button', { name: 'Start tracking' }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('a request that never reaches the server keeps the draft and retries cleanly', async ({ page }) => {
  await signIn(page)
  await openQuickAdd(page)
  await page.getByLabel(/amount in rupees/).fill('111')
  await page.getByRole('button', { name: /Add details/ }).click()
  await page.getByLabel('Merchant or payee').fill('Dropped Cafe')

  let blocked = false
  await page.route('**/rest/v1/rpc/record_entry*', async (route) => {
    if (!blocked) {
      blocked = true
      return route.abort('internetdisconnected')
    }
    return route.continue()
  })
  await page.getByRole('button', { name: 'Save expense' }).click()
  await expect(page.getByText(/Couldn’t confirm the save/)).toBeVisible()
  await expect(page).toHaveURL(/\/add/)
  await expect(page.getByLabel(/amount in rupees/)).toHaveValue('111')

  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page).toHaveURL(/\/$/)
  expect(await countInActivity(page, 'Dropped Cafe')).toBe(1)
})

test('a lost response after the commit never creates a duplicate', async ({ page }) => {
  await signIn(page)
  await openQuickAdd(page)
  await page.getByLabel(/amount in rupees/).fill('222')
  await page.getByRole('button', { name: /Add details/ }).click()
  await page.getByLabel('Merchant or payee').fill('Lost Reply Store')

  let lost = false
  await page.route('**/rest/v1/rpc/record_entry*', async (route) => {
    if (!lost) {
      lost = true
      await route.fetch() // the server commits…
      return route.abort('connectionreset') // …but the reply never arrives
    }
    return route.continue()
  })
  await page.getByRole('button', { name: 'Save expense' }).click()
  await expect(page.getByText(/Couldn’t confirm the save/)).toBeVisible()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('status').filter({ hasText: 'Saved −₹222' })).toBeVisible()
  expect(await countInActivity(page, 'Lost Reply Store')).toBe(1)
})

test('an unsaved draft survives a reload', async ({ page }) => {
  await signIn(page)
  await openQuickAdd(page)
  await page.getByLabel(/amount in rupees/).fill('333')
  await page.reload()
  await expect(page.getByText(/Picked up your unsaved expense/)).toBeVisible()
  await expect(page.getByLabel(/amount in rupees/)).toHaveValue('333')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: 'Add transaction' }).click()
  await expect(page.getByLabel(/amount in rupees/)).toHaveValue('')
})

test('invalid input is explained and blocks saving', async ({ page }) => {
  await signIn(page)
  await openQuickAdd(page)
  await page.getByLabel(/amount in rupees/).fill('12.345')
  await expect(page.getByText('Use at most 2 decimal places (paise)').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save expense' })).toBeDisabled()
  await page.getByLabel(/amount in rupees/).fill('-5')
  await expect(page.getByText(/Amounts are always positive/).first()).toBeVisible()
  await page.getByRole('radio', { name: 'Transfer' }).click()
  // Only one account: there is nowhere to transfer to.
  await page.getByLabel(/amount in rupees/).fill('10')
  await expect(page.getByText('Choose a destination account').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record transfer' })).toBeDisabled()
})

test('the confirmation offers Edit and Undo, and Undo keeps balances right', async ({ page }) => {
  await signIn(page)
  await page.goto('/accounts')
  const before = await page.getByRole('link', { name: /Savings, Bank account/ }).getAttribute('aria-label')

  await openQuickAdd(page)
  await page.getByLabel(/amount in rupees/).fill('444')
  await page.getByRole('button', { name: 'Save expense' }).click()
  const toast = page.getByRole('status').filter({ hasText: 'Saved −₹444' })
  await expect(toast.getByRole('button', { name: 'Edit' })).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('Undone — that entry is gone.')).toBeVisible()

  await page.goto('/accounts')
  await expect(page.getByRole('link', { name: /Savings, Bank account/ })).toHaveAttribute('aria-label', before!)

  await openQuickAdd(page)
  await page.getByLabel(/amount in rupees/).fill('555')
  await page.getByRole('button', { name: 'Save expense' }).click()
  await page.getByRole('status').filter({ hasText: 'Saved −₹555' }).getByRole('button', { name: 'Edit' }).click()
  await expect(page).toHaveURL(/\/entry\/expense\//)
  await expect(page.getByLabel(/amount in rupees/)).toHaveValue('555')
})

test('an edit made elsewhere is never silently overwritten', async ({ browser }) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const a = await contextA.newPage()
  const b = await contextB.newPage()
  await signIn(a)
  await signIn(b)

  await openQuickAdd(a)
  await a.getByLabel(/amount in rupees/).fill('666')
  await a.getByRole('button', { name: /Add details/ }).click()
  await a.getByLabel('Note').fill('Shared edit')
  await a.getByRole('button', { name: 'Save expense' }).click()
  await expect(a).toHaveURL(/\/$/)

  for (const page of [a, b]) {
    await page.goto('/activity?period=all&q=Shared%20edit')
    await page.getByRole('link', { name: /Shared edit/ }).click()
    await page.getByRole('button', { name: 'Edit' }).click()
    await expect(page.getByLabel(/amount in rupees/)).toHaveValue('666')
  }

  await b.getByLabel(/amount in rupees/).fill('700')
  await b.getByRole('button', { name: 'Save changes' }).click()
  await expect(b).toHaveURL(/\/entry\/expense\/[^/]+$/)

  await a.getByLabel(/amount in rupees/).fill('999')
  await a.getByRole('button', { name: 'Save changes' }).click()
  await expect(a.getByText(/changed somewhere else/)).toBeVisible()
  await a.getByRole('button', { name: 'Load the latest version' }).click()
  await expect(a.getByLabel(/amount in rupees/)).toHaveValue('700')

  await contextA.close()
  await contextB.close()
})

test('categories are suggested from history and clearly marked', async ({ page }) => {
  await signIn(page)
  for (const amount of ['80', '95', '120']) {
    await openQuickAdd(page)
    await page.getByLabel(/amount in rupees/).fill(amount)
    await page.getByRole('button', { name: 'Groceries', exact: true }).click()
    await page.getByRole('button', { name: /Add details/ }).click()
    await page.getByLabel('Merchant or payee').fill('Zepto')
    await page.getByRole('button', { name: 'Save expense' }).click()
    await expect(page).toHaveURL(/\/$/)
  }

  await openQuickAdd(page)
  await page.getByLabel(/amount in rupees/).fill('60')
  await page.getByRole('button', { name: /Add details/ }).click()
  await page.getByLabel('Merchant or payee').fill('zepto')
  await expect(page.getByRole('button', { name: 'Groceries, suggested — tap to confirm' })).toBeVisible()
  await expect(page.getByText(/Suggested from your history for zepto/)).toBeVisible()
  await page.getByRole('button', { name: 'Save expense' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved −₹60 · Groceries' })).toBeVisible()
})
