/**
 * Startup health. A node that never answered gets a full screen with the start command; an
 * unavailable Ollama is a status item in the chrome (runtime icon) that says what to do (D-202).
 */
import type { Health } from '@guanxi/contract'
import { Callout, CopyButton, Spinner } from '../../components/ui.tsx'
import { errorMessage } from '../../lib/api.ts'
import { PRODUCT_NAME } from '../../lib/brand.ts'
import { translate } from '../../lib/locale.ts'

export function ollamaHealthState(health: Health): 'reachable' | 'unavailable' | 'incompatible' {
  return health.ollama.state ?? (health.ollama.running ? 'reachable' : 'unavailable')
}

export function HealthLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="flex items-center gap-2 text-xs text-secondary">
        <Spinner size={14} />
        {translate('health.loading')}
      </div>
    </div>
  )
}

/**
 * Сервер Guanxi не ответил вообще — до Ollama дело не дошло. The app keeps asking by itself with a
 * growing pause (useAsync retry), so this screen says how to start the node instead of offering Retry.
 */
export function HealthUnreachable({ error }: { error: unknown }) {
  return (
    <Centered
      title={translate('health.server.title', { product: PRODUCT_NAME })}
      description={translate('health.server.description')}
    >
      <Callout tone="danger" title={translate('health.server.whatHappened')}>
        {errorMessage(error)}
      </Callout>

      <div className="mt-3">
        <p className="mb-1.5 text-xs text-secondary">{translate('health.server.startHint')}</p>
        <CommandBlock command="npx guanxi" />
      </div>

      <p className="mt-4 text-xs text-secondary" role="status">{translate('health.server.reconnecting')}</p>
    </Centered>
  )
}

function CommandBlock({ command }: { command: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-divider bg-inset py-1.5 pr-1.5 pl-2.5">
      <code className="truncate font-mono text-xs select-all">{command}</code>
      <CopyButton text={command} />
    </div>
  )
}

function Centered({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-5">
      <div className="surface w-full max-w-lg rounded-xl p-5 shadow-[var(--shadow-card)]">
        <h1 className="text-base font-semibold">{title}</h1>
        {description && <p className="mt-1 mb-4 text-xs text-secondary">{description}</p>}
        {children}
      </div>
    </div>
  )
}
