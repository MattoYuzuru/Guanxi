/**
 * P2-J Marketplace section for read-only Hugging Face discovery.
 *
 * This is a deliberately separate source from the catalog list: Hugging Face rows have
 * their own provenance and are never mixed into catalog rows or the Installed list.
 *
 * The section is inert until the user explicitly submits a search. Mount, hover, focus,
 * navigation and reload issue no request. Every request carries an AbortSignal, and a
 * late response from a superseded search is discarded rather than rendered.
 *
 * Nothing here offers Install or Pull: choosing an exact GGUF file is a later slice, so
 * the UI says what is still required instead of implying a one-click install.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  HuggingFaceRepository,
  HuggingFaceSearchResult,
  HuggingFaceTransportFailureReason,
  HuggingFaceUnknownVerdictReason,
} from '@alamo/contract'
import { Badge, Button, Callout, Disclosure, EmptyState, Input, Skeleton } from '../../components/ui.tsx'
import { ApiRequestError, api } from '../../lib/api.ts'
import { formatBytes, formatDateTime } from '../../lib/format.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'

type Page = Extract<HuggingFaceSearchResult, { state: 'listed' | 'empty' }>

type FailureReason = HuggingFaceTransportFailureReason | 'offline' | 'invalid'

/** The exact request a retry must repeat, rather than restarting the walk. */
type Intent = { query: string; page: number; cursor: string | null }

type State =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'page'; page: Page; loadingMore: boolean }
  | { kind: 'failed'; reason: FailureReason; intent: Intent }
  /**
   * A further page failed. The results already on screen are kept: a transient
   * failure on page N must not destroy the pages the user already paid for.
   */
  | { kind: 'pageFailed'; page: Page; reason: FailureReason; intent: Intent }

/** Only the reasons the contract can publish are rendered; anything else stays generic. */
const FAILURE_KEYS: Record<HuggingFaceTransportFailureReason, LocaleKey> = {
  provider_unavailable: 'hf.error.reason.provider_unavailable',
  connect_timeout: 'hf.error.reason.connect_timeout',
  response_timeout: 'hf.error.reason.response_timeout',
  response_too_large: 'hf.error.reason.response_too_large',
  provider_malformed: 'hf.error.reason.provider_malformed',
  provider_error: 'hf.error.reason.provider_error',
  rate_limited: 'hf.error.reason.rate_limited',
  not_found: 'hf.error.reason.not_found',
  request_cancelled: 'hf.error.reason.request_cancelled',
}

/** Exhaustive by type: a future contract reason cannot silently render nothing. */
const VERDICT_REASON_KEYS: Record<HuggingFaceUnknownVerdictReason, LocaleKey> = {
  file_inventory_unavailable: 'hf.verdict.reason.file_inventory_unavailable',
  file_listing_truncated: 'hf.verdict.reason.file_listing_truncated',
  file_entries_malformed: 'hf.verdict.reason.file_entries_malformed',
  metadata_unavailable: 'hf.verdict.reason.metadata_unavailable',
  legacy_response: 'hf.verdict.reason.legacy_response',
}

