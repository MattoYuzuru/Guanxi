import { RelayJudgeCascade, type RelayCascadeInput } from './judge-cascade.ts'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Attempt } from '../runs/types.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { RelayStore } from './store.ts'
import type { RelayModel, Reply } from './model.ts'
import type { RelayWorkspace } from './workspace.ts'
import { DEFAULT_RELAY_LIMITS, invariant, RelayError, TRANSIENT_CALL_REASONS, type Ledger, type Handoff, type RelayLimits, type Reserves, type WindowObservation, type Thresholds } from './types.ts'
import { boundary, bounded, request, requestAsync, thresholds, upperTokens, wallDeadline, type AsyncMeasure, type Measure, type RequestParts, type RequestResult } from './budget.ts'
import { canonical, hash, strip, byteHash, selectNotes, probes, validateHandoff } from './handoff.ts'
import { parseModelJson } from './model-json.ts'
import type { JsonSchema } from './json-schema.ts'
import { actionResponseSchema, actionSchema, GENERIC_TOOLS, LOCAL_TOOLS, probeResponseSchema, PROBE_PROMPT, workPrompt, type RelayToolSpec } from './response-schemas.ts'
import { etaInputSchema, type EtaInput } from './eta.ts'
import { evaluateJudgeSignals, type JudgeObservation, type JudgeSignalPolicy } from './judge-signals.ts'
import { JudgeJournalStore, lazyJournal } from './judge-journal.ts'
import { judgeUnknownFacts, prepareJudgeSignals, type JudgePhase, type JudgeUnknownFact, type PreparedRelayJudge, type RelayJudgeCollectInput, type RelayJudgeInput, type RelayJudgeSummary } from './judge-host.ts'

