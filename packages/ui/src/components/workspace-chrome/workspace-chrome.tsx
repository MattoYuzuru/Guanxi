import { useRef, useState, type ReactNode } from 'react'
import { Button } from '../button/button.tsx'
import { Input } from '../input/input.tsx'
import { Textarea } from '../textarea/textarea.tsx'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../menu/menu.tsx'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../dialog/dialog.tsx'
import { EmptyState } from '../empty-state/empty-state.tsx'
import { ErrorState } from '../error-state/error-state.tsx'
import { PortalContainerProvider } from '../../lib/portal.tsx'
import './workspace-chrome.css'

type Choice = { id: string; label: string }
type Base = { children?: ReactNode }
export type WorkspaceChromeProps = Base & (
  | { kind: 'pane'; id: string; title: string; moveLabel: string; hideLabel: string; onMove: () => void; onHide: () => void; canMove?: boolean; description?: string; draft?: { label: string; value: string; onChange: (value: string) => void } }
  | { kind: 'toolbar'; busy?: boolean; label: string; fields: { label: string; value: string; choices: Choice[]; onChange: (id: string) => void }[]; name: { label: string; value: string; onChange: (name: string) => void }; actions: { label: string; onClick: () => void; disabled?: boolean }[] }
  | { kind: 'mover'; modal?: boolean; open: boolean; title: string; description: string; blockLabel: string; zoneLabel: string; cancelLabel: string; moveLabel: string; blocks: Choice[]; zones: Choice[]; block: string; zone: string; onBlock: (id: string) => void; onZone: (id: string) => void; onClose: () => void; onMove: () => void }
  | { kind: 'phone'; label: string; blocks: Choice[]; selected: string; onSelect: (id: string) => void }
  | { kind: 'state'; title: string; loading: boolean; action?: never; error?: never; failure?: never }
  | { kind: 'state'; title: string; loading?: false; action?: { label: string; onClick: () => void; busy?: boolean; disabled?: boolean; loadingLabel?: string }; error?: boolean; failure?: { source: string; observedAt: string; details: string } }
)
function ChoiceMenu({ label, value, choices, onChange, disabled }: { disabled?: boolean; label: string; value: string; choices: Choice[]; onChange: (id: string) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  return <Menu modal={false} onOpenChange={(open, event) => { restoreFocus.current = !open && (event.reason === 'item-press' || event.reason === 'escape-key') }} onOpenChangeComplete={open => { if (!open && restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus() } }}><MenuTrigger ref={trigger} render={<Button variant="secondary" />} disabled={disabled} aria-label={label}>{choices.find(c => c.id === value)?.label ?? label}</MenuTrigger><MenuContent>{choices.map(choice => <MenuItem key={choice.id} onClick={() => onChange(choice.id)} aria-current={choice.id === value ? 'true' : undefined}>{choice.label}</MenuItem>)}</MenuContent></Menu>
}

/** Workspace chrome owns controls only; pane content and the docking engine remain host-owned. */
export function WorkspaceChrome(props: WorkspaceChromeProps) {
  const tabs = useRef<HTMLDivElement>(null)
  const [dialogContainer, setDialogContainer] = useState<HTMLDivElement | null>(null)
  if (props.kind === 'pane') return <section className="gx-workspace-pane" data-block={props.id} aria-label={props.title} tabIndex={-1}>
    <header className="gx-workspace-pane-header"><h2>{props.title}</h2><Menu><MenuTrigger render={<Button variant="ghost" />} aria-label={`${props.moveLabel} ${props.title}`}>{props.moveLabel}</MenuTrigger><MenuContent><MenuItem disabled={props.canMove === false} onClick={props.onMove}>{props.moveLabel}</MenuItem><MenuItem onClick={props.onHide}>{props.hideLabel}</MenuItem></MenuContent></Menu></header>
    <div className="gx-workspace-pane-body">{props.description && <p className="gx-workspace-description">{props.description}</p>}{props.children}{props.draft && <label className="gx-workspace-field"><span>{props.draft.label}</span><Textarea aria-label={props.draft.label} value={props.draft.value} onChange={event => props.draft?.onChange(event.target.value)} /></label>}</div>
  </section>
  if (props.kind === 'toolbar') return <div className="gx-workspace-toolbar" role="group" aria-label={props.label}>
    {props.fields.map(field => <ChoiceMenu key={field.label} {...field} disabled={props.busy} />)}
    <label className="gx-workspace-field"><span>{props.name.label}</span><Input disabled={props.busy} value={props.name.value} onChange={event => props.name.onChange(event.target.value)} /></label>
    {props.actions.map(action => <Button key={action.label} variant="secondary" onClick={action.onClick} disabled={action.disabled || props.busy}>{action.label}</Button>)}
  </div>
  if (props.kind === 'mover') return <Dialog open={props.open} modal={props.modal} onOpenChange={open => { if (!open) props.onClose() }}>
    <DialogContent ref={setDialogContainer} initialFocus={props.modal === false ? false : undefined} finalFocus={props.modal === false ? false : undefined}><PortalContainerProvider container={dialogContainer}><DialogTitle>{props.title}</DialogTitle><DialogDescription>{props.description}</DialogDescription>
      <div className="gx-workspace-mover"><ChoiceMenu label={props.blockLabel} value={props.block} choices={props.blocks} onChange={props.onBlock} /><ChoiceMenu label={props.zoneLabel} value={props.zone} choices={props.zones} onChange={props.onZone} />
        <Button onClick={props.onMove} disabled={!props.block}>{props.moveLabel}</Button><Button variant="secondary" onClick={props.onClose}>{props.cancelLabel}</Button></div>
    </PortalContainerProvider></DialogContent>
  </Dialog>
  if (props.kind === 'phone') return <div ref={tabs} className="gx-workspace-phone-tabs" role="tablist" aria-label={props.label} aria-orientation="vertical" onKeyDown={event => {
    const index = props.blocks.findIndex(block => block.id === props.selected)
    const next = event.key === 'ArrowDown' ? (index + 1) % props.blocks.length : event.key === 'ArrowUp' ? (index - 1 + props.blocks.length) % props.blocks.length : event.key === 'Home' ? 0 : event.key === 'End' ? props.blocks.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    const block = props.blocks[next]
    if (block) { props.onSelect(block.id); (tabs.current?.querySelectorAll('[role=tab]')[next] as HTMLElement)?.focus() }
  }}>{props.blocks.map(block => <Button key={block.id} role="tab" id={`tab-${block.id}`} aria-controls={`phone-${block.id}`} aria-selected={block.id === props.selected} tabIndex={block.id === props.selected ? 0 : -1} onClick={() => props.onSelect(block.id)}>{block.label}</Button>)}</div>
  if (props.loading) return <div className="gx-workspace-loading" aria-busy="true">
    <span role="status" aria-label={props.title} className="gx-sr-only">{props.title}</span>
    <div data-slot="workspace-loading-geometry" aria-hidden="true" className="gx-workspace-loading-geometry">
      <div className="gx-workspace-toolbar">{Array.from({ length: 11 }, (_, index) => index === 6
        ? <div key={index} className="gx-workspace-field"><span className="gx-workspace-loading-label">{'\u00a0'}</span><span className="gx-workspace-loading-control" /></div>
        : <span key={index} className="gx-workspace-loading-control" />)}</div>
      <div className="gx-workspace-loading-content" />
    </div>
  </div>
  const action = props.action && <Button onClick={props.action.onClick} loading={props.action.busy}
    disabled={props.action.disabled} loadingLabel={props.action.loadingLabel}>{props.action.label}</Button>
  return <div className="gx-workspace-state">
    {props.error && props.failure
      ? <ErrorState title={props.title} source={props.failure.source} occurredAt={props.failure.observedAt}
        timeMeaning="observed" details={props.failure.details} action={action} />
      : props.error ? <div role="alert"><p>{props.title}</p>{action}</div>
        : action ? <EmptyState title={props.title} action={action} /> : <p className="gx-workspace-description">{props.title}</p>}
  </div>
}