export function HuggingFaceDiscovery() {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  /** Monotonic id so a late response from a superseded search can be discarded. */
  const requestIdRef = useRef(0)
  /** The exact request currently in flight, used to collapse duplicate intents. */
  const inFlightRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort('unmount')
    }
  }, [])

  const run = async (input: Intent, previous: Page | null) => {
    /** A failure keeps whatever was already on screen and remembers this intent. */
    const failWith = (reason: FailureReason) => {
      setState(previous
        ? { kind: 'pageFailed', page: previous, reason, intent: input }
        : { kind: 'failed', reason, intent: input })
    }
    // Repeating the *same* intent is one request, so a double submit or a
    // double click on "load more" cannot issue two. A different query or page is
    // a new intent: it supersedes the in-flight one instead of being dropped,
    // and the request id below is what discards the superseded late response.
    const intent = JSON.stringify([input.page, input.cursor, input.query])
    if (inFlightRef.current === intent) return
    inFlightRef.current = intent
    const id = ++requestIdRef.current
    controllerRef.current?.abort('superseded')
    const controller = new AbortController()
    controllerRef.current = controller

    setState(previous
      ? { kind: 'page', page: previous, loadingMore: true }
      : { kind: 'searching' })

    try {
      const { result } = await api.searchHuggingFace(
        {
          query: input.query,
          page: input.page,
          pageSize: 10,
          cursor: input.cursor,
        },
        controller.signal,
      )
      // Discard a superseded or unmounted response instead of rendering it.
      if (!mountedRef.current || id !== requestIdRef.current) return

      if (result.state === 'failed') {
        failWith(result.reason)
        return
      }
      // An `empty` further page is the end of the walk, not a loss of results:
      // keep the rows already shown and stop offering another page.
      if (previous && previous.state === 'listed' && result.state === 'empty') {
        setState({
          kind: 'page',
          page: {
            ...previous,
            droppedRows: previous.droppedRows + result.droppedRows,
            nextCursor: null,
          },
          loadingMore: false,
        })
        return
      }
      const merged: Page = previous && previous.state === 'listed' && result.state === 'listed'
        ? {
            ...result,
            repositories: [...previous.repositories, ...result.repositories],
            droppedRows: previous.droppedRows + result.droppedRows,
          }
        : result
      setState({ kind: 'page', page: merged, loadingMore: false })
    } catch (error) {
      if (controller.signal.aborted) return
      if (!mountedRef.current || id !== requestIdRef.current) return
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        failWith('offline')
        return
      }
      failWith(
        error instanceof ApiRequestError && error.status === 400
          ? 'invalid'
          : 'provider_unavailable',
      )
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      // Only the newest intent may clear the marker; a superseded request
      // finishing later must not reopen the one it was replaced by.
      if (id === requestIdRef.current) inFlightRef.current = null
    }
  }

  /** A new first-page search from whatever is currently typed. */
  const startSearch = () => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setState({ kind: 'idle' })
      return
    }
    void run({ query: trimmed, page: 1, cursor: null }, null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    startSearch()
  }

  /**
   * Repeats exactly the request that failed, including its page and cursor, so a
   * transient failure on page N does not silently restart the walk at page 1.
   */
  const retry = () => {
    if (state.kind === 'pageFailed') {
      void run(state.intent, state.page)
      return
    }
    if (state.kind === 'failed') {
      void run(state.intent, null)
      return
    }
    startSearch()
  }

  const loadMore = () => {
    if (state.kind !== 'page' || state.page.state !== 'listed') return
    const cursor = state.page.nextCursor
    if (cursor === null) return
    void run(
      { query: query.trim(), page: state.page.page + 1, cursor },
      state.page,
    )
  }

  /** Rows currently on screen, including those retained behind a failed next page. */
  const listed = state.kind === 'page' && state.page.state === 'listed'
    ? state.page
    : state.kind === 'pageFailed' && state.page.state === 'listed'
      ? state.page
      : null

  return (
    <section aria-labelledby="hf-discovery-heading" className="mt-6">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 id="hf-discovery-heading" className="text-sm font-semibold">
            {translate('hf.section.title')}
          </h2>
          <p className="mt-0.5 text-2xs text-[var(--fg-muted)]">
            {translate('hf.section.subtitle')}
          </p>
        </div>
        {listed ? (
          <p className="text-2xs text-[var(--fg-subtle)]">
            {translate('hf.results.count')}: {listed.repositories.length}
          </p>
        ) : null}
      </div>

      <form className="mt-3 flex min-w-0 flex-wrap items-end gap-2" onSubmit={submit}>
        <div className="min-w-0 flex-1 basis-48">
          <label className="block text-xs font-medium" htmlFor="hf-search-input">
            {translate('hf.search.label')}
          </label>
          <Input
            id="hf-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate('hf.search.placeholder')}
            aria-describedby="hf-search-hint"
            className="mt-1 min-h-11 w-full min-w-0 sm:min-h-0"
            type="search"
            autoComplete="off"
            maxLength={128}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          loading={state.kind === 'searching'}
          aria-label={translate('hf.search.aria.submit')}
          className="min-h-11 sm:min-h-0"
        >
          {state.kind === 'searching'
            ? translate('hf.search.searching')
            : translate('hf.search.submit')}
        </Button>
      </form>
      <p id="hf-search-hint" className="mt-1 text-2xs text-[var(--fg-subtle)]">
        {translate('hf.search.hint')}
      </p>

      {/*
        The announcement carries a monotonic counter so two searches returning the
        same count still change this node's text and are therefore announced.
      */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement(state, listed)}
      </p>

      <div className="mt-3">
        {state.kind === 'idle' ? (
          <EmptyState
            title={translate('hf.search.idle.title')}
            description={translate('hf.search.idle.description')}
          />
        ) : state.kind === 'searching' ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : listed ? (
          <ul className="min-w-0 space-y-2">
            {listed.repositories.map((repository) => (
              <li key={repository.identity.comparisonKey}>
                <RepositoryCard repository={repository} />
              </li>
            ))}
          </ul>
        ) : state.kind === 'page' || state.kind === 'pageFailed' ? (
          <EmptyState
            title={translate('hf.empty.title')}
            description={translate('hf.empty.description')}
          />
        ) : null}
      </div>

      {/*
        The whole Callout carries `role="alert"`, so the failure title, the reason and
        the retry action are announced together rather than as a bare sentence.
      */}
      {state.kind === 'failed' || state.kind === 'pageFailed' ? (
        <div className="mt-3" role="alert">
          <Callout
            tone="danger"
            title={state.kind === 'pageFailed'
              ? translate('hf.more.error.title')
              : translate('hf.error.title')}
            action={
              <Button size="sm" onClick={retry} className="min-h-11 sm:min-h-0">
                {translate('hf.error.retry')}
              </Button>
            }
          >
            {state.reason === 'offline'
              ? translate('hf.error.offline')
              : state.reason === 'invalid'
                ? translate('hf.error.invalidReference')
                : translate(FAILURE_KEYS[state.reason])}
            {state.kind === 'pageFailed'
              ? ` ${translate('hf.more.error.retained')}`
              : ''}
          </Callout>
        </div>
      ) : null}

      {/*
        Refused rows must be disclosed even when every row was refused, because an
        all-dropped page is otherwise indistinguishable from "nothing matched".
      */}
      {droppedRows(state) > 0 ? (
        <p className="mt-2 text-2xs text-[var(--warning)]" role="status">
          {translate('hf.results.dropped')}
        </p>
      ) : null}

      {listed && listed.nextCursor !== null ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={loadMore}
            loading={state.kind === 'page' && state.loadingMore}
            className="min-h-11 sm:min-h-0"
          >
            {translate('hf.more')}
          </Button>
          <p className="min-w-0 text-2xs text-[var(--fg-subtle)]">
            {translate('hf.more.bounded')}
          </p>
        </div>
      ) : null}

      <p className="mt-3 text-2xs text-[var(--fg-subtle)]">{translate('hf.boundary')}</p>
    </section>
  )
}

