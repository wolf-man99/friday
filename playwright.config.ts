import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run the real app against a real (local) PostgreSQL with
// Friday's migrations, served by PostgREST behind a tiny fake auth gateway.
// Requirements: a local PostgreSQL superuser (PG* env vars) and a PostgREST
// binary (POSTGREST_BIN). See README → "Testing".

const POSTGREST_BIN = process.env.POSTGREST_BIN ?? 'postgrest'
const PG_URL = `postgres://${process.env.PGUSER ?? 'postgres'}:${process.env.PGPASSWORD ?? 'postgres'}@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}`
const JWT_SECRET = 'local-dev-jwt-secret-at-least-32-characters-long'

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
  ],
})
