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
 * P2-L adds an explicit connection-owned exact-file download after P2-K confirmation.
 * It still offers no Install/Pull/Create action and never projects success as runtime-ready.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  FitLevel,
  HuggingFaceGgufFile,
  HuggingFaceDownloadFailureReason,
  HuggingFaceDownloadProvenance,
  HuggingFaceDownloadRefusalReason,
  HuggingFaceRepository,
  HuggingFaceSearchResult,
  HuggingFaceSelectionRefusalReason,
  HuggingFaceSelectionResult,
  HuggingFaceTransportFailureReason,
  HuggingFaceUnknownVerdictReason,
} from '@guanxi/contract'
import { Badge, Button, Callout, Disclosure, EmptyState, Input, Meter, Skeleton } from '../../components/ui.tsx'
import { ApiRequestError, api, streamHuggingFaceDownload } from '../../lib/api.ts'
import { formatBytes, formatContextLength, formatDateTime, formatUtilization } from '../../lib/format.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { HuggingFaceImportControl } from './HuggingFaceImportControl.tsx'

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

/**
 * P2-K refusal reasons. Every one is a live re-check outcome — the repository,
 * revision or inventory may have changed since the caller last saw it — never a
 * request-shape error.
 */
const SELECTION_REFUSAL_KEYS: Record<HuggingFaceSelectionRefusalReason, LocaleKey> = {
  repository_not_supported: 'hf.select.refused.repository_not_supported',
  revision_not_exact: 'hf.select.refused.revision_not_exact',
  revision_mismatch: 'hf.select.refused.revision_mismatch',
  file_inventory_truncated: 'hf.select.refused.file_inventory_truncated',
  file_inventory_malformed: 'hf.select.refused.file_inventory_malformed',
  file_not_in_current_inventory: 'hf.select.refused.file_not_in_current_inventory',
}

const SELECTION_FIT_LEVEL_KEYS: Record<FitLevel, LocaleKey> = {
  green: 'catalog.filters.value.green',
  yellow: 'catalog.filters.value.yellow',
  red: 'catalog.filters.value.red',
  unknown: 'catalog.filters.value.unknown',
}

const DOWNLOAD_REFUSAL_KEYS: Record<HuggingFaceDownloadRefusalReason, LocaleKey> = {
  selection_stale: 'hf.download.refused.selection_stale',
  gated_repository: 'hf.download.refused.gated_repository',
  duplicate_active: 'hf.download.refused.duplicate_active',
  redirect_not_allowed: 'hf.download.refused.redirect_not_allowed',
  redirect_limit_exceeded: 'hf.download.refused.redirect_limit_exceeded',
}

const DOWNLOAD_FAILURE_KEYS: Record<HuggingFaceDownloadFailureReason, LocaleKey> = {
  provider_unavailable: 'hf.download.failed.provider_unavailable',
  connect_timeout: 'hf.download.failed.connect_timeout',
  body_timeout: 'hf.download.failed.body_timeout',
  provider_error: 'hf.download.failed.provider_error',
  content_length_invalid: 'hf.download.failed.content_length_invalid',
  maximum_bytes_exceeded: 'hf.download.failed.maximum_bytes_exceeded',
  size_mismatch: 'hf.download.failed.size_mismatch',
  checksum_mismatch: 'hf.download.failed.checksum_mismatch',
  invalid_gguf_magic: 'hf.download.failed.invalid_gguf_magic',
  invalid_gguf_header: 'hf.download.failed.invalid_gguf_header',
  unsupported_gguf_version: 'hf.download.failed.unsupported_gguf_version',
  filesystem_error: 'hf.download.failed.filesystem_error',
}

export function HuggingFaceDiscovery({
  contextLength,
  onInstalled,
}: {
  contextLength: number
  onInstalled?: () => void
}) {
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
                <RepositoryCard
                  repository={repository}
                  contextLength={contextLength}
                  onInstalled={onInstalled}
                />
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
  return gatedStateLabel(repository.gated)
}

