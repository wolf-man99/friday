// Small, dependency-free crypto helpers for the Gmail functions. Everything is
// Web Crypto, so it runs the same in Supabase's Edge Runtime, Deno and tests.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** A URL-safe random token with `byteLength` bytes of entropy (32 bytes → 43 chars). */
export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

/** Tokens we hand out are exactly this shape; anything else is rejected before a lookup. */
export function isToken(value: unknown, byteLength = 32): value is string {
  const length = Math.ceil((byteLength * 4) / 3)
  return typeof value === 'string' && value.length === length && /^[A-Za-z0-9_-]+$/.test(value)
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** PKCE S256 challenge for a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
}

/**
 * Seals refresh tokens with AES-256-GCM. The key comes from a function secret
 * and never reaches the database; each ciphertext is bound to its owner via
 * additional authenticated data, so a row copied to another user won't
 * decrypt. Format: v1.<iv>.<ciphertext+tag>, base64url.
 */
export class TokenCipher {
  private constructor(private readonly key: CryptoKey) {}

  static async fromBase64Key(base64Key: string): Promise<TokenCipher> {
    let raw: Uint8Array<ArrayBuffer>
    try {
      raw = Uint8Array.from(atob(base64Key.trim()), (char) => char.charCodeAt(0))
    } catch {
      throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be base64')
    }
    if (raw.length !== 32) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must decode to 32 bytes')
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    return new TokenCipher(key)
  }

  async encrypt(plaintext: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      this.key,
      encoder.encode(plaintext),
    )
    return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`
  }

  async decrypt(sealed: string, context: string): Promise<string> {
    const [version, iv, body] = sealed.split('.')
    if (version !== 'v1' || !iv || !body) throw new Error('Unknown credential format')
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(context) },
      this.key,
      fromBase64Url(body),
    )
    return decoder.decode(plaintext)
  }
}

/** The additional data a user's Gmail refresh token is sealed with. */
export function refreshTokenContext(userId: string): string {
  return `friday:gmail-refresh:${userId}`
}
