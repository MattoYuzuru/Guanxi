import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type {
  Connection, ConnectionBalance, ConnectionErrorCode, ConnectionSnapshot, ProviderCatalogEntry, ProviderCategory,
} from '@guanxi/contract'
import { providerCatalog, providerCategoryOrder } from '@guanxi/contract'
import {
  Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, Icon, IconButton,
  SegmentedControl,
} from '@guanxi/ui'
import { getActiveLocale, translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { useAutoRecover } from '../../lib/recover.ts'
import { Link, paths } from '../../lib/router.tsx'
import { connectionApi, ConnectionRequestError } from './api.ts'
import { ConnectionKeyDialog } from './KeyDialog.tsx'
import { ModelsPopover } from './ModelsPopover.tsx'
import { catalogEntry, connectionCategory, connectionLabel, connectionMonogram } from './labels.ts'
import './connections.css'

export type ConnectionMutationResult = { ok: true } | { ok: false; code?: ConnectionErrorCode }
/** Runs one server action, refreshes the snapshot and keeps a typed failure for inline copy. */
export type ConnectionMutate = (action: () => Promise<unknown>) => Promise<ConnectionMutationResult>

const PHONE_QUERY = '(max-width: 640px)'
function usePhoneLayout(): boolean {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window.matchMedia !== 'function') return () => undefined
    const query = window.matchMedia(PHONE_QUERY)
    query.addEventListener('change', notify)
    return () => query.removeEventListener('change', notify)
  }, [])
  const snapshot = useCallback(() => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches, [])
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

function money(amount: number, currency: string) {
  return translate('connections.money', { amount: amount.toLocaleString(getActiveLocale()), currency })
}
export function balanceLabel(balance: ConnectionBalance | null): string {
  if (!balance?.observedAt || !Number.isFinite(Date.parse(balance.observedAt)) || balance.amount === null || !balance.currency || balance.confidence === 'unknown') return translate('connections.unknown')
  return money(balance.amount, balance.currency)
}

function originLabel(connection: Connection): string {
  return translate(connection.facts.origin?.value === 'provider_key_import'
    ? 'connections.origin.imported' : 'connections.origin.added')
}

const PROBE_PROVIDERS = new Set<Connection['provider']>(['openrouter', 'deepseek'])

function ConnectionRow({ connection, busy, vaultUnlocked, modelCount, onRotate, onRemove, onModels, run }: {
  connection: Connection
  busy: boolean
  vaultUnlocked: boolean
  modelCount: number | undefined
  onRotate: () => void
  onRemove: () => void
  onModels: (count: number) => void
  run: ConnectionMutate
}) {
  const probe = PROBE_PROVIDERS.has(connection.provider)
  return <li className="connections-row" data-testid={`connection-${connection.id}`}>
    <div className="connections-row-text">
      <p className="connections-row-name">{connectionLabel(connection)}</p>
      <p className="connections-row-meta">
        <span>{originLabel(connection)}</span>
        {modelCount !== undefined && <span>{translate('connections.connection.models', { count: modelCount })}</span>}
      </p>
      {connection.balance && <p className="connections-row-meta">{translate('connections.balance')}: <span data-testid="connection-balance">{balanceLabel(connection.balance)}</span></p>}
    </div>
    <div className="connections-row-actions">
      <IconButton size="sm" disabled={busy || !vaultUnlocked || !connection.secretRef || !probe}
        label={probe ? translate('connections.action.probe', { name: connectionLabel(connection) }) : translate('connections.action.probeUnavailable')}
        icon={<Icon name="play" />} onClick={() => void run(() => connectionApi.probe(connection.id))} />
      {connection.auth === 'api_key' && <IconButton size="sm" disabled={busy || !vaultUnlocked}
        label={translate(connection.secretRef ? 'connections.action.rotate' : 'connections.action.addKey', { name: connectionLabel(connection) })}
        icon={<Icon name="lock" />} onClick={onRotate} />}
      {catalogEntry(connection.provider).models !== 'none' && <ModelsPopover connection={connection} disabled={busy}
        onLoaded={onModels} />}
      <IconButton size="sm" disabled={busy} label={translate('connections.action.remove', { name: connectionLabel(connection) })}
        icon={<Icon name="trash" />} onClick={onRemove} />
    </div>
  </li>
}

