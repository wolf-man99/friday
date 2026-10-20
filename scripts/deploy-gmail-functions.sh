#!/usr/bin/env bash
# Deploys the Gmail Edge Functions to a Supabase project, after checking the
# prerequisites. It never prints secret values.
#
#   SUPABASE_PROJECT_REF=<ref> scripts/deploy-gmail-functions.sh
#
# Needs: the Supabase CLI (npx supabase), a Supabase access token
# (npx supabase login, or SUPABASE_ACCESS_TOKEN), migration
# 20261021000000_gmail_connection.sql applied, and the function secrets set
# (see supabase/functions/.env.example and docs/gmail-connection.md).
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${SUPABASE_PROJECT_REF:-}"
if [[ -z "$REF" ]]; then
  echo "Set SUPABASE_PROJECT_REF (Project Settings → General → Project ID)." >&2
  exit 1
fi
SUPABASE="${SUPABASE_BIN:-npx --yes supabase}"

echo "Checking Supabase CLI access to $REF…"
if ! secrets=$($SUPABASE secrets list --project-ref "$REF" 2>/dev/null); then
  echo "Can't reach the project with the Supabase CLI. Run 'npx supabase login' (or set SUPABASE_ACCESS_TOKEN) and check the project ref." >&2
  exit 1
fi

missing=()
for name in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GMAIL_OAUTH_REDIRECT_URI GMAIL_TOKEN_ENCRYPTION_KEY FRIDAY_APP_URL; do
  grep -q "\b$name\b" <<<"$secrets" || missing+=("$name")
done
if (( ${#missing[@]} > 0 )); then
  echo "Missing function secrets: ${missing[*]}" >&2
  echo "Set them with: npx supabase secrets set --env-file supabase/functions/.env --project-ref $REF" >&2
  exit 1
fi

# Both verify the caller themselves: gmail-connection checks the Supabase
# session; Google's redirect to gmail-oauth-callback carries no session at all.
for fn in gmail-connection gmail-oauth-callback; do
  echo "Deploying $fn…"
  $SUPABASE functions deploy "$fn" --project-ref "$REF" --no-verify-jwt
done

echo "Deployed. Check: Supabase dashboard → Edge Functions → gmail-connection / gmail-oauth-callback."
