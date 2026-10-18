import { Check } from 'lucide-react'
import { cn } from '@/components/ui/cn'
import { TONE_BG, toneOf } from '@/components/ui/tones'
import { CategoryGlyph } from './icons'

interface CategoryTileProps {
  name: string
  icon: string
  color: string
  selected: boolean
  onSelect: () => void
}

/** Chunky selectable category tile. Selected = thicker outline, shadow and a check badge. */
export function CategoryTile({ name, icon, color, selected, onSelect }: CategoryTileProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'pressable relative flex min-h-[5.25rem] flex-col items-center justify-center gap-1.5 rounded-[1.25rem] px-1.5 py-2 text-center',
        TONE_BG[toneOf(color)],
        selected ? 'outline-strong shadow-brutal' : 'border-2 border-ink',
      )}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-ink text-paper outline-regular"
        >
          <Check className="size-3.5" strokeWidth={3.5} />
        </span>
      )}
      <span className="grid size-9 place-items-center rounded-full bg-paper/70 outline-regular">
        <CategoryGlyph icon={icon} className="size-[1.15rem]" />
      </span>
      <span
        className={cn(
          'line-clamp-2 w-full break-words leading-tight',
          // Long single words (user-named categories) shrink rather than spill.
          Math.max(...name.split(/\s+/).map((word) => word.length)) > 10 ? 'text-[0.66rem]' : 'text-[0.75rem]',
          selected ? 'font-extrabold' : 'font-semibold',
        )}
      >
        {name}
      </span>
    </button>
  )
}

/** Small round category badge used in lists. */
export function CategoryBadge({ icon, color, size = 'md' }: { icon: string; color: string; size?: 'sm' | 'md' | 'lg' }) {
  const dims = { sm: 'size-8 rounded-[0.7rem]', md: 'size-11 rounded-[0.9rem]', lg: 'size-14 rounded-[1.1rem]' }[size]
  const glyph = { sm: 'size-4', md: 'size-5', lg: 'size-6' }[size]
  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center outline-regular', dims, TONE_BG[toneOf(color)])}>
      <CategoryGlyph icon={icon} className={glyph} />
    </span>
  )
}
