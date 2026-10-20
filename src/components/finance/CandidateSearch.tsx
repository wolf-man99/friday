import { Search } from 'lucide-react'
import { useDeferredValue, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { OFFSET_CANDIDATES_PAGE } from '@/data/api'

/**
 * Search and "show older" for long lists of purchases to link a refund to:
 * the newest page first, then older ones on request, or a merchant/note search.
 */
export function useCandidateBrowse() {
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(OFFSET_CANDIDATES_PAGE)
  const deferredSearch = useDeferredValue(search.trim())
  return {
    search,
    setSearch: (value: string) => {
      setSearch(value)
      setLimit(OFFSET_CANDIDATES_PAGE)
    },
    query: { search: deferredSearch || undefined, limit },
    /** True when a full page came back, so older entries may exist. */
    hasMore: (rows: number) => rows >= limit,
    more: () => setLimit((value) => value + OFFSET_CANDIDATES_PAGE),
  }
}

export function CandidateSearchField({ value, onChange, label = 'Search purchases' }: { value: string; onChange: (value: string) => void; label?: string }) {
  return (
    <TextField
      label={label}
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Merchant or note"
      prefix={<Search aria-hidden="true" className="size-4" strokeWidth={2.5} />}
      autoComplete="off"
    />
  )
}

export function ShowOlderButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" onClick={onClick}>
      Show older
    </Button>
  )
}
