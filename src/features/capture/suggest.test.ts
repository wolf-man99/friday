import { describe, expect, it } from 'vitest'
import { knownMerchants, recentShortcuts, suggestCategory, type HistoryItem } from './suggest'

const item = (categoryId: string | null, merchant: string | null = null, kind: HistoryItem['kind'] = 'expense', amountMinor = 25000): HistoryItem => ({
  kind,
  categoryId,
  merchant,
  accountId: 'wallet',
  amountMinor,
})
const usable = new Set(['food', 'groceries', 'transport', 'salary'])

describe('suggestCategory', () => {
  it('suggests nothing without enough history', () => {
    expect(suggestCategory([], { kind: 'expense', usableCategoryIds: usable })).toBeNull()
    expect(suggestCategory([item('food'), item('food')], { kind: 'expense', usableCategoryIds: usable })).toBeNull()
  })

  it('suggests nothing when history is split', () => {
    const history = [item('food'), item('groceries'), item('transport'), item('food'), item('groceries'), item('transport')]
    expect(suggestCategory(history, { kind: 'expense', usableCategoryIds: usable })).toBeNull()
  })

  it('suggests the clearly dominant recent category', () => {
    const history = [item('food'), item('food'), item('food'), item('transport'), item('food')]
    expect(suggestCategory(history, { kind: 'expense', usableCategoryIds: usable })).toEqual({ categoryId: 'food', reason: 'frequent', basis: 4 })
  })

  it('prefers what this merchant is usually filed under', () => {
    const history = [item('food', 'Swiggy'), item('food'), item('groceries', ' swiggy '), item('groceries', 'SWIGGY'), item('food'), item('food')]
    expect(suggestCategory(history, { kind: 'expense', merchant: 'Swiggy', usableCategoryIds: usable })).toEqual({
      categoryId: 'groceries',
      reason: 'merchant',
      basis: 2,
    })
  })

  it('learns from corrections because history holds the final choice', () => {
    const before = [item('food', 'Zepto'), item('food', 'Zepto')]
    expect(suggestCategory(before, { kind: 'expense', merchant: 'Zepto', usableCategoryIds: usable })?.categoryId).toBe('food')
    const corrected = [item('groceries', 'Zepto'), item('groceries', 'Zepto'), item('groceries', 'Zepto'), ...before]
    expect(suggestCategory(corrected, { kind: 'expense', merchant: 'Zepto', usableCategoryIds: usable })?.categoryId).toBe('groceries')
  })

  it('never suggests across types or archived categories', () => {
    const income = Array.from({ length: 6 }, () => item('salary', null, 'income'))
    expect(suggestCategory(income, { kind: 'expense', usableCategoryIds: usable })).toBeNull()
    const archived = Array.from({ length: 6 }, () => item('old'))
    expect(suggestCategory(archived, { kind: 'expense', usableCategoryIds: usable })).toBeNull()
  })
})

describe('shortcuts and merchants', () => {
  it('lists distinct recent entries', () => {
    const history = [item('food', 'Blue Tokai', 'expense', 25000), item('food', 'blue tokai', 'expense', 25000), item('transport', null, 'expense', 9000), item(null)]
    expect(recentShortcuts(history).map((s) => [s.merchant, s.amountMinor])).toEqual([
      ['Blue Tokai', 25000],
      [null, 9000],
    ])
  })

  it('dedupes merchant names case-insensitively, newest first', () => {
    expect(knownMerchants([item(null, 'Zepto'), item(null, ' zepto'), item(null, 'Uber'), item(null)])).toEqual(['Zepto', 'Uber'])
  })
})
