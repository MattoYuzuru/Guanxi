import type { ExecuteNotificationActionBody, NotificationWire } from '@guanxi/contract'
import { Button, Input } from '@guanxi/ui'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Select } from '../../components/ui.tsx'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { connectionApi } from '../connections/api.ts'
import type { AvailabilitySlice, NotificationActionName, RowOp } from './inbox-store.ts'
import {
  OWN_CONTROL,
  SEVERITY_GLYPH,
  SEVERITY_TONE,
  actionStatus,
  failureText,
  notificationTitle,
  parseLocalDateTime,
  percentText,
  snoozePresets,
  stateLabel,
  subjectLabel,
  windowLabel,
} from './model.ts'

export interface RowHandlers {
  /** Resolve true when the node confirmed the change. */
  onRead(row: NotificationWire): Promise<boolean>
  onSnooze(row: NotificationWire, untilMs: number): Promise<boolean>
  onAction(row: NotificationWire, body: ExecuteNotificationActionBody): Promise<boolean>
  onRecheck(): void
  onDismiss(row: NotificationWire): void
}

export interface NotificationRowProps extends RowHandlers {
  row: NotificationWire
  availability: AvailabilitySlice
  op: RowOp | undefined
  offline: boolean
  /** Caller clock for snooze presets; epoch milliseconds. */
  now: number
}

type Panel = 'snooze' | 'switch' | null

/** A machine value in the mono face. */
const Machine = ({ children }: { children: string }) => <span className="break-all font-mono">{children}</span>

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col">
    <dt className="text-secondary">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
}

