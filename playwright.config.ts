import { createHmac } from 'node:crypto'
import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run the real app against a real (local) PostgreSQL with
// Friday's migrations, served by PostgREST behind a tiny fake auth gateway.
// Requirements: a local PostgreSQL superuser (PG* env vars) and a PostgREST
// binary (POSTGREST_BIN). See README → "Testing".

const POSTGREST_BIN = process.env.POSTGREST_BIN ?? 'postgrest'
const PG_URL = `postgres://${process.env.PGUSER ?? 'postgres'}:${process.env.PGPASSWORD ?? 'postgres'}@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}`
const JWT_SECRET = 'local-dev-jwt-secret-at-least-32-characters-long'

// The Gmail connection tests also run the real Edge Function code under Deno
// (DENO_BIN), against a local fake Google. Without Deno they're skipped.
const DENO_BIN = process.env.DENO_BIN
function serviceRoleJwt() {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'friday-e2e', iat: 1_700_000_000, exp: 4_100_000_000 })}`
  return `${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`
}
type Server = { command: string; env: Record<string, string>; url: string; reuseExistingServer: boolean }
const gmailServers: Server[] = DENO_BIN
  ? [
      {
        command: 'node e2e/fake-google.mjs',
        env: { PORT: '54400', CLIENT_ID: 'local-client-id', CLIENT_SECRET: 'local-client-secret' },
        url: 'http://localhost:54400/health',
        reuseExistingServer: false,
      },
      {
        command: `${DENO_BIN} run --allow-net --allow-env --config supabase/functions/tests/deno.json supabase/functions/_dev/serve.ts`,
        env: {
          ...(process.env.DENO_CERT ? { DENO_CERT: process.env.DENO_CERT } : {}),
          FUNCTIONS_PORT: '54401',
          SUPABASE_URL: 'http://localhost:54329',
          SUPABASE_SERVICE_ROLE_KEY: serviceRoleJwt(),
          GOOGLE_OAUTH_CLIENT_ID: 'local-client-id',
          GOOGLE_OAUTH_CLIENT_SECRET: 'local-client-secret',
          GMAIL_OAUTH_REDIRECT_URI: 'http://localhost:54329/functions/v1/gmail-oauth-callback',
          // A fixed key for throwaway local data only.
          GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
          FRIDAY_APP_URL: 'http://localhost:5174',
          FRIDAY_GOOGLE_TEST_ORIGIN: 'http://localhost:54400',
        },
        url: 'http://localhost:54401/health',
        reuseExistingServer: false,
      },
    ]
  : []

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5174',
    ...devices['iPhone 13'],
    browserName: 'chromium',
    timezoneId: 'Asia/Kolkata',
    trace: 'retain-on-failure',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
  },
  webServer: [
    {
      command: POSTGREST_BIN,
      env: {
        PGRST_DB_URI: `postgres://authenticator:authenticator@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/friday_e2e`,
        PGRST_DB_SCHEMAS: 'public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_JWT_SECRET: JWT_SECRET,
        PGRST_SERVER_PORT: '3100',
      },
      url: 'http://localhost:3100/',
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/fake-supabase.mjs',
      env: {
        PORT: '54329',
        POSTGREST_URL: 'http://localhost:3100',
        JWT_SECRET,
        DATABASE_URL: `${PG_URL}/friday_e2e`,
        FUNCTIONS_URL: DENO_BIN ? 'http://localhost:54401' : '',
      },
      url: 'http://localhost:54329/health',
      reuseExistingServer: false,
    },
    {
      command: 'npx vite --port 5174 --strictPort',
      env: { VITE_SUPABASE_URL: 'http://localhost:54329', VITE_SUPABASE_PUBLISHABLE_KEY: 'local-test-key' },
      url: 'http://localhost:5174',
      reuseExistingServer: false,
    },
    ...gmailServers,
  ],
})
