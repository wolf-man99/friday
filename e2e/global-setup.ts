import { execFileSync } from 'node:child_process'

/** Fresh database with migrations applied before every run. */
export default function globalSetup() {
  execFileSync('scripts/setup-local-db.sh', ['friday_e2e'], { stdio: 'inherit' })
}