export function NotificationRow(props: NotificationRowProps) {
  const { row, availability, op, offline, now } = props
  const uid = useId()
  const titleId = `${uid}-title`
  const [panel, setPanel] = useState<Panel>(null)
  const snoozeRef = useRef<HTMLButtonElement>(null)
  const switchRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<(() => Promise<boolean>) | null>(null)
  const pending = op?.status === 'pending'
  const facts = row.facts
  const title = notificationTitle(row)
  const closePanel = (restore: Panel) => {
    setPanel(null)
    requestAnimationFrame(() => (restore === 'snooze' ? snoozeRef : switchRef).current?.focus())
  }

  const run = (attempt: () => Promise<boolean>) => {
    retryRef.current = attempt
    return attempt()
  }

  const actions = row.actions.filter((action) => !OWN_CONTROL.has(action))
  const entries = [
    ...(row.state === 'unread' ? [{ id: 'read' as const, label: t('notifications.action.read'),
      status: offline ? { enabled: false, reason: { key: 'notifications.reason.offline' as const } }
        : pending ? { enabled: false, reason: { key: 'notifications.reason.busy' as const } }
          : { enabled: true, reason: null } }] : []),
    ...actions.map((action) => ({ id: action, label: t(`notifications.action.${action}`),
      status: actionStatus({ action, row, availability, offline, busy: pending }) })),
    ...(row.actions.includes('snooze') ? [{ id: 'snooze' as const, label: t('notifications.action.snooze'),
      status: actionStatus({ action: 'snooze', row, availability, offline, busy: pending }) }] : []),
  ]
  // One explanation per distinct reason, wired to every button it disables.
  const reasons = new Map<string, { id: string; text: string }>()
  for (const entry of entries) {
    const reason = entry.status.reason
    if (!reason) continue
    const text = t(reason.key, 'values' in reason ? reason.values : undefined)
    if (!reasons.has(text)) reasons.set(text, { id: `${uid}-reason-${reasons.size}`, text })
  }
  const describedBy = (entry: (typeof entries)[number]) => {
    const reason = entry.status.reason
    if (!reason) return undefined
    return reasons.get(t(reason.key, 'values' in reason ? reason.values : undefined))?.id
  }

  const actionLabel = (op?.kind === 'read' ? t('notifications.failed.read')
    : op?.kind === 'snooze' ? t('notifications.failed.snooze')
      : op?.action ? t(`notifications.action.${op.action}`) : '').replace(/…$/u, '')

  const press = (id: (typeof entries)[number]['id']) => {
    if (id === 'read') void run(() => props.onRead(row))
    else if (id === 'snooze') setPanel(panel === 'snooze' ? null : 'snooze')
    else if (id === 'switch_connection') setPanel(panel === 'switch' ? null : 'switch')
    else {
      const body = bodyFor(id)
      if (body) void run(() => props.onAction(row, body))
    }
  }

  return <article aria-labelledby={titleId} tabIndex={-1} data-testid="notification-row" data-notification-id={row.id}
    data-state={row.state} data-severity={row.severity}
    className="flex min-w-0 flex-col gap-2 rounded-panel border border-divider bg-surface p-3 focus-visible:outline-focus">
    <header className="flex min-w-0 flex-wrap items-center gap-2 text-12">
      <span data-testid="notification-severity" className={`inline-flex items-center gap-1 font-heading ${SEVERITY_TONE[row.severity]}`}>
        <span aria-hidden="true">{SEVERITY_GLYPH[row.severity]}</span>{t(`notifications.severity.${row.severity}`)}
      </span>
      <span data-testid="notification-state" className="rounded-inline border border-divider bg-inset px-2 py-1 font-heading">{stateLabel(row)}</span>
      <span className="text-secondary">{t(`notifications.kind.${row.kind}`)}</span>
    </header>
    <h2 id={titleId} className="min-w-0 break-words text-14 font-heading">{title}</h2>

    <dl data-testid="notification-facts" className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-12 sm:grid-cols-2">
      <Fact label={t('notifications.fact.subject')}><Machine>{subjectLabel(row.subject)}</Machine></Fact>
      <Fact label={t('notifications.fact.window')}>{windowLabel(facts.window)}</Fact>
      <Fact label={t('notifications.fact.remaining')}>
        {facts.remainingPercent === null ? t('notifications.fact.unknown') : percentText(facts.remainingPercent)}
      </Fact>
      {facts.threshold !== null && <Fact label={t('notifications.fact.threshold')}>{percentText(facts.threshold)}</Fact>}
      <Fact label={t('notifications.fact.resetsAt')}>{facts.resetsAt === null ? t('notifications.fact.unknown') : formatDateTime(facts.resetsAt)}</Fact>
      {facts.forecast && <>
        <Fact label={t('notifications.fact.exhaustsAt')}>{formatDateTime(facts.forecast.exhaustsAt)}</Fact>
        <Fact label={t('notifications.fact.before')}>{t(`notifications.fact.before.${facts.forecast.before}`)}</Fact>
        {facts.forecast.runId !== undefined && <Fact label={t('notifications.fact.run')}><Machine>{facts.forecast.runId}</Machine></Fact>}
      </>}
      <Fact label={t('notifications.fact.source')}><Machine>{facts.source}</Machine></Fact>
      <Fact label={t('notifications.fact.observedAt')}><time dateTime={facts.observedAt}>{formatDateTime(facts.observedAt)}</time></Fact>
      <Fact label={t('notifications.fact.confidence')}>
        <span data-testid="notification-confidence">{t(`notifications.confidence.${facts.confidence}`)}</span>
        {facts.confidence === 'estimated' && <span className="block text-secondary">{t('notifications.confidence.estimatedHint')}</span>}
      </Fact>
      <Fact label={t('notifications.fact.raised')}><time dateTime={new Date(row.createdAt).toISOString()}>{formatDateTime(new Date(row.createdAt).toISOString())}</time></Fact>
    </dl>

    <div role="group" aria-label={t('notifications.actions.label')} className="flex min-w-0 flex-wrap items-center gap-2">
      {entries.map((entry) => {
        const working = pending && ((entry.id === 'read' && op?.kind === 'read') || (entry.id === 'snooze' && op?.kind === 'snooze') || (op?.kind === 'action' && op.action === entry.id))
        return <Button key={entry.id} size="sm" ref={entry.id === 'snooze' ? snoozeRef : entry.id === 'switch_connection' ? switchRef : undefined}
          data-action={entry.id} disabled={!entry.status.enabled} loading={working} loadingLabel={t('notifications.action.working')}
          aria-describedby={[describedBy(entry), titleId].filter(Boolean).join(' ')}
          aria-expanded={entry.id === 'snooze' ? panel === 'snooze' : entry.id === 'switch_connection' ? panel === 'switch' : undefined}
          onClick={() => press(entry.id)}>{entry.label}</Button>
      })}
    </div>
    {reasons.size > 0 && <ul data-testid="notification-reasons" aria-label={t('notifications.actions.disabled')} className="flex min-w-0 flex-col gap-1 text-12 text-secondary">
      {[...reasons.values()].map((reason) => <li key={reason.id} id={reason.id} className="break-words">{reason.text}</li>)}
      {!availability.loaded && !availability.loading && availability.failure && !offline &&
        <li><Button size="sm" variant="ghost" onClick={props.onRecheck}>{t('notifications.actions.recheck')}</Button></li>}
    </ul>}

    {panel === 'snooze' && <SnoozeForm now={now} resetsAt={facts.resetsAt} busy={pending}
      onCancel={() => closePanel('snooze')}
      onApply={async (untilMs) => {
        const ok = await run(() => props.onSnooze(row, untilMs))
        if (ok) setPanel(null)
        return ok
      }} />}
    {panel === 'switch' && <SwitchForm subjectId={row.subject.id} busy={pending}
      onCancel={() => closePanel('switch')}
      onApply={async (connectionId) => {
        const ok = await run(() => props.onAction(row, { action: 'switch_connection', args: { connectionId } }))
        if (ok) setPanel(null)
        return ok
      }} />}

    {op?.status === 'failed' && op.failure && <div role="alert" data-testid="notification-failure" className="flex min-w-0 flex-col gap-2 rounded-control border border-danger p-2 text-12">
      <p className="break-words">{t('notifications.failed', { action: actionLabel, reason: failureText(op.failure) })}</p>
      {op.keepsKey && <p className="text-secondary">{t('notifications.failed.keepKey')}</p>}
      <p className="break-words text-secondary">{t('notifications.failed.at', { time: formatDateTime(new Date(op.failure.at).toISOString()), code: op.failure.code })}</p>
      <div className="flex flex-wrap gap-2">
        {retryRef.current && <Button size="sm" disabled={pending} onClick={() => { void retryRef.current?.() }}>{t('notifications.retry')}</Button>}
        <Button size="sm" variant="ghost" onClick={() => props.onDismiss(row)}>{t('notifications.dismiss')}</Button>
      </div>
    </div>}
    {op?.status === 'stale' && <p data-testid="notification-stale" className="text-12 text-secondary">{t('notifications.done.stale')}</p>}
  </article>
}

