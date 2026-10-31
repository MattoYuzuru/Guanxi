import { createHash, randomUUID } from 'node:crypto'
import { leadDelegateInputSchema, type LeadDelegateInput, type LeadWakePacket } from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { ExternalAgentService } from '../external-agents/plugin.ts'
import type { LeadSessionInfo, LeadUsage } from '../external-agents/types.ts'
import { adapterIdSchema, bindingSchema, type Roles, type RoleBinding } from '../external-agents/types.ts'
import type { RunStore } from '../runs/store.ts'
import { TERMINAL_RUN_STATES, type Attempt, type PromiseRecord, type Wake } from '../runs/types.ts'
import { typedWakeFailure } from './failure.ts'
import { buildWakePacket, DEFAULT_PACKET_TOKENS, renderWakePacket } from './packet.ts'
import { LeadStore, type LeadDelegation, type LeadSession } from './store.ts'
import { PROJECT_VIEW_TOOLS, ProjectView, ProjectViewError, type ProjectViewPolicy, type ProjectViewSummary } from './project-view.ts'
import { LeadToolServer, type ExtraTool, type ToolGrantContext, type ToolResult } from './tool-server.ts'
import { LeadError, canonical, code, digestOf, leadInvariant, type ChildReporter, type LeadLimits, type ChildStarter, type LeadNotice,
  type LeadOutcome, type LeadTurnResult } from './types.ts'

/** The lead's read-only view of its project's committed files (MS1 finding 2). Opt-in; the node serves it on the lead's own tool server. */
export interface LeadProjectViewOptions {
  /** Source roots of a project, as the relay start resolves them (the first one is read). Never taken from tool input. */
  roots(projectId: string, signal: AbortSignal): Promise<readonly string[]>
  policy?: Partial<ProjectViewPolicy>
  /** Absolute path of the git binary (tests only). */
  git?: string
}
export interface LeadServiceOptions {
  db: Db
  runs: RunStore
  agents: Pick<ExternalAgentService, 'run' | 'resolve'>
  scrubber: EgressScrubber
  child: ChildStarter
  reporter?: ChildReporter
  /** Host policy for the executor a lead may name; throw a stable code to refuse before hibernation. */
  validateExecutor?: (executor: LeadDelegateInput['executor'], ownerAccountId: string, brief: Readonly<LeadDelegateInput>) => void
  /** Executors the host allows, named to the lead in the tool description. Validation remains `validateExecutor`. */
  executors?: readonly { connectionId: string; model: string }[]
  /** Owner ceilings on caps, deadline and detach; without them the lead's brief is taken as given. */
  limits?: LeadLimits
  /** Absent: the lead has no project tools. */
  projectView?: LeadProjectViewOptions
  /** D-142: the lead connection's billing fact, shown as data with its source and age. */
  billing?: (ownerAccountId: string, connectionId: string) => unknown
  notify?: (notice: LeadNotice) => void
  tools?: LeadToolServer
  clock?: () => number
  renewMs?: number
  packetTokens?: number
  retainMs?: number
  retryMs?: (failures: number) => number
  /** Attempts a child may take before its first model call; real work is never replayed regardless. */
  childStartLimit?: number
  /** Consecutive undeliverable wakes before a person is asked (typed `admission_stuck`, `quota_exhausted` or `agent_unavailable`). Default 5. */
  wakeFailureLimit?: number
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
  /** Set by `runTurn`; the tool handler and the settle step share it. */
  observed?: Observed
}
interface Live { cancel: AbortController; hibernate: AbortController; userCancel: boolean; done: Promise<LeadTurnResult> | null }
interface Observed { text: string; usage: LeadUsage | null; acp: LeadSessionInfo | null; activity: boolean }

const ACP_BACKENDS = new Set(adapterIdSchema.options.filter(id => id !== 'codex'))
/** A held `guanxi_delegate` call looks like a refusal to the model when `session/load` replays it.
 * The wake prompt says what happened before the packet: the delegation was accepted and the
 * interrupted call was hibernation. Never a packet field; `guanxi.wake/v1` is unchanged. */
