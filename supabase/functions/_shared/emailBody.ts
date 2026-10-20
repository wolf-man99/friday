// A Gmail message → what the alert reader needs: sender, subject, sender
// authentication results, Gmail's labels and the body as plain text. Attachments are never
// fetched; the text exists only in memory while the alert is read.

import { htmlToText, type RawEmail } from './alerts.ts'
import { fromBase64Url } from './crypto.ts'
import type { FullMessage, MessagePart } from './google.ts'

const decoder = new TextDecoder()

function decode(data: string | undefined): string {
  if (!data) return ''
  try {
    return decoder.decode(fromBase64Url(data))
  } catch {
    return ''
  }
}

function collect(part: MessagePart, found: { plain: string[]; html: string[] }) {
  const type = part.mimeType?.toLowerCase() ?? ''
  if (type === 'text/plain') found.plain.push(decode(part.body?.data))
  else if (type === 'text/html') found.html.push(decode(part.body?.data))
  for (const child of part.parts ?? []) collect(child, found)
}

function header(part: MessagePart, name: string): string[] {
  return (part.headers ?? []).filter((h) => h.name?.toLowerCase() === name.toLowerCase()).map((h) => h.value ?? '')
}

export function emailFromMessage(message: FullMessage): RawEmail {
  const found = { plain: [] as string[], html: [] as string[] }
  collect(message.payload, found)
  const plain = found.plain.join('\n').trim()
  const html = found.html.join('\n')
  // Some banks' plain-text part is a stub ("view this email in a browser").
  const text = plain.length >= 40 && /(rs\.?|inr|₹)\s*\d/i.test(plain) ? plain : html ? htmlToText(html) : plain
  return {
    id: message.id,
    internalDate: message.internalDate,
    from: header(message.payload, 'From')[0] ?? '',
    subject: header(message.payload, 'Subject')[0] ?? '',
    text,
    authResults: header(message.payload, 'Authentication-Results'),
    labels: message.labelIds ?? [],
  }
}