/** Arguments are identifiers only; nothing here collects free text. */
function bodyFor(action: NotificationActionName): ExecuteNotificationActionBody | null {
  switch (action) {
    case 'open': return { action: 'open', args: {} }
    case 'accept_recommendation': return { action: 'accept_recommendation', args: {} }
    case 'wake_leads': return { action: 'wake_leads', args: {} }
    case 'pause_runs': return { action: 'pause_runs', args: {} }
    case 'resume_runs': return { action: 'resume_runs', args: {} }
    default: return null
  }
}

function SnoozeForm({ now, resetsAt, busy, onApply, onCancel }: {
  now: number
  resetsAt: string | null
  busy: boolean
  onApply(untilMs: number): Promise<boolean>
  onCancel(): void
}) {
  const id = useId()
  const presets = snoozePresets(now, resetsAt)
  const [custom, setCustom] = useState('')
  const [invalid, setInvalid] = useState(false)
  const firstRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { firstRef.current?.focus() }, [])
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    onCancel()
  }
  const applyCustom = () => {
    const untilMs = parseLocalDateTime(custom)
    if (!Number.isFinite(untilMs) || untilMs <= now) { setInvalid(true); return }
    setInvalid(false)
    void onApply(untilMs)
  }
  return <div role="group" aria-labelledby={`${id}-title`} data-testid="snooze-form" onKeyDown={key}
    className="flex min-w-0 flex-col gap-2 rounded-control border border-control p-3">
    <p id={`${id}-title`} className="text-12 font-heading">{t('notifications.snooze.title')}</p>
    <div className="flex min-w-0 flex-wrap gap-2">
      {presets.map((preset, index) => <Button key={preset.id} ref={index === 0 ? firstRef : undefined} size="sm" disabled={busy}
        data-preset={preset.id} onClick={() => { void onApply(preset.untilMs) }}>
        {preset.id === 'reset'
          ? t('notifications.snooze.preset.reset', { time: formatDateTime(new Date(preset.untilMs).toISOString()) })
          : t(`notifications.snooze.preset.${preset.id}`)}
      </Button>)}
    </div>
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`${id}-custom`} className="text-12">{t('notifications.snooze.custom')}</label>
      <Input id={`${id}-custom`} type="datetime-local" value={custom} invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(event) => { setCustom(event.target.value); setInvalid(false) }} />
      {invalid && <p id={`${id}-error`} role="alert" className="text-12 text-danger">{t('notifications.snooze.invalid')}</p>}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={busy} onClick={applyCustom}>{t('notifications.snooze.apply')}</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>{t('notifications.snooze.cancel')}</Button>
    </div>
  </div>
}

