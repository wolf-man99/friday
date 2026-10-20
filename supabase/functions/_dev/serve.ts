// Local stand-in for Supabase's Edge Runtime, for end-to-end tests: serves the
// real Gmail function handlers on one port, routed by function name the way
// Supabase routes /functions/v1/<name>. Never deployed (folders starting with
// "_" aren't functions). Configure with the same secrets as production.
//
//   FUNCTIONS_PORT=54401 deno run --allow-net --allow-env supabase/functions/_dev/serve.ts

import { callbackServer, connectionServer } from '../_shared/server.ts'

const handlers: Record<string, (req: Request) => Promise<Response>> = {
  'gmail-connection': connectionServer(),
  'gmail-oauth-callback': callbackServer(),
}

Deno.serve({ port: Number(Deno.env.get('FUNCTIONS_PORT') ?? 54401) }, (req) => {
  const name = new URL(req.url).pathname.replace(/^\/(functions\/v1\/)?/, '').split('/')[0]
  if (name === 'health') return new Response('ok')
  const handler = handlers[name]
  return handler ? handler(req) : Response.json({ code: 'NOT_FOUND', message: 'Requested function was not found' }, { status: 404 })
})