export const WAKE_ACCEPTED = 'Your guanxi_delegate call was accepted and the work ran while you were hibernated; the interrupted tool call you may see above was the hibernation, not a refusal. Result:'
/** Wake prompts after an accepted delegation of this lead carry the fixed sentence; a lead that
 * never delegated keeps the packet alone. */
export function wakePrompt(packet: string, accepted: boolean): string {
  return accepted ? `${WAKE_ACCEPTED}\n${packet}` : packet
}
/** Only a request defect is independent of the connection; every other failure before the first
 * update may be answered by the run policy's named fallback. */
const NO_FALLBACK = new Set(['empty_prompt'])
const CURRENCIES = new Set(['USD', 'EUR', 'RUB'])
const clip = (text: string, max: number) => { const points = Array.from(text); return points.length <= max ? text : points.slice(0, max - 1).join('') + '…' }
/** The stored task of a lead, exactly as `startLead` records it: the scrubbed prompt, clipped to 4000 code points.
 * `ms1-live start` compares a restarted prompt through this function, never against the raw file. */
export function normalizeTask(prompt: string, scrubber: EgressScrubber): string { return clip(scrubber.scrub(prompt), 4_000) }

/** Orchestrates external ACP leads on top of R1 (promises, outbox, fences) and K5 (processes). */
export class LeadService {
  readonly store: LeadStore
  private readonly o: LeadServiceOptions
  private readonly runs: RunStore
  private readonly scrubber: EgressScrubber
  private readonly tools: LeadToolServer
  private readonly view: ProjectView | null
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
    const limits = options.limits
    if (limits) {
      // Each cap by name: four numbers under other names, a missing cap or an extra key are not the four ceilings.
      const caps = limits.maxCaps as unknown as Record<string, unknown>
      const names = ['cycles', 'tokens', 'moneyMicros', 'wallMs']
      leadInvariant(Number.isSafeInteger(limits.maxDeadlineMs) && limits.maxDeadlineMs > 0 && caps && typeof caps === 'object' &&
        Object.keys(caps).length === names.length && names.every(name => typeof caps[name] === 'number' && Number.isSafeInteger(caps[name]) && (caps[name] as number) >= 0), 'invalid_input')
    }
    this.tools = options.tools ?? new LeadToolServer()
    // An injected server may already name the host's executors; no list means "leave it as it is", not "reset it".
    if (options.executors !== undefined) this.tools.setExecutors(options.executors)
    this.ownsTools = options.tools === undefined
    this.view = options.projectView ? new ProjectView({ scrubber: options.scrubber, ...(options.projectView.policy ? { policy: options.projectView.policy } : {}), ...(options.projectView.git ? { git: options.projectView.git } : {}) }) : null
  }
  /** The task this service would store for `prompt`; the CLI refuses to start a second lead with the same one. */
  normalizeTask(prompt: string): string { return normalizeTask(prompt, this.scrubber) }
  private now(): number { return (this.o.clock ?? Date.now)() }
  private fault(point: string): void { this.o.fault?.(`lead:${point}`) }
  health() { return { failure: this.failure } }
  /** Whether the lead's project tools are configured. */
  get projectViewEnabled(): boolean { return this.view !== null }
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
    const task = normalizeTask(input.prompt, this.scrubber)
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
    // A person's decision supersedes any delegation the lead had only begun to request. Nothing awaits between
    // the new attempt and this, so the pump cannot interleave.
    this.abandonIntents(runId)
    return this.spawn(this.runTurn({ attempt, kind: 'decision', wakeSeq: null, prompt, resume: this.loadable(session),
      seededPrompt: `${this.seedPrefix(session)}\n\n${prompt}` }))
  }
  private agents() { return this.o.agents }
  /** An intent that did not become a delegation must never be completed later without the lead asking again. */
  private abandonIntents(runId: string): void {
    // An intent whose delegation R1 already committed is finished by recovery, never abandoned.
    const committed = new Set(this.runs.promises(runId).map(p => p.delegation_key))
    const open = this.store.delegations(runId).filter(d => d.state === 'intent' && !committed.has(d.key))
    if (!open.length) return
    this.runs.homeFence().transaction('lead.abandon', db => { for (const d of open) this.store.setDelegationState(db, runId, d.key, 'abandoned') })
  }
  /** The saved ACP session, only while the agent advertised `loadSession` and the lead binding is unchanged. */
  private loadable(session: LeadSession): { acpSessionId: string } | null {
    if (!session.acp_session_id || session.load_session !== 1) return null
    try {
      const digest = digestOf(this.agents().resolve(session.owner_account_id, session.project_id, 'lead', this.rolesOf(session)).binding)
      if (digest !== session.binding_digest) return null
    } catch { /* The turn reports an unresolved role as lead_unavailable. */ }
    return { acpSessionId: session.acp_session_id }
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
    turn.observed = observed
    let abortCode: string | null = null
    let failure: unknown = null
    const guard = (body: () => void) => { try { body() } catch (error) { abortCode ??= code(error); live.cancel.abort() } }
    this.live.set(runId, live)
    const result = (async (): Promise<LeadTurnResult> => {
      const session = this.store.session(runId)!
      const grant = this.tools.grant({ runId, attemptId: attempt.id, wakeSeq: turn.wakeSeq }, input => this.delegateCall(runId, turn, session, input),
        this.projectTools(turn, live))
      // The agent holds the token only after its session request was written, so the scrubber may know it from then on:
      // an agent that repeats its own configuration cannot put the capability into the session log. Registering earlier
      // would redact the Authorization header of that very request.
      const tokenRef = `secret://lead/turn/${attempt.id}` as const
      const token = grant.header.value.slice('Bearer '.length)
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
            onSession: info => guard(() => { this.scrubber.register(tokenRef, token); this.onSession(turn, session, info, observed) }),
            onActivity: () => guard(() => this.markActivity(turn)),
            onUsage: usage => { observed.usage = usage } } })
        observed.text = output.text
        observed.usage = output.usage ?? observed.usage
      } catch (error) { failure = error } finally { clearInterval(timer); grant.revoke(); this.scrubber.unregister(tokenRef) }
      if (abortCode && !live.userCancel) failure = new LeadError(abortCode)
      return this.settle(turn, live, observed, failure)
    })().catch((error): LeadTurnResult => {
      this.failure = code(error)
      // An unexpected failure must not leave a live attempt and lease that nothing drives: ask a person.
      if (!['stale_lease', 'closed', 'writer_busy', 'run_not_found'].includes(code(error))) {
        try { this.runs.inputRequired(attempt); this.notice({ kind: 'lead_failed', runId, wakeSeq: turn.wakeSeq, code: code(error) }) } catch { /* fenced out or finished */ }
        try { this.abandonIntents(runId) } catch { /* the intent stays; the person's resume abandons it */ }
      }
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
  /** The first model-produced update, or the delegate call itself (which proves the model ran). */
  private markActivity(turn: Turn): void {
    const observed = turn.observed!
    if (observed.activity) return
    this.onActivity(turn)
    // Only after the acknowledgement committed: a failed one must be retried by `endTurn`, not skipped.
    observed.activity = true
  }
  private onActivity(turn: Turn): void {
    this.fault('turn:before_ack')
    this.runs.modelStarted(turn.attempt, db => { this.store.setRetry(db, turn.attempt.run_id, 0, 0) })
    this.fault('turn:acked')
  }

  // ---- delegation --------------------------------------------------------------------------

  /** Names the first field of the brief that exceeds the owner's ceilings; names only, never values. */
  private limitViolation(brief: LeadDelegateInput): string | null {
    const limits = this.o.limits
    if (!limits) return null
    for (const key of ['cycles', 'tokens', 'moneyMicros', 'wallMs'] as const) {
      const value = brief.caps[key]
      if (value === null || value > limits.maxCaps[key]) return `caps.${key}`
    }
    if (brief.deadlineMs > limits.maxDeadlineMs) return 'deadlineMs'
    if (!limits.allowDetach && brief.onCancel === 'detach') return 'onCancel'
    if (!limits.allowDetach && brief.onDeadline === 'detach') return 'onDeadline'
    return null
  }
  // ---- the lead's project view -------------------------------------------------------------

  /** The three read-only project tools of one turn, or none when the host configured no view. One call runs at a time per turn. */
  private projectTools(turn: Turn, live: Live): ExtraTool[] {
    const view = this.view
    if (!view) return []
    let queue: Promise<unknown> = Promise.resolve()
    return PROJECT_VIEW_TOOLS.map(definition => ({ definition, handler: (input: unknown, context: ToolGrantContext) => {
      const call = queue.then(() => this.projectCall(view, definition.name, turn, live, context, input))
      queue = call.catch(() => undefined)
      return call
    } }))
  }
  /** Serves one project-view call and records it. The project comes from the stored lead session, never from the input. An unaudited read is
   * never served: if the note cannot be written (fenced out, stale lease) the lead gets that code instead of the content. */
  private async projectCall(view: ProjectView, tool: string, turn: Turn, live: Live, context: ToolGrantContext, input: unknown): Promise<ToolResult> {
    const refuse = (text: string): ToolResult => ({ kind: 'result', isError: true, text: this.scrubber.scrub(text) })
    const session = this.store.session(context.runId)
    if (!session || context.runId !== turn.attempt.run_id || context.attemptId !== turn.attempt.id) return refuse('lead_not_found')
    let outcome: { ok: true; text: string; summary: ProjectViewSummary } | { ok: false; error: ProjectViewError }
    try {
      const roots = await this.o.projectView!.roots(session.project_id, live.cancel.signal)
      // The relay works on exactly one root; so does the view. None or several is not a project it can show.
      const root = roots.length === 1 ? roots[0] : undefined
      if (!root) throw new ProjectViewError('project_view_unavailable')
      const result = await view.run(tool, root, input, live.cancel.signal)
      outcome = { ok: true, text: result.text, summary: result.summary }
    } catch (error) {
      // Only a fixed code leaves: an OS message, a path or a library error stays behind the generic one.
      outcome = { ok: false, error: error instanceof ProjectViewError ? error : new ProjectViewError('project_view_unavailable') }
    }
    const summary = outcome.ok ? outcome.summary : null
    try {
      this.runs.mutate(turn.attempt, (_db, emit) => this.note(emit, { action: 'project_view', tool, outcome: outcome.ok ? 'ok' : outcome.error.code,
        path: summary?.path ?? null, commit: summary?.commit ?? null, bytes: summary?.bytes ?? 0, truncated: summary?.truncated ?? false,
        withheld: summary?.withheld ?? 0, ...(summary?.queryChars === undefined ? {} : { queryChars: summary.queryChars }) }))
    } catch (error) { return refuse(code(error)) }
    return outcome.ok ? { kind: 'result', text: outcome.text } : refuse(outcome.error.text)
  }

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
    // The relay runs `acceptance` as argv. A program name with spaces or a JSON array text in one element never runs (`sh: not found`),
    // so the lead is told now, while it can still correct its brief in this turn.
    const argv = brief.plan.items.find(item => /\s/.test(item.acceptance[0]!) || /^[[{"]/.test(item.acceptance[0]!))
    if (argv) return refuse(`invalid_brief: plan.items.${argv.id}.acceptance must be an argv array, one element per argument, e.g. ["node", "--test", "test/a.test.mjs"]`)
    const over = this.limitViolation(brief)
    if (over) return refuse(`delegation_exceeds_policy: ${over}`)
    try { this.o.validateExecutor?.(brief.executor, session.owner_account_id, brief) } catch (error) { return refuse(code(error)) }
    const deadline = this.now() + brief.deadlineMs
    if (!Number.isSafeInteger(deadline)) return refuse('invalid_brief: deadlineMs')
    const key = `lead:${turn.attempt.id}`
    // The call proves the model ran even if the agent emitted no earlier update: acknowledge the wake now.
    try { this.markActivity(turn) } catch (error) { return refuse(code(error)) }
    this.fault('delegate:acked')
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
    this.ensureRetained(attempt)
    if (observed) this.recordUsage(attempt, observed)
    this.fault('delegate:cost_recorded')
    // Under owner ceilings the owner's cancel always reaches the child, whatever an older intent row says.
    const ownerCancels = this.o.limits !== undefined && !this.o.limits.allowDetach
    const promise = this.runs.delegate(attempt, { key, deadline: row.deadline,
      deadlinePolicy: row.on_deadline === 'wrap_up' || ownerCancels ? 'cancel_wrap_up' : 'detach',
      cancelPolicy: ownerCancels ? 'cancel' : row.on_cancel })
    this.fault('delegate:committed')
    this.markDelegated(runId, key, promise, observed?.text ?? '')
    this.fault('delegate:marked')
    if (failureCode === 'cleanup_unconfirmed' || failureCode === 'admission_release_failed') {
      this.notice({ kind: 'cleanup_unconfirmed', runId, wakeSeq: attempt.wake_seq, code: failureCode })
    }
    await this.ensureChild(runId, key)
    return { runId, wakeSeq: attempt.wake_seq, outcome: 'hibernated', code: failureCode }
  }
  /** Idempotent: a kill between the start transaction and the first retain must not leave a sleeping lead unprotected. */
  private ensureRetained(attempt: Attempt): void {
    try { this.runs.retain(attempt, { key: `lead-scratch:${attempt.run_id}`, kind: 'scratch', retainUntil: this.now() + (this.o.retainMs ?? 7 * 86_400_000) }) } catch (error) {
      if (code(error) !== 'idempotency_conflict') throw error
    }
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
  /** A cost observation never strands the run: a failure is noted and the turn goes on. */
  private recordUsage(attempt: Attempt, observed: Observed): void {
    try { this.recordUsageChecked(attempt, observed) } catch (error) {
      try { this.runs.mutate(attempt, (_db, emit) => this.note(emit, { action: 'usage_failed', code: code(error) })) } catch { /* fenced out: the caller's next call reports it */ }
    }
  }
  private recordUsageChecked(attempt: Attempt, observed: Observed): void {
    const { usage, acp } = observed
    const session = this.store.session(attempt.run_id)!
    if (!usage || usage.inputTokens === null || usage.outputTokens === null || !acp) {
      this.runs.mutate(attempt, (_db, emit) => this.note(emit, { action: 'usage_unobserved', attempt: attempt.ordinal }))
      return
    }
    // ACP reports cumulative session totals. The ledger entry key carries the cumulative values it observed, and
    // the baseline is the most recent entry of the SAME agent session and binding, so there is no second record to
    // fall out of step: a kill can neither bill a turn twice nor lose usage for good within a session, a counter
    // reset restarts the baseline at the observed value, and a retry of the same attempt is idempotent.
    const binding = digestOf(this.agents().resolve(session.owner_account_id, session.project_id, 'lead', this.rolesOf(session)).binding)
    const scope = createHash('sha256').update(canonical([acp.acpSessionId, binding])).digest('hex').slice(0, 16)
    const micro = usage.cost && CURRENCIES.has(usage.cost.currency) ? Math.round(usage.cost.amount * 1_000_000) : null
    const cost = micro !== null && Number.isSafeInteger(micro) ? micro : null
    const currency = cost === null ? 'unknown' : usage.cost!.currency as 'USD' | 'EUR' | 'RUB'
    const key = `lead-turn:${attempt.ordinal}:${scope}:${usage.inputTokens}-${usage.outputTokens}-${cost ?? 'u'}-${currency}`
    const entries = this.runs.costEntries(attempt.run_id).filter(entry => entry.key.startsWith('lead-turn:'))
    // One observation per attempt: a second, different one would be summed with the first.
    if (entries.some(entry => entry.key.startsWith(`lead-turn:${attempt.ordinal}:`) && entry.key !== key)) throw new LeadError('usage_conflict')
    const parsed = entries
      .map(entry => /^lead-turn:(\d+):([0-9a-f]{16}):(\d+)-(\d+)-(\d+|u)-(USD|EUR|RUB|unknown)$/.exec(entry.key))
      .filter((match): match is RegExpExecArray => match !== null && match[2] === scope && Number(match[1]) < attempt.ordinal)
      .sort((x, y) => Number(y[1]) - Number(x[1]))
    // Tokens follow the latest observation; money follows the latest KNOWN cost in the same currency, so a
    // turn that reported no cost neither zeroes the baseline nor makes the next cost look new.
    const tokens = parsed[0]
    const money = parsed.find(match => match[5] !== 'u' && match[6] === currency)
    const base = { input: tokens ? Number(tokens[3]) : 0, output: tokens ? Number(tokens[4]) : 0, cost: money ? Number(money[5]) : 0 }
    // A smaller number than the baseline means the agent's counter restarted.
    const delta = (now: number, before: number) => now >= before ? now - before : now
    this.runs.recordCost(attempt, { key, inputTokens: delta(usage.inputTokens, base.input), outputTokens: delta(usage.outputTokens, base.output),
      costMicrounits: cost === null ? null : delta(cost, base.cost), currency })
    this.fault('usage:recorded')
    let billing: unknown = null
    try {
      const binding = this.agents().resolve(session.owner_account_id, session.project_id, 'lead', this.rolesOf(session)).binding
      billing = this.o.billing?.(session.owner_account_id, binding.connectionId) ?? null
    } catch { billing = null }
    this.runs.mutate(attempt, (_db, emit) => this.note(emit, { action: 'cost', attempt: attempt.ordinal, billing }))
  }

  // ---- child -------------------------------------------------------------------------------

  /** One start per delegation at a time, whether called by the finishing turn or by the pump. */
  private async ensureChild(runId: string, key: string): Promise<void> {
    const guardKey = `child:${runId}:${key}`
    while (this.busy.has(guardKey)) { if (this.closed) return; await new Promise(resolve => setTimeout(resolve, 2)) }
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
    const limit = this.o.childStartLimit ?? 3
    const restartable = child.state === 'submitted' || (child.state === 'interrupted' && previous.every(a => a.first_model_at === null) && previous.length < limit)
    // An executor of this process that outlived its lease is still unwinding; its fenced calls fail and its
    // handle settles. Starting another beside it would run the host's preparation twice.
    if (restartable && child.state === 'interrupted' && this.children.has(childId)) return
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
    // Shutdown aborted this turn: mutate nothing. Recovery completes a persisted intent or redelivers the wake.
    if (this.closed && !live.userCancel) return done('failed', 'lead_closed')
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
    if (failures >= (this.o.wakeFailureLimit ?? 5)) {
      // Retrying forever hides a blocked account: keep the wake and packet, record the real code, and ask a person.
      const reason = typedWakeFailure(failureCode)
      this.runs.mutate(attempt, (db, emit) => {
        this.store.setRetry(db, runId, failures, 0)
        this.note(emit, { action: 'wake_undeliverable', reason, code: failureCode, failures })
      })
      this.runs.inputRequired(attempt)
      this.notice({ kind: 'lead_failed', runId, wakeSeq: attempt.wake_seq, code: reason })
      return { runId, wakeSeq: attempt.wake_seq, outcome: 'input_required', code: reason }
    }
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
    const packet = JSON.parse(row!.packet) as LeadWakePacket
    // The fixed sentence says the work ran while the lead slept. Only a resolution of a child that had an attempt can
    // say that: an escalation or quota wake leaves the child pending, and a child cancelled before its start never ran.
    const text = wakePrompt(renderWakePacket(packet), packet.kind === 'resolution' && packet.child.attempts > 0)
    const resume = this.loadable(session)
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
    const open = this.store.openDelegations()
    for (const id of this.interruptedNoticed) if (!open.some(d => d.child_run_id === id)) this.interruptedNoticed.delete(id)
    for (const d of open) {
      if (d.state === 'intent' && !this.live.has(d.lead_run_id)) this.once(`intent:${d.lead_run_id}:${d.key}`, () => this.recoverIntent(d))
      else if (d.state === 'delegated') this.once(`scan:child:${d.lead_run_id}:${d.key}`, () => this.ensureChild(d.lead_run_id, d.key))
      else if (d.state === 'child_started' && d.child_run_id) {
        const state = this.runs.get(d.child_run_id).state
        if (state === 'canceled') this.once(`stop:${d.child_run_id}`, () => this.stopChild(d))
        // An executor lost to a restart before its first model call is started again, once per attempt.
        else if (state === 'interrupted') this.once(`scan:child:${d.lead_run_id}:${d.key}`, () => this.ensureChild(d.lead_run_id, d.key))
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
    this.view?.close()
    if (this.ownsTools) await this.tools.close()
  }
}
const defaultRetry = (failures: number) => Math.min(30_000 * 2 ** Math.max(0, failures - 1), 900_000)
