import { describe, expect, it } from 'vitest'
import { escapeCsvField, toCsv } from './csv'

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(escapeCsvField('Dosa, coffee')).toBe('"Dosa, coffee"')
    expect(escapeCsvField('6" sub')).toBe('"6"" sub"')
    expect(escapeCsvField('line\nbreak')).toBe('"line\nbreak"')
    expect(escapeCsvField(null)).toBe('')
  })

  it('neutralises formula injection but keeps signed numbers', () => {
    expect(escapeCsvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(escapeCsvField('-1250.50')).toBe('-1250.50')
    expect(escapeCsvField(-5)).toBe('-5')
  })

  it('writes a BOM and CRLF rows', () => {
    expect(toCsv(['a', 'b'], [[1, '₹']])).toBe('﻿a,b\r\n1,₹\r\n')
  })
})
