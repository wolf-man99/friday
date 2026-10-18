import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useSettings } from '@/app/settings'
import { CategoryBadge } from '@/components/finance/CategoryTile'
import { CATEGORY_ICON_KEYS, CategoryGlyph } from '@/components/finance/icons'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { Dialog } from '@/components/ui/Dialog'
import { TextField } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { PillSwitch } from '@/components/ui/PillSwitch'
import { InlineError } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { TONE_BG, TONE_LABEL, TONES, toneOf, type AccentTone } from '@/components/ui/tones'
import type { CategoryRow, TransactionType } from '@/data/database.types'
import { useSaveCategory } from '@/data/hooks'
import { friendlyError } from '@/lib/errors'

export function Categories() {
  const { categories } = useSettings()
  const [type, setType] = useState<TransactionType>('expense')
  const [editing, setEditing] = useState<CategoryRow | 'new' | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const ofType = categories.filter((c) => c.transaction_type === type)
  const active = ofType.filter((c) => !c.is_archived)
  const archived = ofType.filter((c) => c.is_archived)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Categories"
        back="/profile"
        actions={
          <Button size="sm" variant="primary" icon={<Plus className="size-4" strokeWidth={3} />} onClick={() => setEditing('new')}>
            Add<span className="sr-only"> category</span>
          </Button>
        }
      />
      <PillSwitch
        label="Category type"
        options={[
          { value: 'expense', label: 'Spending' },
          { value: 'income', label: 'Income' },
        ]}
        value={type}
        onChange={setType}
      />
      <Card padded={false} className="p-1.5">
        <ul>
          {active.map((category) => (
            <CategoryItem key={category.id} category={category} onEdit={() => setEditing(category)} />
          ))}
        </ul>
        {active.length === 0 && <p className="p-4 text-muted">No active categories. Add one!</p>}
      </Card>

      {archived.length > 0 && (
        <section className="flex flex-col gap-3">
          <Button variant="ghost" aria-expanded={showArchived} onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </Button>
          {showArchived && (
            <Card padded={false} className="p-1.5 opacity-80">
              <ul>
                {archived.map((category) => (
                  <CategoryItem key={category.id} category={category} onEdit={() => setEditing(category)} />
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}

      <p className="text-sm text-muted">
        Archived categories stay on past entries and in reports; they just stop appearing when you add something new.
      </p>

      <CategoryDialog
        open={editing !== null}
        category={editing === 'new' ? undefined : (editing ?? undefined)}
        type={type}
        onClose={() => setEditing(null)}
      />
    </div>
  )
}

function CategoryItem({ category, onEdit }: { category: CategoryRow; onEdit: () => void }) {
  return (
    <li className="flex min-h-14 items-center gap-3 px-2 py-1.5">
      <CategoryBadge icon={category.icon} color={category.color} />
      <span className="min-w-0 flex-1 truncate font-semibold">{category.name}</span>
      {category.is_default && <span className="label-mono text-muted">Default</span>}
      <IconButton label={`Edit ${category.name}`} icon={<Pencil className="size-4" strokeWidth={2.5} />} onClick={onEdit} />
    </li>
  )
}

function CategoryDialog({
  open,
  category,
  type,
  onClose,
}: {
  open: boolean
  category?: CategoryRow
  type: TransactionType
  onClose: () => void
}) {
  const save = useSaveCategory()
  const toast = useToast()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState('tag')
  const [color, setColor] = useState<AccentTone>('orange')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(category?.name ?? '')
    setIcon(category?.icon ?? 'tag')
    setColor(toneOf(category?.color ?? 'orange'))
    setError(null)
  }, [open, category])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Give the category a name')
      return
    }
    try {
      await save.mutateAsync({
        id: category?.id,
        values: category
          ? { name: name.trim(), icon, color }
          : { name: name.trim(), icon, color, transaction_type: type, sort_order: 500 },
      })
      toast({ message: category ? 'Category saved' : 'Category added' })
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  async function toggleArchive() {
    if (!category) return
    try {
      await save.mutateAsync({ id: category.id, values: { is_archived: !category.is_archived } })
      toast({ message: category.is_archived ? 'Category restored' : 'Category archived' })
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title={category ? 'Edit category' : `New ${type === 'expense' ? 'spending' : 'income'} category`}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <CategoryBadge icon={icon} color={color} size="lg" />
          <TextField
            className="flex-1"
            label="Name"
            value={name}
            maxLength={40}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            autoComplete="off"
          />
        </div>

        <fieldset>
          <legend className="label-mono mb-2">Icon</legend>
          <div className="grid max-h-48 grid-cols-6 gap-2 overflow-y-auto p-1">
            {CATEGORY_ICON_KEYS.map((key) => (
              <label key={key}>
                <input type="radio" name="category-icon" value={key} checked={icon === key} onChange={() => setIcon(key)} className="peer sr-only" />
                <span
                  className={cn(
                    'grid size-11 cursor-pointer place-items-center rounded-[0.8rem] peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink',
                    icon === key ? 'bg-ink text-paper outline-regular' : 'bg-canvas outline-regular',
                  )}
                >
                  <CategoryGlyph icon={key} />
                </span>
                <span className="sr-only">{key.replace(/-/g, ' ')}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="label-mono mb-2">Colour</legend>
          <div className="flex flex-wrap gap-2.5">
            {TONES.map((tone) => (
              <label key={tone}>
                <input type="radio" name="category-colour" value={tone} checked={color === tone} onChange={() => setColor(tone)} className="peer sr-only" />
                <span
                  className={cn(
                    'grid size-11 cursor-pointer place-items-center rounded-full outline-regular peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink',
                    TONE_BG[tone],
                    color === tone && 'outline-strong shadow-brutal-sm',
                  )}
                >
                  {color === tone && <span aria-hidden="true" className="size-3 rounded-full bg-ink" />}
                </span>
                <span className="sr-only">{TONE_LABEL[tone]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {error && <InlineError message={error} />}

        <div className="flex gap-3">
          {category && (
            <Button
              block
              icon={category.is_archived ? <ArchiveRestore className="size-4" strokeWidth={2.5} /> : <Archive className="size-4" strokeWidth={2.5} />}
              onClick={() => void toggleArchive()}
              disabled={save.isPending}
            >
              {category.is_archived ? 'Restore' : 'Archive'}
            </Button>
          )}
          <Button type="submit" variant="primary" block loading={save.isPending}>
            {category ? 'Save' : 'Add category'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
