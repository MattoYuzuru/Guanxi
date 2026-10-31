// B3-b: a deterministic fake relay. It implements the same `RelaySource` port as the HTTP source and writes events in the
// shapes the real relay writes (store notes `{data, relay}`, executor notes flat, call ids and steps), so the whole
// collection path runs offline. Every number is invented; nothing here is a measurement.
import { createHash } from 'node:crypto'
import type { RelayStartInput, RelayStartStatus } from '@guanxi/contract'
import type { LedgerObservation, SealObservation } from './relay-smoke-build.ts'
import { canonicalText, sha256Hex, type EventLike } from './relay-smoke-facts.ts'
import type { EventPage, RelaySource } from './relay-smoke-source.ts'
import { SmokeSourceError } from './relay-smoke-source.ts'

export class FakeClock {
  private ms: number
  constructor(start: number) { this.ms = start }
  now = (): number => this.ms
  advance(by: number): number { this.ms += by; return this.ms }
  sleep = (by: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    this.ms += by
    return Promise.resolve()
  }
}

export interface FakeCycle {
  /** Items whose first gate evidence appears in this cycle, and whether that gate passed. */
  items?: ReadonlyArray<{ item: string; ok: boolean }>
  /** Whole-answer probe results by retry (cycles after the first only). Default one correct answer. */
  probe?: readonly boolean[]
  /** Model calls in the cycle, each with this many evaluated prompt tokens. */
  calls?: number
  inputTokens?: number
  /** A truncated reply: the run ends with `truncation_protocol` after the last call of this cycle. */
  truncated?: boolean
  /** The judge observer saw dead ends in this cycle; `repeat` fires `repeated_dead_end`. */
  deadEnd?: 'none' | 'repeat'
  /** Default true. False models a cycle that ended before its seal. */
  sealed?: boolean
  /** The stored handoff disagrees with the stored ledger. */
  tamper?: boolean
  /** Naive mode: the model-written summary was cut by the handoff bound. */
  summaryTruncated?: boolean
}
export interface FakeScenario {
  cycles: readonly FakeCycle[]
  status: RelayStartStatus['status']
  error?: string
  windowTokens?: number
  /** Plan items by id; every item that never gets gate evidence stays open. */
  noLedger?: boolean
}

