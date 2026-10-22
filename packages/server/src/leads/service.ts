import { randomUUID } from 'node:crypto'
import { leadDelegateInputSchema, type LeadDelegateInput, type LeadWakePacket } from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { ExternalAgentService } from '../external-agents/plugin.ts'
import type { LeadSessionInfo, LeadUsage } from '../external-agents/types.ts'
import { adapterIdSchema, bindingSchema, type Roles, type RoleBinding } from '../external-agents/types.ts'
import type { RunStore } from '../runs/store.ts'
import { TERMINAL_RUN_STATES, type Attempt, type PromiseRecord, type Wake } from '../runs/types.ts'
import { buildWakePacket, DEFAULT_PACKET_TOKENS, renderWakePacket } from './packet.ts'
import { LeadStore, type LeadDelegation, type LeadSession } from './store.ts'
import { LeadToolServer, type ToolResult } from './tool-server.ts'
import { LeadError, canonical, code, digestOf, leadInvariant, type ChildReporter, type ChildStarter, type LeadNotice,
  type LeadOutcome, type LeadTurnResult } from './types.ts'

export interface LeadServiceOptions {
  db: Db
  runs: RunStore
  agents: Pick<ExternalAgentService, 'run' | 'resolve'>
  scrubber: EgressScrubber
  child: ChildStarter
  reporter?: ChildReporter
  /** Host policy for the executor a lead may name; throw a stable code to refuse before hibernation. */
  validateExecutor?: (executor: LeadDelegateInput['executor'], ownerAccountId: string) => void
  /** D-142: the lead connection's billing fact, shown as data with its source and age. */
  billing?: (ownerAccountId: string, connectionId: string) => unknown
  notify?: (notice: LeadNotice) => void
  tools?: LeadToolServer
  clock?: () => number
  renewMs?: number
  packetTokens?: number
  retainMs?: number
  retryMs?: (failures: number) => number
  cancelGraceMs?: number
  /** Every durable boundary of the lead flow; crash tests kill the process at each. */
  fault?: (point: string) => void
}
export interface LeadStartInput {
  runId?: string
  ownerAccountId: string
  actorAccountId: string
  projectId: string
  sessionRoles?: Roles
  /** Run policy: the only connection a failed lead may fall back to (ADR-0019 decision 9). */
  fallback?: RoleBinding | null
  prompt: string
}

interface Turn {
  attempt: Attempt
  kind: 'first' | 'wake' | 'decision'
  wakeSeq: number | null
  prompt: string
  seededPrompt?: string
  resume: { acpSessionId: string } | null
  delegating?: { key: string }
}
interface Live { cancel: AbortController; hibernate: AbortController; userCancel: boolean; done: Promise<LeadTurnResult> | null }
interface Observed { text: string; usage: LeadUsage | null; acp: LeadSessionInfo | null; activity: boolean }

const ACP_BACKENDS = new Set(adapterIdSchema.options.filter(id => id !== 'codex'))
/** Only a request defect is independent of the connection; every other failure before the first
 * update may be answered by the run policy's named fallback. */
const NO_FALLBACK = new Set(['empty_prompt'])
const CURRENCIES = new Set(['USD', 'EUR', 'RUB'])
const clip = (text: string, max: number) => { const points = Array.from(text); return points.length <= max ? text : points.slice(0, max - 1).join('') + '…' }

