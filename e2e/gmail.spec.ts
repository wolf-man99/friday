import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

// The Gmail connection through the real app, the real Edge Function code
// (run locally under Deno), the real database, and a local fake Google:
// declining, connecting read-only (nothing recorded; past months offered), an
// approval started from another Friday account, and disconnecting.

test.describe.configure({ mode: 'serial' })
test.skip(!process.env.DENO_BIN, 'Set DENO_BIN to run the Gmail functions locally')

const password = 'correct-horse-battery'
const asha = { email: 'gmail-asha@example.com', name: 'Asha' }
const bea = { email: 'gmail-bea@example.com', name: 'Bea' }
const GOOGLE = 'http://localhost:54400'
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly'

function psql(sql: string) {
  return execFileSync('psql', ['-q', '-t', '-A', '-d', 'friday_e2e', '-c', sql], { encoding: 'utf8' }).trim()
}

/** 'August 2026': this month (back = 0) or one before it, as the app names it. */
function monthName(back: number, withYear = true) {
  const date = new Date()
  date.setDate(1)
  date.setMonth(date.getMonth() - back)
  return date.toLocaleString('en-GB', withYear ? { month: 'long', year: 'numeric' } : { month: 'long' })
}

const userId = (email: string) => psql(`select id from auth.users where email = '${email}'`)

async function issuedByGoogle() {
  return (await (await fetch(`${GOOGLE}/__inspect?email=asha@gmail.com`)).json()) as { refreshTokens: string[]; revoked: string[] }
}

async function signUp(page: Page, user: { email: string; name: string }) {
  await page.goto('/login')
  await page.getByRole('radio', { name: 'Create account' }).click()
  await page.getByLabel('Your name').fill(user.name)
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/onboarding/)
  await page.getByLabel('Name').fill('Savings')
  await page.getByLabel('Starting balance').fill('10000')
  await page.getByRole('button', { name: 'Start tracking' }).click()
  await expect(page).toHaveURL(/\/$/)
}

async function signIn(page: Page, user: { email: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Back to wherever sign-out happened.
  await expect(page).not.toHaveURL(/\/login/)
}

async function signOut(page: Page) {
  await page.goto('/profile')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
}

/** From Friday's Gmail page to Google's consent screen. */
async function toGoogle(page: Page) {
  await page.goto('/connections/gmail')
  await page.getByRole('button', { name: /^(Connect|Reconnect) Gmail$/ }).click()
  await expect(page).toHaveURL(new RegExp(`^${GOOGLE}/o/oauth2/v2/auth`))
}

test('set up two Friday users', async ({ page }) => {
  await signUp(page, bea)
  await signOut(page)
  await signUp(page, asha)
})

test('saying no on Google’s screen connects nothing', async ({ page }) => {
  await signIn(page, asha)
  await page.goto('/profile')
  await page.getByRole('link', { name: /Gmail/ }).click()
  await expect(page.getByRole('heading', { name: 'Not connected' })).toBeVisible()
  await toGoogle(page)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page).toHaveURL('http://localhost:5174/connections/gmail')
  await expect(page.getByRole('alert')).toContainText('You didn’t allow access on Google’s screen')
  await expect(page.getByRole('heading', { name: 'Not connected' })).toBeVisible()
  expect(psql(`select count(*) from public.source_connections where user_id = '${userId(asha.email)}'`)).toBe('0')
})

test('connect Gmail read-only, offer past months, record nothing', async ({ page }) => {
  await signIn(page, asha)
  await toGoogle(page)
  const auth = new URL(page.url()).searchParams
  expect(auth.get('scope')).toBe(READONLY)
  expect(auth.get('response_type')).toBe('code')
  expect(auth.get('access_type')).toBe('offline')
  expect(auth.get('code_challenge_method')).toBe('S256')
  expect(auth.has('client_secret')).toBe(false)

  await page.getByLabel('Account').fill('asha@gmail.com')
  await page.getByRole('button', { name: 'Allow' }).click()
  // Back in Friday, with the one-time ticket already used and gone from the address bar.
  await expect(page.getByText('Gmail connected · asha@gmail.com')).toBeVisible()
  await expect(page).toHaveURL('http://localhost:5174/connections/gmail')
  await expect(page.getByRole('heading', { name: 'asha@gmail.com' })).toBeVisible()
  await expect(page.getByText('Connected · read-only')).toBeVisible()

  // Stored only encrypted, only server-side; the browser never held it.
  const uid = userId(asha.email)
  expect(psql(`select row(status, provider, account_email, scopes)::text from public.source_connections where user_id = '${uid}'`)).toBe(
    `(active,gmail,asha@gmail.com,{${READONLY}})`,
  )
  const sealed = psql(`select refresh_token_enc from friday_private.gmail_credentials where user_id = '${uid}'`)
  expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const { refreshTokens } = await issuedByGoogle()
  const browserStorage = await page.evaluate<string>('JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie')
  for (const token of refreshTokens) {
    expect(sealed).not.toContain(token)
    expect(browserStorage).not.toContain(token)
    expect(psql(`select count(*) from public.source_connections where position('${token}' in row(source_connections.*)::text) > 0`)).toBe('0')
  }

  // Next: importing past months (e2e/gmail-import.spec.ts). Nothing is recorded by connecting.
  await expect(page.getByRole('heading', { name: 'Track your past transactions?' })).toBeVisible()
  expect(psql(`select count(*) from public.transactions where user_id = '${uid}'`)).toBe('0')
  expect(psql(`select count(*) from public.source_events where user_id = '${uid}'`)).toBe('0')

  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth')
  expect(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: 'test-results/gmail-connected.png', fullPage: true })
})

