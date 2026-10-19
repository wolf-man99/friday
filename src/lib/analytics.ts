// Privacy-first product analytics for the Quick Add funnel.
//
// Friday ships with no analytics vendor. Events go to in-app sinks only:
// nothing leaves the device unless a sink is registered (see README). Event
// properties are typed so amounts, notes, merchants, category or account
// names and ids cannot be passed, and sanitise() drops anything else that
// slips through.

import type { EntryKind } from '@/data/database.types'

export type ErrorClass = 'offline' | 'network' | 'validation' | 'conflict' | 'auth' | 'outdated_schema' | 'server' | 'unknown'
type Source = 'suggested' | 'user' | 'none'

export type AnalyticsEvent =
  | { name: 'quick_add_opened'; props: { context: string; draft_restored: boolean } }
  | { name: 'transaction_type_selected'; props: { type: EntryKind; previous: EntryKind } }
  | {
      name: 'transaction_save_attempted'
      props: { type: EntryKind; attempt: number; elapsed_ms: number; category_source: Source; account_source: string; has_note: boolean; has_merchant: boolean; mode: 'create' | 'edit' }
    }
  | { name: 'transaction_save_succeeded'; props: { type: EntryKind; attempt: number; elapsed_ms: number; replayed: boolean; mode: 'create' | 'edit' } }
  | { name: 'transaction_save_failed'; props: { type: EntryKind; attempt: number; elapsed_ms: number; error_class: ErrorClass; mode: 'create' | 'edit' } }
  | { name: 'suggestion_shown'; props: { type: EntryKind; reason: 'merchant' | 'frequent'; basis: number } }
  | { name: 'suggestion_changed'; props: { type: EntryKind; to: 'other_category' | 'none' | 'confirmed' } }
  | { name: 'transaction_undo_used'; props: { type: EntryKind; seconds_after_save: number } }
  | { name: 'draft_recovered'; props: { type: EntryKind; age_s: number } }

export type TrackedEvent = AnalyticsEvent & { at: string }
export type AnalyticsSink = (event: TrackedEvent) => void

const sinks = new Set<AnalyticsSink>()

/** Register a destination for events; returns an unsubscribe function. */
export function addAnalyticsSink(sink: AnalyticsSink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

const FORBIDDEN_KEY = /note|merchant|amount|account_id|category_id|name|email|receipt/i

/** Only short primitive values on allowed keys survive. */
export function sanitise(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const clean: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(props)) {
    if (FORBIDDEN_KEY.test(key) && !/^(has_note|has_merchant|account_source)$/.test(key)) continue
    if (typeof value === 'boolean') clean[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = Math.round(value)
    else if (typeof value === 'string' && value.length <= 40) clean[key] = value
  }
  return clean
}

export function track<E extends AnalyticsEvent>(name: E['name'], props: E['props']) {
  const event = { name, props: sanitise(props as Record<string, unknown>), at: new Date().toISOString() } as TrackedEvent
  for (const sink of sinks) {
    try {
      sink(event)
    } catch {
      // A broken sink must never break capture.
    }
  }
}

// Developers can watch events locally: localStorage['friday:debug-analytics'] = '1'.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  try {
    if (window.localStorage.getItem('friday:debug-analytics') === '1') {
      addAnalyticsSink((event) => console.debug('[analytics]', event.name, event.props))
    }
  } catch {
    // ignore
  }
}