/** Orchestrates external ACP leads on top of R1 (promises, outbox, fences) and K5 (processes). */
export class LeadService {
  readonly store: LeadStore
  private readonly o: LeadServiceOptions
  private readonly runs: RunStore
  private readonly scrubber: EgressScrubber
  private readonly tools: LeadToolServer
  private readonly ownsTools: boolean
  private readonly live = new Map<string, Live>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly busy = new Set<string>()
  private readonly children = new Map<string, Promise<void>>()
  private readonly interruptedNoticed = new Set<string>()
  private closed = false
  private failure: string | null = null
  constructor(options: LeadServiceOptions) {
    this.o = options
    this.runs = options.runs
    this.scrubber = options.scrubber
    this.store = new LeadStore(options.db)
    this.tools = options.tools ?? new LeadToolServer()
    this.ownsTools = options.tools === undefined
  }
  private now(): number { return (this.o.clock ?? Date.now)() }
  private fault(point: string): void { this.o.fault?.(`lead:${point}`) }
  health() { return { failure: this.failure } }
  private notice(notice: LeadNotice): void { try { this.o.notify?.(notice) } catch { /* A notification sink never owns control flow. */ } }
  private spawn<T>(promise: Promise<T>): Promise<T> {
    const task = promise.finally(() => this.tasks.delete(task))
    this.tasks.add(task)
    void task.catch(() => undefined)
    return promise
  }
  /** Resolves when no lead turn, child start or stop is in flight (deterministic tests). */
  async idle(): Promise<void> { while (this.tasks.size) await Promise.allSettled([...this.tasks]) }
  private note(emit: (event: { type: 'agent.note'; data: { text: string } }) => void, value: Record<string, unknown>): void {
    emit({ type: 'agent.note', data: { text: canonical(this.scrubber.scrub({ lead: value })) } })
  }

  // ---- start and resume --------------------------------------------------------------------

  startLead(input: LeadStartInput): { runId: string; first: Promise<LeadTurnResult> } {
    leadInvariant(!this.closed, 'lead_closed')
    leadInvariant(typeof input.prompt === 'string' && input.prompt.trim(), 'empty_prompt')
    const roles = input.sessionRoles ?? {}
    const resolved = this.agents().resolve(input.ownerAccountId, input.projectId, 'lead', roles)
    leadInvariant(ACP_BACKENDS.has(resolved.binding.backend as never), 'lead_adapter_unsupported')
    if (input.fallback) {
      const fallback = bindingSchema.parse(input.fallback)
      leadInvariant(ACP_BACKENDS.has(fallback.backend as never), 'lead_adapter_unsupported')
    }
    const runId = input.runId ?? randomUUID()
    leadInvariant(!this.store.session(runId), 'lead_exists')
    const task = this.scrubber.scrub(clip(input.prompt, 4_000))
    const attempt = this.runs.createStarted({ id: runId, sessionId: runId }, (a, db, emit) => {
      this.store.insertSession(db, { run_id: runId, owner_account_id: input.ownerAccountId, actor_account_id: input.actorAccountId,
        project_id: input.projectId, session_roles: canonical(roles), fallback: input.fallback ? canonical(input.fallback) : null,
        binding_digest: digestOf(resolved.binding), task })
      this.note(emit, { action: 'started', backend: resolved.binding.backend })
      return a
    })
    this.fault('start:session_persisted')
    this.runs.retain(attempt, { key: `lead-scratch:${runId}`, kind: 'scratch', retainUntil: this.now() + (this.o.retainMs ?? 7 * 86_400_000) })
    const first = this.spawn(this.runTurn({ attempt, kind: 'first', wakeSeq: null, prompt: input.prompt, resume: null }))
    return { runId, first }
  }
  /** Explicit continuation of a lead that needs a person: `input_required` after a failed turn, or
   * `interrupted` by a restart after its wake was acknowledged. Never automatic (R1 restart table). */
  resume(runId: string, prompt: string): Promise<LeadTurnResult> {
    leadInvariant(!this.closed && typeof prompt === 'string' && prompt.trim(), 'invalid_input')
    const session = this.store.session(runId)
    leadInvariant(session && !this.live.has(runId), 'lead_not_found')
    const state = this.runs.get(runId).state
    leadInvariant(state === 'input_required' || state === 'interrupted', 'invalid_transition')
    const attempt = state === 'input_required' ? this.runs.decide(runId) : this.runs.start(runId)
    return this.spawn(this.runTurn({ attempt, kind: 'decision', wakeSeq: null, prompt, resume: this.loadable(session),
      seededPrompt: `${this.seedPrefix(session)}\n\n${prompt}` }))
  }
  private agents() { return this.o.agents }
  private loadable(session: LeadSession): { acpSessionId: string } | null {
    return session.acp_session_id && session.load_session === 1 ? { acpSessionId: session.acp_session_id } : null
  }
  private seedPrefix(session: LeadSession): string {
    return `Guanxi resumed this lead in a new session; the earlier session could not be loaded. Lead handoff:\n${session.handoff || clip(session.task, 2_000)}`
  }