type Choice = { status: 'loading' } | { status: 'error' } | { status: 'ready'; options: Array<{ value: string; label: string }> }

function SwitchForm({ subjectId, busy, onApply, onCancel }: {
  subjectId: string
  busy: boolean
  onApply(connectionId: string): Promise<boolean>
  onCancel(): void
}) {
  const id = useId()
  const [choice, setChoice] = useState<Choice>({ status: 'loading' })
  const [value, setValue] = useState('')
  const [missing, setMissing] = useState(false)
  const selectRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    connectionApi.list(controller.signal).then(
      (snapshot) => {
        if (controller.signal.aborted) return
        const options = snapshot.connections.filter((connection) => connection.id !== subjectId)
          .map((connection) => ({ value: connection.id, label: connection.name }))
        setChoice({ status: 'ready', options })
      },
      () => { if (!controller.signal.aborted) setChoice({ status: 'error' }) },
    )
    return () => controller.abort()
  }, [subjectId])
  useEffect(() => {
    if (choice.status === 'ready') selectRef.current?.querySelector('select')?.focus()
  }, [choice.status])
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    onCancel()
  }
  return <div role="group" aria-labelledby={`${id}-title`} data-testid="switch-form" onKeyDown={key}
    className="flex min-w-0 flex-col gap-2 rounded-control border border-control p-3">
    <label id={`${id}-title`} htmlFor={`${id}-select`} className="text-12 font-heading">{t('notifications.switch.label')}</label>
    {choice.status === 'loading' && <p role="status" className="text-12 text-secondary">{t('notifications.switch.loading')}</p>}
    {choice.status === 'error' && <p role="alert" className="text-12 text-danger">{t('notifications.switch.error')}</p>}
    {choice.status === 'ready' && (choice.options.length === 0
      ? <p className="text-12 text-secondary">{t('notifications.switch.none')}</p>
      : <div ref={selectRef}><Select id={`${id}-select`} value={value} disabled={busy} describedBy={missing ? `${id}-required` : undefined}
        onChange={(next) => { setValue(next); setMissing(false) }}
        options={[{ value: '', label: t('notifications.switch.placeholder') }, ...choice.options]} /></div>)}
    {missing && <p id={`${id}-required`} role="alert" className="text-12 text-danger">{t('notifications.switch.required')}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={busy || choice.status !== 'ready' || choice.options.length === 0}
        onClick={() => { if (value === '') setMissing(true); else void onApply(value) }}>{t('notifications.switch.apply')}</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>{t('notifications.switch.cancel')}</Button>
    </div>
  </div>
}
