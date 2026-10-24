import { providerCategoryOrder, type AccessMode, type Connection, type Project, type Workspace } from '@guanxi/contract'
import {
  Button, Icon, IconButton, Input, Menu, type IconName, MenuContent, MenuItem, MenuTrigger, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Textarea,
} from '@guanxi/ui'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { translate as t } from '../../lib/locale.ts'
import { useAsync } from '../../lib/useAsync.ts'
import { connectionApi, ConnectionRequestError } from '../connections/api.ts'
import { connectionCategory, connectionLabel } from '../connections/labels.ts'

/** One labelled control with its hint and error wired through `aria-describedby`. */
export function FormField({ label, hint, error, children }: {
  label: string; hint?: string; error?: string; children: (control: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
}) {
  const id = useId(), hintId = `${id}-hint`, errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  return <div className="flex min-w-0 flex-col gap-1">
    <label htmlFor={id} className="text-12 font-label text-secondary">{label}</label>
    {children({ id, describedBy, invalid: Boolean(error) })}
    {hint && <p id={hintId} className="m-0 text-12 text-muted">{hint}</p>}
    {error && <p id={errorId} className="m-0 text-12 text-danger">{error}</p>}
  </div>
}

/** A quiet chip-like trigger for composer and stage pickers: icon, short value, chevron. */
function PickerButton({ icon, children, ...props }: { icon: IconName; children?: ReactNode } & Record<string, unknown>) {
  return <Button variant="ghost" size="sm" {...props}>
    <Icon name={icon} />
    <span className="max-w-3xs truncate">{children}</span>
    <Icon name="chevron-down" size={12} />
  </Button>
}

/** "A new session opens in the current project" (D-207): the most recent project is preselected. */
export function ProjectPicker({ projects, recent, value, onChange }: {
  projects: Project[]; recent: string[]; value: string; onChange: (projectId: string) => void
}) {
  const current = projects.find(project => project.id === value)
  const ordered = [...recent.flatMap(id => projects.filter(project => project.id === id)), ...projects.filter(project => !recent.includes(project.id))]
  return <Menu>
    <MenuTrigger render={<PickerButton icon="folder" aria-label={current ? t('newSession.project.current', { name: current.name }) : t('newSession.project.choose')} />}>
      {current ? current.name : t('newSession.project.choose')}
    </MenuTrigger>
    <MenuContent align="center">
      {ordered.map(project => <MenuItem key={project.id} onClick={() => onChange(project.id)}>
        <Icon name={project.id === value ? 'check' : 'folder'} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <span className="gx-menu-item-end">{project.filesystemBindings.length
          ? t('newSession.project.foldersShort', { count: project.filesystemBindings.length }) : t('newSession.project.noFolderShort')}</span>
      </MenuItem>)}
    </MenuContent>
  </Menu>
}

/** The simplified permission mode at the composer's lower left (D-207). */
export function PermissionMenu({ mode, onChange }: { mode: AccessMode; onChange: (mode: AccessMode) => void }) {
  const label = t(`native.${mode}`)
  return <Menu>
    <MenuTrigger render={<PickerButton icon={mode === 'full-access' ? 'permission-full' : 'permission-read'} aria-label={t('newSession.permission.current', { mode: label })} />}>
      {label}
    </MenuTrigger>
    <MenuContent side="top" align="start">
      {(['read-only', 'full-access'] as const).map(option => <MenuItem key={option} onClick={() => onChange(option)}>
        <Icon name={option === 'full-access' ? 'permission-full' : 'permission-read'} />
        <span className="flex-1">{t(`native.${option}`)}</span>
        {option === mode ? <Icon name="check" /> : null}
      </MenuItem>)}
    </MenuContent>
  </Menu>
}

/**
 * Connection and model at the composer's lower right (D-207, D-218). Connections are grouped by
 * the catalog category; choosing one lists the models the node reports for it. Arrow keys move
 * through the model list, Enter chooses, Escape closes. A typed ID is a fallback, not the default.
 */
export function ModelPicker({ connections, connectionId, onConnection, model, onModel, onChoice,
  contextRequired, context, onContext, contextInvalid }: {
  connections: Connection[]
  connectionId: string
  onConnection: (id: string) => void
  model: string
  onModel: (model: string) => void
  /** Records an explicit choice for the next session; a typed fallback may call it on start. */
  onChoice?: (connectionId: string, model: string) => void
  contextRequired: boolean
  context: string
  onContext: (value: string) => void
  contextInvalid: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [custom, setCustom] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const active = connections.find(connection => connection.id === connectionId)
  const activeLabel = active ? connectionLabel(active) : ''
  // Keep the answer bound to the connection that asked: a switch must not show the previous
  // connection's IDs while the next read is still in flight.
  const models = useAsync(async signal => ({ connectionId,
    models: connectionId ? await connectionApi.models(connectionId, signal) : [] }), [connectionId])
  const groups = providerCategoryOrder.map(category => ({ category,
    connections: connections.filter(connection => connectionCategory(connection) === category) }))
    .filter(group => group.connections.length > 0)
  const query = search.trim().toLocaleLowerCase()
  const catalog = models.data?.connectionId === connectionId ? models.data.models : null
  const filtered = (catalog ?? []).filter(item => item.id.toLocaleLowerCase().includes(query))
  const errorCode = models.error instanceof ConnectionRequestError ? models.error.code : null

  useEffect(() => { setSearch(''); setCustom(false) }, [connectionId])
  useEffect(() => { if (open) searchRef.current?.focus() }, [open])

  const chooseConnection = (id: string) => {
    if (id !== connectionId) { onConnection(id); onModel('') }
  }
  const chooseModel = (value: string) => {
    onModel(value)
    onChoice?.(connectionId, value)
    if (!contextRequired) setOpen(false)
  }
  const typeModel = (value: string) => {
    onModel(value)
  }
  const triggerLabel = active && model.trim()
    ? t('newSession.model.currentChoice', { connection: activeLabel, model: model.trim() })
    : active ? t('newSession.model.currentConnection', { connection: activeLabel }) : t('newSession.model.choose')

  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    const available = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    if (available.length === 0) return
    const current = available.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      available[(current + step + available.length) % available.length]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      available[event.key === 'Home' ? 0 : available.length - 1]?.focus()
    } else if (event.key === 'Enter' && current >= 0) {
      event.preventDefault()
      const value = available[current]?.dataset.model
      if (value) chooseModel(value)
    }
  }

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<PickerButton icon="models" aria-label={triggerLabel} />}>
      <span className="new-session-choice-connection">{active ? activeLabel : t('newSession.model.choose')}</span>
      {active && model.trim() ? <span className="new-session-choice-model">{model.trim()}</span> : null}
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="new-session-model-popover w-md">
      <PopoverTitle>{t('newSession.model.label')}</PopoverTitle>
      <div className="flex flex-col gap-3 pt-1" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) }
      }}>
        <div role="group" aria-label={t('newSession.model.connection')} className="flex flex-col gap-2">
          <span className="text-12 font-label text-secondary">{t('newSession.model.connection')}</span>
          {groups.map(group => <div key={group.category} className="flex flex-col gap-1">
            <span className="text-12 text-muted">{t(`connections.category.${group.category}`)}</span>
            <div className="flex flex-wrap gap-1">
              {group.connections.map(connection => <Button key={connection.id} size="sm"
                variant={connection.id === connectionId ? 'primary' : 'secondary'}
                aria-pressed={connection.id === connectionId} onClick={() => chooseConnection(connection.id)}>
                {connectionLabel(connection)}
              </Button>)}
            </div>
          </div>)}
        </div>

        {active && <div className="flex min-w-0 flex-col gap-2" role="group" aria-label={t('newSession.model.installed')}>
          <FormField label={t('newSession.model.search')}>
            {({ id, describedBy }) => <Input ref={searchRef} id={id} aria-describedby={describedBy} type="search"
              autoComplete="off" value={search} onChange={event => setSearch(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  listRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus()
                } else if (event.key === 'Enter' && filtered[0]) { event.preventDefault(); chooseModel(filtered[0].id) }
              }} />}
          </FormField>
          {catalog === null && models.error === null && <p role="status" className="m-0 text-12 text-secondary">{t('newSession.model.loading')}</p>}
          {models.error !== null && <p role="alert" className="m-0 text-12 text-danger">
            {t('newSession.model.error')} {errorCode ? t(`connections.error.${errorCode}`) : ''}
          </p>}
          {catalog !== null && filtered.length === 0 && <p className="m-0 text-12 text-muted">
            {query ? t('newSession.model.noMatch') : t('newSession.model.empty')}
          </p>}
          {filtered.length > 0 && <ul ref={listRef} aria-label={t('newSession.model.installed')} role="listbox"
            onKeyDown={move} className="new-session-model-list m-0 flex max-h-64 flex-col gap-1 overflow-y-auto p-0">
            {filtered.map((item, index) => {
              const selected = item.id === model.trim()
              return <li key={item.id} role="none">
                <Button type="button" variant={selected ? 'secondary' : 'ghost'} size="sm" role="option"
                  aria-selected={selected} data-model={item.id}
                  tabIndex={selected || (!model.trim() && index === 0) ? 0 : -1}
                  className="w-full justify-start text-left" onClick={() => chooseModel(item.id)}>
                  <span className="min-w-0 flex-1 break-all font-mono">{item.id}</span>
                  {selected ? <Icon name="check" /> : null}
                </Button>
              </li>
            })}
          </ul>}
          {!custom && <Button variant="ghost" size="sm" className="w-fit" onClick={() => setCustom(true)}>
            {t('newSession.model.other')}
          </Button>}
          {custom && <FormField label={t('newSession.model.id')} hint={t('newSession.model.hint')}>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={model}
              autoComplete="off" spellCheck={false} className="font-mono"
              onChange={event => typeModel(event.target.value)} />}
          </FormField>}
        </div>}

        {contextRequired && <FormField label={t('newSession.context.label')} error={contextInvalid ? t('newSession.context.invalid') : undefined}>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="numeric" value={context} onChange={event => onContext(event.target.value)} />}
        </FormField>}
      </div>
    </PopoverContent>
  </Popover>
}

