import { useEffect, useId, useState, type FormEvent } from 'react'
import type { Connection, ConnectionBalance, ConnectionSnapshot, ConnectionErrorCode } from '@guanxi/contract'
// DS1-b is not merged. Reuse existing primitives until its integration.
import { Button, Field, Input, Select } from '../../components/ui.tsx'
import { getActiveLocale, translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { connectionApi, ConnectionRequestError } from './api.ts'
import './connections.css'

const providers = {
  agent: ['claude-code', 'codex', 'copilot'], model_api: ['anthropic', 'openai', 'google', 'openrouter', 'deepseek'],
  local_runtime: ['ollama'], service: ['brave', 'tavily', 'openai-stt'],
} as const
function money(amount: number, currency: string) {
  return translate('connections.money', { amount: amount.toLocaleString(getActiveLocale()), currency })
}
function provenance(value: { source: string; observedAt?: string | null; confidence: 'high' | 'medium' | 'low' | 'unknown' }) {
  if (!value.observedAt || !Number.isFinite(Date.parse(value.observedAt))) return translate('connections.unknown')
  return translate('connections.observed', { source: value.source, time: new Date(value.observedAt).toLocaleString(getActiveLocale()),
    confidence: translate(`connections.confidence.${value.confidence}`) })
}
export function balanceLabel(balance: ConnectionBalance | null): string {
  if (!balance?.observedAt || !Number.isFinite(Date.parse(balance.observedAt)) || balance.amount === null || !balance.currency || balance.confidence === 'unknown') return translate('connections.unknown')
  return money(balance.amount, balance.currency)
}

export function ConnectionsView({ snapshot, loading = false, error = false, errorCode, offline = false, busy = false, saved = false,
  retry, mutate }: {
  snapshot: ConnectionSnapshot | null; loading?: boolean; error?: boolean; errorCode?: ConnectionErrorCode; offline?: boolean; busy?: boolean; saved?: boolean
  retry: () => void; mutate: (action: () => Promise<unknown>) => Promise<void>
}) {
  const base = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Connection['kind']>('model_api')
  const [provider, setProvider] = useState<Connection['provider']>('anthropic')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await mutate(() => connectionApi.create({ name, kind, provider, auth: kind === 'agent' ? 'cli_login' : kind === 'local_runtime' ? 'none' : 'api_key' }))
  }
  return <section className="connections rounded-panel border p-4" aria-labelledby={`${base}-title`}>
    <h2 id={`${base}-title`} className="text-15 connections-heading">{translate('connections.title')}</h2>
    <p className="connections-muted mt-1 text-12">{translate('connections.description')}</p>
    {loading && <p role="status" className="py-4">{translate('connections.loading')}</p>}
    {error && <div role="alert" className="py-4">
      <p>{translate(offline ? 'connections.offline' : errorCode ? `connections.error.${errorCode}` : 'connections.error')}</p>
      {errorCode === 'vault_locked'
        ? <Button type="button" onClick={() => void mutate(connectionApi.unlock)} disabled={busy}>{translate('connections.vault.unlock')}</Button>
        : <Button type="button" onClick={retry} disabled={busy}>{translate('connections.retry')}</Button>}
    </div>}
    {snapshot && <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <span>{translate(snapshot.vault.unlocked ? 'connections.vault.unlocked' : 'connections.vault.locked')}</span>
        <Button type="button" hidden={errorCode === 'vault_locked'} disabled={busy} onClick={() => void mutate(snapshot.vault.unlocked ? connectionApi.lock : connectionApi.unlock)}>
          {translate(snapshot.vault.unlocked ? 'connections.vault.lock' : 'connections.vault.unlock')}
        </Button>
      </div>
      {snapshot.connections.length === 0 && <p className="py-4">{translate('connections.empty')}</p>}
      <div className="space-y-4">
        {snapshot.connections.map(connection => <ConnectionRow key={connection.id} connection={connection} snapshot={snapshot} busy={busy} mutate={mutate} />)}
      </div>
      <form onSubmit={event => void submit(event)} className="mt-4">
        <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
          <Field label={translate('connections.name')} htmlFor={`${base}-name`}>
            <Input id={`${base}-name`} required maxLength={160} value={name} onChange={e => setName(e.target.value)} />
          </Field>
          <Field label={translate('connections.kind')} htmlFor={`${base}-kind`}>
            <Select id={`${base}-kind`} value={kind} onChange={value => {
              const next = value as Connection['kind']; setKind(next); setProvider(providers[next][0])
            }} options={Object.keys(providers).map(key => ({ value: key, label: translate(`connections.kind.${key as Connection['kind']}`) }))} />
          </Field>
          <Field label={translate('connections.provider')} htmlFor={`${base}-provider`}>
            <Select id={`${base}-provider`} value={provider} onChange={value => setProvider(value as Connection['provider'])}
              options={providers[kind].map(value => ({ value, label: translate(`connections.provider.${value}`) }))} />
          </Field>
          <div className="flex items-end py-2"><Button type="submit" disabled={!name.trim()}>{translate('connections.add')}</Button></div>
        </fieldset>
      </form>
    </>}
    <p role="status" aria-live="polite" className="mt-2 text-12">{saved ? translate('connections.saved') : ''}</p>
  </section>
}
function ConnectionRow({ connection, snapshot, busy, mutate }: {
  connection: Connection; snapshot: ConnectionSnapshot; busy: boolean; mutate: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [secret, setSecret] = useState('')
  const base = useId()
  const costs = snapshot.costs.filter(cost => cost.connectionId === connection.id)
  return <article className="connections-record border-t pt-4" aria-labelledby={`${base}-name`}>
    {connection.baseUrl && <p className="connections-muted text-12">{translate('connections.endpointHost', { host: new URL(connection.baseUrl).host })}</p>}
    <h3 id={`${base}-name`} className="break-words connections-heading">{connection.name}</h3>
    <p className="connections-muted text-12">{translate('connections.route', { provider: translate(`connections.provider.${connection.provider}`), kind: translate(`connections.kind.${connection.kind}`) })}</p>
    <p className="mt-2">{translate(connection.balance?.scope === 'key_allowance' ? 'connections.allowance' : 'connections.balance')}: <span data-testid="connection-balance">{balanceLabel(connection.balance)}</span></p>
    {connection.balance?.observedAt && <p className="connections-muted break-words text-12">{provenance(connection.balance)}</p>}
    {['openrouter', 'deepseek'].includes(connection.provider)
      ? <Button type="button" disabled={busy || !snapshot.vault.unlocked || !connection.secretRef} onClick={() => void mutate(() => connectionApi.probe(connection.id))}>{translate('connections.probe')}</Button>
      : <p className="connections-muted text-12">{translate('connections.noProbe')}</p>}
    {Object.entries(connection.facts).map(([key, fact]) => <p key={key} className="break-words text-12">
      <span className="font-mono">{key}: {fact.observedAt ? String(fact.value ?? translate('connections.unknown')) : translate('connections.unknown')}</span>
      <span className="connections-muted">{translate('connections.provenance', { provenance: provenance(fact) })}</span>
    </p>)}
    <div className="my-3 flex flex-wrap items-center gap-3">
      <Button type="button" role="switch" aria-checked={connection.unattended} aria-label={translate('connections.unattended.label', { name: connection.name })}
        disabled={busy || (!connection.unattended && !snapshot.vault.unattendedAvailable)}
        onClick={() => void mutate(() => connectionApi.unattended(connection.id, !connection.unattended))}>{translate(connection.unattended ? 'connections.unattended.on' : 'connections.unattended.off')}</Button>
      <p className="connections-muted text-12">{translate('connections.unattended.hint')}</p>
    </div>
    {connection.auth === 'api_key' && <>
      <p className="break-all font-mono text-12">{connection.secretRef ?? translate('connections.secret.absent')}</p>
      <form onSubmit={event => { event.preventDefault(); const value = secret; setSecret(''); void mutate(() => connectionApi.secret(connection.id, value)) }} className="mt-2 flex flex-wrap items-end gap-3">
        <Field label={translate('connections.secret')} htmlFor={`${base}-secret`}>
          <Input id={`${base}-secret`} type="password" autoComplete="off" value={secret} disabled={busy || !snapshot.vault.unlocked} onChange={e => setSecret(e.target.value)} />
        </Field>
        <Button type="submit" disabled={busy || !secret || !snapshot.vault.unlocked}>{translate('connections.secret.save')}</Button>
      </form>
    </>}
    {connection.auth === 'cli_login' && <p className="mt-2 text-12">{translate('connections.cli')}</p>}
    <p className="mt-2 text-12 connections-heading">{translate('connections.cost')}</p>
    {costs.length === 0 ? <p className="connections-muted text-12">{translate('connections.cost.none')}</p>
      : costs.map(cost => <p key={cost.id} className="break-words text-12">
        {translate('connections.observation', { value: cost.costUsd === null ? translate('connections.unknown') : money(cost.costUsd, 'USD'), provenance: provenance(cost) })}
      </p>)}
  </article>
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
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false); setErrorCode(undefined)
    void connectionApi.list(controller.signal).then(data => {
      if (!controller.signal.aborted) setSnapshot(data)
    }).catch(error => { if (!controller.signal.aborted) { setError(true); setErrorCode(error instanceof ConnectionRequestError ? error.code : undefined) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(false); setErrorCode(undefined); setSaved(false)
    try { await action(); setSnapshot(await connectionApi.list()); setSaved(true) }
    catch (error) { setError(true); setErrorCode(error instanceof ConnectionRequestError ? error.code : undefined) }
    finally { setBusy(false) }
  }
  return <ConnectionsView snapshot={snapshot} loading={loading} error={error} errorCode={errorCode} offline={!navigator.onLine} busy={busy} saved={saved}
    retry={() => setRevision(value => value + 1)} mutate={mutate} />
}

/** Keep unrelated Settings usable without opening or querying Connections. */
export function ConnectionsSettings() {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div>
    <Button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {translate('connections.title')}
    </Button>
    <div id={id} className="mt-3">{open && <ConnectionsPage />}</div>
  </div>
}