/** Refused rows, whether the page ended up listed, empty or failed mid-walk. */
function droppedRows(state: State): number {
  if (state.kind === 'page' || state.kind === 'pageFailed') return state.page.droppedRows
  return 0
}

/**
 * The screen-reader announcement. Every terminal state produces non-empty text, so
 * "no results" is never announced as silence after "reading metadata".
 */
function announcement(state: State, listed: Page | null): string {
  if (state.kind === 'idle') return ''
  if (state.kind === 'searching') return translate('hf.search.loading')
  const failure = state.kind === 'failed' || state.kind === 'pageFailed'
    ? ` ${translate('hf.error.title')}`
    : ''
  if (listed) {
    return `${translate('hf.results.count')}: ${listed.repositories.length}${failure}`
  }
  return `${translate('hf.empty.title')}${failure}`
}

function verdictBadge(repository: HuggingFaceRepository) {
  const { verdict } = repository
  if (verdict.state === 'supported') {
    return { tone: 'green' as const, label: translate('hf.verdict.supported') }
  }
  if (verdict.state === 'unsupported') {
    // Out of scope for this application's import path — never "broken".
    return { tone: 'neutral' as const, label: translate('hf.verdict.unsupported') }
  }
  return { tone: 'yellow' as const, label: translate('hf.verdict.unknown') }
}

function gatedLabel(repository: HuggingFaceRepository): string {
  const { gated } = repository
  if (gated.state === 'open') return translate('hf.repository.gated.open')
  if (gated.state === 'unknown') return translate('hf.repository.gated.unknown')
  return gated.mode === 'auto'
    ? translate('hf.repository.gated.gated.auto')
    : gated.mode === 'manual'
      ? translate('hf.repository.gated.gated.manual')
      : translate('hf.repository.gated.gated.unspecified')
}

