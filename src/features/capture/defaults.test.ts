import { describe, expect, it } from 'vitest'
import { pickAccount } from './defaults'

const accounts = [
  { id: 'card', type: 'credit_card' as const },
  { id: 'bank', type: 'bank' as const },
  { id: 'cash', type: 'cash' as const },
]

describe('pickAccount', () => {
  it('honours the screen context, then the configured default, then recent', () => {
    expect(pickAccount(accounts, { contextId: 'cash', defaultId: 'bank', recentId: 'card' })).toEqual({ id: 'cash', source: 'context' })
    expect(pickAccount(accounts, { defaultId: 'bank', recentId: 'cash' })).toEqual({ id: 'bank', source: 'default' })
    expect(pickAccount(accounts, { recentId: 'card' })).toEqual({ id: 'card', source: 'recent' })
  })

  it('falls back to money you hold, not a card', () => {
    expect(pickAccount(accounts, {})).toEqual({ id: 'bank', source: 'fallback' })
    expect(pickAccount([accounts[0]], {})).toEqual({ id: 'card', source: 'fallback' })
  })

  it('ignores stale ids (archived or deleted accounts)', () => {
    expect(pickAccount(accounts, { defaultId: 'gone', recentId: 'also-gone' })).toEqual({ id: 'bank', source: 'fallback' })
  })

  it('never picks the excluded account (transfer destination)', () => {
    expect(pickAccount(accounts, { defaultId: 'bank', excludeId: 'bank' })).toEqual({ id: 'cash', source: 'fallback' })
  })

  it('reports when there is nothing to pick', () => {
    expect(pickAccount([], { defaultId: 'bank' })).toEqual({ id: null, source: null })
  })
})
