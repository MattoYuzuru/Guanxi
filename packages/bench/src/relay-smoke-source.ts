// B3-b: the relay endpoint port and its real implementations. The HTTP source speaks to the owner API of a home node
// (loopback only) exactly as `guanxi relay exec` and the MS1 lead do. The optional SQLite reader opens the home node's
// database read-only, as MS1's own status script does, to recover sealed ledgers and per-call token counts.
// Errors carry fixed codes only; a response body, a path or a header is never echoed.
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { relayStartInputSchema, relayStartStatusSchema, sessionEventsResponse, type RelayStartInput, type RelayStartStatus } from '@guanxi/contract'
import { z } from 'zod'
import type { LedgerObservation, SealObservation } from './relay-smoke-build.ts'
import { canonicalText, sha256Hex, type EventLike } from './relay-smoke-facts.ts'

export class SmokeSourceError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'SmokeSourceError'; this.code = code }
}
export interface EventPage { events: EventLike[]; nextAfter: number; hasMore: boolean }

/** What the runner needs from one relay endpoint. `arm` selects the endpoint (and database) the arm was configured with. */
export interface RelaySource {
  readonly kind: 'http' | 'fake'
  start(arm: string, input: RelayStartInput, signal?: AbortSignal): Promise<RelayStartStatus>
  status(arm: string, key: string, signal?: AbortSignal): Promise<RelayStartStatus>
  stop(arm: string, key: string, signal?: AbortSignal): Promise<RelayStartStatus>
  events(arm: string, sessionId: string, after: number, signal?: AbortSignal): Promise<EventPage>
  /** Sealed ledgers and call costs of a finished run, or null when the arm has no readable home database. */
  ledger(arm: string, runId: string): Promise<LedgerObservation | null>
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** The owner API origin: http, loopback, no credentials, no path, no query. */
export function loopbackOrigin(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new SmokeSourceError('endpoint_invalid') }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new SmokeSourceError('endpoint_invalid')
  return url
}

/** Fixed codes the relay routes answer with (`relayStartCode` plus the route guards). Anything else is `relay_http_failed`. */
const KNOWN = new Set(['runtime_meter_unavailable', 'relay_workspace_unavailable', 'relay_local_connection_required', 'relay_local_model_required',
  'runtime_observation_stale', 'runtime_identity_unknown', 'runtime_identity_changed', 'runtime_counter_mismatch', 'runtime_count_invalid', 'runtime_request_changed',
  'relay_project_unavailable', 'relay_project_changed', 'relay_checkout_invalid', 'relay_policy_invalid', 'relay_idempotency_conflict', 'relay_stopped',
  'content_withheld', 'cleanup_unconfirmed', 'stale_lease', 'writer_busy', 'egress_not_ready', 'relay_closed', 'relay_not_found', 'judge_config_invalid',
  'contract_feature_unavailable', 'relay_start_failed', 'validation_failed', 'loopback_only', 'origin_denied', 'json_required'])
/** After one of these the relay answered and refused, so nothing is running for the key. A transport failure, a timeout or an
 * unreadable answer is different: the start may have been admitted, and the caller must reconcile by key before going on. */
