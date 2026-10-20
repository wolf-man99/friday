import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

// Importing past months from Gmail, through the real app, the real Edge
// Function code (under Deno), the real database and a fake Gmail holding
// typical alert emails across this month and the two before it
// (e2e/fake-google.mjs): connect → choose months → confirm accounts →
// recorded / review / skipped → balances kept → undo.

test.describe.configure({ mode: 'serial' })
test.skip(!process.env.DENO_BIN, 'Set DENO_BIN to run the Gmail functions locally')

const meera = { email: 'gmail-import@example.com', password: 'correct-horse-battery' }

function psql(sql: string) {
  return execFileSync('psql', ['-q', '-t', '-A', '-d', 'friday_e2e', '-c', sql], { encoding: 'utf8' }).trim()
}
const uid = () => psql(`select id from auth.users where email = '${meera.email}'`)

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(meera.email)
  await page.getByLabel('Password', { exact: true }).fill(meera.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

test('connecting Gmail offers to import the last three months', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('radio', { name: 'Create account' }).click()
  await page.getByLabel('Your name').fill('Meera')
  await page.getByLabel('Email').fill(meera.email)
  await page.getByLabel('Password', { exact: true }).fill(meera.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByLabel('Name').fill('Savings')
  await page.getByLabel('Starting balance').fill('10000')
  await page.getByRole('button', { name: 'Start tracking' }).click()
  await expect(page).toHaveURL(/\/$/)

  await page.goto('/connections/gmail')
  await page.getByRole('button', { name: 'Connect Gmail' }).click()
  await page.getByLabel('Account').fill('meera@gmail.com')
  await page.getByRole('button', { name: 'Allow' }).click()
  await expect(page.getByText('Gmail connected · meera@gmail.com')).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Track your past transactions?' })).toBeVisible()
  const chips = page.getByRole('button', { pressed: true })
  await expect(chips).toHaveCount(3)
  await expect(page.getByRole('button', { name: /\(to today\)/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/gmail-import-months.png', fullPage: true })
})

test('Friday finds the accounts in the emails and asks about each', async ({ page }) => {
  await signIn(page)
  await page.goto('/connections/gmail')
  await page.getByRole('button', { name: 'Find transactions in all 3 months' }).click()

  await expect(page.getByText(/Found \d+ transaction emails/)).toBeVisible({ timeout: 30_000 })
  const hdfc = page.getByLabel('Use HDFC Bank account ••1234 as')
  const icici = page.getByLabel('Use ICICI Bank credit card ••9001 as')
  const paytm = page.getByLabel('Use Paytm wallet as')
  const yes = page.getByLabel('Use Yes Bank account ••5678 as')
  for (const field of [hdfc, icici, paytm, yes]) await expect(field).toBeVisible()
  await expect(icici).toHaveValue('create')
  // Nothing has been recorded yet.
  expect(psql(`select count(*) from public.transactions where user_id = '${uid()}' and created_via = 'import'`)).toBe('0')

  await hdfc.selectOption({ label: 'Savings · Bank account' })
  await expect(page.getByText('Earlier transactions will count in your spending; Savings’s balance stays exactly as it is.')).toBeVisible()
  await yes.selectOption('ignore')
  await page.getByLabel('Name').first().fill('ICICI Amazon card')
  await page.screenshot({ path: 'test-results/gmail-import-accounts.png', fullPage: true })

  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth')
  expect(overflow).toBeLessThanOrEqual(0)
})

test('importing records what\'s clear, sends the rest to review, keeps balances', async ({ page }) => {
  await signIn(page)
  await page.goto('/connections/gmail')
  // Choices aren't saved until confirmed: a reload starts from the suggestions again.
  await page.getByLabel('Use HDFC Bank account ••1234 as').selectOption({ label: 'Savings · Bank account' })
  await page.getByLabel('Use Yes Bank account ••5678 as').selectOption('ignore')
  await page.getByRole('button', { name: 'Import transactions' }).click()

  const summary = page.getByText(/^Imported /)
  await expect(summary).toBeVisible({ timeout: 30_000 })
  const id = uid()
  const counts = psql(`select row(recorded, review, skipped, ignored)::text from public.gmail_import_jobs where user_id = '${id}'`)
  // Recorded: two HDFC debits, the salary, two card spends, the wallet payment.
  // Review: the card bill paid from HDFC (a transfer). Skipped: the OTP, a
  // friend's email, a look-alike sender. Ignored: Yes Bank.
  expect(counts).toBe('(6,1,3,1)')
  await expect(page.getByText('Waiting in Review').locator('xpath=following-sibling::dd[1]')).toHaveText('1')
  await page.screenshot({ path: 'test-results/gmail-import-done.png', fullPage: true })

  // Savings: its balance is exactly what was typed in at sign-up.
  expect(psql(`select balance_minor from public.account_balances where user_id = '${id}' and name = 'Savings'`)).toBe('1000000')
  expect(psql(`select row(type, balance_minor)::text from public.account_balances where user_id = '${id}' and institution_name = 'ICICI Bank'`)).toBe(
    '(credit_card,-249800)',
  )
  expect(psql(`select count(*) from public.transactions t join public.categories c on c.id = t.category_id
               where t.user_id = '${id}' and t.created_via = 'import' and c.name = 'Salary'`)).toBe('1')
  // Only facts were kept: no email text anywhere.
  expect(psql(`select count(*) from public.source_events e where e.user_id = '${id}' and row(e.*)::text like '%SENTINEL%'`)).toBe('0')
  expect(psql(`select count(*) from public.transactions t where t.user_id = '${id}' and row(t.*)::text like '%SENTINEL%'`)).toBe('0')

  await page.getByRole('link', { name: /Open Review/ }).click()
  await expect(page).toHaveURL(/\/review/)
  await expect(page.getByText(/15,000/).first()).toBeVisible()
})

test('undo removes what the import recorded and nothing else', async ({ page }) => {
  await signIn(page)
  await page.goto('/connections/gmail')
  await page.getByRole('button', { name: 'Undo this import' }).click()
  await page.getByRole('dialog', { name: 'Undo this import?' }).getByRole('button', { name: 'Undo import' }).click()
  await expect(page.getByText(/Import undone · removed 6/)).toBeVisible()
  const id = uid()
  expect(psql(`select count(*) from public.transactions where user_id = '${id}' and deleted_at is null and created_via = 'import'`)).toBe('0')
  expect(psql(`select count(*) from public.source_events where user_id = '${id}' and processing_status = 'needs_review'`)).toBe('0')
  expect(psql(`select balance_minor from public.account_balances where user_id = '${id}' and name = 'Savings'`)).toBe('1000000')
  await expect(page.getByText(/import was undone/)).toBeVisible()
})
