import { expect, test, type Page } from '@playwright/test'

// The TRD's end-to-end path: create account → add income → add expense →
// transfer → inspect summaries → edit/delete → export.

// Fixed address: global setup gives every run a fresh database.
const email = 'e2e-user@example.com'

async function addEntry(page: Page, opts: { kind?: 'Expense' | 'Income' | 'Transfer'; amount: string; category?: string; account?: string; to?: string; note?: string }) {
  await page.getByRole('button', { name: 'Add transaction' }).click()
  await expect(page).toHaveURL(/\/add/)
  if (opts.kind && opts.kind !== 'Expense') await page.getByRole('radio', { name: opts.kind }).click()
  await page.getByLabel(/amount in rupees/).fill(opts.amount)
  if (opts.category) await page.getByRole('button', { name: opts.category, exact: true }).click()
  if (opts.kind === 'Transfer') {
    await page.getByRole('radiogroup', { name: 'From' }).getByRole('radio', { name: opts.account }).click()
    await page.getByRole('radiogroup', { name: 'To' }).getByRole('radio', { name: opts.to }).click()
  } else if (opts.account) {
    await page.getByRole('radio', { name: opts.account }).click()
  }
  if (opts.note) {
    await page.getByRole('button', { name: 'Add details' }).click()
    await page.getByLabel('Note').fill(opts.note)
  }
  const save = page.getByRole('button', { name: opts.kind === 'Transfer' ? 'Record transfer' : opts.kind === 'Income' ? 'Save income' : 'Save expense' })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page).not.toHaveURL(/\/add/)
}

test('a fresh user can track, correct and export their money', async ({ page }) => {
  // Sign up → onboarding → first account
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
  await page.getByRole('radio', { name: 'Create account' }).click()
  // Every field is required: an empty submit flags each one.
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText('Enter your name')).toBeVisible()
  await expect(page.getByText('Enter your email address')).toBeVisible()
  await expect(page.getByText('Enter your password')).toBeVisible()
  await page.getByLabel('Your name').fill('Sai')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByLabel('Name').fill('Savings')
  await page.getByLabel('Starting balance').fill('50000')
  await page.getByRole('button', { name: 'Start tracking' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Nothing logged yet')).toBeVisible()

  // A cash account
  await page.goto('/accounts/new')
  // The type radios are visually replaced by their labels; tap the label like a person would.
  await page.locator('label').filter({ has: page.getByRole('radio', { name: 'Cash' }) }).click()
  await expect(page.getByRole('radio', { name: 'Cash' })).toBeChecked()
  await page.getByLabel('Name').fill('Wallet')
  await page.getByLabel('Starting balance').fill('1000')
  await page.getByRole('button', { name: 'Add account' }).click()
  await expect(page).toHaveURL(/\/accounts$/)
  await page.goto('/')

  // Save stays disabled until there's an amount
  await page.getByRole('button', { name: 'Add transaction' }).click()
  await expect(page.getByRole('button', { name: 'Save expense' })).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await addEntry(page, { kind: 'Income', amount: '80000', category: 'Salary', account: 'Savings' })
  await addEntry(page, { amount: '1250.50', category: 'Food & dining', account: 'Wallet', note: 'Dinner' })
  await addEntry(page, { kind: 'Transfer', amount: '5000', account: 'Savings', to: 'Wallet' })

  // Summaries: the transfer is in neither income nor spending.
  await expect(page.getByLabel('Received ₹80,000', { exact: true })).toBeVisible()
  await expect(page.getByLabel('₹1,250.50', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Net cash flow ₹78,749.50', { exact: true })).toBeVisible()

  // Balances: opening + income − expenses ± transfers
  await page.goto('/accounts')
  await expect(page.getByRole('link', { name: /Savings, Bank account\. Balance ₹1,25,000/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Wallet, Cash\. Balance ₹4,749\.50/ })).toBeVisible()

  // Edit: open the dinner's details, then change its amount
  await page.goto('/activity')
  await page.getByRole('link', { name: /Dinner/ }).click()
  await expect(page).toHaveURL(/\/entry\/expense\/[^/]+$/)
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel(/amount in rupees/).fill('1500')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page).toHaveURL(/\/entry\/expense\/[^/]+$/)
  await page.goto('/activity')
  await expect(page.getByRole('link', { name: /Dinner, spent ₹1,500/ })).toBeVisible()

  // Delete the transfer from its details page, then undo
  await page.getByRole('link', { name: /moved ₹5,000/ }).click()
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('Deleted transfer · ₹5,000')).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('Restored.')).toBeVisible()
  await page.goto('/activity')
  await expect(page.getByRole('link', { name: /moved ₹5,000/ })).toBeVisible()

  // Delete for real; balances follow.
  await page.getByRole('link', { name: /moved ₹5,000/ }).click()
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByText('Deleted transfer · ₹5,000')).toBeVisible()
  await page.goto('/activity')
  await expect(page.getByRole('link', { name: /moved ₹5,000/ })).toHaveCount(0)
  await page.goto('/accounts')
  await expect(page.getByRole('link', { name: /Savings, Bank account\. Balance ₹1,30,000/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Wallet, Cash\. Balance −₹500|Wallet, Cash\. Overdrawn/ })).toBeVisible()

  // Export
  await page.goto('/profile')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Transactions (CSV)' }).click(),
  ])
  const csv = await (await download.createReadStream()).toArray()
  const text = Buffer.concat(csv).toString('utf8')
  // Columns only ever get appended, so older spreadsheets keep working.
  expect(text).toContain('date,time,type,amount,currency,account,category,transfer_from,transfer_to,merchant,note,id,status,source,refund_of')
  expect(text).toContain('income,80000.00,INR,Savings,Salary')
  expect(text).toContain('expense,1500.00,INR,Wallet,Food & dining,,,,Dinner')
  expect(text).not.toContain('transfer,5000.00')
})

test('recurring items wait for a decision and never post twice', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
  const start = new Date(`${today}T00:00:00Z`)
  start.setUTCMonth(start.getUTCMonth() - 1)

  await page.goto('/recurring/new')
  await page.getByLabel('Name').fill('Netflix')
  await page.getByLabel('Amount').fill('649')
  await page.getByLabel('First due date').fill(start.toISOString().slice(0, 10))
  await page.getByRole('button', { name: 'Add recurring item' }).click()
  await expect(page).toHaveURL(/\/recurring$/)
  await page.reload()

  const dueNow = page.getByRole('region', { name: 'Due now' })
  await expect(dueNow.getByRole('article', { name: /Netflix/ })).toHaveCount(2)
  // Nothing recorded until confirmed
  await page.goto('/activity?period=all&q=Netflix')
  await expect(page.getByText('No transactions match')).toBeVisible()

  await page.goto('/recurring')
  await dueNow.getByRole('article', { name: /Netflix/ }).first().getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText(/Recorded Netflix/)).toBeVisible()
  await dueNow.getByRole('article', { name: /Netflix/ }).first().getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByText(/Skipped Netflix/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Due now' })).toHaveCount(0)

  await page.goto('/activity?period=all&q=Netflix')
  await expect(page.getByRole('link', { name: /Netflix, spent ₹649/ })).toHaveCount(1)
})
