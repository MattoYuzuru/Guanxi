import { useEffect, useId, useRef, useState } from 'react'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from '@guanxi/ui'
import { getActiveLocale, translate as t } from '../../lib/locale.ts'

export interface ShellCommand {
  id: string
  label: string
  keywords?: string
  disabled?: boolean
  reason?: string
  execute(): void
}
export interface ShellSessionSearch {
  loaded: number
  loading: boolean
  hasMore: boolean
  searching: boolean
  error: boolean
  refreshFailed?: boolean
  omitted: boolean
  search(): void
  cancel(): void
}

/** The host supplies admitted commands; this search UI grants no capabilities. */
export function ShellPalette({ open, onOpenChange, commands, sessionSearch }: {
  open: boolean; onOpenChange(open: boolean): void; commands: readonly ShellCommand[]; sessionSearch?: ShellSessionSearch
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(''), [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => { if (!open) { setQuery(''); setActiveId(null) } }, [open])
  const needle = query.trim().toLocaleLowerCase(getActiveLocale())
  const filtered = commands.filter(command => `${command.label} ${command.keywords ?? ''}`.toLocaleLowerCase(getActiveLocale()).includes(needle))
  const available = filtered.filter(command => !command.disabled)
  const current = available.find(command => command.id === activeId) ?? available[0]
  const optionId = (command: ShellCommand) => `${id}-option-${encodeURIComponent(command.id)}`
  function changeOpen(next: boolean) {
    if (!next) { setQuery(''); setActiveId(null) }
    onOpenChange(next)
  }
  function execute(command: ShellCommand) {
    if (command.disabled) return
    changeOpen(false)
    // Let the palette restore focus before navigation or a workspace dialog takes it.
    requestAnimationFrame(command.execute)
  }
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogContent initialFocus={input} className="max-h-full overflow-y-auto">
      <DialogTitle>{t('shell.palette')}</DialogTitle>
      <DialogDescription>{t('shell.palette.description')}</DialogDescription>
      <Input ref={input} aria-label={t('shell.palette.search')} role="combobox" aria-autocomplete="list"
        aria-expanded={open} aria-controls={`${id}-results`} aria-activedescendant={open && current ? optionId(current) : undefined}
        value={query} onChange={event => { setQuery(event.target.value); setActiveId(null) }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && current) { event.preventDefault(); execute(current); return }
          const index = available.findIndex(command => command.id === current?.id)
          const next = event.key === 'ArrowDown' ? (index + 1) % available.length
            : event.key === 'ArrowUp' ? (index - 1 + available.length) % available.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : -1
          if (next >= 0 && available[next]) {
            event.preventDefault(); setActiveId(available[next].id)
            document.getElementById(optionId(available[next]))?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
          }
        }} />
      {sessionSearch && <div className="flex flex-col gap-1">
        <p role="status" aria-live="polite" className="text-12 text-secondary">{t(sessionSearch.loading ? 'shell.search.loading'
          : sessionSearch.searching ? 'shell.search.searching' : sessionSearch.refreshFailed ? 'shell.search.refreshFailed' : sessionSearch.error ? 'shell.search.error'
            : sessionSearch.hasMore ? 'shell.search.partial' : 'shell.search.available', { count: sessionSearch.loaded })}</p>
        {sessionSearch.omitted && <p className="text-12 text-secondary">{t('shell.sessions.omitted')}</p>}
        {sessionSearch.searching
          ? <Button variant="ghost" onClick={() => { sessionSearch.cancel(); input.current?.focus() }}>{t('shell.search.cancel')}</Button>
          : (sessionSearch.hasMore || sessionSearch.error) && <Button variant="ghost" disabled={sessionSearch.loading}
            onClick={() => { sessionSearch.search(); input.current?.focus() }}>{t('shell.search.all')}</Button>}
      </div>}
      <p className="sr-only" role="status" aria-live="polite">{t('shell.palette.results', { count: filtered.length })}</p>
      <div id={`${id}-results`} role="listbox" aria-label={t('shell.palette')} className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {filtered.map(command => <div key={command.id} className="flex flex-col gap-1">
          <Button id={optionId(command)} role="option" tabIndex={-1} aria-selected={command.id === current?.id}
            aria-describedby={command.reason ? `${optionId(command)}-reason` : undefined}
            variant={command.id === current?.id ? 'primary' : 'ghost'} disabled={command.disabled}
            onClick={() => execute(command)}>{command.label}</Button>
          {command.reason && <p id={`${optionId(command)}-reason`} className="text-12 text-secondary">{command.reason}</p>}
        </div>)}
      </div>
      {!filtered.length && <p>{t('shell.palette.empty')}</p>}
    </DialogContent>
  </Dialog>
}
