// The Quick Add draft: what the user has typed, kept on this device until it
// is confirmed saved or deliberately discarded, so a crash, a failed save or a
// quick trip to another screen never loses it. Drafts never leave the device.

import type { CaptureKind } from '@/data/database.types'
import type { EntryDraft } from '@/lib/entry'

export type CategorySource = 'suggested' | 'user' | null

export interface CaptureDraft extends EntryDraft {
  merchant: string
  /** How the category got there: a suggestion the user hasn't confirmed, or their own pick. */
  categorySource: CategorySource
  /** Identifies this capture to the server, so retries can never save it twice. */
  idempotencyKey: string
  /** ms since epoch of the last change. */
  updatedAt: number
}

const VERSION = 1
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const storageKey = (userId: string) => `friday:quick-add-draft:${userId}`

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // RFC 4122 v4 from getRandomValues for older browsers.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Anything the user would be sorry to lose. */
export function isDirty(draft: Pick<CaptureDraft, 'amountText' | 'note' | 'merchant'>) {
  return draft.amountText.trim() !== '' || draft.note.trim() !== '' || draft.merchant.trim() !== ''
}

/**
 * Switching Expense / Income / Transfer keeps the amount, date, note and
 * merchant, but never carries a category across: an expense category can't
 * describe income, and transfers have none.
 */
export function switchKind(draft: CaptureDraft, kind: CaptureKind, destinationAccountId: string | null): CaptureDraft {
  if (kind === draft.kind) return draft
  return {
    ...draft,
    kind,
    categoryId: null,
    categorySource: null,
    destinationAccountId: kind === 'transfer' ? destinationAccountId : null,
    updatedAt: Date.now(),
  }
}

export function loadDraft(userId: string, now = Date.now()): CaptureDraft | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: number; draft?: CaptureDraft }
    const draft = parsed.draft
    if (parsed.version !== VERSION || !draft || typeof draft.amountText !== 'string' || typeof draft.idempotencyKey !== 'string') {
      return null
    }
    if (now - draft.updatedAt > MAX_AGE_MS || !isDirty(draft)) {
      clearDraft(userId)
      return null
    }
    return draft
  } catch {
    return null
  }
}

export function saveDraft(userId: string, draft: CaptureDraft) {
  try {
    if (isDirty(draft)) window.localStorage.setItem(storageKey(userId), JSON.stringify({ version: VERSION, draft }))
    else window.localStorage.removeItem(storageKey(userId))
  } catch {
    // Storage full or blocked: the in-memory draft still works.
  }
}

export function clearDraft(userId: string) {
  try {
    window.localStorage.removeItem(storageKey(userId))
  } catch {
    // ignore
  }
}