  // ---- one lead turn -----------------------------------------------------------------------

  private async runTurn(turn: Turn): Promise<LeadTurnResult> {
    const { attempt } = turn
    const runId = attempt.run_id
    const live: Live = { cancel: new AbortController(), hibernate: new AbortController(), userCancel: false, done: null }
    const observed: Observed = { text: '', usage: null, acp: null, activity: false }
    let abortCode: string | null = null
    let failure: unknown = null
    const guard = (body: () => void) => { try { body() } catch (error) { abortCode ??= code(error); live.cancel.abort() } }
    this.live.set(runId, live)
    const result = (async (): Promise<LeadTurnResult> => {
      const session = this.store.session(runId)!
      const grant = this.tools.grant({ runId, attemptId: attempt.id, wakeSeq: turn.wakeSeq }, input => this.delegateCall(runId, turn, session, input))
      const timer = setInterval(() => guard(() => { this.runs.renew(attempt) }), this.o.renewMs ?? 15_000)
      timer.unref()
      try {
        this.fault('turn:begin')
        const url = await this.tools.url()
        const roles = this.rolesOf(session)
        const output = await this.agents().run({ ownerAccountId: session.owner_account_id, actorAccountId: session.actor_account_id,
          projectId: session.project_id, role: 'lead', sessionRoles: roles, prompt: turn.prompt, signal: live.cancel.signal,
          lead: { mcpServers: [{ type: 'http', name: 'guanxi', url, headers: [grant.header] }], resume: turn.resume,
            ...(turn.seededPrompt === undefined ? {} : { seededPrompt: turn.seededPrompt }),
            hibernateSignal: live.hibernate.signal, ...(this.o.cancelGraceMs === undefined ? {} : { cancelGraceMs: this.o.cancelGraceMs }),
            onSession: info => guard(() => this.onSession(turn, session, info, observed)),
            onActivity: () => { if (!observed.activity) { observed.activity = true; guard(() => this.onActivity(turn)) } },
            onUsage: usage => { observed.usage = usage } } })
        observed.text = output.text
        observed.usage = output.usage ?? observed.usage
      } catch (error) { failure = error } finally { clearInterval(timer); grant.revoke() }
      if (abortCode && !live.userCancel) failure = new LeadError(abortCode)
      return this.settle(turn, live, observed, failure)
    })().catch((error): LeadTurnResult => {
      this.failure = code(error)
      return { runId, wakeSeq: turn.wakeSeq, outcome: 'failed', code: code(error) }
    }).finally(() => { this.live.delete(runId) })
    live.done = result
    return result
  }
  private rolesOf(session: LeadSession): Roles {
    const roles = JSON.parse(session.session_roles) as Roles
    return session.fallback_used === 1 && session.fallback ? { ...roles, lead: JSON.parse(session.fallback) as RoleBinding } : roles
  }
  private onSession(turn: Turn, session: LeadSession, info: LeadSessionInfo, observed: Observed): void {
    observed.acp = info
    const roles = this.rolesOf(session)
    const digest = digestOf(this.agents().resolve(session.owner_account_id, session.project_id, 'lead', roles).binding)
    this.runs.mutate(turn.attempt, (db, emit) => {
      this.store.observeSession(db, session.run_id, info.acpSessionId, info.loadSession, digest)
      if (turn.wakeSeq !== null) this.store.setResumeMode(db, session.run_id, turn.wakeSeq, info.mode)
      this.note(emit, { action: 'session', mode: info.mode, wakeSeq: turn.wakeSeq, loadSession: info.loadSession })
    })
  }
  /** The first activity of the prompted turn is the observation R1 requires before it acknowledges. */
  private onActivity(turn: Turn): void {
    this.fault('turn:before_ack')
    this.runs.modelStarted(turn.attempt, db => { this.store.setRetry(db, turn.attempt.run_id, 0, 0) })
    this.fault('turn:acked')
  }

  // ---- delegation --------------------------------------------------------------------------

