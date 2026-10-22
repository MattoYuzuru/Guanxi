import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  parseEvidenceEvent, parseItemSpec, parsePlanAuthor, parseWorkMode,
  WorkError,
  type Activation, type ActivationInput, type EvidenceEvent, type ItemSpec, type PlanAuthor,
  type PlanRevision, type RevisionInput, type StoredEvidenceEvent, type WorkMode,
} from './types.ts'
import { deriveStatuses } from './status.ts'

const MIGRATION_VERSION = 1

/** WAL, foreign keys and the independent work ledger schema. Never rewrites R1/K2/R2 tables. */
const MIGRATION = `
CREATE TABLE wg1_plan_revisions (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('user','lead')),
  items TEXT NOT NULL,
  PRIMARY KEY(project_id, revision)
);
CREATE TRIGGER wg1_plan_revisions_no_replace BEFORE INSERT ON wg1_plan_revisions
WHEN EXISTS (
  SELECT 1 FROM wg1_plan_revisions
  WHERE project_id=NEW.project_id AND revision=NEW.revision
)
BEGIN SELECT RAISE(ABORT, 'plan revision is immutable'); END;
CREATE TRIGGER wg1_plan_revisions_no_update BEFORE UPDATE ON wg1_plan_revisions
BEGIN SELECT RAISE(ABORT, 'plan revision is immutable'); END;
CREATE TRIGGER wg1_plan_revisions_no_delete BEFORE DELETE ON wg1_plan_revisions
BEGIN SELECT RAISE(ABORT, 'plan revision is immutable'); END;
CREATE TABLE wg1_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY(project_id, revision) REFERENCES wg1_plan_revisions(project_id, revision)
);
CREATE INDEX wg1_events_project_seq ON wg1_events(project_id, seq);
CREATE TRIGGER wg1_events_no_replace BEFORE INSERT ON wg1_events
WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM wg1_events WHERE seq=NEW.seq)
BEGIN SELECT RAISE(ABORT, 'events are append only'); END;
CREATE TRIGGER wg1_events_no_update BEFORE UPDATE ON wg1_events
BEGIN SELECT RAISE(ABORT, 'events are append only'); END;
CREATE TRIGGER wg1_events_no_delete BEFORE DELETE ON wg1_events
BEGIN SELECT RAISE(ABORT, 'events are append only'); END;
CREATE TABLE wg1_activation (
  project_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK(mode IN ('off','run','project')),
  reason TEXT NOT NULL
);
INSERT INTO wg1_migrations VALUES (1);
`

export type WorkClock = () => number | string

function createdAt(clock: WorkClock): string {
  const now = clock()
  if (typeof now === 'string') {
    if (!Number.isFinite(Date.parse(now))) throw new WorkError('invalid_clock', 'clock must return a valid timestamp')
    return now
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new WorkError('invalid_clock', 'clock must return a finite number or timestamp string')
  }
  return new Date(now).toISOString()
}

function projectId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkError('invalid_revision', 'projectId must be a non-empty string')
  }
  return value
}

function cyclePath(items: ItemSpec[]): string[] | null {
  const byId = new Map(items.map(item => [item.id, item]))
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    const current = state.get(id) ?? 0
    if (current === 2) return null
    if (current === 1) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    state.set(id, 1)
    stack.push(id)
    for (const dependency of byId.get(id)!.dependsOn) {
      const found = visit(dependency)
      if (found) return found
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const item of items) {
    const found = visit(item.id)
    if (found) return found
  }
  return null
}

/** First proposal for an id. Duplicate proposals are ignored by derivation. */
function proposalSpec(events: StoredEvidenceEvent[], itemId: string): ItemSpec | null {
  for (const event of events) {
    if (event.type === 'proposed' && event.itemId === itemId) return event.item
  }
  return null
}

/** Proposals whose latest accept/reject decision is `accepted`. */
function acceptedProposalSpecs(events: StoredEvidenceEvent[]): ItemSpec[] {
  const proposals = new Map<string, ItemSpec>()
  const decisions = new Map<string, 'accepted' | 'rejected'>()
  for (const event of events) {
    if (event.type === 'proposed' && !proposals.has(event.itemId)) proposals.set(event.itemId, event.item)
    if ((event.type === 'accepted' || event.type === 'rejected') && proposals.has(event.itemId)) {
      decisions.set(event.itemId, event.type)
    }
  }
  return [...proposals]
    .filter(([id]) => decisions.get(id) === 'accepted')
    .map(([, spec]) => spec)
}

