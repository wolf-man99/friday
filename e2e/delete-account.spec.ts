import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

// Deleting an account for good, through the real app and database.

const user = { email: 'delete-account@example.com', password: 'correct-horse-battery' }
const psql = (sql: string) => execFileSync('psql', ['-q', '-t', '-A', '-d', 'friday_e2e', '-c', sql], { encoding: 'utf8' }).trim()

test('an account can be deleted for good, after a clear warning', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('radio', { name: 'Create account' }).click()
  await page.getByLabel('Your name').fill('Dev')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByLabel('Name').fill('Old savings')
  await page.getByLabel('Starting balance').fill('10000')
  await page.getByRole('button', { name: 'Start tracking' }).click()
  await expect(page).toHaveURL(/\/$/)
  const uid = psql(`select id from auth.users where email = '${user.email}'`)
  const account = psql(`select id from public.accounts where user_id = '${uid}'`)
  psql(`insert into public.accounts (user_id, name, type) values ('${uid}', 'Wallet', 'wallet')`)

  await page.goto(`/accounts/${account}`)
  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete this account?' })
  await expect(dialog.getByText(/can’t be undone/)).toBeVisible()
  await page.screenshot({ path: 'test-results/delete-account.png' })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(psql(`select count(*) from public.accounts where id = '${account}'`)).toBe('1')

  await page.getByRole('button', { name: 'Delete account' }).click()
  await dialog.getByRole('button', { name: 'Delete for good' }).click()
  await expect(page.getByText('Old savings deleted')).toBeVisible()
  await expect(page).toHaveURL(/\/accounts$/)
  expect(psql(`select count(*) from public.accounts where id = '${account}'`)).toBe('0')
  await expect(page.getByText('Wallet').first()).toBeVisible()

  // The last account: Friday asks for a new one, as on first sign-in.
  const wallet = psql(`select id from public.accounts where user_id = '${uid}'`)
  await page.goto(`/accounts/${wallet}`)
  await page.getByRole('button', { name: 'Delete account' }).click()
  await dialog.getByRole('button', { name: 'Delete for good' }).click()
  await expect(page).toHaveURL(/\/onboarding/)
})