  private async delegateCall(runId: string, turn: Turn, session: LeadSession, raw: unknown): Promise<ToolResult> {
    const refuse = (text: string): ToolResult => ({ kind: 'result', isError: true, text: this.scrubber.scrub(text) })
    if (turn.delegating) return refuse('delegation_already_requested')
    const parsed = leadDelegateInputSchema.safeParse(raw)
    if (!parsed.success) {
      return refuse('invalid_brief: ' + parsed.error.issues.slice(0, 10).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '))
    }
    const brief = parsed.data
    if (canonical(this.scrubber.scrub(brief)) !== canonical(brief)) return refuse('content_withheld')
    if (!this.runs.alwaysOnHome) return refuse('no_always_on_home')
    try { this.o.validateExecutor?.(brief.executor, session.owner_account_id) } catch (error) { return refuse(code(error)) }
    const deadline = this.now() + brief.deadlineMs
    if (!Number.isSafeInteger(deadline)) return refuse('invalid_brief: deadlineMs')
    const key = `lead:${turn.attempt.id}`
    try {
      this.runs.mutate(turn.attempt, (db, emit) => {
        this.store.insertIntent(db, { lead_run_id: runId, key, brief: canonical(brief), deadline,
          on_deadline: brief.onDeadline, on_cancel: brief.onCancel })
        this.note(emit, { action: 'delegation_intent', key })
      })
    } catch (error) { return refuse(code(error)) }
    this.fault('delegate:intent_persisted')
    turn.delegating = { key }
    this.live.get(runId)?.hibernate.abort()
    return { kind: 'hold' }
  }

  /** Records the turn's usage, commits R1's one-transaction delegation, then starts the child. */
  private async finishDelegation(runId: string, attempt: Attempt, key: string, observed: Observed | null, failureCode: string | null): Promise<LeadTurnResult> {
    const row = this.store.delegation(runId, key)
    leadInvariant(row && row.state === 'intent', 'delegation_not_pending')
    this.fault('delegate:turn_stopped')
    if (observed) this.recordUsage(attempt, observed)
    this.fault('delegate:cost_recorded')
    const promise = this.runs.delegate(attempt, { key, deadline: row.deadline,
      deadlinePolicy: row.on_deadline === 'wrap_up' ? 'cancel_wrap_up' : 'detach', cancelPolicy: row.on_cancel })
    this.fault('delegate:committed')
    this.markDelegated(runId, key, promise, observed?.text ?? '')
    this.fault('delegate:marked')
    if (failureCode === 'cleanup_unconfirmed' || failureCode === 'admission_release_failed') {
      this.notice({ kind: 'cleanup_unconfirmed', runId, wakeSeq: attempt.wake_seq, code: failureCode })
    }
    await this.ensureChild(runId, key)
    return { runId, wakeSeq: attempt.wake_seq, outcome: 'hibernated', code: failureCode }
  }
  private composeHandoff(session: LeadSession, brief: LeadDelegateInput, narrative: string): string {
    return this.scrubber.scrub([
      `Task: ${clip(session.task, 2_000)}`,
      `Delegated objective: ${clip(brief.objective, 600)}`,
      `Definition of done:\n${brief.definitionOfDone.slice(0, 10).map(line => `- ${clip(line, 200)}`).join('\n')}`,
      `Plan ${brief.plan.revision} at ${brief.plan.base}:\n${brief.plan.items.slice(0, 30).map(item => `- ${item.id}: ${clip(item.title, 120)}`).join('\n')}`,
      narrative ? `Your last words before hibernating:\n${clip(narrative, 1_500)}` : '',
    ].filter(Boolean).join('\n'))
  }
  private markDelegated(runId: string, key: string, promise: PromiseRecord, narrative: string): void {
    const row = this.store.delegation(runId, key)!
    const session = this.store.session(runId)!
    const handoff = this.composeHandoff(session, JSON.parse(row.brief) as LeadDelegateInput, narrative)
    this.runs.homeFence().transaction('lead.delegated', db => {
      this.store.setDelegationState(db, runId, key, 'delegated', promise.child_id)
      this.store.setHandoff(db, runId, handoff)
    })
  }
  private recordUsage(attempt: Attempt, observed: Observed): void {
    const { usage, acp } = observed
    const session = this.store.session(attempt.run_id)!
    if (!usage || usage.inputTokens === null || usage.outputTokens === null || !acp) {
      this.runs.mutate(attempt, (_db, emit) => this.note(emit, { action: 'usage_unobserved', attempt: attempt.ordinal }))
      return
    }
    const same = session.usage_session_id === acp.acpSessionId
    const base = same ? { input: session.usage_in, output: session.usage_out, cost: session.usage_cost_micro } : { input: 0, output: 0, cost: 0 }
    // ACP reports cumulative session totals. A smaller number means the agent's counter restarted.
    const delta = (now: number, before: number) => now >= before ? now - before : now
    const cost = usage.cost && CURRENCIES.has(usage.cost.currency) ? Math.round(usage.cost.amount * 1_000_000) : null
    this.runs.recordCost(attempt, { key: `lead-turn:${attempt.ordinal}`, inputTokens: delta(usage.inputTokens, base.input),
      outputTokens: delta(usage.outputTokens, base.output), costMicrounits: cost === null ? null : delta(cost, base.cost),
      currency: cost === null ? 'unknown' : usage.cost!.currency as 'USD' | 'EUR' | 'RUB' })
    this.fault('usage:recorded')
    let billing: unknown = null
    try {
      const binding = this.agents().resolve(session.owner_account_id, session.project_id, 'lead', this.rolesOf(session)).binding
      billing = this.o.billing?.(session.owner_account_id, binding.connectionId) ?? null
    } catch { billing = null }
    this.runs.mutate(attempt, (db, emit) => {
      this.store.setUsage(db, attempt.run_id, { sessionId: acp.acpSessionId, input: usage.inputTokens!, output: usage.outputTokens!,
        costMicro: cost ?? base.cost })
      this.note(emit, { action: 'cost', attempt: attempt.ordinal, billing })
    })
  }

  // ---- child -------------------------------------------------------------------------------

  /** One start per delegation at a time, whether called by the finishing turn or by the pump. */
  private async ensureChild(runId: string, key: string): Promise<void> {
    const guardKey = `child:${runId}:${key}`
    while (this.busy.has(guardKey)) await new Promise(resolve => setTimeout(resolve, 2))
    this.busy.add(guardKey)
    try { await this.startChild(runId, key) } finally { this.busy.delete(guardKey) }
  }
  private async startChild(runId: string, key: string): Promise<void> {
    const row = this.store.delegation(runId, key)
    if (!row || !['delegated', 'child_started'].includes(row.state) || !row.child_run_id) return
    const childId = row.child_run_id
    const setState = () => this.runs.homeFence().transaction('lead.child_started', db => this.store.setDelegationState(db, runId, key, 'child_started'))
    const child = this.runs.get(childId)
    const previous = this.runs.attempts(childId)
    // R1 `start` is the exactly-once point. A child that began a model call is never replayed: it
    // stays `interrupted` and the lead is woken by the deadline, with a notice to the person.
    const restartable = child.state === 'submitted' || (child.state === 'interrupted' && previous.every(a => a.first_model_at === null))
    if (!restartable) {
      if (row.state === 'delegated') setState()
      if (child.state === 'interrupted' && !this.interruptedNoticed.has(childId)) {
        this.interruptedNoticed.add(childId)
        this.notice({ kind: 'child_interrupted', runId, childRunId: childId })
      }
      return
    }
    const attempt = this.runs.start(childId)
    this.fault('child:attempt_started')
    const session = this.store.session(runId)!
    try {
      const handle = await this.o.child.start({ leadRunId: runId, childRunId: childId, brief: Object.freeze(JSON.parse(row.brief) as LeadDelegateInput),
        attempt, previousAttempts: previous.length, ownerAccountId: session.owner_account_id, actorAccountId: session.actor_account_id,
        projectId: session.project_id })
      this.fault('child:launched')
      if (row.state === 'delegated') setState()
      const done = handle.done.catch(error => this.childFailed(runId, childId, attempt, code(error))).finally(() => { this.children.delete(childId) })
      // The executor outlives this call and is not ours to wait for: `idle` and `close` ignore it.
      this.children.set(childId, done)
    } catch (error) { this.childFailed(runId, childId, attempt, code(error)); if (row.state === 'delegated') setState() }
  }
  /** An executor that fails without finishing its run resolves the lead's promise as failed. */
  private childFailed(runId: string, childId: string, attempt: Attempt, failure: string): void {
    this.notice({ kind: 'child_start_failed', runId, childRunId: childId, code: failure })
    try { this.runs.complete(attempt, 'failed') } catch { /* Already finished, canceled or fenced out. */ }
  }

  // ---- settle ------------------------------------------------------------------------------

  private async settle(turn: Turn, live: Live, observed: Observed, failure: unknown): Promise<LeadTurnResult> {
    const { attempt } = turn
    const runId = attempt.run_id
    const done = (outcome: LeadOutcome, why: string | null = null): LeadTurnResult => ({ runId, wakeSeq: turn.wakeSeq, outcome, code: why })
    const failureCode = failure === null ? null : code(failure)
    if (live.userCancel || TERMINAL_RUN_STATES.has(this.runs.get(runId).state)) return done('canceled')
    if (turn.delegating) {
      try { return await this.finishDelegation(runId, attempt, turn.delegating.key, observed, failureCode) } catch (error) {
        if (TERMINAL_RUN_STATES.has(this.runs.get(runId).state)) return done('canceled')
        throw error
      }
    }
    if (failure !== null) return await this.failTurn(turn, observed, failureCode!)
    return this.endTurn(turn, observed)
  }
  private endTurn(turn: Turn, observed: Observed): LeadTurnResult {
    const { attempt } = turn
    const runId = attempt.run_id
    // A turn that ended without any visible update still ran; leaving the wake unacknowledged would loop.
    if (!observed.activity) this.runs.modelStarted(attempt, db => { this.store.setRetry(db, runId, 0, 0) })
    this.recordUsage(attempt, observed)
    this.fault('turn:usage_recorded')
    const waiting = this.runs.promises(runId).some(p => p.outcome === null && !p.detached) ||
      this.runs.wakes(runId).some(w => w.acknowledged_at === null && w.suppressed_at === null)
    if (waiting) { this.runs.hibernate(attempt); this.fault('turn:yielded'); return { runId, wakeSeq: turn.wakeSeq, outcome: 'yielded', code: null } }
    this.runs.complete(attempt, 'completed')
    this.fault('turn:completed')
    return { runId, wakeSeq: turn.wakeSeq, outcome: 'completed', code: null }
  }
  private async failTurn(turn: Turn, observed: Observed, failureCode: string): Promise<LeadTurnResult> {
    const { attempt } = turn
    const runId = attempt.run_id
    const session = this.store.session(runId)!
    const result = (outcome: LeadOutcome): LeadTurnResult => ({ runId, wakeSeq: turn.wakeSeq, outcome, code: failureCode })
    if (observed.activity) {
      // The wake is acknowledged and the lead already worked: only a person decides what happens next.
      this.runs.inputRequired(attempt)
      this.notice({ kind: 'lead_failed', runId, wakeSeq: turn.wakeSeq, code: failureCode })
      return result('input_required')
    }
    if (session.fallback && session.fallback_used === 0 && !NO_FALLBACK.has(failureCode)) {
      this.runs.mutate(attempt, (db, emit) => {
        this.store.useFallback(db, runId, digestOf(bindingSchema.parse(JSON.parse(session.fallback!))))
        this.note(emit, { action: 'fallback', reason: failureCode })
      })
      // The fallback agent cannot load the failed agent's session: it starts a new one from the seed.
      const next: Turn = { ...turn, resume: null, prompt: turn.kind === 'first' ? turn.prompt : turn.seededPrompt ?? turn.prompt }
      delete next.delegating
      return this.runTurn(next)
    }
    if (turn.kind === 'wake') return this.deferWake(attempt, failureCode)
    const retryAt = null
    if (turn.kind === 'decision') this.runs.inputRequired(attempt)
    else this.runs.complete(attempt, 'failed')
    this.notice({ kind: 'lead_unavailable', runId, wakeSeq: turn.wakeSeq, code: failureCode, retryAt })
    return result(turn.kind === 'decision' ? 'input_required' : 'failed')
  }
  /** The wake and its packet stay; the attempt yields and the next claim waits for the back-off. */
  private deferWake(attempt: Attempt, failureCode: string): LeadTurnResult {
    const runId = attempt.run_id
    const failures = this.store.session(runId)!.failures + 1
    const retryAt = this.now() + (this.o.retryMs ?? defaultRetry)(failures)
    this.runs.hibernate(attempt)
    this.runs.homeFence().transaction('lead.retry', db => this.store.setRetry(db, runId, failures, retryAt))
    this.notice({ kind: 'lead_unavailable', runId, wakeSeq: attempt.wake_seq, code: failureCode, retryAt })
    return { runId, wakeSeq: attempt.wake_seq, outcome: 'unavailable', code: failureCode }
  }

  // ---- wake --------------------------------------------------------------------------------

  private claim = (wake: Readonly<Wake>): boolean => {
    const session = this.store.session(wake.run_id)
    return !this.closed && !!session && !this.live.has(wake.run_id) && session.retry_at <= this.now()
  }
  private async resumeWake(attempt: Attempt): Promise<LeadTurnResult> {
    const runId = attempt.run_id
    const wakeSeq = attempt.wake_seq!
    this.fault('wake:claimed')
    const session = this.store.session(runId)!
    let row = this.store.wake(runId, wakeSeq)
    try {
    if (!row) {
      const wake = this.runs.wakes(runId).find(w => w.wake_seq === wakeSeq)!
      const built = buildWakePacket(this.packetInput(runId, wake), this.scrubber, this.o.packetTokens ?? DEFAULT_PACKET_TOKENS)
      const packet = canonical(built.packet)
      this.runs.mutate(attempt, (db, emit) => {
        this.store.insertWake(db, { runId, wakeSeq, packet, hash: digestOf(built.packet) })
        this.note(emit, { action: 'wake_packet', wakeSeq, hash: digestOf(built.packet), tokens: built.tokens, kind: wake.kind })
      })
      row = this.store.wake(runId, wakeSeq)!
    }
    } catch (error) {
      // No packet, no resume: the lead is not prompted with anything else.
      if (['stale_lease', 'closed', 'writer_busy'].includes(code(error))) throw error
      return this.deferWake(attempt, code(error))
    }
    this.fault('wake:packet_built')
    const text = renderWakePacket(JSON.parse(row!.packet) as LeadWakePacket)
    let resume = this.loadable(session)
    if (resume) {
      // A changed role binding cannot load the old agent session.
      try {
        const digest = digestOf(this.agents().resolve(session.owner_account_id, session.project_id, 'lead', this.rolesOf(session)).binding)
        if (digest !== session.binding_digest) resume = null
      } catch { /* The turn reports the unresolved role as lead_unavailable. */ }
    }
    return this.runTurn({ attempt, kind: 'wake', wakeSeq, prompt: text, resume, seededPrompt: `${this.seedPrefix(session)}\n\n${text}` })
  }
  private packetInput(runId: string, wake: Wake) {
    const promises = this.runs.promises(runId)
    const pending = promises.filter(p => p.outcome === null && !p.detached)
    const resolved = wake.kind === 'resolution' ? promises.find(p => p.id === wake.source_key) : undefined
    const chosen = resolved ?? pending.find(p => this.runs.get(p.child_id).state === 'input_required') ?? pending[pending.length - 1] ?? promises[promises.length - 1]
    leadInvariant(chosen, 'wake_without_child')
    const child = this.runs.get(chosen.child_id)
    const outcome: LeadWakePacket['outcome'] = resolved ? (resolved.outcome === 'rejected' ? 'failed' : (resolved.outcome ?? 'pending')) : 'pending'
    return {
      runId, wakeSeq: wake.wake_seq, kind: wake.kind, outcome,
      child: { runId: child.id, state: child.state, attempts: this.runs.attempts(child.id).length,
        costs: this.runs.costs(child.id).map(cost => ({ currency: cost.currency, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, costMicrounits: cost.costMicrounits })) },
      report: this.o.reporter?.report(child.id) ?? null,
      pendingChildren: pending.map(p => p.child_id),
    }
  }

  // ---- pump, recovery, cancel --------------------------------------------------------------

  /** One synchronous pass: finish durable intents, start or stop children, claim wakes. */
  pump(): void {
    if (this.closed) return
    try {
      this.scanDelegations()
      for (const attempt of this.runs.dispatch(wake => this.claim(wake))) this.spawn(this.resumeWake(attempt).catch((error): LeadTurnResult => {
        this.failure = code(error)
        return { runId: attempt.run_id, wakeSeq: attempt.wake_seq, outcome: 'failed', code: code(error) }
      }))
      this.failure = null
    } catch (error) { this.failure = code(error) }
  }
  private once(key: string, body: () => Promise<void> | void): void {
    if (this.busy.has(key)) return
    this.busy.add(key)
    this.spawn((async () => { try { await body() } catch (error) { this.failure = code(error) } finally { this.busy.delete(key) } })())
  }
  private scanDelegations(): void {
    for (const d of this.store.delegations()) {
      if (d.state === 'intent' && !this.live.has(d.lead_run_id)) this.once(`intent:${d.lead_run_id}:${d.key}`, () => this.recoverIntent(d))
      else if (d.state === 'delegated') this.once(`scan:child:${d.lead_run_id}:${d.key}`, () => this.ensureChild(d.lead_run_id, d.key))
      else if (d.state === 'child_started' && d.child_run_id) {
        const state = this.runs.get(d.child_run_id).state
        if (state === 'canceled') this.once(`stop:${d.child_run_id}`, () => this.stopChild(d))
        // An executor lost to a restart before its first model call is started again, once per attempt.
        else if (state === 'interrupted' && !this.children.has(d.child_run_id)) this.once(`scan:child:${d.lead_run_id}:${d.key}`, () => this.ensureChild(d.lead_run_id, d.key))
      }
    }
  }
  /** Completes a delegation the lead decided on before a crash; the lead is never re-prompted. */
  private async recoverIntent(d: LeadDelegation): Promise<void> {
    const lead = this.runs.get(d.lead_run_id)
    if (TERMINAL_RUN_STATES.has(lead.state)) return
    const promise = this.runs.promises(d.lead_run_id).find(p => p.delegation_key === d.key)
    if (promise) { this.markDelegated(d.lead_run_id, d.key, promise, ''); await this.ensureChild(d.lead_run_id, d.key); return }
    if (lead.state !== 'interrupted' && lead.state !== 'submitted') return
    const attempt = this.runs.start(d.lead_run_id)
    await this.finishDelegation(d.lead_run_id, attempt, d.key, null, null)
  }
  private async stopChild(d: LeadDelegation): Promise<void> {
    await this.o.child.stop(d.child_run_id!)
    this.fault('cancel:child_stopped')
    this.runs.homeFence().transaction('lead.child_stopped', db => this.store.setDelegationState(db, d.lead_run_id, d.key, 'child_stop_requested'))
  }
  /** Cancels the run chain once through R1, stops a live lead turn, then stops each canceled child's executor. */
  async cancel(runId: string): Promise<void> {
    leadInvariant(this.store.session(runId), 'lead_not_found')
    const live = this.live.get(runId)
    if (live) { live.userCancel = true; live.cancel.abort() }
    this.runs.cancel(runId)
    this.fault('cancel:run_canceled')
    await live?.done?.catch(() => undefined)
    for (const d of this.store.delegations(runId)) {
      if (d.state === 'child_started' && d.child_run_id && this.runs.get(d.child_run_id).state === 'canceled') await this.stopChildOnce(d)
    }
  }
  private async stopChildOnce(d: LeadDelegation): Promise<void> {
    const key = `stop:${d.child_run_id}`
    if (this.busy.has(key)) { await this.waitFor(key); return }
    this.busy.add(key)
    try { await this.stopChild(d) } finally { this.busy.delete(key) }
  }
  private async waitFor(key: string): Promise<void> { while (this.busy.has(key)) await new Promise(resolve => setTimeout(resolve, 5)) }

  async close(): Promise<void> {
    this.closed = true
    for (const live of this.live.values()) live.cancel.abort()
    await this.idle()
    if (this.ownsTools) await this.tools.close()
  }
}
const defaultRetry = (failures: number) => Math.min(30_000 * 2 ** Math.max(0, failures - 1), 900_000)