export class RelayExecutor {
  private turns: string[] = []
  private controller = new AbortController()
  private running = false
  private readonly eta?: EtaInput
  private readonly cascade?: RelayJudgeCascade
  private readonly judge?: PreparedRelayJudge
  /** The tools the model may call: the executor's two ledger queries and exactly what the workspace serves. */
  readonly tools: readonly RelayToolSpec[]
  private readonly workText: string
  private readonly schemas?: { readonly action: JsonSchema; readonly probe: JsonSchema }
  readonly store: RelayStore; readonly model: RelayModel; readonly workspace: RelayWorkspace; readonly reserves: Reserves; readonly scrubber: EgressScrubber; readonly limits: RelayLimits
  constructor(store: RelayStore, model: RelayModel, workspace: RelayWorkspace, reserves: Reserves, scrubber: EgressScrubber, limits: RelayLimits = DEFAULT_RELAY_LIMITS, eta?: EtaInput, judgeSignals?: RelayJudgeInput, cascade?: RelayCascadeInput) {
    this.store = store; this.model = model; this.workspace = workspace; this.reserves = reserves; this.scrubber = scrubber; this.limits = limits
    this.eta = eta ? etaInputSchema.parse(eta) : undefined
    this.tools = Object.freeze([...LOCAL_TOOLS, ...(workspace.tools?.() ?? GENERIC_TOOLS)])
    this.workText = workPrompt(this.tools)
    // Decoding under a grammar never changes the prompt, so every count and bound below is unchanged by it.
    if (limits.structuredOutput !== false) this.schemas = Object.freeze({ action: actionResponseSchema(this.tools), probe: probeResponseSchema() })
    this.judge = judgeSignals ? prepareJudgeSignals(judgeSignals) : undefined
    this.cascade = cascade
      ? new RelayJudgeCascade(store, {
          ...cascade,
          ...(cascade.structuredOutput === undefined ? { structuredOutput: limits.structuredOutput !== false } : {}),
          // The journal constructor opens a write transaction and migrates. Keep it off the
          // executor/start assembly path; the cascade's existing record containment applies.
          journal: cascade.journal === undefined
            ? lazyJournal(() => new JudgeJournalStore(store.db, { scrubber, clock: store.clock }))
            : cascade.journal
        })
      : undefined
  }
  stop() { this.controller.abort() }
  private caps(l: Ledger, nextCycle = false): string | null {
    const c = l.caps
    if (c.cycles !== null && l.cycle + Number(nextCycle) > c.cycles) return 'cycles'
    if (c.tokens !== null && l.tokens >= c.tokens) return 'tokens'
    // A zero money cap admits only calls that cost exactly nothing (local compute): any spend or an unknown cost stops it. A positive cap
    // stops once it is reached, before a call that could exceed it.
    if (c.moneyMicros !== null && (l.unknownCosts > 0 || (c.moneyMicros === 0 ? l.moneyMicros > 0 : l.moneyMicros >= c.moneyMicros))) return 'money'
    if (c.wallMs !== null && this.store.clock() - l.startedAt >= c.wallMs) return 'wall'
    return null
  }
  private wrap(a: Attempt, reason: string): void {
    this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'cap', reason }) } })
    this.store.runs.wrappingUp(a)
  }
  /** One measure per cycle: packing, the boundary and dispatch evidence use the same unit. */
  private measure(w: WindowObservation, signal: AbortSignal): Measure | AsyncMeasure {
    const exact = this.model.countIsExact === true, remote = this.model.countAsync
    // A remote exact meter answers over the network. The executor never blocks the event loop for it.
    if (exact && remote) return Object.assign(async (value: string) => (await remote(this.scrubber.scrub(value), signal)) + w.framingTokens, { exact, async: true as const })
    return Object.assign((value: string) => exact
      ? this.model.count(this.scrubber.scrub(value)) + w.framingTokens
      : upperTokens(value, w), { exact })
  }
  private pack(prompt: string, parts: RequestParts, measure: Measure | AsyncMeasure, limit: number): Promise<RequestResult> | RequestResult {
    return 'async' in measure ? requestAsync(prompt, parts, measure, limit) : request(prompt, parts, measure, limit)
  }
  private dropped(a: Attempt, cycle: number, dropped: number, cut: number): void {
    this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'context_dropped', dropped, cut, cycle }) } })
  }
  /** The fixed reason of a failed call: a relay code, or a transport's own fixed refusal code. A message is never read. */
  private failureReason(error: unknown): string {
    const fixed = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value)
    return error instanceof RelayError ? error.code
      : fixed((error as { reason?: unknown })?.reason) ? (error as { reason: string }).reason
      : fixed((error as { code?: unknown })?.code) ? (error as { code: string }).code : 'unknown'
  }
  /** A cancel or takeover can revoke the fence while the executor is already reporting. */
  private lost(error: unknown): boolean {
    return error instanceof Error && 'code' in error && ['stale_lease', 'writer_busy', 'invalid_transition'].includes(String((error as { code?: unknown }).code))
  }
  /** R1 has no separate read-only fence probe; its existing fenced extension transaction is
   * the execution-fence check before the host await. */
  private checkExecution(a: Attempt): void {
    this.store.runs.mutate(a, () => undefined)
  }
  /** Await the trusted read-only collector without letting it own run completion. The race uses
   * the existing run signal only: there is no timeout and no new cancellation authority. A
   * collector that ignores the signal may still need cooperative cleanup of its underlying read,
   * but it cannot hold the executor, renewal or plugin disposal open. Late resolution/rejection
   * is consumed and discarded, so it cannot publish a note or resume work. */
  private collectJudge(judge: PreparedRelayJudge, input: RelayJudgeCollectInput): Promise<JudgeObservation> {
    const { signal } = input
    return new Promise<JudgeObservation>((resolve, reject) => {
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', aborted)
        action()
      }
      const aborted = () => finish(() => reject(signal.reason))
      if (signal.aborted) { aborted(); return }
      signal.addEventListener('abort', aborted, { once: true })
      // Recheck after installing the listener so an abort cannot slip between the two steps.
      if (signal.aborted) { aborted(); return }
      let pending: Promise<JudgeObservation>
      try { pending = judge.collect(input) } catch (error) { finish(() => reject(error)); return }
      // Both outcomes stay observed even after an abort wins the race.
      pending.then(
        observation => finish(() => resolve(observation)),
        error => finish(() => reject(error)),
      )
    })
  }
  /** One host observation at a synchronous boundary. The collector gets a detached ledger,
   * a detached attempt and the actual run signal; the note is published only after a successful
   * collection and evaluation, in the same R1-fenced transaction. No signal changes control flow. */
  private async judgeSample(a: Attempt, phase: JudgePhase, signal: AbortSignal): Promise<
    | {
        summary: RelayJudgeSummary
        observation: JudgeObservation
        policy: Readonly<JudgeSignalPolicy>
        unobserved: readonly JudgeUnknownFact[]
      }
    | undefined
  > {
    const judge = this.judge
    if (!judge) return
    signal.throwIfAborted()
    this.checkExecution(a)
    const ledger = structuredClone(this.store.read(a.run_id))
    const cycle = ledger.cycle
    const attempt = { id: a.id, runId: a.run_id, epoch: a.epoch, token: a.token }
    let observation: JudgeObservation
    try {
      observation = await this.collectJudge(judge, { attempt, ledger, signal })
    } catch (error) {
      // Cancellation and a revoked fence keep their existing loss/cancel semantics. Only a
      // live collector failure becomes the fixed observer error; no exception text is kept.
      signal.throwIfAborted()
      if (this.lost(error)) throw error
      throw new RelayError('judge_observation_unavailable')
    }
    signal.throwIfAborted()
    // The collector is a host await: recheck the execution fence before any publication.
    this.checkExecution(a)
    let signals: ReturnType<typeof evaluateJudgeSignals>
    try {
      signals = evaluateJudgeSignals(observation, judge.policy)
    } catch {
      throw new RelayError('judge_observation_invalid')
    }
    const summary: RelayJudgeSummary = {attempt, cycle, phase, signals, unknownFacts: judgeUnknownFacts(observation, judge.unobserved)}
    this.store.emit(a, { type: 'agent.note', data: { text: canonical({
      relay: 'judge_signals', phase, cycle, signals, unknownFacts: summary.unknownFacts,
    }) } })
    return {
      summary: structuredClone(summary),
      observation: structuredClone(observation),
      policy: judge.policy,
      unobserved: [...judge.unobserved]
    }
  }
  /** A fresh observation of the loaded runtime, before anything is counted. An exact count is valid only against a recent observation, and the
   * previous call, gate or judge sample may have taken minutes: counting first would refuse a request the runtime can still serve. The window must
   * be the one this cycle was planned for. Dispatch observes again itself, so the freshness rule there is unchanged. */
  private async fresh(a: Attempt, w: WindowObservation, signal: AbortSignal): Promise<void> {
    const waits = this.limits.transientRetryMs ?? []
    // No reservation is held yet, so a dropped link here can wait and re-observe just like a failed call. The fence is
    // rechecked after each wait: an observation under a deposed attempt is never used, even if the link came back.
    for (let retry = 0; ; retry++) {
      try {
        const current = await this.model.observe(signal)
        invariant(current.tokens === w.tokens && current.source === w.source, 'window_changed')
        return
      } catch (error) {
        const reason = this.failureReason(error)
        if (TRANSIENT_CALL_REASONS.has(reason) && retry < waits.length && !signal.aborted) {
          try { await sleep(waits[retry]!, undefined, { signal }) } catch { /* the stop is handled below */ }
          if (!signal.aborted) { this.checkExecution(a); continue }
        }
        throw error
      }
    }
  }
  private async call(a: Attempt, purpose: string, prompt: string, w: WindowObservation, t: Thresholds, signal: AbortSignal, responseSchema?: JsonSchema): Promise<Reply> {
    signal.throwIfAborted()
    invariant(this.scrubber.isReady(), 'egress_not_ready')
    const clean = this.scrubber.scrub(prompt)
    await this.fresh(a, w, signal)
    const count = this.model.countAsync ? await this.model.countAsync(clean, signal) : this.model.count(clean)
    invariant(Number.isSafeInteger(count) && count >= 0 && count <= t.H, 'context_ceiling')
    const l = this.store.read(a.run_id), reason = this.caps(l)
    if (reason) { this.wrap(a, reason); throw new RelayError('cap_reached') }
    // K3 may expand late redactions; reserve the entire admissible input ceiling.
    const inputReserve = t.H
    const quote = this.model.maxCostMicros?.(inputReserve, this.reserves.turn) ?? null
    invariant(quote === null || Number.isSafeInteger(quote) && quote >= 0, 'cost_bound_invalid')
    if ((l.caps.tokens !== null && l.tokens + inputReserve + this.reserves.turn > l.caps.tokens) ||
      (l.caps.moneyMicros !== null && (quote === null || l.moneyMicros + quote > l.caps.moneyMicros))) {
      this.wrap(a, 'call_reserve'); throw new RelayError('cap_reached')
    }
    const id = randomUUID()
    this.store.change(a, 'call_reserved', state => {
      invariant(state.pendingCall === null, 'call_pending')
      state.pendingCall = id; state.tokens += inputReserve + this.reserves.turn
      if (quote !== null) state.moneyMicros += quote
    })
    this.store.emit(a, { type: 'assistant.started', data: { messageId: id, model: 'relay:' + purpose, step: l.cycle } })
    let reply: Reply | undefined
    const waits = this.limits.transientRetryMs ?? []
    for (let retry = 0; reply === undefined; retry++) {
    try { reply = this.scrubber.scrub(await this.model.call(clean, { runId: a.run_id, requestId: id, maxOutput: this.reserves.turn, maxInput: t.H, window: w, signal, onStarted: () => this.store.runs.modelStarted(a),
      ...(responseSchema ? { responseSchema } : {}) })) }
    catch (error) {
      // Only a fixed code is recorded: a message may carry provider text or paths.
      // K3 keeps a trusted transport's fixed refusal code as `reason`; its own code is the generic provider_failed.
      const reason = this.failureReason(error)
      // A transient transport failure re-sends the same reserved call after a wait: the reservation, request id and prompt are unchanged,
      // nothing was observed, and dispatch re-observes the runtime. A stop, a lost fence or the wall cap end the waiting.
      if (TRANSIENT_CALL_REASONS.has(reason) && retry < waits.length && !signal.aborted) {
        this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'call_retry', purpose, reason, retry: retry + 1, waitMs: waits[retry] }) } })
        try { await sleep(waits[retry]!, undefined, { signal }) } catch { /* the stop is handled below */ }
        if (!signal.aborted && this.caps(this.store.read(a.run_id)) !== 'wall') continue
      }
      this.store.change(a, 'call_failed', state => { state.pendingCall = null; state.errors++ })
      this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'call_failed_reason', purpose, reason }) } })
      // A grammar the server rejects is rejected for every later call too: say so, instead of letting the probe retry and fail as something else.
      throw new RelayError(reason === 'response_schema_rejected' ? reason : 'model_failed')
    }
    }
    invariant([reply.inputTokens, reply.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0) &&
      (reply.moneyMicros === null || Number.isSafeInteger(reply.moneyMicros) && reply.moneyMicros >= 0), 'usage_invalid')
    this.store.change(a, 'call_observed', state => {
      state.pendingCall = null; state.tokens += reply.inputTokens + reply.outputTokens - inputReserve - this.reserves.turn
      if (quote !== null) state.moneyMicros -= quote
      if (reply.moneyMicros === null) state.unknownCosts++; else state.moneyMicros += reply.moneyMicros
    })
    this.store.runs.recordCost(a, { key: id, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, costMicrounits: reply.moneyMicros, currency: 'USD' })
    // Drop reasoning entirely. It is neither a narrative input nor a plaintext event.
    this.store.emit(a, { type: 'assistant.message', data: { messageId: id, step: l.cycle, text: reply.text } })
    invariant(!reply.inputTruncated && reply.inputTokens <= t.H && reply.outputTokens <= this.reserves.turn, 'truncation_protocol')
    if (reply.outputLimited) {
      if (purpose === 'narrative') throw new RelayError('narrative_output_limited')
      if (purpose !== 'work') throw new RelayError('truncation_protocol')
    }
    const exhausted = this.caps(this.store.read(a.run_id))
    if (exhausted) { this.wrap(a, exhausted); throw new RelayError('cap_reached') }
    return reply
  }
  private make(a: Attempt, l: Ledger, bundle: Uint8Array, narrative: string, degraded: boolean, max: number): Handoff {
    const h: Handoff = { format: 'guanxi.handoff/v1', runId: a.run_id, cycle: l.cycle, attemptId: a.id, epoch: a.epoch, token: a.token,
      ledgerHash: hash(l), ledger: { ref: `run:${a.run_id}/cycles/${l.cycle}/ledger`, strip: strip(l), head: l.head, revision: l.plan.revision },
      notes: [], narrative: '', degraded, bundleHash: byteHash(bundle) }
    // JSON and Markdown both have a <=15% window bound; leave space for their framing.
    const available = Math.max(0, max - Buffer.byteLength(canonical(h)) - 80)
    h.notes = selectNotes(this.store.notes(a.run_id), l, this.store.clock(), Math.floor(available / 2), 3)
    h.narrative = bounded(this.scrubber.scrub(narrative), Math.max(0, available - Buffer.byteLength(canonical(h.notes))))
    validateHandoff(h, l, bundle, max)
    return h
  }
  private async orient(a: Attempt, w: WindowObservation, t: Thresholds, signal: AbortSignal, measure: Measure | AsyncMeasure): Promise<string> {
    const sealed = this.store.sealed(a)
    if (!sealed) return ''
    let h = sealed.handoff
    let damaged = false
    try { invariant(hash(h) === sealed.artifactHash, 'handoff_corrupt'); validateHandoff(h, sealed.ledger, sealed.bundle, t.handoff) } catch { damaged = true }
    for (let retry = 0; retry < 2; retry++) {
      if (damaged || retry) {
        h = this.make(a, sealed.ledger, sealed.bundle, 'Recover from the authoritative ledger. Query evidence before continuing.', true, t.handoff)
        this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'probe_degraded', cycle: h.cycle }) } })
      }
      const expected = probes(sealed.ledger)
      await this.fresh(a, w, signal)
      const { text: prompt } = await this.pack(PROBE_PROMPT,
        { head: [canonical(h), canonical({ open: sealed.ledger.plan.items.filter(i => sealed.ledger.items[i.id] !== 'done').map(i => ({ id: i.id, status: sealed.ledger.items[i.id], dependsOn: i.dependsOn })) })] }, measure, t.H)
      let correct = false
      try { correct = !damaged && canonical(parseModelJson((await this.call(a, 'probe', prompt, w, t, signal, this.schemas?.probe)).text)) === canonical(expected) }
      catch (e) { if (e instanceof RelayError && ['cap_reached', 'truncation_protocol', 'window_changed', 'response_schema_rejected'].includes(e.code)) throw e }
      this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'probe', retry, correct, damaged }) } })
      if (correct) return canonical({ narrative: h.narrative, notes: h.notes })
      damaged = false
    }
    await this.cascade?.review(a,'probes',signal)
    this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'judge_requested', reason: 'probes' }) } })
    this.store.runs.signal(a, `relay-probes-${this.store.read(a.run_id).cycle}`)
    throw new RelayError('probe_failed_twice')
  }
  /** Commits uncommitted work through the harness checkpoint (same refusals as the checkpoint action) when the tree is
   * dirty. Returns whether it did. Any other reason the tree is unverifiable still throws. */
  private async checkpointIfDirty(a: Attempt, reason: 'verify' | 'handoff', signal: AbortSignal): Promise<boolean> {
    const l = this.store.read(a.run_id)
    // Validate against the tree as it is now: a checkpoint the ledger has not observed yet is not a dirty tree.
    const now = await this.workspace.observe(l.plan.base, l.baseline.head)
    // Record a head the ledger has not seen (a checkpoint interrupted before its observation) before anything reads statuses.
    if (now.head !== l.head) this.store.observe(a, now)
    try { await this.workspace.validate(l.plan, now.head, now.files); return false } catch (error) {
      if (!(error instanceof RelayError && error.code === 'checkout_dirty')) throw error
    }
    this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'auto_checkpoint', reason }) } })
    await this.workspace.checkpoint(signal)
    this.store.observe(a, await this.workspace.observe(l.plan.base, l.baseline.head))
    return true
  }
  /** The verify action. Gate evidence is bound to a head, and a new checkpoint reopens every item, so the dependencies an
   * item needs are re-verified first, in dependency order, at the current head; the first failing gate ends the action.
   * Requests the model cannot mean (an unknown id, an item already done at this head) are answered, not fatal. */
  private async verifyAction(a: Attempt, item: string, signal: AbortSignal): Promise<string> {
    const plan = this.store.read(a.run_id).plan
    if (!plan.items.some(i => i.id === item)) return canonical({ item, refused: 'unknown_item', items: plan.items.map(i => i.id) })
    // Dirtiness first: work written after an item passed reopens it once it is checkpointed.
    const autoCheckpoint = await this.checkpointIfDirty(a, 'verify', signal)
    if (this.store.read(a.run_id).items[item] === 'done') return canonical({ item, alreadyDone: true, head: this.store.read(a.run_id).head })
    const order: string[] = []
    const seen = new Set<string>()
    const visit = (id: string): void => {
      if (seen.has(id)) return; seen.add(id)
      for (const d of plan.items.find(i => i.id === id)!.dependsOn) visit(d)
      if (id === item || this.store.read(a.run_id).items[id] !== 'done') order.push(id)
    }
    visit(item)
    const gates: unknown[] = []
    for (const id of order) {
      this.store.requestVerification(a, id)
      let e: Awaited<ReturnType<RelayWorkspace['verify']>>
      try { e = await this.workspace.verify(plan, id, signal, this.limits.gateTimeoutMs) } catch (error) {
        // Still dirty right after a checkpoint (a background writer, a filter mismatch): say so, do not loop.
        if (autoCheckpoint && error instanceof RelayError && error.code === 'checkout_dirty') throw new RelayError('checkout_dirty_after_checkpoint')
        throw error
      }
      const l = this.store.read(a.run_id)
      const after = await this.workspace.observe(l.plan.base, l.baseline.head)
      invariant(after.head === e.head, 'gate_head_changed')
      this.store.observe(a, { ...after, evidence: e }); gates.push(e)
      if (!e.ok) break
    }
    const final = gates.at(-1) as { item: string; ok: boolean } | undefined
    // The verdict comes first: a bounded result may cut the gate outputs, never the answer.
    return canonical({ item, ok: final?.item === item && final.ok, ...(final && !final.ok ? { failedAt: final.item } : {}),
      ...(autoCheckpoint ? { autoCheckpoint: true } : {}), gates })
  }
  /** Gates of every item in dependency order at the current head; the first failure ends the pass. */
  private async verifyAll(a: Attempt, signal: AbortSignal): Promise<void> {
    const l = this.store.read(a.run_id), order: string[] = []
    const visit = (id: string): void => { if (order.includes(id)) return; for (const d of l.plan.items.find(i => i.id === id)!.dependsOn) visit(d); order.push(id) }
    for (const item of l.plan.items) visit(item.id)
    for (const id of order) {
      const evidence = await this.workspace.verify(l.plan, id, signal, this.limits.gateTimeoutMs)
      const after = await this.workspace.observe(l.plan.base, l.baseline.head)
      invariant(after.head === this.store.read(a.run_id).head && evidence.head === after.head, 'gate_head_changed')
      this.store.observe(a, { ...after, evidence })
      if (!evidence.ok) break
    }
  }
  private async handoff(a: Attempt, w: WindowObservation, t: Thresholds, signal: AbortSignal, measure: Measure | AsyncMeasure): Promise<void> {
    this.store.transition(a, 'handoff_write')
    // A seal needs a clean checkpoint; uncommitted work at a boundary is committed, never discarded or left to stop the run.
    const allDoneBefore = Object.values(this.store.read(a.run_id).items).every(status => status === 'done')
    const autoCheckpoint = await this.checkpointIfDirty(a, 'handoff', signal)
    if (autoCheckpoint) {
      // The next cycle must know this commit was not the model's own choice and may hold half-finished edits.
      this.store.note(a, 'open_issue', 'The harness checkpointed uncommitted work at the end of the previous cycle; review it before relying on it.', [], null)
    }
    const observation = await this.workspace.observe(this.store.read(a.run_id).plan.base, this.store.read(a.run_id).baseline.head)
    this.store.observe(a, observation)
    const l = this.store.read(a.run_id)
    try { await this.workspace.validate(l.plan, l.head, l.files) } catch (error) {
      if (autoCheckpoint && error instanceof RelayError && error.code === 'checkout_dirty') throw new RelayError('checkout_dirty_after_checkpoint')
      throw error
    }
    // Every item done, or every item was done before a harness checkpoint reopened them: the final gates run again here.
    if (Object.values(l.items).every(status => status === 'done') || autoCheckpoint && allDoneBefore) await this.verifyAll(a, signal)
    this.store.countProgress(a, observation.nonemptyCommit)
    if (this.eta) this.store.updateEta(a, this.eta)
    const judged = await this.judgeSample(a, 'pre_seal', signal)
    await this.cascade?.sample(
      a,
      'pre_seal',
      signal,
      judged?.summary,
      judged && {
        observation: judged.observation,
        policy: judged.policy,
        signals: judged.summary.signals,
        unknownFacts: judged.summary.unknownFacts,
        unobserved: judged.unobserved
      }
    )
    let narrative = '', degraded = false
    try {
      const ledger = this.store.read(a.run_id)
      const notes = selectNotes(this.store.notes(a.run_id), ledger, this.store.clock(), Math.floor(t.H / 8), 3)
      await this.fresh(a, w, signal)
      const context = await this.pack('Write a fresh bounded handoff narrative from this evidence: current work, next 1-3 actions, hypothesis and watch-outs. Do not invent progress. No prior narrative is supplied.',
        { head: [canonical({ strip: strip(ledger), head: ledger.head, notes })], turns: this.turns.slice(-3) }, measure, t.H)
      if (context.dropped || context.cut) this.dropped(a, ledger.cycle, context.dropped, context.cut)
      narrative = (await this.call(a, 'narrative', context.text, w, t, signal)).text
    } catch (e) {
      if (e instanceof RelayError && ['cap_reached', 'truncation_protocol', 'window_changed'].includes(e.code)) throw e
      degraded = true; narrative = 'Continue from the authoritative ledger and evidence; query work.query and notes.search.'
    }
    this.store.transition(a, 'handoff_validate')
    const bundle = await this.workspace.bundle(l.plan.base)
    const current = this.store.read(a.run_id)
    await this.workspace.validate(current.plan, current.head, current.files)
    for (let tries = 0; tries < 2; tries++) {
      try {
        const ledger = this.store.read(a.run_id); ledger.state = 'sealed'
        const h = this.make(a, ledger, bundle, narrative, degraded, t.handoff)
        this.store.seal(a, h, bundle, t.handoff)
        return
      } catch (e) {
        if (!(e instanceof RelayError) || !e.code.startsWith('handoff_')) throw e
        if (!tries) {
          this.store.transition(a, 'handoff_write'); this.store.transition(a, 'handoff_validate')
        } else {
          this.store.transition(a, 'harness_fallback'); degraded = true; narrative = ''
          const ledger = this.store.read(a.run_id); ledger.state = 'sealed'
          const h = this.make(a, ledger, bundle, narrative, true, t.handoff)
          this.store.transition(a, 'handoff_validate'); this.store.seal(a, h, bundle, t.handoff)
          return
        }
      }
    }
  }
  private async tool(a: Attempt, name: string, args: Record<string, unknown>, signal: AbortSignal, t: Thresholds): Promise<string> {
    if (name === 'work.query' || name === 'notes.search') {
      const text = name === 'work.query' ? canonical(this.store.read(a.run_id)) : canonical(this.store.notes(a.run_id).filter(n => n.text.includes(String(args.query ?? ''))))
      const offset = Number(args.offset ?? 0)
      invariant(Number.isSafeInteger(offset) && offset >= 0, 'invalid_offset')
      invariant(offset <= text.length, 'invalid_offset')
      const page = Buffer.from(text.slice(offset)).subarray(0, this.limits.pageBytes).toString('utf8').replace(/\uFFFD$/u, '')
      return canonical({ text: page, nextOffset: offset + page.length, more: offset + page.length < text.length })
    }
    // A tool page is sized so that the per-turn bound below never cuts it: a cut page would hide bytes its nextOffset says were read.
    return this.workspace.tool(name, args, signal, { pageBytes: Math.floor(t.hard / 4) })
  }
  async run(a: Attempt, external?: AbortSignal): Promise<Ledger> {
    invariant(!this.running, 'executor_busy'); this.running = true
    const initial = this.store.read(a.run_id)
    const wall = new AbortController()
    const cancelDeadline = initial.caps.wallMs === null ? () => {} : wallDeadline(
      () => initial.startedAt + initial.caps.wallMs! - this.store.clock(), () => wall.abort())
    const signal = AbortSignal.any([this.controller.signal, wall.signal, ...(external ? [external] : [])])
    const renewal = setInterval(() => { try { this.store.runs.renew(a) } catch { this.controller.abort() } }, 1_000)
    try {
      this.cascade?.bind(a)
      if (this.store.runs.get(a.run_id).state === 'wrapping_up') return this.store.read(a.run_id)
      while (true) {
        signal.throwIfAborted()
        const current = this.store.read(a.run_id)
        const cap = this.caps(current, true)
        if (cap) { this.wrap(a, cap); return current }
        const w = await this.model.observe(signal), t = thresholds(w, this.reserves), measure = this.measure(w, signal)
        this.store.begin(a)
        if (this.eta) this.store.updateEta(a, this.eta)
        const judged = await this.judgeSample(a, 'cycle_start', signal)
        await this.cascade?.sample(
          a,
          'cycle_start',
          signal,
          judged?.summary,
          judged && {
            observation: judged.observation,
            policy: judged.policy,
            signals: judged.summary.signals,
            unknownFacts: judged.summary.unknownFacts,
            unobserved: judged.unobserved
          }
        )
        const narrative = await this.orient(a, w, t, signal, measure)
        this.store.transition(a, 'work'); this.turns = []
        let invalidActions = 0
        while (true) {
          signal.throwIfAborted()
          const l = this.store.read(a.run_id)
          await this.fresh(a, w, signal)
          const context = await this.pack(this.workText, { head: [strip(l), bounded(l.plan.goal, this.limits.goalBytes), narrative], turns: this.turns }, measure, t.H)
          const used = await measure(context.text)
          if (context.dropped || context.cut) {
            this.dropped(a, l.cycle, context.dropped, context.cut)
            this.store.transition(a, 'wind_down'); break
          }
          if (boundary(t, used, false, this.reserves.stepMedian) && this.turns.length) { this.store.transition(a, 'wind_down'); break }
          const reply = await this.call(a, 'work', context.text, w, t, signal, this.schemas?.action)
          if (reply.outputLimited) {
            this.store.change(a, 'invalid_action', s => { s.errors++ })
            this.turns.push('Your reply hit the output limit; return one short valid JSON action.')
            if (++invalidActions >= this.limits.invalidActions) break
            continue
          }
          const action = actionSchema.safeParse((() => { try { return parseModelJson(reply.text) } catch { return null } })())
          if (!action.success) { this.store.change(a, 'invalid_action', s => { s.errors++ }); this.turns.push('Invalid action; return valid JSON.'); if (++invalidActions >= this.limits.invalidActions) break; continue }
          const x = action.data
          if (x.action === 'handoff' || x.action === 'finish') break
          let result = ''
          if (x.action === 'note') this.store.note(a, x.kind, x.text, x.items, x.expiresAt)
          if (x.action === 'propose') this.store.propose(a, x.text)
          if (x.action === 'checkpoint') {
            await this.workspace.checkpoint(signal)
            this.store.observe(a, await this.workspace.observe(l.plan.base, l.baseline.head))
          }
          if (x.action === 'verify') result = await this.verifyAction(a, x.item, signal)
          if (x.action === 'tool') {
            const id = randomUUID()
            this.store.emit(a, { type: 'tool.call', data: { toolCallId: id, name: x.name, arguments: x.args, source: 'builtin', parsedFrom: 'content_json', diffPath: null } })
            try {
              result = this.scrubber.scrub(await this.tool(a, x.name, x.args, signal, t))
              this.store.emit(a, { type: 'tool.result', data: { toolCallId: id, status: 'ok', result, error: null, durationMs: 0 } })
            } catch (error) {
              if (error instanceof RelayError && error.code === 'cleanup_unconfirmed') throw error
              const text = this.scrubber.scrub(error instanceof Error ? error.message : 'tool_failed')
              this.store.change(a, 'tool_error', s => { s.errors++ })
              this.store.emit(a, { type: 'tool.result', data: { toolCallId: id, status: 'error', result: null, error: text, durationMs: 0 } })
              result = text
            }
          }
          this.turns.push(canonical(x), result)
          // Turn storage is bounded, tool artifacts and the ledger remain queryable.
          this.turns = this.turns.map(v => bounded(v, Math.floor(t.hard / 4)))
          if (boundary(t, used, x.action === 'verify', this.reserves.stepMedian)) { this.store.transition(a, 'wind_down'); break }
        }
        await this.handoff(a, w, t, signal, measure)
        const l = this.store.read(a.run_id)
        if (l.noProgress >= 2) {
          this.store.emit(a, { type: 'agent.note', data: { text: canonical({ relay: 'judge_requested', reason: 'no_progress', cycle: l.cycle }) } })
          this.store.runs.signal(a, `relay-progress-${l.cycle}`)
        }
        if (l.noProgress >= 3) throw new RelayError('no_progress')
        if (Object.values(l.items).every(s => s === 'done')) { this.store.transition(a, 'finish'); this.store.runs.complete(a, 'completed'); return this.store.read(a.run_id) }
        this.store.transition(a, 'boot')
      }
    } catch (error) {
      if (error instanceof RelayError && error.code === 'cap_reached') return this.store.read(a.run_id)
      if (wall.signal.aborted) { this.wrap(a, 'wall'); return this.store.read(a.run_id) }
      if (error instanceof RelayError && ['probe_failed_twice', 'no_progress'].includes(error.code)) {
        try { this.store.transition(a, 'escalate') } catch (report) { if (!this.lost(report)) throw report }
      }
      // Cancellation and restart never continue a model or mutating tool automatically.
      try {
        this.store.emit(a, { type: 'error', data: { code: signal.aborted ? 'relay_stopped' : error instanceof RelayError ? error.code : 'relay_failed', message: 'Relay execution stopped; ledger retained.' } })
      } catch (report) { if (!this.lost(report)) throw report }
      try { this.store.runs.inputRequired(a) } catch (report) { if (!this.lost(report)) throw report }
      return this.store.read(a.run_id)
    } finally { clearInterval(renewal); cancelDeadline(); this.running = false }
  }
}
