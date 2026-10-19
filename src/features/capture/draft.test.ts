import { beforeEach, describe, expect, it } from 'vitest'
import { clearDraft, isDirty, loadDraft, newIdempotencyKey, saveDraft, switchKind, type CaptureDraft } from './draft'

const draft = (patch: Partial<CaptureDraft> = {}): CaptureDraft => ({
  kind: 'expense',
  amountText: '250',
  accountId: 'bank',
  destinationAccountId: null,
  categoryId: 'food',
  categorySource: 'user',
  date: '2026-10-19',
  note: 'Lunch',
  merchant: 'Cafe',
  idempotencyKey: 'key-1',
  updatedAt: Date.now(),
  ...patch,
})

beforeEach(() => localStorage.clear())

describe('switchKind', () => {
  it('keeps the amount and details but drops the category', () => {
    const next = switchKind(draft(), 'income', null)
    expect(next).toMatchObject({ kind: 'income', amountText: '250', note: 'Lunch', merchant: 'Cafe', categoryId: null, categorySource: null })
  })

  it('gives transfers a destination and never a category', () => {
    expect(switchKind(draft(), 'transfer', 'cash')).toMatchObject({ kind: 'transfer', destinationAccountId: 'cash', categoryId: null })
    expect(switchKind(draft({ kind: 'transfer', destinationAccountId: 'cash', categoryId: null }), 'expense', 'x').destinationAccountId).toBeNull()
  })

  it('keeps the same request key so a switch can never cause a duplicate', () => {
    expect(switchKind(draft(), 'income', null).idempotencyKey).toBe('key-1')
  })
})

describe('draft storage', () => {
  it('round-trips a dirty draft per user', () => {
    saveDraft('u1', draft())
    expect(loadDraft('u1')?.amountText).toBe('250')
    expect(loadDraft('u2')).toBeNull()
  })

  it('does not keep empty drafts', () => {
    saveDraft('u1', draft({ amountText: '', note: '', merchant: '' }))
    expect(loadDraft('u1')).toBeNull()
  })

  it('expires drafts after a week', () => {
    saveDraft('u1', draft({ updatedAt: Date.now() - 8 * 24 * 3600 * 1000 }))
    expect(loadDraft('u1')).toBeNull()
  })

  it('ignores corrupt storage', () => {
    localStorage.setItem('friday:quick-add-draft:u1', '{nope')
    expect(loadDraft('u1')).toBeNull()
    localStorage.setItem('friday:quick-add-draft:u1', JSON.stringify({ version: 99, draft: draft() }))
    expect(loadDraft('u1')).toBeNull()
  })

  it('clears', () => {
    saveDraft('u1', draft())
    clearDraft('u1')
    expect(loadDraft('u1')).toBeNull()
  })
})

describe('helpers', () => {
  it('knows when there is something to lose', () => {
    expect(isDirty({ amountText: '', note: '', merchant: '' })).toBe(false)
    expect(isDirty({ amountText: '', note: ' x', merchant: '' })).toBe(true)
  })

  it('makes v4 uuids', () => {
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