export const isDefinitiveStartRefusal = (code: string): boolean => KNOWN.has(code) && code !== 'relay_not_found'
export interface HttpArm { url: string; homeDb?: string | undefined }
export class HttpRelaySource implements RelaySource {
  readonly kind = 'http' as const
  private readonly arms: Map<string, { origin: URL; reader: SqliteLedgerReader | null }>
  private readonly transport: typeof fetch
  private readonly timeoutMs: number
  private readonly startTimeoutMs: number
  private readonly stopTimeoutMs: number
  /** `POST /api/relay` answers only after the relay is prepared, and the first observation of a model hashes the whole GGUF
   * (minutes; ms1-live-run.md allows 15). The start and stop deadlines are therefore far longer than an ordinary request. */
  constructor(arms: Record<string, HttpArm>, options: { transport?: typeof fetch; timeoutMs?: number; startTimeoutMs?: number; stopTimeoutMs?: number } = {}) {
    this.transport = options.transport ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.startTimeoutMs = options.startTimeoutMs ?? 20 * 60_000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5 * 60_000
    this.arms = new Map(Object.entries(arms).map(([id, a]) => [id, { origin: loopbackOrigin(a.url), reader: a.homeDb ? new SqliteLedgerReader(a.homeDb) : null }]))
  }
  private arm(id: string) {
    const arm = this.arms.get(id)
    if (!arm) throw new SmokeSourceError('arm_endpoint_unknown')
    return arm
  }
  private async request(arm: string, path: string, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<unknown> {
    const { origin } = this.arm(arm)
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.transport(new URL(path, origin), { method, redirect: 'error', headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch { throw new SmokeSourceError(signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'endpoint_unreachable') }
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { code?: unknown } | null
      throw new SmokeSourceError(typeof value?.code === 'string' && KNOWN.has(value.code) ? value.code : 'relay_http_failed')
    }
    try { return await response.json() } catch { throw new SmokeSourceError('response_invalid') }
  }
  private static status(value: unknown): RelayStartStatus {
    const parsed = relayStartStatusSchema.safeParse(value)
    if (!parsed.success) throw new SmokeSourceError('response_invalid')
    return parsed.data
  }
  async start(arm: string, input: RelayStartInput, signal?: AbortSignal): Promise<RelayStartStatus> {
    return HttpRelaySource.status(await this.request(arm, '/api/relay', 'POST', relayStartInputSchema.parse(input), signal, this.startTimeoutMs))
  }
  async status(arm: string, key: string, signal?: AbortSignal): Promise<RelayStartStatus> {
    return HttpRelaySource.status(await this.request(arm, `/api/relay/starts/${encodeURIComponent(key)}`, 'GET', undefined, signal))
  }
  async stop(arm: string, key: string, signal?: AbortSignal): Promise<RelayStartStatus> {
    return HttpRelaySource.status(await this.request(arm, `/api/relay/starts/${encodeURIComponent(key)}/stop`, 'POST', {}, signal, this.stopTimeoutMs))
  }
  async events(arm: string, sessionId: string, after: number, signal?: AbortSignal): Promise<EventPage> {
    const value = await this.request(arm, `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}&limit=500&eventVersion=3`, 'GET', undefined, signal)
    const parsed = sessionEventsResponse.safeParse(value)
    if (!parsed.success) throw new SmokeSourceError('response_invalid')
    return { events: parsed.data.events.map(e => ({ seq: e.seq, type: e.type, createdAt: e.createdAt, jobId: e.jobId, data: e.data })), nextAfter: parsed.data.nextAfter, hasMore: parsed.data.hasMore }
  }
  async ledger(arm: string, runId: string): Promise<LedgerObservation | null> {
    return this.arm(arm).reader?.read(runId) ?? null
  }
}

const sealLedger = z.object({ cycle: z.number().int().nonnegative(), head: z.string(), items: z.record(z.string(), z.string()),
  evidence: z.array(z.object({ item: z.string(), head: z.string(), ok: z.boolean() }).passthrough()) }).passthrough()
const sealHandoff = z.object({ ledgerHash: z.string(), bundleHash: z.string() }).passthrough()

/** The home node keeps running and owns its database; the runner only ever reads it. */
export const HOME_DB_OPEN_OPTIONS = Object.freeze({ readOnly: true })

/** Read-only view of the three tables the cohort needs. The home node keeps running; this never writes. */
export class SqliteLedgerReader {
  private readonly path: string
  constructor(path: string) { this.path = path }
  /** The only way this class reaches the database: a read-only handle. The caller closes it.
   * The node's database is in WAL mode. Opening a WAL database whose node is down would make this process create the -wal/-shm
   * files next to it, so a database that claims WAL mode without a -shm file is refused: run against a live node. */
  open(): DatabaseSync {
    let header: Buffer
    try {
      const fd = openSync(this.path, 'r')
      try { header = Buffer.alloc(20); readSync(fd, header, 0, 20, 0) } finally { closeSync(fd) }
    } catch { throw new SmokeSourceError('home_database_unreadable') }
    if (header[18] === 2 && !existsSync(`${this.path}-shm`)) throw new SmokeSourceError('home_node_not_running')
    try { return new DatabaseSync(this.path, HOME_DB_OPEN_OPTIONS) } catch { throw new SmokeSourceError('home_database_unreadable') }
  }
  /** Names the missing tables, or an empty list when the schema is usable. */
  check(): string[] {
    const db = this.open()
    try {
      const have = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name))
      return ['relay_seals', 'relay_runs', 'run_costs'].filter(t => !have.has(t))
    } catch { throw new SmokeSourceError('home_database_unreadable') } finally { db.close() }
  }
  read(runId: string): LedgerObservation {
    const db = this.open()
    try {
      const sealRows = db.prepare('SELECT cycle, epoch, attempt_id AS attemptId, ledger, handoff, artifact_hash AS artifactHash, bundle FROM relay_seals WHERE run_id=? ORDER BY cycle').all(runId) as Array<{
        cycle: number; epoch: number; attemptId: string; ledger: string; handoff: string; artifactHash: string; bundle: Uint8Array }>
      const seals: SealObservation[] = []
      for (const row of sealRows) {
        let ledger: z.infer<typeof sealLedger>, handoff: z.infer<typeof sealHandoff> | null = null
        try { ledger = sealLedger.parse(JSON.parse(String(row.ledger))) } catch {
          // A seal whose ledger has an unexpected shape stays visible as a seal that could not be read, never silently dropped.
          seals.push({ cycle: Number(row.cycle), epoch: Number(row.epoch), attemptId: String(row.attemptId), head: '', items: {}, evidence: [], ledgerSha256: null, handoffLedgerSha256: null, bundleSha256: null,
            bundleMatchesHandoff: null, artifactMatchesHandoff: null, unreadable: true })
          continue
        }
        try { handoff = sealHandoff.parse(JSON.parse(String(row.handoff))) } catch { /* a corrupt artifact is a failed integrity fact */ }
        const bundleSha256 = row.bundle instanceof Uint8Array ? sha256Hex(row.bundle) : null
        seals.push({
          cycle: Number(row.cycle), epoch: Number(row.epoch), attemptId: String(row.attemptId), head: ledger.head, items: ledger.items,
          evidence: ledger.evidence.map(e => ({ item: e.item, head: e.head, ok: e.ok })),
          ledgerSha256: sha256Hex(canonicalText(JSON.parse(String(row.ledger)))),
          handoffLedgerSha256: handoff?.ledgerHash ?? null, bundleSha256,
          bundleMatchesHandoff: handoff && bundleSha256 ? bundleSha256 === handoff.bundleHash : null,
          artifactMatchesHandoff: handoff ? sha256Hex(canonicalText(JSON.parse(String(row.handoff)))) === String(row.artifactHash) : null,
        })
      }
      let final: LedgerObservation['final'] = null
      const snapshot = db.prepare('SELECT snapshot FROM relay_runs WHERE run_id=?').get(runId) as { snapshot: string } | undefined
      if (snapshot) {
        try {
          const l = sealLedger.parse(JSON.parse(String(snapshot.snapshot)))
          final = { cycle: l.cycle, head: l.head, items: l.items, evidence: l.evidence.map(e => ({ item: e.item, head: e.head, ok: e.ok })) }
        } catch { final = null }
      }
      const costs = (db.prepare('SELECT entry_key AS key, input_tokens AS inputTokens, output_tokens AS outputTokens FROM run_costs WHERE run_id=?').all(runId) as Array<{ key: string; inputTokens: number; outputTokens: number }>)
        .map(c => ({ key: String(c.key), inputTokens: Number(c.inputTokens), outputTokens: Number(c.outputTokens) }))
      return { seals, final, costs }
    } catch (error) {
      if (error instanceof SmokeSourceError) throw error
      throw new SmokeSourceError('home_database_unreadable')
    } finally { db.close() }
  }
}
