// Surface tones available to cards, tiles and category colours. Every tone
// takes ink text at ≥ 6:1 contrast (see src/styles/index.css).

export const TONES = ['orange', 'pink', 'lime', 'purple', 'yellow', 'sky', 'mint', 'peach'] as const
export type AccentTone = (typeof TONES)[number]
export type SurfaceTone = AccentTone | 'paper' | 'canvas' | 'ink'

export const TONE_BG: Record<SurfaceTone, string> = {
  orange: 'bg-orange',
  pink: 'bg-pink',
  lime: 'bg-lime',
  purple: 'bg-purple',
  yellow: 'bg-yellow',
  sky: 'bg-sky',
  mint: 'bg-mint',
  peach: 'bg-peach',
  paper: 'bg-paper',
  canvas: 'bg-canvas',
  ink: 'bg-ink text-paper',
}

export const TONE_LABEL: Record<AccentTone, string> = {
  orange: 'Orange',
  pink: 'Pink',
  lime: 'Lime',
  purple: 'Purple',
  yellow: 'Yellow',
  sky: 'Sky',
  mint: 'Mint',
  peach: 'Peach',
}

export function toneOf(color: string | null | undefined): AccentTone {
  return (TONES as readonly string[]).includes(color ?? '') ? (color as AccentTone) : 'peach'
}