function ProviderCard({ entry, connections, modelCounts, busy, vaultUnlocked, onAdd, onRotate, onRemove, onModels, run }: {
  entry: ProviderCatalogEntry
  connections: Connection[]
  modelCounts: Record<string, number>
  busy: boolean
  vaultUnlocked: boolean
  onAdd: () => void
  onRotate: (connection: Connection) => void
  onRemove: (connection: Connection) => void
  onModels: (connection: Connection, count: number) => void
  run: ConnectionMutate
}) {
  const connected = connections.length > 0
  return <article className="connections-card" aria-labelledby={`provider-${entry.provider}`} data-provider={entry.provider}>
    <div className="connections-card-head">
      <span className="connections-monogram" aria-hidden="true">{connectionMonogram(entry.label)}</span>
      <div className="connections-card-title">
        <h3 id={`provider-${entry.provider}`}>{entry.label}</h3>
        <p data-state={connected ? 'connected' : 'not_connected'}>
          {connected ? translate('connections.provider.connected', { count: connections.length }) : translate('connections.provider.notConnected')}
        </p>
      </div>
      {!connected && <Button variant="primary" size="sm" disabled={busy} onClick={onAdd}>
        {entry.keyHint ? translate('connections.provider.addKey') : translate('connections.provider.connect')}
      </Button>}
    </div>
    <p className="connections-card-hint">{entry.keyHint ?? translate('connections.provider.noKey')}</p>
    {entry.docsUrl && <a className="connections-docs" href={entry.docsUrl} target="_blank" rel="noreferrer">
      <Icon name="external" />{translate('connections.provider.docs')}
    </a>}
    {connected && <ul className="connections-rows" aria-label={translate('connections.provider.list', { provider: entry.label })}>
      {connections.map(connection => <ConnectionRow key={connection.id} connection={connection} busy={busy}
        vaultUnlocked={vaultUnlocked} modelCount={modelCounts[connection.id]}
        onRotate={() => onRotate(connection)} onRemove={() => onRemove(connection)}
        onModels={count => onModels(connection, count)} run={run} />)}
    </ul>}
  </article>
}