function licenseLabel(repository: HuggingFaceRepository): string {
  const { license } = repository
  if (license.state === 'declared') return license.value
  if (license.source === 'conflicting_declarations') {
    return translate('hf.repository.license.conflicting')
  }
  // Unparseable text is not an absent declaration.
  if (license.source === 'malformed') {
    return translate('hf.repository.license.malformed')
  }
  if (license.source === 'metadata_unavailable') {
    return translate('hf.repository.license.unavailable')
  }
  return translate('hf.repository.license.unknown')
}

function RepositoryCard({ repository }: { repository: HuggingFaceRepository }) {
  const badge = verdictBadge(repository)
  const { files, verdict, revision } = repository

  return (
    <article className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {/* The exact case-sensitive Hub path, never the folded comparison key. */}
          <p className="min-w-0 break-all font-mono text-sm">
            {repository.identity.repositoryId}
          </p>
          <p className="mt-0.5 text-2xs text-[var(--fg-subtle)]">
            {translate('hf.repository.source')}: {translate('hf.repository.source.value')}
            {' · '}
            {translate('hf.repository.observed')}: {formatDateTime(repository.observedAt)}
          </p>
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      <p className="mt-2 text-2xs text-[var(--fg-muted)]">
        {verdict.state === 'supported'
          ? translate('hf.verdict.supported.detail')
          : verdict.state === 'unsupported'
            ? translate('hf.verdict.unsupported.detail')
            : translate('hf.verdict.unknown.detail')}
        {verdict.reason !== null
          ? ` ${translate(VERDICT_REASON_KEYS[verdict.reason])}`
          : ''}
      </p>

      <dl className="mt-2 grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-2xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-[var(--fg-subtle)]">{translate('hf.repository.revision')}</dt>
          <dd className="min-w-0 break-all font-mono">
            {revision.state === 'exact_commit'
              ? revision.commit
              : revision.source === 'malformed'
                ? translate('hf.repository.revision.malformed')
                : translate('hf.repository.revision.unknown')}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[var(--fg-subtle)]">{translate('hf.repository.gated')}</dt>
          <dd className="min-w-0">{gatedLabel(repository)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[var(--fg-subtle)]">{translate('hf.repository.license')}</dt>
          <dd className="min-w-0 break-words">
            {licenseLabel(repository)}
            {repository.license.state === 'declared' ? (
              <span className="block text-[var(--fg-subtle)]">
                {translate('hf.repository.license.note')}
              </span>
            ) : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[var(--fg-subtle)]">{translate('hf.repository.files.total')}</dt>
          <dd className="min-w-0">
            {files.state === 'listed'
              ? files.totalFiles
              : translate('hf.repository.files.unknown')}
          </dd>
        </div>
      </dl>

      <Disclosure
        className="mt-2"
        summary={`${translate('hf.repository.files')}: ${
          files.state === 'listed'
            ? files.ggufFiles.length === 0
              ? translate('hf.repository.files.none')
              : String(files.ggufFiles.length)
            : translate('hf.repository.files.unknown')
        }`}
      >
        {files.state === 'listed' && files.ggufFiles.length > 0 ? (
          <ul className="min-w-0 space-y-1">
            {files.ggufFiles.map((file) => (
              <li key={file.path} className="min-w-0 break-all font-mono text-2xs">
                {file.path}
                <span className="ml-2 font-sans text-[var(--fg-subtle)]">
                  {file.sizeBytes === null
                    ? translate('hf.repository.files.size.unknown')
                    : formatBytes(file.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-2xs text-[var(--fg-muted)]">
            {files.state === 'listed'
              ? translate('hf.repository.files.none')
              : translate('hf.repository.files.unknown')}
          </p>
        )}
        {files.state === 'listed' && files.truncated ? (
          <p className="mt-1 text-2xs text-[var(--warning)]">
            {translate('hf.repository.files.truncated')}
          </p>
        ) : null}
        {files.state === 'listed' && files.malformedEntries > 0 ? (
          <p className="mt-1 text-2xs text-[var(--warning)]">
            {translate('hf.repository.files.malformed')}
          </p>
        ) : null}
      </Disclosure>

      {repository.gated.state === 'gated' ? (
        <p className="mt-2 text-2xs text-[var(--fg-subtle)]">
          {translate('hf.repository.gated.note')}
        </p>
      ) : null}

      <p className="mt-2 text-2xs text-[var(--fg-subtle)]">
        <span className="font-medium">{translate('hf.next')}: </span>
        {translate('hf.next.detail')}
      </p>
    </article>
  )
}
