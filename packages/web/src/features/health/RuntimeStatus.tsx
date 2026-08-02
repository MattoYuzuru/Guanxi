import type { ListRunningResponse, RunningModel } from '@alamo/contract'
import { Button, Spinner } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import {
  formatBytes,
  formatContextLength,
  formatDateTime,
  formatRelativeTime,
} from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { useAsync } from '../../lib/useAsync.ts'

export interface RuntimeStatusViewProps {
  data: ListRunningResponse | null
  error: unknown
  loading: boolean
  refreshing: boolean
  onRetry: () => void
}

export function RuntimeStatus() {
  const running = useAsync((signal) => api.listRunning(signal), [])

  return (
    <RuntimeStatusView
      data={running.data}
      error={running.error}
      loading={running.loading}
      refreshing={running.refreshing}
      onRetry={running.reload}
    />
  )
}

export function RuntimeStatusView({
  data,
  error,
  loading,
  refreshing,
  onRetry,
}: RuntimeStatusViewProps) {
  return (
    <section
      aria-labelledby="runtime-status-title"
      className="border-b border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id="runtime-status-title" className="text-2xs font-semibold">
          {translate('runtime.title')}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          loading={refreshing}
          aria-label={translate('runtime.retry')}
          className="min-h-11 sm:min-h-0"
        >
          {translate('runtime.retry')}
        </Button>
      </div>

      {loading ? (
        <div
          className="mt-1 flex items-center gap-1.5 text-2xs text-[var(--fg-muted)]"
          role="status"
          aria-live="polite"
        >
          <Spinner size={12} />
          {translate('runtime.checking')}
        </div>
      ) : error ? (
        <div className="mt-1 text-2xs text-[var(--danger)]" role="alert">
          <p className="font-medium">{translate('runtime.error.title')}</p>
          <p className="text-[var(--fg-muted)]">{translate('runtime.error.summary')}</p>
          <p className="mt-0.5 break-words text-[var(--fg-subtle)]">
            {errorMessage(error)}
          </p>
        </div>
      ) : (data?.models.length ?? 0) === 0 ? (
        <div className="mt-1 text-2xs" role="status" aria-live="polite">
          <p className="font-medium">{translate('runtime.empty.title')}</p>
          <p className="text-[var(--fg-muted)]">{translate('runtime.empty.summary')}</p>
          <Observation observedAt={data?.observedAt ?? null} />
        </div>
      ) : (
        <div className="mt-1">
          <ul className="flex min-w-0 flex-wrap gap-2" aria-label={translate('runtime.title')}>
            {data?.models.map((model) => (
              <RunningModelRow key={`${model.name}:${model.digest ?? ''}`} model={model} />
            ))}
          </ul>
          <Observation observedAt={data?.observedAt ?? null} />
        </div>
      )}
    </section>
  )
}

function RunningModelRow({ model }: { model: RunningModel }) {
  return (
    <li className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-2xs">
      <p className="truncate font-mono font-medium" title={model.name}>
        {model.name}
      </p>
      <dl className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[var(--fg-muted)]">
        <RuntimeFact label={translate('runtime.size')} value={formatBytes(model.sizeBytes)} />
        <RuntimeFact
          label={translate('runtime.acceleratorSize')}
          value={
            model.sizeVramBytes === null
              ? translate('runtime.unknown')
              : formatBytes(model.sizeVramBytes)
          }
        />
        <RuntimeFact
          label={translate('runtime.context')}
          value={
            model.contextLength === null
              ? translate('runtime.unknown')
              : formatContextLength(model.contextLength)
          }
        />
        <RuntimeFact
          label={translate('runtime.expiry')}
          value={
            model.expiresAt
              ? formatRelativeTime(model.expiresAt)
              : translate('runtime.unknown')
          }
        />
      </dl>
      <p className="mt-0.5 text-[var(--fg-subtle)]">
        {model.source ?? translate('runtime.unknown')}
        {model.observedAt ? ` · ${formatDateTime(model.observedAt)}` : ''}
      </p>
    </li>
  )
}

function RuntimeFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt>{label}:</dt>
      <dd>{value}</dd>
    </div>
  )
}

function Observation({ observedAt }: { observedAt: string | null }) {
  return (
    <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
      {translate('runtime.sampled')}
      {observedAt ? ` · ${formatDateTime(observedAt)}` : ''}
    </p>
  )
}
