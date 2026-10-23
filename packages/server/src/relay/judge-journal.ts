/** Local D-199 observation journal and R3-b replay reader.
 *
 * The journal is a sidecar in the same node SQLite as the relay plugin. It is append-only for
 * normal operation: rows are inserted once per actually evaluated judge request and never
 * updated. The only deletion paths are the bounded retention purge and the owning run/session
 * deletion (foreign-key cascade). Values are scrubbed again here, so a secret registered after
 * collection cannot enter a row; file paths are intentionally retained (D-199).
 *
 * Nothing in this module exports rows. There is no REST route, event, log line, wake packet,
 * handoff or federation encoder here; the only reader is the local replay adapter below.
 */
import type { Db } from '../store/db.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { DEFAULT_REASONING_RETENTION_MS } from '../session-log/log.ts'
import { JUDGE_UNKNOWN_FACTS, type JudgeUnknownFact } from './judge-host.ts'
import { canonical } from './handoff.ts'
import {
  parseReplayCorpus,
  type ReplayCorpus,
  type ReplayRun,
  type ReplayStep
} from './judge-replay.ts'
import {
  evaluateJudgeSignals,
  type JudgeObservation,
  type JudgeSignal,
  type JudgeSignalPolicy
} from './judge-signals.ts'

/** Independent additive ledger 42; main user_version and ledgers 34-41 stay untouched. */
export const JUDGE_JOURNAL_MIGRATION_42 = `
CREATE TABLE relay_journal_migrations(version INTEGER PRIMARY KEY);
INSERT INTO relay_journal_migrations VALUES(42);
CREATE TABLE relay_judge_journal(
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES durable_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  cycle INTEGER NOT NULL CHECK(cycle >= 0),
  phase TEXT NOT NULL,
  layer TEXT NOT NULL,
  reason TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  packet TEXT NOT NULL CHECK(json_valid(packet)),
  observation TEXT CHECK(observation IS NULL OR json_valid(observation)),
  policy TEXT CHECK(policy IS NULL OR json_valid(policy)),
  signals TEXT NOT NULL CHECK(json_valid(signals)),
  unknown_facts TEXT NOT NULL CHECK(json_valid(unknown_facts)),
  unobserved TEXT NOT NULL CHECK(json_valid(unobserved)),
  state TEXT NOT NULL CHECK(state IN ('completed','unavailable','invalid','abandoned')),
  result TEXT NOT NULL CHECK(json_valid(result)),
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX relay_judge_journal_run ON relay_judge_journal(run_id, cycle, started_at);
CREATE INDEX relay_judge_journal_session ON relay_judge_journal(session_id, expires_at);
CREATE INDEX relay_judge_journal_expiry ON relay_judge_journal(expires_at);
CREATE TRIGGER relay_judge_journal_immutable BEFORE UPDATE ON relay_judge_journal
BEGIN SELECT RAISE(ABORT,'append only'); END;
`

export type JudgeJournalLayer = 'J1.5' | 'J2' | 'J3'
export type JudgeJournalState = 'completed' | 'unavailable' | 'invalid' | 'abandoned'

/** The host observation and evaluated signals attached to one evaluation. The cascade never
 * adds these to the judge prompt; they exist only for the local journal/replay path. */
export interface JudgeJournalContext {
  observation: JudgeObservation | null
  policy: JudgeSignalPolicy | null
  signals: readonly JudgeSignal[]
  /** `judgeUnknownFacts` for this sample, including the collector's declared unobserved facts. */
  unknownFacts?: readonly JudgeUnknownFact[]
  /** The collector's declared unobserved facts, unchanged. */
  unobserved?: readonly JudgeUnknownFact[]
}

/** Small boundary owned by the cascade. No SQLite type crosses into the cascade. */
export interface JudgeJournal {
  record(entry: JudgeJournalEntry): void | Promise<void>
  /** Best-effort completeness marker after a write failure. */
  incomplete?(runId: string): void
}

/** Construct the real sink only when the first row is recorded. `BEGIN IMMEDIATE`, DDL and a
 * schema-version check must never run while a relay start or executor is being assembled; a
 * foreign ledger value, a busy database or an open transaction disables this local sidecar and
 * leaves the judged relay (and its already-fenced verdict) untouched. Construction is tried once:
 * a persistent failure is a null journal, not a retry on every boundary. */
