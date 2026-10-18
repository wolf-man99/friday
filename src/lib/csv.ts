// RFC 4180 CSV with a UTF-8 BOM so spreadsheet apps read ₹ and names correctly.

export type CsvValue = string | number | boolean | null | undefined

export function escapeCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  // Neutralise spreadsheet formula injection from user-entered text
  // (plain signed numbers such as "-12.50" are left alone).
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?$/.test(text)) {
    text = `'${text}`
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvField).join(','))
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

export function downloadFile(filename: string, contents: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([contents], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
