// A password-reset link signs the person in (that's how Supabase proves they
// own the email). That session is only good for choosing a new password: until
// they do, every screen sends them to /reset-password. The mark survives
// reloads and is cleared by saving a new password or signing out.

import { supabase } from '@/lib/supabase'

const KEY = 'friday:password-recovery'

export const RESET_PATH = '/reset-password'

/** Does this address come from a password-reset email? (#…type=recovery, before supabase-js clears it) */
export function isRecoveryLink(href: string): boolean {
  try {
    const url = new URL(href)
    const hash = new URLSearchParams(url.hash.slice(1))
    return hash.get('type') === 'recovery' || url.searchParams.get('type') === 'recovery'
  } catch {
    return false
  }
}

export function isRecoveryPending(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setRecoveryPending(pending: boolean) {
  try {
    if (pending) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // Without storage the gate lasts only until supabase-js reports the event again.
  }
}

/**
 * Runs once at startup, before supabase-js reads the link: subscribing here
 * (not in a React effect) means the PASSWORD_RECOVERY event can't be missed.
 */
export function watchPasswordRecovery() {
  if (typeof window !== 'undefined' && isRecoveryLink(window.location.href)) setRecoveryPending(true)
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') setRecoveryPending(true)
    if (event === 'SIGNED_OUT') setRecoveryPending(false)
  })
}
