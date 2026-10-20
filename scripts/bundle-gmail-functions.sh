#!/usr/bin/env bash
# Builds one self-contained file per Gmail Edge Function, for deploying through
# the Supabase dashboard's editor (Edge Functions → Deploy a new function → Via
# Editor), which takes a single file. Same code as supabase/functions/*, with
# the _shared modules inlined; supabase-js stays an npm: import.
#
#   DENO_BIN=deno scripts/bundle-gmail-functions.sh [out-dir]   (default: dist-functions/)
#
# Deploying with the Supabase CLI (scripts/deploy-gmail-functions.sh) needs none of this.
set -euo pipefail
cd "$(dirname "$0")/.."

DENO="${DENO_BIN:-deno}"
OUT="${1:-dist-functions}"
mkdir -p "$OUT"
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

for fn in gmail-connection gmail-oauth-callback; do
  tmp=$(mktemp)
  "$DENO" bundle --quiet --config supabase/functions/tests/deno.json --platform deno --external 'npm:*' \
    -o "$tmp" "supabase/functions/$fn/index.ts"
  {
    echo "// GENERATED from supabase/functions/$fn (commit $commit) by scripts/bundle-gmail-functions.sh."
    echo "// Paste into the Supabase dashboard editor as the function's index.ts. Don't edit here:"
    echo "// change the source and regenerate. Turn OFF \"Verify JWT\" for this function."
    echo
    cat "$tmp"
  } > "$OUT/$fn.ts"
  rm -f "$tmp"
  echo "$OUT/$fn.ts"
done