export function lazyJournal(create: () => JudgeJournal | null): JudgeJournal {
  let inner: JudgeJournal | null | undefined
  const resolve = (): JudgeJournal | null => {
    if (inner !== undefined) return inner
    try {
      inner = create()
    } catch {
      inner = null
    }
    return inner
  }
  return {
    record(entry) {
      const target = resolve()
      if (!target) return
      return target.record(entry)
    },
    incomplete(runId) {
      const target = resolve()
      if (target?.incomplete) target.incomplete(runId)
    }
  }
}

export interface JudgeJournalEntry {
  runId: string
  sessionId: string
  attemptId: string
  cycle: number
  phase: string
  layer: JudgeJournalLayer
  reason: string
  requestKey: string
  /** The exact scrubbed evidence object the judge/model/checker received. */
  packet: unknown
  observation: JudgeObservation | null
  policy: JudgeSignalPolicy | null
  signals: readonly JudgeSignal[]
  unknownFacts: readonly JudgeUnknownFact[]
  unobserved: readonly JudgeUnknownFact[]
  state: JudgeJournalState
  /** Sample verdicts, checker result or a fixed unavailable/invalid/canceled code. */
  result: unknown
  startedAt: number
  finishedAt: number
}

export interface JudgeJournalRow {
  id: number
  run_id: string
  session_id: string
  attempt_id: string
  /** Admission order from `run_attempts`; the replay reader never orders attempts by id. */
  attempt_ordinal?: number
  cycle: number
  phase: string
  layer: string
  reason: string
  request_key: string
  packet: string
  observation: string | null
  policy: string | null
  signals: string
  unknown_facts: string
  unobserved: string
  state: string
  result: string
  started_at: number
  finished_at: number
  expires_at: number
}

export interface JudgeJournalStoreOptions {
  scrubber: EgressScrubber
  clock?: () => number
  /** Defaults to the implemented D-113 reasoning retention. */
  retentionMs?: number
}

const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
  'interrupted'
])
const PHASE_ORDER = ['cycle_start', 'pre_seal'] as const
const LAYER_ORDER: Readonly<Record<string, number>> = { 'J2': 0, 'J1.5': 1, 'J3': 2 }