test('an approval started from another Friday account is refused, and Asha stays connected', async ({ page }) => {
  // Bea starts connecting and sends the Google link to Asha.
  await signIn(page, bea)
  await toGoogle(page)
  const lure = page.url()
  await signOut(page)

  const ashaSealed = psql(`select refresh_token_enc from friday_private.gmail_credentials where user_id = '${userId(asha.email)}'`)
  const before = (await issuedByGoogle()).refreshTokens.length

  // Asha, signed in to her own Friday, approves it with her Gmail.
  await signIn(page, asha)
  await page.goto(lure)
  await page.getByLabel('Account').fill('asha@gmail.com')
  await page.getByRole('button', { name: 'Allow' }).click()
  await expect(page).toHaveURL('http://localhost:5174/connections/gmail')
  await expect(page.getByRole('alert')).toContainText('started from a different Friday account')

  // Nobody gained anything: Bea isn't connected, the parked grant is gone, and
  // Asha's connection is unchanged and still works — the refused token was
  // dropped, not revoked, because revoking would end Asha's access too.
  expect(psql(`select count(*) from public.source_connections where user_id = '${userId(bea.email)}'`)).toBe('0')
  expect(psql(`select count(*) from friday_private.gmail_pending_grants`)).toBe('0')
  expect(psql(`select refresh_token_enc from friday_private.gmail_credentials where user_id = '${userId(asha.email)}'`)).toBe(ashaSealed)
  const google = await issuedByGoogle()
  expect(google.refreshTokens.length).toBe(before + 1)
  expect(google.revoked).toEqual([])
  await expect(page.getByRole('heading', { name: 'asha@gmail.com' })).toBeVisible()
  // Gmail still answers for Asha: find this month's alerts, then cancel.
  await page.getByRole('button', { name: monthName(1) }).click()
  await page.getByRole('button', { name: monthName(2) }).click()
  await page.getByRole('button', { name: `Find transactions in ${monthName(0, false)}` }).click()
  await expect(page.getByText(new RegExp(`Found \\d+ transaction emails? in ${monthName(0, false)}`))).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Cancel import' }).click()
  await expect(page.getByText('The last import was cancelled. Nothing was recorded.')).toBeVisible()
  expect(psql(`select count(*) from public.transactions where user_id = '${userId(asha.email)}'`)).toBe('0')
})

test('disconnecting deletes the stored access and revokes it with Google', async ({ page }) => {
  await signIn(page, asha)
  await page.goto('/connections/gmail')
  await page.getByRole('button', { name: 'Disconnect Gmail' }).click()
  const dialog = page.getByRole('dialog', { name: 'Disconnect Gmail?' })
  await dialog.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByText('Gmail disconnected. Friday’s access was removed.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Not connected' })).toBeVisible()

  const uid = userId(asha.email)
  expect(psql(`select count(*) from friday_private.gmail_credentials where user_id = '${uid}'`)).toBe('0')
  expect(psql(`select count(*) from friday_private.gmail_oauth_states where user_id = '${uid}'`)).toBe('0')
  expect(psql(`select status from public.source_connections where user_id = '${uid}'`)).toBe('disconnected')
  const google = await issuedByGoogle()
  // Google ends the whole grant for asha@gmail.com: every token ever issued for it.
  expect(google.refreshTokens.filter((t) => !google.revoked.includes(t))).toEqual([])

  await page.goto('/profile')
  await expect(page.getByRole('link', { name: /Gmail.*Not connected/ })).toBeVisible()
})
