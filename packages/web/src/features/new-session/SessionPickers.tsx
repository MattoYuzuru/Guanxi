import type { AccessMode, Connection, Project, Workspace } from '@guanxi/contract'
import {
  Button, Icon, IconButton, Input, Menu, type IconName, MenuContent, MenuItem, MenuTrigger, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Textarea,
} from '@guanxi/ui'
import { useId, type ReactNode } from 'react'
import { translate as t } from '../../lib/locale.ts'

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
 * Model, connection and context at the composer's lower right (D-207). The suggestion list is a
 * generic `ModelSuggestion[]`, so a provider-model source (D-208) can feed it without changes here.
 */
export interface ModelSuggestion { id: string; label: string; detail?: string }

export function ModelPicker({ connections, connectionId, onConnection, model, onModel, suggestions, contextRequired, context, onContext, contextInvalid }: {
  connections: Connection[]
  connectionId: string
  onConnection: (id: string) => void
  model: string
  onModel: (model: string) => void
  suggestions: ModelSuggestion[]
  contextRequired: boolean
  context: string
  onContext: (value: string) => void
  contextInvalid: boolean
}) {
  const summary = model.trim() ? model.trim() : t('newSession.model.choose')
  return <Popover>
    <PopoverTrigger render={<PickerButton icon="models" aria-label={model.trim() ? t('newSession.model.current', { model: model.trim() }) : t('newSession.model.choose')} />}>
      {summary}
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="w-sm">
      <PopoverTitle>{t('newSession.model.label')}</PopoverTitle>
      <div className="flex flex-col gap-3 pt-1">
        <div role="group" aria-label={t('newSession.model.connection')} className="flex flex-col gap-1">
          <span className="text-12 font-label text-secondary">{t('newSession.model.connection')}</span>
          <div className="flex flex-wrap gap-1">
            {connections.map(item => <Button key={item.id} size="sm" variant={item.id === connectionId ? 'primary' : 'secondary'}
              aria-pressed={item.id === connectionId} onClick={() => onConnection(item.id)}>{item.name}</Button>)}
          </div>
        </div>
        {suggestions.length > 0 && <div role="group" aria-label={t('newSession.model.installed')} className="flex flex-col gap-1">
          <span className="text-12 font-label text-secondary">{t('newSession.model.installed')}</span>
          <div className="flex flex-wrap gap-1">
            {suggestions.map(item => <Button key={item.id} size="sm" variant={item.id === model.trim() ? 'primary' : 'ghost'}
              aria-pressed={item.id === model.trim()} onClick={() => onModel(item.id)}><span className="font-mono">{item.label}</span></Button>)}
          </div>
        </div>}
        <FormField label={t('newSession.model.id')} hint={t('newSession.model.hint')}>
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={model} onChange={event => onModel(event.target.value)} className="font-mono" />}
        </FormField>
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