/** Folders, network hosts, attachments and protected paths: safe defaults, one click away. */
export function RunOptions({ project, workspaces, selectedRoots, onRoots, rootsDirty, rootsBusy, rootsFailure, onSaveRoots, unreachable,
  domains, onDomains, domainsInvalid, attachments, onAttachments, protectedPaths, onProtectedPaths }: {
  project: Project | undefined
  workspaces: Workspace[] | null
  selectedRoots: string[]
  onRoots: (roots: string[]) => void
  rootsDirty: boolean
  rootsBusy: boolean
  rootsFailure: string | null
  onSaveRoots: () => void
  unreachable: boolean
  domains: string; onDomains: (value: string) => void; domainsInvalid: boolean
  attachments: string; onAttachments: (value: string) => void
  protectedPaths: string; onProtectedPaths: (value: string) => void
}) {
  return <Popover>
    <PopoverTrigger render={<IconButton size="sm" label={t('newSession.options.button')} icon={<Icon name="more" />} />} />
    <PopoverContent side="top" align="start" className="w-md">
      <PopoverTitle>{t('newSession.options')}</PopoverTitle>
      <div className="new-session-options flex flex-col gap-3 pt-1">
        <p className="m-0 text-12 text-muted">{t('newSession.options.hint')}</p>
        {project && (workspaces === null
          ? <p role="status" className="m-0 text-12 text-secondary">{t('newSession.folders.unavailable')}</p>
          : <fieldset className="flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-12 font-label text-secondary">{t('native.folders')}</legend>
            {workspaces.length === 0 && <p className="m-0 text-12 text-muted">{t('newSession.folders.none')}</p>}
            <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
              {workspaces.map(workspace => {
                const included = selectedRoots.includes(workspace.id)
                return <li key={workspace.id} className="max-w-full"><Button size="sm" variant={included ? 'primary' : 'secondary'} aria-pressed={included}
                  className="h-auto! max-w-full whitespace-normal! break-all py-1 text-left"
                  onClick={() => onRoots(included ? selectedRoots.filter(rootId => rootId !== workspace.id) : [...selectedRoots, workspace.id])}>
                  {included ? <Icon name="check" /> : <Icon name="folder" />}{workspace.exists ? workspace.name : t('newSession.folders.missing', { name: workspace.name })}</Button></li>
              })}
            </ul>
            <p className="m-0 text-12 text-muted">{t('newSession.folders.hint')}</p>
            <div><Button size="sm" disabled={!rootsDirty || rootsBusy || unreachable} loading={rootsBusy} onClick={onSaveRoots}>{t('native.saveFolders')}</Button></div>
            {rootsFailure && <p role="alert" className="m-0 text-12 text-danger">{rootsFailure}</p>}
          </fieldset>)}
        <FormField label={t('native.domains')} hint={t('native.domainsHint')} error={domainsInvalid ? t('newSession.domains.invalid') : undefined}>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} value={domains} onChange={event => onDomains(event.target.value)} />}
        </FormField>
        <FormField label={t('native.attachments')}>
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={attachments} onChange={event => onAttachments(event.target.value)} />}
        </FormField>
        <FormField label={t('native.protected')}>
          {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={protectedPaths} onChange={event => onProtectedPaths(event.target.value)} />}
        </FormField>
      </div>
    </PopoverContent>
  </Popover>
}
