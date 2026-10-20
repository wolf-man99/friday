// Supabase Edge Function: a signed-in Friday user's Gmail connection
// (start, complete, disconnect, test-fetch). See supabase/functions/_shared/connection.ts.
// Deploy with --no-verify-jwt: it verifies the caller's Supabase session itself.

import { connectionServer } from '../_shared/server.ts'

Deno.serve(connectionServer())