export function ConnectionsView({ snapshot, loading = false, error = false, errorCode, offline = false, busy = false, saved = false,
  recovering = false, mutate }: {
  snapshot: ConnectionSnapshot | null; loading?: boolean; error?: boolean; errorCode?: ConnectionErrorCode; offline?: boolean; busy?: boolean; saved?: boolean
  /** A failed read that Guanxi repeats by itself (D-203); there is no Retry button. */
  recovering?: boolean
  mutate: ConnectionMutate
}) {
  const base = useId()
  const phone = usePhoneLayout()
  const [category, setCategory] = useState<ProviderCategory>(providerCategoryOrder[0]!)
  const [dialog, setDialog] = useState<{ entry: ProviderCatalogEntry; connection?: Connection } | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [removing, setRemoving] = useState<Connection | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeFailure, setRemoveFailure] = useState<ConnectionErrorCode>()
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({})
  const connections = snapshot?.connections ?? []
  const connectedProviders = new Set(connections.map(connection => connection.provider))
  const categories = providerCategoryOrder.map(value => ({
    value,
    entries: providerCatalog.filter(item => item.category === value),
    connected: providerCatalog.filter(item => item.category === value && connectedProviders.has(item.provider)).length,
  }))
  const active = categories.find(item => item.value === category) ?? categories[0]!
  const activeConnections = connections.filter(connection => connectionCategory(connection) === active.value)
  const vaultUnlocked = snapshot?.vault.unlocked ?? false
  const vaultLabel = translate(vaultUnlocked ? 'connections.vault.lock' : 'connections.vault.unlock')

  const remove = async (connection: Connection) => {
    setRemoveFailure(undefined)
    const result = await mutate(() => connectionApi.remove(connection.id))
    if (result.ok) setRemoveOpen(false)
    else setRemoveFailure(result.code)
  }

  return <section className="connections" aria-labelledby={`${base}-title`}>
    <header className="connections-header">
      <div className="connections-heading-text">
        <h1 id={`${base}-title`} className="connections-title">{translate('connections.title')}</h1>
        <p className="connections-muted">{translate('connections.description')}</p>
      </div>
      <IconButton label={vaultLabel} icon={<Icon name={vaultUnlocked ? 'lock' : 'unlock'} />} disabled={busy}
        onClick={() => void mutate(vaultUnlocked ? connectionApi.lock : connectionApi.unlock)} />
    </header>

    {loading && <p role="status" className="connections-note">{translate('connections.loading')}</p>}
    {offline && !error && <p role="status" className="connections-note">{translate('connections.offline')}</p>}
    {error && <div role="alert" className="connections-alert">
      <p>{translate(offline ? 'connections.offline' : errorCode ? `connections.error.${errorCode}` : 'connections.error')}</p>
      {recovering && errorCode !== 'vault_locked' && <p className="text-12">{translate('connections.recovering')}</p>}
    </div>}

    {snapshot && <div className="connections-layout">
      <nav aria-label={translate('connections.categories')} className="connections-category-nav">
        {phone
          ? <SegmentedControl label={translate('connections.categories')} value={category}
            onValueChange={value => setCategory(value)}
            options={categories.map(item => ({ value: item.value,
              label: `${translate(`connections.category.${item.value}`)} (${item.connected})` }))} />
          : <ul className="connections-rail">
            {categories.map(item => <li key={item.value}>
              <Button variant={item.value === category ? 'secondary' : 'ghost'} size="sm"
                className="connections-rail-item w-full justify-between" aria-pressed={item.value === category}
                onClick={() => setCategory(item.value)}>
                <span>{translate(`connections.category.${item.value}`)}</span>
                <span className="connections-count">{item.connected}</span>
              </Button>
            </li>)}
          </ul>}
      </nav>

      <div className="connections-catalog">
        <div className="connections-category-head">
          <h2>{translate(`connections.category.${active.value}`)}</h2>
          {activeConnections.length === 0 && <p className="connections-note">{translate('connections.category.none')}</p>}
        </div>
        {active.entries.length === 0
          ? <p className="connections-note">{translate('connections.category.empty')}</p>
          : <div className="connections-cards">
            {active.entries.map(entry => <ProviderCard key={entry.provider} entry={entry}
              connections={connections.filter(connection => connection.provider === entry.provider)}
              modelCounts={modelCounts} busy={busy} vaultUnlocked={vaultUnlocked}
              onAdd={() => { setDialog({ entry }); setDialogOpen(true) }}
              onRotate={connection => { setDialog({ entry, connection }); setDialogOpen(true) }}
              onRemove={connection => { setRemoveFailure(undefined); setRemoving(connection); setRemoveOpen(true) }}
              onModels={(connection, count) => setModelCounts(previous => previous[connection.id] === count
                ? previous : { ...previous, [connection.id]: count })}
              run={mutate} />)}
          </div>}
      </div>
    </div>}

    {snapshot && connections.length === 0 && <p className="connections-note">{translate('connections.empty')}</p>}
    <p role="status" aria-live="polite" className="connections-note">{saved ? translate('connections.saved') : ''}</p>

    {dialog && <ConnectionKeyDialog open={dialogOpen} entry={dialog.entry} connection={dialog.connection} busy={busy} run={mutate}
      onOpenChange={setDialogOpen} />}

    {removing && <Dialog open={removeOpen} onOpenChange={open => { setRemoveOpen(open); if (!open) setRemoveFailure(undefined) }}>
      <DialogContent>
        <DialogTitle>{translate('connections.remove.title', { name: connectionLabel(removing) })}</DialogTitle>
        <DialogDescription>{translate('connections.remove.description')}</DialogDescription>
        {removeFailure && <p role="alert" className="text-12 text-danger">{translate(`connections.error.${removeFailure}`)}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" type="button" />}>{translate('connections.remove.cancel')}</DialogClose>
          <Button variant="danger" loading={busy} loadingLabel={translate('connections.remove.pending')} onClick={() => void remove(removing)}>
            {translate('connections.remove.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </section>
}

export function ConnectionsPage() {
  useLocale()
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [errorCode, setErrorCode] = useState<ConnectionErrorCode>()
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [revision, setRevision] = useState(0)
  // A failed read recovers by itself; its error stays on screen until a read succeeds (D-203).
  const [loadFailure, setLoadFailure] = useState<object | null>(null)
  const loadFailed = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    if (!loadFailed.current) {
      setLoading(true)
      setError(false); setErrorCode(undefined)
    }
    void connectionApi.list(controller.signal).then(data => {
      if (controller.signal.aborted) return
      loadFailed.current = false; setLoadFailure(null)
      setError(false); setErrorCode(undefined)
      setSnapshot(data)
    }).catch(error => {
      if (controller.signal.aborted) return
      setError(true); setErrorCode(error instanceof ConnectionRequestError ? error.code : undefined)
      // A locked vault needs the user; anything else is repeated by itself.
      const recoverable = !(error instanceof ConnectionRequestError && error.code === 'vault_locked')
      loadFailed.current = recoverable
      setLoadFailure(recoverable ? {} : null)
    })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  useAutoRecover(loadFailure, () => setRevision(value => value + 1))
  const mutate: ConnectionMutate = async action => {
    setBusy(true); setError(false); setErrorCode(undefined); setSaved(false)
    try {
      await action()
      setSnapshot(await connectionApi.list())
      setSaved(true)
      return { ok: true }
    } catch (error) {
      const code = error instanceof ConnectionRequestError ? error.code : undefined
      setError(true); setErrorCode(code)
      // A create may have changed the snapshot even when the follow-up secret save failed.
      try { setSnapshot(await connectionApi.list()) } catch { /* Keep the last good snapshot. */ }
      return { ok: false, code }
    } finally { setBusy(false) }
  }
  return <ConnectionsView snapshot={snapshot} loading={loading} error={error} errorCode={errorCode} offline={!navigator.onLine}
    busy={busy} saved={saved} recovering={loadFailure !== null} mutate={mutate} />
}

/** Settings keeps a single entry point; the centre itself lives at `/connections`. */
export function ConnectionsSettings() {
  return <div className="flex flex-col items-start gap-2">
    <p className="m-0 text-12 text-secondary">{translate('connections.settings.description')}</p>
    <Button variant="secondary" nativeButton={false} render={<Link to={paths.connections()} />}>
      {translate('connections.settings.open')}
    </Button>
  </div>
}