const uuid = (n: number): string => { const h = createHash('sha256').update(`fake-${n}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}` }
const note = (relay: string, payload: Record<string, unknown>, nested: boolean): string => canonicalText(nested ? { relay, data: payload } : { relay, ...payload })

/** The default scenario: five cycles, one item each. The naive arm fails one item and does not finish. */
export function defaultScenario(input: RelayStartInput, arm: string): FakeScenario {
  const naive = arm.includes('naive')
  const cycles: FakeCycle[] = input.plan.items.map((item, i) => ({
    items: [{ item: item.id, ok: !(naive && i === 3) }],
    probe: [true],
    calls: 3, inputTokens: 18_000 + i * 2_000, sealed: true,
  }))
  const failed = naive && cycles.length >= 5
  return { cycles, status: failed ? 'failed' : 'completed', ...(failed ? { error: 'cap_reached' } : {}) }
}

interface Entry { arm: string; key: string; runId: string; sessionId: string; polls: number; status: RelayStartStatus['status']; error: string | null; events: EventLike[]; ledger: LedgerObservation | null; windowTokens: number }

export class FakeRelay implements RelaySource {
  readonly kind = 'fake' as const
  readonly started: Array<{ arm: string; input: RelayStartInput }> = []
  /** Keys a stop was requested for, in order. */
  readonly stopped: string[] = []
  /** The compaction mode the home node was started in (an operator setting, node-wide). Null derives it from the arm name. */
  homeMode: 'ledger' | 'naive' | null = null
  private readonly entries = new Map<string, Entry>()
  private seq = 0
  private readonly clock: FakeClock
  private readonly options: { scenario?: (input: RelayStartInput, arm: string) => FakeScenario; pollsBeforeDone?: number; cycleMs?: number; failStart?: (arm: string, key: string) => string | null; hangStart?: (arm: string, key: string) => boolean; failStop?: (arm: string, key: string) => boolean }
  constructor(clock: FakeClock, options: FakeRelay['options'] = {}) { this.clock = clock; this.options = options }

  private entry(arm: string, key: string): Entry {
    const e = this.entries.get(`${arm}\u0000${key}`)
    if (!e) throw new SmokeSourceError('relay_not_found')
    return e
  }
  private view(e: Entry): RelayStartStatus {
    const done = e.polls >= (this.options.pollsBeforeDone ?? 1)
    const status = done ? e.status : 'running'
    return {
      key: e.key, runId: e.runId, sessionId: e.sessionId, status, error: done ? e.error : null, source: 'run-home', observedAt: new Date(this.clock.now()).toISOString(), confidence: 'observed',
      runtime: { model: 'fake-model', digest: 'f'.repeat(64), contextTokens: e.windowTokens, runtimeVersion: 'fake/1', source: 'fake', observedAt: this.clock.now(), confidence: 'high' },
      runtimeAgeMs: 0, meter: null, reserves: null,
    }
  }
  async start(arm: string, input: RelayStartInput): Promise<RelayStartStatus> {
    const existing = this.entries.get(`${arm}\u0000${input.key}`)
    if (existing) return this.view(existing)
    const refusal = this.options.failStart?.(arm, input.key) ?? null
    if (refusal) throw new SmokeSourceError(refusal)
    this.started.push({ arm, input })
    const scenario = (this.options.scenario ?? defaultScenario)(input, arm)
    const runId = `run-${sha256Hex(`${arm}|${input.key}`).slice(0, 12)}`
    const e: Entry = { arm, key: input.key, runId, sessionId: `ses-${runId}`, polls: 0, status: scenario.status, error: scenario.error ?? null, events: [], ledger: null, windowTokens: scenario.windowTokens ?? 32_768 }
    this.play(e, scenario, input, this.homeMode ?? (arm.includes('naive') ? 'naive' : 'ledger'))
    this.entries.set(`${arm}\u0000${input.key}`, e)
    // The request was admitted but the answer never came back (a start that outlives the client deadline).
    if (this.options.hangStart?.(arm, input.key)) throw new SmokeSourceError('timeout')
    return this.view(e)
  }
  async status(arm: string, key: string): Promise<RelayStartStatus> {
    const e = this.entry(arm, key)
    e.polls++
    return this.view(e)
  }
  async stop(arm: string, key: string): Promise<RelayStartStatus> {
    this.stopped.push(key)
    if (this.options.failStop?.(arm, key)) throw new SmokeSourceError('endpoint_unreachable')
    const e = this.entry(arm, key)
    if (e.polls < (this.options.pollsBeforeDone ?? 1)) { e.status = 'canceled'; e.error = null; e.polls = Number.MAX_SAFE_INTEGER }
    return this.view(e)
  }
  async events(arm: string, sessionId: string, after: number): Promise<EventPage> {
    const e = [...this.entries.values()].find(x => x.arm === arm && x.sessionId === sessionId)
    if (!e) throw new SmokeSourceError('relay_not_found')
    const page = e.events.filter(x => x.seq > after).slice(0, 7)
    const lastSeq = e.events.at(-1)?.seq ?? 0
    return { events: page, nextAfter: page.at(-1)?.seq ?? after, hasMore: (page.at(-1)?.seq ?? after) < lastSeq }
  }
  async ledger(arm: string, runId: string): Promise<LedgerObservation | null> {
    return [...this.entries.values()].find(x => x.arm === arm && x.runId === runId)?.ledger ?? null
  }

  /** Writes the whole run at start; the status machine reveals it as the runner polls. */
  private play(e: Entry, scenario: FakeScenario, input: RelayStartInput, mode: 'ledger' | 'naive'): void {
    const ids = input.plan.items.map(i => i.id)
    const items: Record<string, string> = Object.fromEntries(ids.map(i => [i, 'open']))
    const evidence: Array<{ item: string; head: string; ok: boolean }> = []
    const seals: SealObservation[] = []
    const costs: Array<{ key: string; inputTokens: number; outputTokens: number }> = []
    const step = this.options.cycleMs ?? 60_000
    const push = (type: string, data: unknown) => {
      this.clock.advance(1_000)
      e.events.push({ seq: ++this.seq, type, createdAt: new Date(this.clock.now()).toISOString(), jobId: e.runId, data })
    }
    const noteOf = (relay: string, payload: Record<string, unknown>, nested: boolean) => push('agent.note', { text: note(relay, payload, nested) })
    let call = 0
    noteOf('initialized', { revision: input.plan.revision, hash: sha256Hex(`init-${e.key}`) }, true)
    // The naive arm states itself before its first model call; a ledger run writes none of the naive notes.
    if (mode === 'naive') noteOf('compaction', { mode: 'naive' }, false)
    scenario.cycles.forEach((spec, index) => {
      const cycle = index + 1
      this.clock.advance(step)
      noteOf('cycle_begin', { cycle, state: 'orient', hash: sha256Hex(`ledger-${cycle}`) }, true)
      if (spec.deadEnd) {
        noteOf('judge_signals', { phase: 'cycle_start', cycle, signals: spec.deadEnd === 'repeat' ? [{ layer: 'J1', code: 'repeated_dead_end', observedAt: this.clock.now(), source: 'harness.judge-signals', confidence: 'medium' }] : [], unknownFacts: ['heartbeat'] }, false)
      }
      const calls = spec.calls ?? 3
      for (let n = 0; n < calls; n++) {
        const messageId = uuid(++call)
        push('assistant.started', { messageId, model: n === 0 && cycle > 1 && mode === 'ledger' ? 'relay:probe' : 'relay:work', step: cycle })
        push('assistant.message', { messageId, step: cycle, text: 'withheld' })
        costs.push({ key: messageId, inputTokens: spec.inputTokens ?? 20_000, outputTokens: 300 })
      }
      if (cycle > 1 && mode === 'ledger') (spec.probe ?? [true]).forEach((correct, retry) => noteOf('probe', { retry, correct, damaged: false }, false))
      if (cycle > 1 && mode === 'naive') noteOf('probe_not_applicable', { mode: 'naive', cycle, reason: 'ledger_facts_not_shown', damaged: false }, false)
      for (const gate of spec.items ?? []) {
        evidence.push({ item: gate.item, head: `${cycle}`.padStart(40, 'a'), ok: gate.ok })
        items[gate.item] = gate.ok ? 'done' : 'verification_requested'
      }
      if (spec.truncated) { push('error', { code: 'truncation_protocol', message: 'Relay execution stopped; ledger retained.' }); return }
      if (spec.sealed !== false) {
        const ledgerSha = sha256Hex(`sealed-ledger-${e.key}-${cycle}`)
        seals.push({
          cycle, epoch: 1, head: `${cycle}`.padStart(40, 'a'), items: { ...items }, evidence: evidence.map(x => ({ ...x })),
          ledgerSha256: ledgerSha, handoffLedgerSha256: spec.tamper ? sha256Hex('other') : ledgerSha, bundleSha256: sha256Hex(`bundle-${cycle}`),
          bundleMatchesHandoff: true, artifactMatchesHandoff: true,
        })
        noteOf('sealed', { cycle, ledgerHash: ledgerSha, bundleHash: sha256Hex(`bundle-${cycle}`) }, true)
        if (mode === 'naive') noteOf('compaction_summary', { mode: 'naive', cycle, summaryBytes: 900, handoffLimitBytes: 4000, truncated: spec.summaryTruncated === true, degraded: false, inputDropped: spec.summaryTruncated ? 2 : 0, inputCut: 0 }, false)
      }
    })
    if (scenario.error && !scenario.cycles.some(c => c.truncated)) push('error', { code: scenario.error, message: 'Relay execution stopped; ledger retained.' })
    const cycle = scenario.cycles.length
    e.ledger = scenario.noLedger ? null : { seals, final: { cycle, head: `${cycle}`.padStart(40, 'a'), items: { ...items }, evidence }, costs }
  }
}
