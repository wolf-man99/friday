import { describe, expect, it } from 'vitest'
import { activityHref, activitySearch, readActivityParams } from './activityParams'

const TODAY = '2026-10-19'
const read = (query: string) => readActivityParams(new URLSearchParams(query), TODAY)

describe('readActivityParams', () => {
  it('defaults to this month with no filters', () => {
    expect(read('')).toEqual({
      period: 'month',
      range: { from: '2026-10-01', to: '2026-10-31' },
      kind: null,
      status: null,
      account: null,
      category: null,
      q: '',
    })
  })

  it('reads the refund kind and every status filter', () => {
    expect(read('kind=refund').kind).toBe('refund')
    expect(read('kind=expense').kind).toBe('expense')
    expect(read('kind=income').kind).toBe('income')
    expect(read('kind=transfer').kind).toBe('transfer')
    expect(read('status=attention').status).toBe('attention')
    expect(read('status=pending').status).toBe('pending')
    expect(read('status=needs_review').status).toBe('needs_review')
    expect(read('status=voided').status).toBe('voided')
  })

  it('ignores junk values', () => {
    const filters = read('kind=reversal&status=posted&period=fortnight&account=a),or(x.eq.1&category=x,y')
    expect(filters.kind).toBeNull()
    expect(filters.status).toBeNull()
    expect(filters.period).toBe('month')
    expect(filters.account).toBeNull()
    expect(filters.category).toBeNull()
    expect(read('kind=EXPENSE&status=whatever').kind).toBeNull()
    expect(read('status=whatever').status).toBeNull()
  })

  it('ignores a junk period instead of keeping it next to a valid range', () => {
    expect(read('from=2026-09-01&to=2026-09-30&period=bogus')).toMatchObject({
      period: 'month',
      range: { from: '2026-09-01', to: '2026-09-30' },
    })
    expect(read('from=2026-09-03&to=2026-09-09&period=bogus').period).toBe('custom')
  })

  it('keeps ids and the uncategorised marker', () => {
    const filters = read('account=0b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e&category=none&q=chai')
    expect(filters.account).toBe('0b6c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e')
    expect(filters.category).toBe('none')
    expect(filters.q).toBe('chai')
  })

  it('drops a category from a transfer filter', () => {
    expect(read('kind=transfer&category=none').category).toBeNull()
  })

  it('reads all time without a range', () => {
    expect(read('period=all&from=2026-09-01&to=2026-09-30')).toMatchObject({ period: 'all', range: null })
  })
})

describe('activitySearch / activityHref', () => {
  const range = { from: '2026-10-01', to: '2026-10-31' }

  it('writes kind=refund and status=attention and reads them back', () => {
    const params = activitySearch({ range, kind: 'refund', status: 'attention' })
    expect(params.get('kind')).toBe('refund')
    expect(params.get('status')).toBe('attention')
    expect(readActivityParams(params, TODAY)).toMatchObject({ kind: 'refund', status: 'attention', range })
  })

  it('lists reversals under Refunds', () => {
    expect(activitySearch({ range, kind: 'reversal' }).get('kind')).toBe('refund')
  })

  it('keeps the existing callers working', () => {
    expect(activityHref({ range, kind: 'expense' })).toBe('/activity?from=2026-10-01&to=2026-10-31&kind=expense')
    expect(activityHref({ range, kind: 'expense', category: 'none' })).toBe(
      '/activity?from=2026-10-01&to=2026-10-31&kind=expense&category=none',
    )
    expect(activityHref({ period: 'all', account: 'acc-1' })).toBe('/activity?period=all&account=acc-1')
    expect(activityHref({ range: { from: '2026-10-12', to: '2026-10-18' }, period: 'week' })).toBe(
      '/activity?from=2026-10-12&to=2026-10-18&period=week',
    )
  })

  it('round-trips every filter', () => {
    const filters = read('from=2026-09-01&to=2026-09-30&kind=income&status=voided&account=acc-1&category=cat-1&q=rent')
    expect(readActivityParams(activitySearch(filters), TODAY)).toEqual(filters)
  })
})