function invalid(message: string): never {
  throw new TypeError(`judge journal: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function unknownFacts(value: unknown, field: string): asserts value is readonly JudgeUnknownFact[] {
  if (!Array.isArray(value) || value.some((fact) => !JUDGE_UNKNOWN_FACTS.includes(fact)) ||
    new Set(value).size !== value.length) {
    invalid(`invalid ${field}`)
  }
}

/** One retention implementation shared with reasoning: the session/run owns the row and a
 * parent Thread TTL may shorten, never extend, the diagnostic window. */
function journalExpiry(
  db: Db,
  sessionId: string,
  now: number,
  retentionMs: number
): number {
  const base = now + retentionMs
  const row = db
    .prepare(
      `SELECT t.retention_policy AS policy,
              t.last_user_activity_at AS activity,
              t.created_at AS created
       FROM sessions s LEFT JOIN threads t ON t.id=s.thread_id
       WHERE s.id=?`
    )
    .get(sessionId) as
    | { policy: string | null; activity: string | null; created: string | null }
    | undefined
  if (!row || row.policy !== 'ttl') return base
  const activity = Date.parse(row.activity ?? row.created ?? '')
  return Number.isFinite(activity)
    ? Math.min(base, activity + DEFAULT_REASONING_RETENTION_MS)
    : base
}

function pickStep(row: JudgeJournalRow): boolean {
  return (PHASE_ORDER as readonly string[]).includes(row.phase) &&
    row.observation !== null &&
    row.policy !== null
}

/** A real ledger moves an item to `done` only after a passing gate; an executor that asks for
 * verification leaves it at `verification_requested` (`store.ts`). Both statuses are therefore
 * a done claim, while `open` is not. Acceptance is the newest gate at the packet's current head:
 * false when any claimed item failed there, null when evidence is missing or incomplete. */
function claimsAndAcceptance(packet: unknown): {
  claimsDone: boolean
  acceptancePassed: boolean | null
} {
  if (!isRecord(packet) || !isRecord(packet.items)) {
    return { claimsDone: false, acceptancePassed: null }
  }
  const entries = Object.entries(packet.items)
  if (entries.length === 0 ||
    entries.some(([, status]) => status !== 'done' && status !== 'verification_requested')) {
    return { claimsDone: false, acceptancePassed: null }
  }
  const claimed = entries.map(([id]) => id)
  const gates = Array.isArray(packet.gates)
    ? packet.gates.filter((gate): gate is Record<string, unknown> => isRecord(gate))
    : []
  const head = typeof packet.head === 'string' ? packet.head : null
  let acceptancePassed: boolean | null = true
  for (const id of claimed) {
    const relevant = gates.filter(
      (gate) => gate.item === id && (head === null || gate.head === head)
    )
    if (relevant.length === 0) {
      acceptancePassed = null
      continue
    }
    const latest = relevant.at(-1)!
    if (latest.ok === false) return { claimsDone: true, acceptancePassed: false }
    if (latest.ok !== true) acceptancePassed = null
  }
  return { claimsDone: true, acceptancePassed }
}

/** Turn journal rows of one finished run into the existing R3-b replay shape. There is no
 * ground-truth label in the journal, so labels stay empty unless the local caller supplies
 * them; a reader never invents a fault class. One J2 observation per cycle phase becomes one
 * step, preferring J2 over the checker/J3 rows recorded at the same boundary. */
export function journalReplayRun(
  rows: readonly JudgeJournalRow[],
  options: { labels?: ReplayRun['labels']; id?: string; policy?: JudgeSignalPolicy } = {}
): ReplayRun {
  const selected = new Map<string, JudgeJournalRow>()
  for (const row of rows) {
    if (!pickStep(row)) continue
    // Request keys already include the attempt id; the replay selection must too, or a recovery
    // attempt's boundary disappears and its sibling boundary attaches to the previous attempt.
    const key = `${row.attempt_id}:${row.cycle}:${row.phase}`
    const prior = selected.get(key)
    if (
      !prior ||
      (LAYER_ORDER[row.layer] ?? 99) < (LAYER_ORDER[prior.layer] ?? 99)
    ) {
      selected.set(key, row)
    }
  }
  const attemptOrder = (row: JudgeJournalRow): number => row.attempt_ordinal ?? 0
  const stepsInOrder = [...selected.values()].sort(
    (left, right) =>
      attemptOrder(left) - attemptOrder(right) ||
      left.cycle - right.cycle ||
      PHASE_ORDER.indexOf(left.phase as (typeof PHASE_ORDER)[number]) -
        PHASE_ORDER.indexOf(right.phase as (typeof PHASE_ORDER)[number]) ||
      left.id - right.id
  )
  if (stepsInOrder.length === 0) invalid('run has no replayable judge observations')
  const fromRows = JSON.parse(stepsInOrder[0]!.policy!) as JudgeSignalPolicy
  const policy = options.policy ?? fromRows
  const steps: ReplayStep[] = []
  let previous: number | null = null
  for (const row of stepsInOrder) {
    const rowPolicy = JSON.parse(row.policy!) as JudgeSignalPolicy
    if (canonical(rowPolicy) !== canonical(policy)) {
      invalid('observations were recorded under different signal policies')
    }
    const observation = JSON.parse(row.observation!) as JudgeObservation
    // Equal host-clock milliseconds are valid; the rows were ordered by attempt, cycle and
    // phase before this check, so the parser never sorts by an invented timestamp.
    if (previous !== null && observation.observedAt < previous) {
      invalid('journal observations are not non-decreasing in time')
    }
    previous = observation.observedAt
    if (canonical(evaluateJudgeSignals(observation, rowPolicy)) !== canonical(JSON.parse(row.signals))) {
      invalid('recorded signals disagree with the recorded observation')
    }
    const claims = claimsAndAcceptance(JSON.parse(row.packet))
    const step: ReplayStep = { observation }
    const unknownFacts = JSON.parse(row.unknown_facts) as JudgeUnknownFact[]
    if (unknownFacts.length > 0) step.unknownFacts = unknownFacts
    if (claims.claimsDone) {
      step.claimsDone = true
      step.acceptancePassed = claims.acceptancePassed
    }
    steps.push(step)
  }
  return parseReplayCorpus({
    version: 1,
    runs: [
      {
        id: options.id ?? stepsInOrder[0]!.run_id,
        origin: 'recorded',
        policy,
        steps,
        labels: options.labels ?? []
      }
    ]
  }).runs[0]!
}

export class JudgeJournalStore implements JudgeJournal {
  private readonly db: Db
  private readonly scrubber: EgressScrubber
  private readonly clock: () => number
  private readonly retentionMs: number

  constructor(db: Db, options: JudgeJournalStoreOptions) {
    this.db = db
    this.scrubber = options.scrubber
    this.clock = options.clock ?? Date.now
    this.retentionMs = options.retentionMs ?? DEFAULT_REASONING_RETENTION_MS
    if (!integer(this.retentionMs, 1)) invalid('retention must be a positive safe integer')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_journal_migrations'").get()) {
        this.db.exec(JUDGE_JOURNAL_MIGRATION_42)
      }
      const versions = this.db.prepare('SELECT version FROM relay_journal_migrations').all()
      if (versions.length !== 1 || versions[0]!.version !== 42) {
        invalid('unexpected schema version')
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Insert exactly once. A duplicate request key keeps the existing row: the stored result is
   * authoritative and a retry must not rewrite history. The scrubber must be ready: persisting
   * before every secret source is known would make a later registration unredactable. */
  record(entry: JudgeJournalEntry): void {
    if (!entry.runId || !entry.sessionId || !entry.attemptId || !entry.requestKey) {
      invalid('missing run/session/attempt/request identity')
    }
    if (!integer(entry.cycle, 0)) invalid('invalid cycle')
    if (!integer(entry.startedAt, 0) || !integer(entry.finishedAt, 0)) invalid('invalid timestamps')
    if (!['completed', 'unavailable', 'invalid', 'abandoned'].includes(entry.state)) {
      invalid('invalid state')
    }
    unknownFacts(entry.unknownFacts, 'unknown facts')
    unknownFacts(entry.unobserved, 'unobserved facts')
    if (!this.scrubber.isReady()) invalid('egress not ready')
    for (const value of [
      entry.runId,
      entry.sessionId,
      entry.attemptId,
      entry.phase,
      entry.layer,
      entry.reason,
      entry.requestKey
    ]) {
      if (this.scrubber.scrub(value) !== value) invalid('identity contains a registered secret')
    }
    const packet = canonical(this.scrubber.scrub(entry.packet))
    const observation = entry.observation === null
      ? null
      : canonical(this.scrubber.scrub(entry.observation))
    const policy = entry.policy === null ? null : canonical(this.scrubber.scrub(entry.policy))
    const signals = canonical(this.scrubber.scrub([...entry.signals]))
    const unknown = canonical(this.scrubber.scrub([...entry.unknownFacts]))
    const unobserved = canonical(this.scrubber.scrub([...entry.unobserved]))
    const result = canonical(this.scrubber.scrub(entry.result))
    if (packet === undefined || result === undefined) invalid('unserializable payload')
    const expiresAt = journalExpiry(
      this.db,
      entry.sessionId,
      entry.finishedAt,
      this.retentionMs
    )
    this.db
      .prepare(
        `INSERT INTO relay_judge_journal(
           run_id, session_id, attempt_id, cycle, phase, layer, reason, request_key,
           packet, observation, policy, signals, unknown_facts, unobserved, state, result,
           started_at, finished_at, expires_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(request_key) DO NOTHING`
      )
      .run(
        entry.runId,
        entry.sessionId,
        entry.attemptId,
        entry.cycle,
        entry.phase,
        entry.layer,
        entry.reason,
        entry.requestKey,
        packet,
        observation,
        policy,
        signals,
        unknown,
        unobserved,
        entry.state,
        result,
        entry.startedAt,
        entry.finishedAt,
        expiresAt
      )
  }

  private scrubJson(value: string): string {
    return canonical(this.scrubber.scrub(JSON.parse(value)))
  }

  /** Finished-run, unexpired rows in stable order. Expiry is enforced on read as it is for
   * reasoning (D-113), not only by the periodic purge. A live run is refused: a partial corpus
   * is not a recorded one, and a caller must not mistake it for gate evidence. Values are
   * scrubbed again on read so a secret registered after the write is still redacted. */
  readRun(runId: string, now = this.clock()): JudgeJournalRow[] {
    if (!integer(now, 0)) invalid('invalid read time')
    if (!this.scrubber.isReady()) invalid('egress not ready')
    const run = this.db.prepare('SELECT state FROM durable_runs WHERE id=?').get(runId) as
      | { state: string }
      | undefined
    if (!run) invalid('run not found')
    if (!TERMINAL_RUN_STATES.has(run.state)) invalid('run is not finished')
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_judge_journal'").get()) {
      return []
    }
    const rows = this.db
      .prepare(
        `SELECT j.*, a.ordinal AS attempt_ordinal
         FROM relay_judge_journal j
         LEFT JOIN run_attempts a ON a.id=j.attempt_id
         WHERE j.run_id=? AND j.expires_at > ?
         ORDER BY a.ordinal, j.cycle,
           CASE j.phase WHEN 'cycle_start' THEN 0 WHEN 'pre_seal' THEN 1 ELSE 2 END,
           j.id`
      )
      .all(runId, now) as unknown as JudgeJournalRow[]
    for (const row of rows) {
      for (const value of [
        row.run_id,
        row.session_id,
        row.attempt_id,
        row.phase,
        row.layer,
        row.reason,
        row.request_key
      ]) {
        if (this.scrubber.scrub(value) !== value) {
          invalid('stored identity contains a registered secret')
        }
      }
    }
    return rows.map((row) => ({
      ...row,
      packet: this.scrubJson(row.packet),
      observation: row.observation === null ? null : this.scrubJson(row.observation),
      policy: row.policy === null ? null : this.scrubJson(row.policy),
      signals: this.scrubJson(row.signals),
      result: this.scrubJson(row.result)
    }))
  }

  purgeExpired(now = this.clock()): number {
    if (!integer(now, 0)) invalid('invalid purge time')
    return Number(this.db.prepare('DELETE FROM relay_judge_journal WHERE expires_at <= ?').run(now).changes)
  }

  purgeRun(runId: string): number {
    return Number(this.db.prepare('DELETE FROM relay_judge_journal WHERE run_id=?').run(runId).changes)
  }

  purgeSession(sessionId: string): number {
    return Number(this.db.prepare('DELETE FROM relay_judge_journal WHERE session_id=?').run(sessionId).changes)
  }
}

/** Construct the store only when this database already has the journal table. The relay plugin
 * uses this to purge rows left by an earlier run even when no judge executes on this start. */
export function journalIfPresent(db: Db, scrubber: EgressScrubber): JudgeJournalStore | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_judge_journal'").get()) return null
  return new JudgeJournalStore(db, { scrubber })
}

export function readJournalReplay(
  store: JudgeJournalStore,
  runId: string,
  options: { labels?: ReplayRun['labels']; policy?: JudgeSignalPolicy } = {}
): ReplayRun {
  const rows = store.readRun(runId)
  if (rows.length === 0) invalid(`finished run ${runId} has no journal rows`)
  return journalReplayRun(rows, { ...options, id: runId })
}

export function readJournalCorpus(
  store: JudgeJournalStore,
  runIds: readonly string[],
  options: {
    labels?: ReplayRun['labels']
    labelsById?: Readonly<Record<string, ReplayRun['labels']>>
    policy?: JudgeSignalPolicy
  } = {}
): ReplayCorpus {
  if (runIds.length === 0) invalid('no run ids')
  return parseReplayCorpus({
    version: 1,
    runs: runIds.map((runId) =>
      readJournalReplay(store, runId, {
        policy: options.policy,
        labels: options.labelsById?.[runId] ?? options.labels
      })
    )
  })
}
