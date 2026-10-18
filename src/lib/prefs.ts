// Small per-device conveniences (never financial data). Storage can be
// unavailable (private mode), so every access is guarded.

const PREFIX = 'friday:'

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(PREFIX + key, value)
  } catch {
    // Ignore — preferences are a nicety.
  }
}

/** Last account used for a kind of entry, so quick-add can preselect it (FR-03). */
export const lastAccountKey = (kind: string) => `last-account:${kind}`
export const lastDestinationKey = 'last-account:transfer-to'
