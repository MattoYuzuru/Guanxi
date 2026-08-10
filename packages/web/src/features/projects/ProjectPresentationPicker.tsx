import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  PROJECT_COLOR_PALETTE,
  PROJECT_ICON_CATEGORIES,
  PROJECT_ICON_MANIFEST,
  type ProjectColorToken,
  type ProjectIconCategory,
  type ProjectIconKey,
} from '@alamo/contract'
import { Button, Input } from '../../components/ui.tsx'
import { errorMessage } from '../../lib/api.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { ProjectIcon, projectColorStyle } from './ProjectIcon.tsx'

const PAGE_SIZE = 12
const GRID_COLUMNS = 4

type PickerProps = {
  projectName: string
  initialIconKey: ProjectIconKey
  initialColorToken: ProjectColorToken
  onClose: () => void
  onSave: (iconKey: ProjectIconKey, colorToken: ProjectColorToken) => Promise<void>
}

function message(key: string): string {
  return translate(key as LocaleKey)
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (value, [key, replacement]) => value.replace(`{${key}}`, String(replacement)),
    template,
  )
}

export function ProjectPresentationPicker({
  projectName,
  initialIconKey,
  initialColorToken,
  onClose,
  onSave,
}: PickerProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ProjectIconCategory | 'all'>('all')
  const [page, setPage] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [iconKey, setIconKey] = useState(initialIconKey)
  const [colorToken, setColorToken] = useState(initialColorToken)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savingRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return PROJECT_ICON_MANIFEST.filter((icon) => {
      if (category !== 'all' && icon.category !== category) return false
      if (!normalized) return true
      const name = message(icon.nameKey).toLocaleLowerCase()
      const categoryName = message(`projects.icon.category.${icon.category}`).toLocaleLowerCase()
      return [icon.key, icon.sourceIcon, name, categoryName].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      )
    })
  }, [category, query])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageIcons = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    setPage(0)
    setActiveIndex(0)
  }, [category, query])

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage)
    setActiveIndex((index) => Math.min(index, Math.max(0, pageIcons.length - 1)))
  }, [currentPage, page, pageIcons.length])

  const focusCell = (index: number) => {
    const bounded = Math.max(0, Math.min(index, pageIcons.length - 1))
    setActiveIndex(bounded)
    requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLButtonElement>(`[data-project-icon-index="${bounded}"]`)
        ?.focus()
    })
  }

  const changePage = (nextPage: number) => {
    const bounded = Math.max(0, Math.min(nextPage, pageCount - 1))
    setPage(bounded)
    setActiveIndex(0)
    requestAnimationFrame(() => focusCell(0))
  }

  const onGridKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null
    switch (event.key) {
      case 'ArrowRight': next = index + 1; break
      case 'ArrowLeft': next = index - 1; break
      case 'ArrowDown': next = index + GRID_COLUMNS; break
      case 'ArrowUp': next = index - GRID_COLUMNS; break
      case 'Home': next = 0; break
      case 'End': next = pageIcons.length - 1; break
      case 'PageDown':
        if (currentPage < pageCount - 1) {
          event.preventDefault()
          changePage(currentPage + 1)
        }
        return
      case 'PageUp':
        if (currentPage > 0) {
          event.preventDefault()
          changePage(currentPage - 1)
        }
        return
      default: return
    }
    event.preventDefault()
    focusCell(next)
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!savingRef.current) onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      ) ?? [],
    )
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave(iconKey, colorToken)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const selectedName = message(
    PROJECT_ICON_MANIFEST.find((icon) => icon.key === iconKey)!.nameKey,
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-presentation-title"
        aria-describedby="project-presentation-description"
        onKeyDown={handleDialogKeyDown}
        className="surface max-h-[calc(100dvh-1.5rem)] w-full max-w-xl min-w-0 overflow-y-auto rounded-lg p-4 shadow-xl"
      >
        <form onSubmit={save}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="project-presentation-title" className="break-words text-base font-semibold">
                {fill(translate('projects.presentation.dialog'), { name: projectName })}
              </h2>
              <p id="project-presentation-description" className="mt-1 text-xs text-[var(--fg-muted)]">
                {translate('projects.presentation.description')}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              aria-label={translate('projects.presentation.close')}
              disabled={saving}
              onClick={onClose}
            >
              ×
            </Button>
          </div>

          <label className="mt-4 block text-xs font-medium">
            {translate('projects.icon.search.label')}
            <Input
              ref={searchRef}
              value={query}
              autoComplete="off"
              placeholder={translate('projects.icon.search.placeholder')}
              onChange={(event) => setQuery(event.target.value)}
              className="mt-1 w-full"
            />
          </label>

          <div className="mt-3" role="group" aria-label={translate('projects.icon.categories')}>
            <div className="flex flex-wrap gap-1.5">
              {(['all', ...PROJECT_ICON_CATEGORIES] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={category === value ? 'primary' : 'secondary'}
                  aria-pressed={category === value}
                  onClick={() => setCategory(value)}
                >
                  {message(`projects.icon.category.${value}`)}
                </Button>
              ))}
            </div>
          </div>

          {pageIcons.length === 0 ? (
            <p className="mt-4 rounded-md border border-dashed p-4 text-center text-xs text-[var(--fg-muted)]">
              {translate('projects.icon.empty')}
            </p>
          ) : (
            <div
              role="grid"
              aria-label={translate('projects.icon.grid')}
              aria-rowcount={Math.ceil(pageIcons.length / GRID_COLUMNS)}
              aria-colcount={GRID_COLUMNS}
              className="mt-4 grid grid-cols-4 gap-2"
            >
              {Array.from(
                { length: Math.ceil(pageIcons.length / GRID_COLUMNS) },
                (_, rowIndex) => (
                  <div key={rowIndex} role="row" className="contents">
                    {pageIcons
                      .slice(rowIndex * GRID_COLUMNS, (rowIndex + 1) * GRID_COLUMNS)
                      .map((icon, columnIndex) => {
                        const index = rowIndex * GRID_COLUMNS + columnIndex
                        const name = message(icon.nameKey)
                        const selected = icon.key === iconKey
                        return (
                          <button
                            key={icon.key}
                            type="button"
                            role="gridcell"
                            data-project-icon-index={index}
                            aria-rowindex={rowIndex + 1}
                            aria-colindex={columnIndex + 1}
                            aria-label={name}
                            aria-selected={selected}
                            tabIndex={index === activeIndex ? 0 : -1}
                            onFocus={() => setActiveIndex(index)}
                            onKeyDown={(event) => onGridKeyDown(event, index)}
                            onClick={() => setIconKey(icon.key)}
                            className="project-icon-cell flex min-w-0 flex-col items-center gap-1 rounded-md border p-2 text-2xs"
                          >
                            <ProjectIcon iconKey={icon.key} size={22} />
                            <span className="w-full truncate text-center">{name}</span>
                          </button>
                        )
                      })}
                  </div>
                ),
              )}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <Button
              type="button"
              size="sm"
              aria-label={translate('projects.icon.previous')}
              disabled={currentPage === 0}
              onClick={() => changePage(currentPage - 1)}
            >
              ←
            </Button>
            <span className="text-2xs text-[var(--fg-muted)]" aria-live="polite">
              {fill(translate('projects.icon.page'), { page: currentPage + 1, pages: pageCount })}
            </span>
            <Button
              type="button"
              size="sm"
              aria-label={translate('projects.icon.next')}
              disabled={currentPage >= pageCount - 1}
              onClick={() => changePage(currentPage + 1)}
            >
              →
            </Button>
          </div>

          <div className="mt-4" role="radiogroup" aria-label={translate('projects.color.group')}>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {PROJECT_COLOR_PALETTE.map((color) => {
                const selected = color.token === colorToken
                return (
                  <button
                    key={color.token}
                    type="button"
                    role="radio"
                    aria-label={message(color.nameKey)}
                    aria-checked={selected}
                    onClick={() => setColorToken(color.token)}
                    style={projectColorStyle(color.token)}
                    className="project-color-chip flex min-h-10 items-center justify-center rounded-md border-2 p-1 text-2xs font-semibold"
                  >
                    {selected ? '✓' : ''}
                  </button>
                )
              })}
            </div>
          </div>

          <p className="mt-3 text-2xs text-[var(--fg-muted)]" aria-live="polite">
            {fill(translate('projects.presentation.selected'), { name: selectedName })}
          </p>
          {error && (
            <div className="mt-3" role="alert">
              <p className="font-medium text-[var(--danger)]">{translate('projects.presentation.error')}</p>
              <p className="break-words text-2xs text-[var(--fg-muted)]">{error}</p>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" disabled={saving} onClick={onClose}>
              {translate('projects.presentation.close')}
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              {saving
                ? translate('projects.presentation.saving')
                : translate('projects.presentation.save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