/**
 * D-172: an accepted proposal joins the dependency graph. Validate it against plan items and
 * previously accepted proposals before the acceptance event is stored, using the same missing
 * and cycle rules as `addRevision`.
 */
function validateProposalAcceptance(
  plan: PlanRevision,
  events: StoredEvidenceEvent[],
  itemId: string,
): void {
  if (plan.items.some(item => item.id === itemId)) return
  const proposal = proposalSpec(events, itemId)
  if (proposal === null) return
  const graph = new Map(plan.items.map(item => [item.id, item]))
  for (const spec of acceptedProposalSpecs(events)) graph.set(spec.id, spec)
  graph.set(proposal.id, proposal)
  const items = [...graph.values()]
  const ids = new Set(items.map(item => item.id))
  const missing = proposal.dependsOn.filter(dependency => !ids.has(dependency))
  if (missing.length > 0) {
    throw new WorkError(
      'invalid_proposal',
      `proposal ${proposal.id} depends on missing item${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
    )
  }
  const cycle = cyclePath(items)
  if (cycle) {
    throw new WorkError(
      'invalid_proposal',
      `proposal dependency cycle: ${cycle.join(' -> ')}`,
      { cycle },
    )
  }
}

export class WorkStore {
  readonly db: DatabaseSync
  readonly clock: WorkClock

  constructor(path: string, clock: WorkClock = Date.now) {
    this.clock = clock
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    }
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA recursive_triggers=ON;')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS wg1_migrations (version INTEGER PRIMARY KEY)')
      const row = this.db.prepare('SELECT version FROM wg1_migrations ORDER BY version DESC LIMIT 1').get() as
        { version: number } | undefined
      if (row === undefined) {
        this.db.exec(MIGRATION)
      } else if (Number(row.version) !== MIGRATION_VERSION) {
        throw new WorkError('schema_version', `unsupported work schema version ${row.version}`)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.db.close()
      throw error
    }
    if (path !== ':memory:') {
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, 0o600)
      }
    }
  }

  close(): void { this.db.close() }

  /** Revision numbers are previous + 1; the input can never choose or rewrite one. */
  addRevision(input: RevisionInput): PlanRevision {
    if (input === null || typeof input !== 'object') {
      throw new WorkError('invalid_revision', 'revision input must be an object')
    }
    const id = projectId(input.projectId)
    const author: PlanAuthor = parsePlanAuthor(input.author)
    if (!Array.isArray(input.items)) throw new WorkError('invalid_revision', 'items must be an array')
    const items = input.items.map((item, index) => parseItemSpec(item, `items[${index}]`))
    const ids = new Set<string>()
    for (const item of items) {
      if (ids.has(item.id)) throw new WorkError('duplicate_item', `duplicate item id: ${item.id}`)
      ids.add(item.id)
    }
    for (const item of items) {
      for (const dependency of item.dependsOn) {
        if (!ids.has(dependency)) {
          throw new WorkError('missing_dependency', `item ${item.id} depends on unknown item ${dependency}`)
        }
      }
    }
    const cycle = cyclePath(items)
    if (cycle) {
      throw new WorkError('dependency_cycle', `dependency cycle: ${cycle.join(' -> ')}`, { cycle })
    }
    const created = createdAt(this.clock)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare(
        'SELECT revision FROM wg1_plan_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1',
      ).get(id) as { revision: number } | undefined
      const revision = previous === undefined ? 1 : Number(previous.revision) + 1
      const plan: PlanRevision = { projectId: id, revision, createdAt: created, author, items }
      this.db.prepare('INSERT INTO wg1_plan_revisions VALUES (?,?,?,?,?)')
        .run(id, revision, created, author, JSON.stringify(items))
      this.db.exec('COMMIT')
      return plan
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  latestRevision(id: string): PlanRevision | null {
    const row = this.db.prepare(
      'SELECT project_id, revision, created_at, author, items FROM wg1_plan_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1',
    ).get(projectId(id)) as
      { project_id: string; revision: number; created_at: string; author: string; items: string } | undefined
    if (!row) return null
    return {
      projectId: String(row.project_id),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      author: parsePlanAuthor(row.author),
      items: (JSON.parse(String(row.items)) as unknown[]).map((item, index) => parseItemSpec(item, `items[${index}]`)),
    }
  }

  appendEvent(projectId: string, event: EvidenceEvent): StoredEvidenceEvent
  appendEvent(event: EvidenceEvent & { projectId: string }): StoredEvidenceEvent
  appendEvent(projectIdOrEvent: string | (EvidenceEvent & { projectId: string }), maybeEvent?: EvidenceEvent): StoredEvidenceEvent {
    if (projectIdOrEvent === null || typeof projectIdOrEvent !== 'string' && typeof projectIdOrEvent !== 'object') {
      throw new WorkError('invalid_event', 'project id or event is required')
    }
    const id = typeof projectIdOrEvent === 'string' ? projectId(projectIdOrEvent) : projectId(projectIdOrEvent.projectId)
    const raw = typeof projectIdOrEvent === 'string' ? maybeEvent : projectIdOrEvent
    if (raw === undefined) throw new WorkError('invalid_event', 'event is required')
    const event = parseEvidenceEvent(raw)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const plan = this.latestRevision(id)
      if (!plan) throw new WorkError('revision_not_found', `no plan revision for project ${id}`)
      const events = this.events(id, {})
      const current = deriveStatuses(plan, events)
      if (current.get(event.itemId)?.status === 'canceled'
        && !(event.type === 'human_decision' && event.decision === 'reopen')) {
        throw new WorkError('canceled', `item ${event.itemId} is canceled; only reopen is accepted`)
      }
      if (event.type === 'accepted') validateProposalAcceptance(plan, events, event.itemId)
      const result = this.db.prepare(
        'INSERT INTO wg1_events(project_id, revision, item_id, type, at, payload) VALUES (?,?,?,?,?,?)',
      ).run(id, plan.revision, event.itemId, event.type, event.at, JSON.stringify(event))
      this.db.exec('COMMIT')
      return { ...event, seq: Number(result.lastInsertRowid) }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Append order, optionally after a sequence. No limit means every matching event. */
  events(id: string, options: { afterSeq?: number; limit?: number } = {}): StoredEvidenceEvent[] {
    const project = projectId(id)
    const after = options.afterSeq ?? 0
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new WorkError('invalid_paging', 'afterSeq must be a non-negative integer')
    }
    const limit = options.limit ?? -1
    if (limit !== -1 && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new WorkError('invalid_paging', 'limit must be a positive integer')
    }
    const rows = this.db.prepare(
      'SELECT seq, payload FROM wg1_events WHERE project_id=? AND seq>? ORDER BY seq ASC LIMIT ?',
    ).all(project, after, limit) as Array<{ seq: number; payload: string }>
    return rows.map(row => {
      const event = parseEvidenceEvent(JSON.parse(String(row.payload)))
      return { ...event, seq: Number(row.seq) }
    })
  }

  setMode(id: string, mode: WorkMode, reason: string): Activation {
    const project = projectId(id)
    const parsed = parseWorkMode(mode)
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new WorkError('invalid_activation', 'reason must be a non-empty string')
    }
    this.db.prepare(`
      INSERT INTO wg1_activation(project_id, mode, reason) VALUES (?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode, reason=excluded.reason
    `).run(project, parsed, reason)
    return { projectId: project, mode: parsed, reason }
  }

  /** Default is always `off` (D-173); project mode needs an explicit activation. */
  mode(id: string): WorkMode {
    return this.activation(id).mode
  }

  activation(id: string): Activation {
    const project = projectId(id)
    const row = this.db.prepare('SELECT mode, reason FROM wg1_activation WHERE project_id=?').get(project) as
      { mode: string; reason: string } | undefined
    return row === undefined
      ? { projectId: project, mode: 'off', reason: 'default' }
      : { projectId: project, mode: parseWorkMode(row.mode), reason: String(row.reason) }
  }
}

/**
 * ADR-0032 §3 / D-173: project mode activates for two or more executors, a linked tracker,
 * or an explicitly opened backlog. It is never a default before the WL-series A/B.
 */
export function shouldActivateProject(input: ActivationInput): 'project' | 'off' {
  if (typeof input.executors !== 'number' || !Number.isFinite(input.executors) || input.executors < 0) {
    throw new WorkError('invalid_activation', 'executors must be a non-negative number')
  }
  return input.executors >= 2 || input.linkedTracker || input.backlogOpened ? 'project' : 'off'
}
