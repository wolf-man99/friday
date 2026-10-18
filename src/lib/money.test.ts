import { describe, expect, it } from 'vitest'
import {
  formatAmountInput,
  formatMoney,
  formatMoneyCompact,
  minorToDecimalString,
  parseAmountToMinor,
  percentOf,
} from './money'

describe('parseAmountToMinor', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['1250', 125000],
    ['1,250.5', 125050],
    ['1,25,050.75', 12505075],
    ['₹ 80,000', 8000000],
    ['.5', 50],
    ['12.', 1200],
    ['0.01', 1],
    ['0.10', 10],
  ])('parses %s → %i paise', (input, expected) => {
    expect(parseAmountToMinor(input)).toBe(expected)
  })

  it.each(['', '.', 'abc', '1.234', '-5', '1.2.3', '1e5'])('rejects %j', (input) => {
    expect(parseAmountToMinor(input)).toBeNull()
  })

  it('never introduces float error', () => {
    // 0.1 + 0.2 style inputs stay exact.
    expect(parseAmountToMinor('0.29')).toBe(29)
    expect(parseAmountToMinor('1.15')).toBe(115)
    expect(parseAmountToMinor('4.35')).toBe(435)
  })
})

describe('formatMoney', () => {
  it('uses Indian digit grouping', () => {
    expect(formatMoney(12345678)).toBe('₹1,23,456.78')
    expect(formatMoney(1000000000)).toBe('₹1,00,00,000')
  })

  it('shows paise only when present unless asked', () => {
    expect(formatMoney(125000)).toBe('₹1,250')
    expect(formatMoney(125050)).toBe('₹1,250.50')
    expect(formatMoney(125000, { alwaysFraction: true })).toBe('₹1,250.00')
  })

  it('handles signs explicitly', () => {
    expect(formatMoney(-50000)).toBe('−₹500')
    expect(formatMoney(50000, { sign: 'always' })).toBe('+₹500')
    expect(formatMoney(-50000, { sign: 'never' })).toBe('₹500')
    expect(formatMoney(0, { sign: 'always' })).toBe('₹0')
  })

  it('refuses non-integer minor units', () => {
    expect(() => formatMoney(10.5)).toThrow(TypeError)
  })
})

describe('formatMoneyCompact', () => {
  it.each([
    [95000, '₹950'],
    [1250000, '₹12.5k'],
    [34000000, '₹3.4L'],
    [1200000000, '₹1.2Cr'],
    [-200000, '−₹2k'],
  ])('%i → %s', (minor, expected) => {
    expect(formatMoneyCompact(minor)).toBe(expected)
  })
})

describe('minorToDecimalString', () => {
  it('round-trips with the parser', () => {
    for (const minor of [0, 1, 10, 99, 100, 125050, 999999999]) {
      expect(parseAmountToMinor(minorToDecimalString(minor))).toBe(minor)
    }
  })
  it('keeps the sign', () => {
    expect(minorToDecimalString(-1505)).toBe('-15.05')
  })
})

describe('formatAmountInput', () => {
  it.each([
    ['', ''],
    ['1', '1'],
    ['1234', '1,234'],
    ['123456', '1,23,456'],
    ['1234.', '1,234.'],
    ['1234.5', '1,234.5'],
    ['1234.567', '1,234.56'],
    ['.5', '0.5'],
    ['007', '7'],
    ['1,2a3', '123'],
    ['1.2.3', '1.23'],
  ])('%j → %j', (raw, expected) => {
    expect(formatAmountInput(raw)).toBe(expected)
  })
})

describe('percentOf', () => {
  it('is safe with a zero total', () => {
    expect(percentOf(5, 0)).toBe(0)
    expect(percentOf(1, 3)).toBe(33)
  })
})