function gatedStateLabel(gated: HuggingFaceRepository['gated']): string {
  if (gated.state === 'open') return translate('hf.repository.gated.open')
  if (gated.state === 'unknown') return translate('hf.repository.gated.unknown')
  return gated.mode === 'auto'
    ? translate('hf.repository.gated.gated.auto')
    : gated.mode === 'manual'
      ? translate('hf.repository.gated.gated.manual')
      : translate('hf.repository.gated.gated.unspecified')
}

function licenseLabel(repository: HuggingFaceRepository): string {
  return licenseStateLabel(repository.license)
}

function licenseStateLabel(license: HuggingFaceRepository['license']): string {
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

/** A live re-check outcome, not a request-shape failure: `offline` is client-detected. */
type SelectionFailureReason = HuggingFaceTransportFailureReason | 'offline'

type SelectionState =
  | { kind: 'idle' }
  | { kind: 'selecting'; filePath: string }
  | {
      kind: 'confirmed'
      filePath: string
      result: Extract<HuggingFaceSelectionResult, { state: 'confirmed' }>
    }
  | { kind: 'refused'; filePath: string; reason: HuggingFaceSelectionRefusalReason }
  | { kind: 'failed'; filePath: string; reason: SelectionFailureReason }

/** Announces every terminal selection state, so a screen-reader user never hears silence. */
function selectionAnnouncement(state: SelectionState): string {
  if (state.kind === 'selecting') return translate('hf.select.selecting')
  if (state.kind === 'confirmed') return `${translate('hf.select.heading')}: ${state.filePath}`
  if (state.kind === 'refused') return translate(SELECTION_REFUSAL_KEYS[state.reason])
  if (state.kind === 'failed') {
    return state.reason === 'offline'
      ? translate('hf.error.offline')
      : translate(FAILURE_KEYS[state.reason])
  }
  return ''
}

type DownloadState =
  | { kind: 'idle' }
  | {
      kind: 'running'
      phase: 'preparing' | 'downloading' | 'verifying'
      completedBytes: number
      totalBytes: number | null
    }
  | { kind: 'completed'; provenance: HuggingFaceDownloadProvenance }
  | { kind: 'cancelled' }
  | { kind: 'refused'; reason: HuggingFaceDownloadRefusalReason }
  | { kind: 'failed'; reason: HuggingFaceDownloadFailureReason }

function downloadAnnouncement(state: DownloadState): string {
  if (state.kind === 'running') {
    if (state.phase === 'preparing') return translate('hf.download.preparing')
    if (state.phase === 'verifying') return translate('hf.download.verifying')
    return translate('hf.download.downloading')
  }
  if (state.kind === 'completed') return translate('hf.download.completed')
  if (state.kind === 'cancelled') return translate('hf.download.cancelled')
  if (state.kind === 'refused') return translate('hf.download.refused')
  if (state.kind === 'failed') return translate('hf.download.failed')
  return ''
}

function HuggingFaceDownloadControl({
  result,
  onInstalled,
}: {
  result: Extract<HuggingFaceSelectionResult, { state: 'confirmed' }>
  onInstalled?: () => void
}) {
  const [state, setState] = useState<DownloadState>({ kind: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  const attemptRef = useRef(0)
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  const statusRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptRef.current += 1
      controllerRef.current?.abort('hf-download-connection-closed')
    }
  }, [])

  useEffect(() => {
    if (state.kind === 'idle' || state.kind === 'running') return
    statusRef.current?.focus()
  }, [state.kind])

  const start = async () => {
    if (runningRef.current) return
    runningRef.current = true
    const controller = new AbortController()
    const attempt = ++attemptRef.current
    controllerRef.current = controller
    setState({
      kind: 'running', phase: 'preparing', completedBytes: 0, totalBytes: null,
    })
    let terminal = false
    try {
      for await (const event of streamHuggingFaceDownload(
        {
          identity: result.selection.identity,
          revision: result.selection.revision,
          filePath: result.selection.filePath,
          contextLength: result.fit.contextLength,
        },
        controller.signal,
      )) {
        if (
          !mountedRef.current
          || controller.signal.aborted
          || attemptRef.current !== attempt
          || controllerRef.current !== controller
        ) return
        if (event.type === 'state') {
          setState((current) => ({
            kind: 'running',
            phase: event.data.state,
            completedBytes: current.kind === 'running' ? current.completedBytes : 0,
            totalBytes: current.kind === 'running' ? current.totalBytes : null,
          }))
        } else if (event.type === 'progress') {
          setState({
            kind: 'running', phase: 'downloading',
            completedBytes: event.data.completedBytes,
            totalBytes: event.data.totalBytes,
          })
        } else if (event.type === 'completed') {
          terminal = true
          setState({ kind: 'completed', provenance: event.data.provenance })
          break
        } else if (event.type === 'cancelled') {
          terminal = true
          setState({ kind: 'cancelled' })
          break
        } else if (event.type === 'refused') {
          terminal = true
          setState({ kind: 'refused', reason: event.data.reason })
          break
        } else if (event.type === 'failed') {
          terminal = true
          setState({ kind: 'failed', reason: event.data.reason })
          break
        }
      }
      if (
        !terminal
        && !controller.signal.aborted
        && mountedRef.current
        && attemptRef.current === attempt
        && controllerRef.current === controller
      ) {
        setState({ kind: 'failed', reason: 'provider_unavailable' })
      }
    } catch {
      if (
        !controller.signal.aborted
        && mountedRef.current
        && attemptRef.current === attempt
        && controllerRef.current === controller
      ) {
        setState({ kind: 'failed', reason: 'provider_unavailable' })
      }
    } finally {
      if (controllerRef.current === controller && attemptRef.current === attempt) {
        controllerRef.current = null
        runningRef.current = false
      }
    }
  }

  const cancel = () => {
    attemptRef.current += 1
    controllerRef.current?.abort('hf-download-user-cancelled')
    controllerRef.current = null
    runningRef.current = false
    setState({ kind: 'cancelled' })
  }

  if (state.kind === 'idle') {
    return (
      <div className="mt-2">
        <Button
          size="sm"
          className="min-h-11 sm:min-h-0"
          onClick={() => void start()}
        >
          {translate('hf.download.action')}
        </Button>
        <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
          {translate('hf.download.boundary')}
        </p>
      </div>
    )
  }

  if (state.kind === 'running') {
    const ratio = state.totalBytes !== null && state.totalBytes > 0
      ? state.completedBytes / state.totalBytes
      : null
    return (
      <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg-subtle)] p-2">
        <p className="sr-only" role="status" aria-live="polite">
          {downloadAnnouncement(state)}
        </p>
        <p className="text-2xs font-medium">
          {state.phase === 'preparing'
            ? translate('hf.download.preparing')
            : state.phase === 'verifying'
              ? translate('hf.download.verifying')
              : translate('hf.download.downloading')}
        </p>
        {state.phase === 'downloading' ? (
          <div className="mt-2">
            {ratio === null ? (
              <p className="text-2xs text-[var(--fg-subtle)]">
                {formatBytes(state.completedBytes)} · {translate('hf.download.totalUnknown')}
              </p>
            ) : (
              <>
                <Meter value={ratio} label={translate('hf.download.progress')} height={4} />
                <p className="mt-1 font-mono text-2xs text-[var(--fg-subtle)]">
                  {formatBytes(state.completedBytes)} / {formatBytes(state.totalBytes!)}
                </p>
              </>
            )}
          </div>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 min-h-11 sm:min-h-0"
          onClick={cancel}
        >
          {translate('hf.download.cancel')}
        </Button>
      </div>
    )
  }

  const title = state.kind === 'completed'
    ? translate('hf.download.completed')
    : state.kind === 'cancelled'
      ? translate('hf.download.cancelled')
      : state.kind === 'refused'
        ? translate('hf.download.refused')
        : translate('hf.download.failed')
  return (
    <div
      ref={statusRef}
      tabIndex={-1}
      role={state.kind === 'completed' || state.kind === 'cancelled' ? 'status' : 'alert'}
      aria-live="polite"
      className="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg-subtle)] p-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <p className="text-2xs font-semibold">{title}</p>
      {state.kind === 'completed' ? (
        <div className="mt-1 min-w-0 text-2xs text-[var(--fg-subtle)]">
          <p>
            {formatBytes(state.provenance.observedSizeBytes)} · {translate('hf.download.format')}{' '}
            v{state.provenance.format.version}
          </p>
          <p className="mt-1 min-w-0 break-all font-mono">
            {translate('hf.download.checksum')}: {state.provenance.checksum.observedDigest}
          </p>
          <p className="mt-0.5">
            {state.provenance.checksum.relation === 'matched_provider_claim'
              ? translate('hf.download.checksum.matched')
              : translate('hf.download.checksum.observedOnly')}
          </p>
          <p className="mt-1">
            {translate('hf.repository.license')}: {licenseStateLabel(state.provenance.license)}
            {' · '}
            {translate('hf.repository.gated')}: {gatedStateLabel(state.provenance.gated)}
          </p>
          <p className="mt-1 min-w-0 break-all font-mono">
            {translate('hf.download.artifact')}: {state.provenance.artifact.id}
          </p>
          <HuggingFaceImportControl
            artifact={state.provenance}
            contextLength={result.fit.contextLength}
            onInstalled={onInstalled}
          />
        </div>
      ) : state.kind === 'refused' ? (
        <p className="mt-1 text-2xs text-[var(--danger)]">
          {translate(DOWNLOAD_REFUSAL_KEYS[state.reason])}
        </p>
      ) : state.kind === 'failed' ? (
        <p className="mt-1 text-2xs text-[var(--danger)]">
          {translate(DOWNLOAD_FAILURE_KEYS[state.reason])}
        </p>
      ) : null}
      <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
        {translate('hf.download.boundary')}
      </p>
      {state.kind !== 'completed' ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2 min-h-11 sm:min-h-0"
          onClick={() => void start()}
        >
          {translate('hf.download.retry')}
        </Button>
      ) : null}
    </div>
  )
}

