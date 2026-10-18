import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/data/database.types'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
// Only the publishable (anon) key may ship to the browser. RLS protects data.
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as
  | string
  | undefined

export const isSupabaseConfigured = Boolean(url && key)

export const supabase: SupabaseClient<Database> = createClient<Database>(
  url ?? 'http://localhost:54321',
  key ?? 'missing-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'friday-auth',
    },
  },
)
