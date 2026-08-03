import {
  Component,
  useEffect,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { translate } from '../lib/locale.ts'

type ErrorScope = 'root' | 'chat' | 'runtime'

type Diagnostic = {
  correlationId: string
  observedAt: string
  route: string
  errorName: string
  errorMessage: string
  componentStack: string | null
}

type Props = {
  children: ReactNode
  scope: ErrorScope
}

type State = {
  diagnostic: Diagnostic | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { diagnostic: null }

  static getDerivedStateFromError(error: unknown): State {
    return { diagnostic: createDiagnostic(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const diagnostic = {
      ...(this.state.diagnostic ?? createDiagnostic(error)),
      componentStack: info.componentStack?.trim() || null,
    }
    console.error('[ui] client render error contained', {
      scope: this.props.scope,
      ...diagnostic,
    })
    this.setState({ diagnostic })
  }

  render(): ReactNode {
    if (!this.state.diagnostic) return this.props.children
    return <ErrorFallback scope={this.props.scope} diagnostic={this.state.diagnostic} />
  }
}

function ErrorFallback({
  scope,
  diagnostic,
}: {
  scope: ErrorScope
  diagnostic: Diagnostic
}) {
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (scope !== 'runtime') titleRef.current?.focus()
  }, [scope])

  const root = scope === 'root'
  const runtime = scope === 'runtime'
  const title = translate(
    root ? 'error.root.title' : runtime ? 'error.runtime.title' : 'error.chat.title',
  )
  const summary = translate(
    root ? 'error.root.summary' : runtime ? 'error.runtime.summary' : 'error.chat.summary',
  )

  return (
    <div
      className={
        root
          ? 'flex min-h-dvh items-center justify-center bg-[var(--bg)] p-4 text-[var(--fg)]'
          : runtime
            ? 'border-b border-[var(--border)] bg-[var(--bg-subtle)] p-2 text-[var(--fg)]'
            : 'flex min-h-[calc(100dvh-44px)] items-start justify-center bg-[var(--bg)] p-4 text-[var(--fg)] sm:p-6'
      }
    >
      <section
        role="alert"
        aria-labelledby={`error-title-${scope}`}
        className={
          runtime
            ? 'w-full px-1 py-1'
            : 'surface w-full max-w-2xl rounded-xl p-4 shadow-[var(--shadow-card)] sm:p-5'
        }
      >
        <p className="mb-1 font-mono text-2xs tracking-wide text-[var(--danger)] uppercase">
          {diagnostic.correlationId}
        </p>
        <h1
          ref={titleRef}
          id={`error-title-${scope}`}
          tabIndex={-1}
          className="text-base font-semibold"
        >
          {title}
        </h1>
        <p className="mt-1 max-w-prose text-xs text-[var(--fg-muted)]">{summary}</p>

        <div className={runtime ? 'mt-2 flex flex-wrap gap-2' : 'mt-4 flex flex-wrap gap-2'}>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-md border border-transparent bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-fg)] hover:brightness-110"
            onClick={() => window.location.reload()}
          >
            {translate('error.reload')}
          </button>
          {!root && !runtime && (
            <a
              href="/chat"
              className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 text-xs font-medium hover:bg-[var(--bg-subtle)]"
            >
              {translate('error.chats')}
            </a>
          )}
          <a
            href="/"
            className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 text-xs font-medium hover:bg-[var(--bg-subtle)]"
          >
            {translate('error.home')}
          </a>
        </div>

        <details className="mt-4 rounded-md border border-[var(--border)] bg-[var(--bg-subtle)]">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {translate('error.diagnostics')}
          </summary>
          <dl className="grid gap-x-3 gap-y-2 border-t border-[var(--border)] px-3 py-3 text-2xs sm:grid-cols-[max-content_minmax(0,1fr)]">
            <DiagnosticRow
              label={translate('error.correlation')}
              value={diagnostic.correlationId}
            />
            <DiagnosticRow label={translate('error.time')} value={diagnostic.observedAt} />
            <DiagnosticRow label={translate('error.route')} value={diagnostic.route} />
            <DiagnosticRow
              label={translate('error.type')}
              value={`${diagnostic.errorName}: ${diagnostic.errorMessage}`}
            />
            <DiagnosticRow
              label={translate('error.componentStack')}
              value={diagnostic.componentStack ?? translate('error.notAvailable')}
              multiline
            />
          </dl>
        </details>
      </section>
    </div>
  )
}

function DiagnosticRow({
  label,
  value,
  multiline = false,
}: {
  label: string
  value: string
  multiline?: boolean
}) {
  return (
    <>
      <dt className="font-medium text-[var(--fg-muted)]">{label}</dt>
      <dd
        className={
          multiline
            ? 'max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-[var(--fg)]'
            : 'min-w-0 break-all font-mono text-[var(--fg)]'
        }
      >
        {value}
      </dd>
    </>
  )
}

function createDiagnostic(error: unknown): Diagnostic {
  const typedError = error instanceof Error ? error : null

  return {
    correlationId: createCorrelationId(),
    observedAt: new Date().toISOString(),
    route:
      typeof window === 'undefined'
        ? translate('error.notAvailable')
        : `${window.location.pathname}${window.location.search}`,
    errorName: typedError?.name || 'Error',
    errorMessage: typedError?.message || translate('error.unknown'),
    componentStack: null,
  }
}

function createCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ui-${crypto.randomUUID()}`
  }
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