export function RepositoryCard({
  repository,
  contextLength,
  onInstalled,
}: {
  repository: HuggingFaceRepository
  contextLength: number
  onInstalled?: () => void
}) {
  const badge = verdictBadge(repository)
  const { files, verdict, revision } = repository
  const canSelect =
    verdict.state === 'supported'
    && revision.state === 'exact_commit'
    && files.state === 'listed'
    && !files.truncated
    && files.malformedEntries === 0

  const [state, setState] = useState<SelectionState>({ kind: 'idle' })

  const fileButtonRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const changeButtonRef = useRef<HTMLButtonElement>(null)
  const lastActivatedPathRef = useRef<string | null>(null)
  /** Set right before an `idle` transition, so focus returns to the file it named. */
  const pendingFocusPathRef = useRef<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const inFlightRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const repositoryEvidenceRef = useRef(repository)
  /**
   * The last confirmed file, kept even while a context-window re-check is itself
   * in flight — reading live `state` instead would miss a second window change that
   * arrives before the first re-check settles.
   */
  const confirmedFilePathRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort('hf-selection-unmount')
    }
  }, [])

  // A new search can publish a newer sample for the same case-folded repository key.
  // Never keep a confirmed target or in-flight response across that evidence boundary.
  useEffect(() => {
    // Effects run after the first paint. Treating that initial effect as an evidence
    // change can abort a selection activated before passive effects have flushed.
    if (repositoryEvidenceRef.current === repository) return
    repositoryEvidenceRef.current = repository
    requestIdRef.current += 1
    controllerRef.current?.abort('hf-selection-repository-changed')
    controllerRef.current = null
    inFlightRef.current = null
    confirmedFilePathRef.current = null
    lastActivatedPathRef.current = null
    setState({ kind: 'idle' })
  }, [repository])

  const runSelection = async (filePath: string) => {
    if (revision.state !== 'exact_commit') return
    const revisionCommit = revision.commit
    // Repeating the same exact intent collapses to one request.
    const intent = JSON.stringify([filePath, revisionCommit, contextLength])
    if (inFlightRef.current === intent) return
    inFlightRef.current = intent
    const id = ++requestIdRef.current
    controllerRef.current?.abort('hf-selection-superseded')
    const controller = new AbortController()
    controllerRef.current = controller
    lastActivatedPathRef.current = filePath

    setState({ kind: 'selecting', filePath })
    try {
      const { result } = await api.selectHuggingFaceGgufFile(
        {
          identity: repository.identity,
          revision,
          filePath,
          contextLength,
        },
        controller.signal,
      )
      if (!mountedRef.current || id !== requestIdRef.current) return
      if (result.state === 'confirmed') {
        confirmedFilePathRef.current = filePath
        setState({ kind: 'confirmed', filePath, result })
      } else if (result.state === 'refused') {
        setState({ kind: 'refused', filePath, reason: result.reason })
      } else {
        setState({ kind: 'failed', filePath, reason: result.reason })
      }
    } catch (error) {
      if (controller.signal.aborted) return
      if (!mountedRef.current || id !== requestIdRef.current) return
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      setState({
        kind: 'failed',
        filePath,
        reason: offline
          ? 'offline'
          : error instanceof ApiRequestError && error.status === 400
            ? 'provider_error'
            : 'provider_unavailable',
      })
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (id === requestIdRef.current) inFlightRef.current = null
    }
  }

  // Restores focus once the confirmed panel (and its own "change" control) unmounts.
  useEffect(() => {
    if (state.kind !== 'idle' || pendingFocusPathRef.current === null) return
    const path = pendingFocusPathRef.current
    pendingFocusPathRef.current = null
    fileButtonRefs.current.get(path)?.focus()
  }, [state.kind])

  /*
   * `Button` sets `disabled` while `loading`, and a disabled focused element loses
   * focus to `<body>` in the browser. Once the request settles, move focus back to
   * the control the user actually activated instead of leaving it stranded.
   */
  useEffect(() => {
    if (state.kind === 'selecting') return
    if (typeof document === 'undefined' || document.activeElement !== document.body) return
    if (state.kind === 'confirmed') {
      changeButtonRef.current?.focus()
      return
    }
    if (lastActivatedPathRef.current) {
      fileButtonRefs.current.get(lastActivatedPathRef.current)?.focus()
    }
  }, [state.kind])

  // The fit preview is computed for the current context window; a confirmed
  // selection re-checks itself when that window changes rather than going stale.
  // A second window change arriving before the first re-check settles simply
  // supersedes it, via the same intent/abort guard `runSelection` already applies.
  const contextLengthRef = useRef(contextLength)
  useEffect(() => {
    if (contextLengthRef.current === contextLength) return
    contextLengthRef.current = contextLength
    const pendingPath = state.kind === 'selecting' ? state.filePath : null
    const filePath = confirmedFilePathRef.current ?? pendingPath
    if (filePath) void runSelection(filePath)
  }, [contextLength])

  const selectButton = (file: HuggingFaceGgufFile) => {
    const isThisFile = (state.kind === 'confirmed' || state.kind === 'selecting') && state.filePath === file.path
    const selected = state.kind === 'confirmed' && state.filePath === file.path
    return (
      <Button
        ref={(node) => {
          fileButtonRefs.current.set(file.path, node)
        }}
        size="sm"
        variant={selected ? 'secondary' : 'primary'}
        loading={state.kind === 'selecting' && isThisFile}
        disabled={selected || (state.kind === 'selecting' && !isThisFile)}
        onClick={() => void runSelection(file.path)}
        aria-label={`${translate('hf.select.aria')} ${file.path}`}
        className="min-h-11 shrink-0 sm:min-h-0"
      >
        {selected ? translate('hf.select.selected') : translate('hf.select.action')}
      </Button>
    )
  }

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
        key={repository.observedAt}
        className="mt-2"
        defaultOpen={canSelect}
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
              <li
                key={file.path}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 font-mono text-2xs"
              >
                <span className="min-w-0 break-all">
                  {file.path}
                  <span className="ml-2 font-sans text-[var(--fg-subtle)]">
                    {file.sizeBytes === null
                      ? translate('hf.repository.files.size.unknown')
                      : formatBytes(file.sizeBytes)}
                  </span>
                </span>
                {canSelect ? selectButton(file) : null}
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
        {verdict.state === 'supported' && revision.state !== 'exact_commit' ? (
          <p className="mt-1 text-2xs text-[var(--warning)]">
            {translate('hf.select.revisionUnavailable')}
          </p>
        ) : null}
      </Disclosure>

      {canSelect ? (
        <div className="mt-2">
          <p className="sr-only" role="status" aria-live="polite">
            {selectionAnnouncement(state)}
          </p>
          {state.kind === 'confirmed' ? (
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-inset)] p-2">
              <p className="text-2xs font-semibold">{translate('hf.select.heading')}</p>
              <p className="mt-1 min-w-0 break-all font-mono text-2xs">
                {state.result.selection.filePath}
              </p>
              <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
                {translate('hf.select.size')}:{' '}
                {state.result.selection.sizeBytes === null
                  ? translate('hf.repository.files.size.unknown')
                  : `${formatBytes(state.result.selection.sizeBytes)} · ${translate('hf.select.size.source')}`}
              </p>
              <div className="mt-2">
                {state.result.fit.state === 'calculated' ? (
                  <div className="text-2xs">
                    <p className="font-medium">
                      {translate(SELECTION_FIT_LEVEL_KEYS[state.result.fit.verdict.level])}
                      {' · '}
                      {formatUtilization(state.result.fit.verdict.utilization)}
                    </p>
                    <p className="mt-0.5 text-[var(--fg-subtle)]">
                      {formatBytes(state.result.fit.verdict.requiredBytes)} /{' '}
                      {formatBytes(state.result.fit.verdict.usableBytes)}
                      {' · '}
                      {translate('hf.select.fit.context')}{' '}
                      {formatContextLength(state.result.fit.contextLength)}
                    </p>
                    <p className="mt-1 text-[var(--warning)]">
                      {translate('hf.select.fit.reportedSizeOnly')}
                    </p>
                    <p className="mt-1 text-[var(--fg-subtle)]">
                      {translate('hf.select.fit.hardware')}:{' '}
                      {translate('hf.select.fit.hardware.source')}
                      {' · '}
                      {translate('hf.repository.observed')}:{' '}
                      {formatDateTime(state.result.fit.hardware.observedAt)}
                      {' · '}
                      {translate('hf.select.fit.hardware.confidence')}
                      {' · '}
                      {translate('hf.select.fit.calculated')}:{' '}
                      {formatDateTime(state.result.fit.calculatedAt)}
                    </p>
                  </div>
                ) : (
                  <p className="text-2xs text-[var(--warning)]">
                    {state.result.fit.reason === 'size_not_reported'
                      ? translate('hf.select.fit.unknown')
                      : translate('hf.select.fit.hardwareUnavailable')}
                  </p>
                )}
              </div>
              <p className="mt-2 text-2xs text-[var(--fg-subtle)]">
                {translate('hf.repository.gated')}: {gatedLabel(state.result.repository)}
                {' · '}
                {translate('hf.repository.license')}: {licenseLabel(state.result.repository)}
              </p>
              {state.result.repository.license.state === 'declared' ? (
                <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
                  {translate('hf.repository.license.note')}
                </p>
              ) : null}
              <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
                {translate('hf.repository.gated.note')}
              </p>
              <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg-subtle)] p-2">
                <p className="text-2xs font-medium">{translate('hf.select.next')}</p>
                <p className="mt-0.5 text-2xs text-[var(--fg-subtle)]">
                  {translate('hf.select.next.detail')}
                </p>
              </div>
          <HuggingFaceDownloadControl result={state.result} onInstalled={onInstalled} />
              <Button
                ref={changeButtonRef}
                size="sm"
                variant="ghost"
                className="mt-2 min-h-11 sm:min-h-0"
                onClick={() => {
                  pendingFocusPathRef.current = state.filePath
                  confirmedFilePathRef.current = null
                  setState({ kind: 'idle' })
                }}
              >
                {translate('hf.select.change')}
              </Button>
            </div>
          ) : state.kind === 'refused' || state.kind === 'failed' ? (
            <div role="alert">
              <Callout
                tone="danger"
                title={translate('hf.select.error.title')}
                action={
                  <Button
                    size="sm"
                    className="min-h-11 sm:min-h-0"
                    onClick={() => void runSelection(state.filePath)}
                  >
                    {translate('hf.error.retry')}
                  </Button>
                }
              >
                {state.kind === 'refused'
                  ? translate(SELECTION_REFUSAL_KEYS[state.reason])
                  : state.reason === 'offline'
                    ? translate('hf.error.offline')
                    : translate(FAILURE_KEYS[state.reason])}
              </Callout>
            </div>
          ) : null}
        </div>
      ) : null}

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
