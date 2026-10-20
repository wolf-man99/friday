// Supabase Edge Function: Google's OAuth redirect target. See
// supabase/functions/_shared/callback.ts. Deploy with --no-verify-jwt: Google's
// redirect carries no Supabase session; the one-time state proves who started it.

import { callbackServer } from '../_shared/server.ts'

Deno.serve(callbackServer())
