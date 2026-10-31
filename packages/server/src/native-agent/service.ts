import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, lstat, writeFile, rm, open } from 'node:fs/promises'
import { resolve, join, sep, dirname } from 'node:path'
import {
  nativeAgentInputSchema,
  agentExecResultSchema,
  SESSION_EVENT_VERSION,
  type NativeAgentInput,
  type AgentProgress,
  type AgentProgressV2,
  agentProgressV2Schema,
  type AgentExecResult,
  type SessionEvent,
  type SessionInputArtifactRef,
  type SessionEventDataV2,
  nativeRunBudgetSchema,
  promptTextOf, SIDE_CHAT_SAVE_MAX_BYTES, sideChatRespondRequestSchema, sideChatSaveRequestSchema, sideChatSendRequestSchema, encodeSideChatSavedNote,
  type SideChatRespondResponse, type SideChatSaveResponse, type SideChatSendResponse,
} from '@guanxi/contract'
import { RunStore } from '../runs/store.ts'
import type { Attempt } from '../runs/types.ts'
import type { Db } from '../store/db.ts'
import { NativeSessions } from './sessions.ts'
import type { AppContext } from '../context.ts'
import { SessionLogError, type AppendOptions, type AppendResult, type SessionEventInput, type SessionHandle, type SessionLog } from '../session-log/log.ts'
import { SessionInputError, SessionInputStore, inputMediaTypeFor, isInlineInput, utf8Excerpt } from '../session-log/input-artifacts.ts'
import { NativeAppendQueue } from './append-queue.ts'
import { ArtifactQueueError, blocksV1Producer, legacyQueueOf, queueStateOf, queueV2Of, type ExecutableQueueItem, type QueueState } from './queue-state.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { Connections } from '../connections/service.ts'
import { assertRootsClean } from './cleanup.ts'
import { selectedModel, connectionStream, emptyUsage } from './model.ts'
import { runSideChat, SideChatError, sideChatConcurrencyFromEnv, sideChatMessageId } from './side-chat.ts'
import { orientation } from './orientation.ts'
import type { ProjectIndexService } from '../indexing/plugin.ts'
import { nativeTools } from './tools.ts'
import { NativeProjectRoots } from './projects.ts'
import { sandboxCommand, type SandboxPolicy } from './sandbox.ts'
import { apiPortFromEnv, portFromEnv, DEFAULT_WEB_PORT, WEB_PORT_ENV } from '../config/listen-env.ts'
import { resolveInWorkspace } from '../tools/jail.ts'

export class NativeAgentError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}
/** The legacy progress body cannot describe an artifact-backed queue item: ask for progress2. */
export class NativeProgressVersionError extends NativeAgentError {
  constructor() { super('native_progress_version_unsupported') }
}
/** The content-free failure codes a queued turn's preparation records on its own attempt. */
const PREPARATION_REPORTS = {
  input_artifact_unavailable: 'Session input artifact unavailable',
  egress_unavailable: 'Egress scrubber unavailable',
  stored_data_invalid: 'Stored session data is unreadable',
} as const
function preparationFailureCode(error: unknown): keyof typeof PREPARATION_REPORTS | null {
  const code = error instanceof NativeAgentError ? error.code : null
  return code !== null && Object.hasOwn(PREPARATION_REPORTS, code) ? code as keyof typeof PREPARATION_REPORTS : null
}
/** What a queued turn's preparation hands to `execute`: the verified input and history. */
interface PreparedTurn { prompt: string; history: AgentMessage[] }
/**
 * `verify` is the owner check (abort, availability, active identity, home and attempt fence). `execute` calls
 * it synchronously on return from `prepare`, and again after a preparation failure to tell a lost owner
 * (recorded as the ordinary cancelled or failed terminal) from a genuinely unreadable input.
 */
interface PrepareTurn { prepare(): Promise<PreparedTurn>; verify(): void }
interface Active {
  policy: SandboxPolicy; handle: SessionHandle; abort: AbortController; settled: Promise<void>; attempt: Attempt
  /** Open for queue mutations while a turn runs. Null between turns and while a queued turn prepares. */
  queue: NativeAppendQueue | null
  /** The FIFO of a queued turn that is still preparing: it owns stop and failure recording, not mutations. */
  preparing: NativeAppendQueue | null
}
export type NativeHost = Pick<AppContext, 'projects' | 'workspaces' | 'artifactTransfers'>
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep)
async function rejectUnresolvedLinks(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    let link = false
    try {
      link = (await lstat(current)).isSymbolicLink()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new NativeAgentError('protected_path_invalid')
    }
    if (link) {
      // An absent future path is valid. An existing dangling link is not:
      // its future target cannot be protected by the nearest-parent fallback.
      try { await realpath(current) } catch { throw new NativeAgentError('protected_path_invalid') }
    }
    if (dirname(current) === current) return
  }
}
export class NativeAgents {
  private preparing = new Set<string>()
  /** In-flight side-chat `respond` requests per session, bounded by `sideChatConcurrency`. */
  private sideChatInFlight = new Map<string, number>()
  sideChatConcurrency = sideChatConcurrencyFromEnv(process.env)
  private active = new Map<string, Active>()
  private closed = false
  private projectRoots: NativeProjectRoots
  readonly host: NativeHost
  readonly log: SessionLog
  readonly connections: Connections
  readonly scrubber: EgressScrubber
  readonly dataDir: string
  readonly nodePorts: () => number[]
  readonly sessions: NativeSessions
  private maintenanceTask: Promise<void> = Promise.resolve()
  private maintaining = false
  private maintenance: ReturnType<typeof setInterval>
  readonly runs: RunStore
  readonly inputArtifacts: SessionInputStore
  private commandRunner: typeof sandboxCommand
  private readonly index?: ProjectIndexService
  constructor(host: NativeHost, log: SessionLog, connections: Connections, scrubber: EgressScrubber, dataDir: string, nodePorts = () => [apiPortFromEnv(process.env, 4310), portFromEnv(process.env, WEB_PORT_ENV, DEFAULT_WEB_PORT)], commandRunner = sandboxCommand, runtime: { db: Db; runs: RunStore; inputArtifacts?: SessionInputStore }, index?: ProjectIndexService) {
    this.index = index
    this.runs = runtime.runs
    this.inputArtifacts = runtime.inputArtifacts ?? new SessionInputStore({ dataDir, db: runtime.db })
    this.sessions = new NativeSessions(runtime.db, log, dataDir, this.runs)
    this.maintenance = setInterval(() => { void this.maintain() }, 60000)
    this.maintenance.unref()
    void this.maintain()
    this.commandRunner = commandRunner
    this.nodePorts = nodePorts
    this.host = host; this.log = log; this.connections = connections; this.scrubber = scrubber; this.dataDir = dataDir
    this.projectRoots = new NativeProjectRoots(join(dataDir, 'native-projects.sqlite'), host)
    this.trackProjects()
  }
  private trackProjects() {
    if (!this.index) return
    for (const project of this.projectRoots.list()) for (const binding of project.filesystemBindings) {
      const workspace = this.host.workspaces.get(binding.workspaceId)
      if (workspace) void this.index.track(workspace.rootPath).catch(() => undefined)
    }
  }

  private maintain(): Promise<void> {
    if (this.maintaining || this.closed) return this.maintenanceTask
    this.maintaining = true
    this.maintenanceTask = Promise.resolve().then(async () => {
      this.runs.heartbeat()
      this.runs.reconcile()
      await this.sessions.maintain(new Set(this.active.keys()))
      await this.sessions.reapOrphans(id => this.preparing.has(id) || this.active.has(id), () => this.runs.heartbeat())
      await this.inputArtifacts.reap({
        isLive: id => this.preparing.has(id) || this.active.has(id),
        liveSessionIds: [...this.preparing, ...this.active.keys()],
        assertHome: () => this.runs.heartbeat(),
        // The final fresh membership check and rename share the R1 home
        // generation and SQLite transaction that serializes session creation.
        criticalSection: (operation, body) => this.runs.homeFence().transaction(operation, () => body()),
      })
    }).catch(() => { /* Readiness/home contention or cleanup failures retry next pass. */ })
      .finally(() => { this.maintaining = false })
    return this.maintenanceTask
  }
  async create(raw: unknown): Promise<{ sessionId: string }> {
    this.ready()
    this.runs.heartbeat()
    const input = nativeAgentInputSchema.parse(raw)
    selectedModel(this.connections, input)
    const project = this.projectRoots.get(input.projectId)
    if (!project) throw new NativeAgentError('project_not_found')
    const roots = await Promise.all(project.filesystemBindings.map(async binding => {
      const workspace = this.host.workspaces.get(binding.workspaceId)
      if (!workspace) throw new NativeAgentError('root_unavailable')
      const root = await realpath(workspace.rootPath)
      if (root === '/' || !(await stat(root)).isDirectory()) throw new NativeAgentError('root_unavailable')
      return root
    }))
    const dataRoot = await realpath(this.dataDir)
    if (roots.some(root => inside(root, dataRoot) || inside(dataRoot, root))) throw new NativeAgentError('root_overlaps_node_data')
    const sessionId = randomUUID()
    const scratch = join(dataRoot, 'scratch', sessionId)
    const attachmentDir = join(dataRoot, 'native-attachments', sessionId)
    this.preparing.add(sessionId)
    let handle: SessionHandle | undefined
    try {
      await mkdir(scratch, { recursive: true, mode: 0o700 })
      await mkdir(attachmentDir, { recursive: true, mode: 0o700 })
      const attachments: string[] = []
      const attachmentMetadata: NonNullable<SandboxPolicy['attachmentMetadata']> = []
      for (const id of input.attachmentIds) {
        const attachment = await this.host.artifactTransfers.download(id, { scope: 'project', projectId: project.id }, new AbortController().signal)
        this.ready()
        this.runs.heartbeat()
        const target = join(attachmentDir, `${attachments.length}.attachment`)
        await writeFile(target, attachment.content, { flag: 'wx', mode: 0o400 })
        attachments.push(target)
        attachmentMetadata.push({ path: target, mediaType: attachment.attachment.artifact.mediaType, displayName: attachment.attachment.displayName })
      }
      // Canonical paths and literal sandbox entries prevent glob/symlink interpretation.
      const allowed = [...roots, await realpath(scratch)]
      const protectedPaths = [...new Set((await Promise.all(input.protectedPaths.map(async path => {
        const lexical = resolve(roots[0] ?? scratch, path)
        if (!allowed.some(root => inside(root, lexical))) throw new NativeAgentError('protected_path_invalid')
        await rejectUnresolvedLinks(lexical)
        for (const root of allowed) {
          try {
            // Keep the name and its canonical target, including absent children
            // beneath an existing linked parent. The OS profile compares real paths.
            return [lexical, resolveInWorkspace(root, lexical)]
          } catch { /* the target may belong to another allowed root */ }
        }
        throw new NativeAgentError('protected_path_invalid')
      }))).flat())]
      const policy: SandboxPolicy = { mode: input.mode, roots: [...new Set(roots)], scratch: await realpath(scratch), attachments, protectedPaths, domains: input.domains, nodePorts: [...this.nodePorts()], runtimeBase: dataRoot, attachmentMetadata, hiddenPaths: [await realpath(this.dataDir)] }
      this.ready()
      this.ensureRoots(policy, sessionId)
      for (const root of roots) void this.index?.track(root).catch(() => undefined)
      const { prompt: _prompt, ...settings } = input
      handle = this.sessions.create(sessionId, input.model, input.retention, { ...settings, ...policy })
      this.launch(sessionId, input, policy, handle, input.prompt, [])
      return { sessionId }
    } catch (error) {
      handle?.close()
      await rm(scratch, { recursive: true, force: true })
      await rm(attachmentDir, { recursive: true, force: true })
      throw error
    } finally { this.preparing.delete(sessionId) }
  }
  private ensureRoots(policy: SandboxPolicy, id: string) {
    if (policy.mode === 'full-access') for (const [otherId, active] of this.active) {
      if (otherId === id || active.policy.mode !== 'full-access') continue
      if (policy.roots.some(root => active.policy.roots.some(other => inside(root, other) || inside(other, root)))) throw new NativeAgentError('root_busy')
    }
    assertRootsClean(this.dataDir, [policy.scratch, ...policy.roots])
  }
  private ready() {
    if (this.closed) throw new NativeAgentError('agent_unavailable')
    if (!this.scrubber.isReady()) throw new NativeAgentError('egress_unavailable')
  }
  projects() { this.ready(); return this.scrubber.scrub(this.projectRoots.list()) }
  setRoots(id: string, workspaceIds: string[]) {
    this.ready()
    const project = this.projectRoots.set(id, workspaceIds)
    this.trackProjects()
    if (!project) throw new NativeAgentError('project_not_found')
    return project
  }
  /**
   * The log read, with a stored snapshot that cannot be projected safely (for example a late
   * secret registration that expands a v3 inline item past its bound) reported as a typed
   * content-free error instead of a raw log error. The stored input stays untouched.
   */
  private readLog(id: string) {
    try { return this.log.readAll(id, 'remote_agent') } catch (error) {
      if (error instanceof SessionLogError && error.code === 'stored_data_invalid') throw new NativeAgentError('stored_data_invalid')
      throw error
    }
  }
  private events(id: string) {
    this.ready()
    const events = this.readLog(id)
    if (!events.some(e => e.type === 'agent.policy')) throw new NativeAgentError('session_not_found')
    return events
  }
  /**
   * The internal read model: everything progress and result report except the
   * queue, plus the executable queue state. Nothing here is an outward body.
   */
  private snapshot(id: string) {
    const events = this.events(id)
    const policy = events.find(e => e.type === 'agent.policy')!
    if (policy.type !== 'agent.policy') throw new NativeAgentError('session_not_found')
    let status: AgentProgress['status'] = 'interrupted', error: string | null = null
    let plan: AgentProgress['plan'] = [], summary = ''
    let shellUnavailable: AgentProgress['shellUnavailable']
    for (const event of events) {
      if (event.type === 'agent.state') { status = event.data.status; error = event.data.error }
      if (event.type === 'agent.plan') plan = event.data.items
      if (event.type === 'assistant.message') summary = event.data.text
      if (event.type === 'tool.result' && event.data.status === 'error' && events.some(call => call.type === 'tool.call' && call.data.toolCallId === event.data.toolCallId && call.data.name === 'shell')) {
        for (const reason of ['container_runtime_unavailable', 'container_path_unsupported', 'container_home_root_denied', 'container_runtime_protected'] as const) {
          if (event.data.error === reason) shellUnavailable = reason
        }
      }
      if (event.type === 'tool.result' && event.data.status === 'ok' && events.some(call => call.type === 'tool.call' && call.data.toolCallId === event.data.toolCallId && call.data.name === 'shell')) shellUnavailable = undefined
    }
    const queue = queueStateOf(events)
    const lifecycle = events.filter(e => e.type === 'run.lifecycle').at(-1)
    if (!this.active.has(id) && lifecycle?.type === 'run.lifecycle') {
      const run = this.runs.get(lifecycle.data.runId)
      if (run.state === 'canceled') { status = 'cancelled'; error = this.runs.executionReason(run.id) }
      else if (run.state === 'completed') status = 'completed'
      else if (run.state === 'failed') status = 'failed'
      else { status = run.state === 'input_required' ? 'input_required' : 'interrupted'; error = 'process_restarted' }
    } else if (status === 'running' && !this.active.has(id)) { status = 'interrupted'; error = 'process_restarted' }
    try { assertRootsClean(this.dataDir, [policy.data.scratch, ...policy.data.roots]) } catch { status = 'failed'; error = 'cleanup_unconfirmed' }
    return { queue, status, error, plan, summary, shellUnavailable, retention: this.sessions.retention(id), sessionId: id,
      projectId: policy.data.projectId, connectionId: policy.data.connectionId, model: policy.data.model, mode: policy.data.mode,
      observedAt: events.at(-1)!.createdAt }
  }
  private outward(state: ReturnType<NativeAgents['snapshot']>, queue: unknown, version?: 2) {
    return this.scrubber.scrub({ ...(version ? { version } : {}), retention: state.retention, sessionId: state.sessionId, projectId: state.projectId, connectionId: state.connectionId,
      model: state.model, mode: state.mode, status: state.status, plan: state.plan, queue, summary: state.summary, error: state.error,
      observedAt: state.observedAt, source: 'session.log', confidence: 'high', ...(state.shellUnavailable ? { shellUnavailable: state.shellUnavailable } : {}) })
  }
  /**
   * The legacy v1 body: `queue[].text` is the complete current scrubbed text. An
   * artifact-backed pending item has no honest v1 text, so it is refused with a
   * typed error (HTTP 406) rather than approximated by an excerpt.
   */
  progress(id: string): AgentProgress {
    const state = this.snapshot(id)
    let queue: AgentProgress['queue']
    try { queue = legacyQueueOf(state.queue.pending) } catch (error) {
      if (error instanceof ArtifactQueueError) throw new NativeProgressVersionError()
      throw error
    }
    return this.outward(state, queue) as AgentProgress
  }
  /** The negotiated v2 body. It never opens an artifact: previews come from stored excerpts only. */
  progressV2(id: string): AgentProgressV2 {
    const state = this.snapshot(id)
    const body = agentProgressV2Schema.safeParse(this.outward(state, queueV2Of(state.queue.pending, text => this.scrubber.scrub(text)), 2))
    // A late registration that rewrites a required opaque field fails closed and content-free.
    if (!body.success) throw new NativeAgentError('agent_unavailable')
    return body.data
  }
  result(id: string): AgentExecResult {
    const state = this.snapshot(id)
    if (state.status === 'running') throw new NativeAgentError('session_busy')
    const reported = this.scrubber.scrub({ status: state.status, summary: state.summary, error: state.error })
    return agentExecResultSchema.parse({ version: 1, sessionId: id, status: reported.status, text: reported.summary, error: reported.error })
  }
  async wait(id: string) { await this.active.get(id)?.settled; return this.result(id) }
  stop(id: string) {
    const active = this.active.get(id)
    if (!active) { this.events(id); return }
    // Enqueue before aborting, but never wait for artifact I/O or a commit here.
    // The queue retains this intent so an earlier aborted artifact append cannot
    // drop it from the failure path that writes the single terminal. A queued turn
    // that is still preparing owns its attempt, so it records the intent too.
    const owner = active.queue ?? active.preparing
    if (owner !== null) {
      void owner.requestIntervention({ type: 'intervention', data: { action: 'stop', reason: 'explicit_stop' } }).catch(() => undefined)
    }
    active.abort.abort()
  }
  /** v1 snapshot items for the pending state. Only reachable when the producer is not blocked, so every item is inline. */
  private v1Items(state: QueueState): { id: string; text: string }[] {
    return state.pending.map(item => {
      if (item.kind !== 'inline') throw new NativeAgentError('native_queue_producer_unavailable')
      return { id: item.id, text: this.scrubber.scrub(item.text) }
    })
  }
  async queue(id: string, text: string, userActivity = true, itemId?: string): Promise<'queued' | 'duplicate'> {
    this.ready()
    if (!text.trim()) throw new NativeAgentError('validation_failed')
    const active = this.active.get(id)
    if (!active || active.queue === null) throw new NativeAgentError('session_not_running')
    const pending = active.queue
    // Read and append the projection inside the same FIFO operation: a snapshot
    // taken before enqueue is stale as soon as a concurrent queue() or
    // removeQueued() commits, and would silently overwrite its accepted items.
    // A caller-chosen item id (side-chat Send) makes the operation idempotent: an id that is
    // already pending or already consumed as a prompt is never queued a second time.
    const outcome = await pending.enqueue(() => {
      // Reads that can fail for reasons unrelated to the turn (scrubber readiness, an unreadable
      // snapshot) are returned, never thrown: a throw inside the FIFO would abort the main turn.
      // The append itself stays unprotected on purpose, because a failed trace write must fail the turn.
      let current: QueueState, duplicate = false
      try {
        current = queueStateOf(this.events(id))
        // Q1 restricted-reader floor: this node still writes v1 snapshots, which cannot carry a pending
        // v3 item. Refuse before anything is written, read or replaced.
        if (blocksV1Producer(current)) return { error: new NativeAgentError('native_queue_producer_unavailable') }
        // Retention counts only an accepted-for-evaluation user call, never a refused one.
        if (userActivity) this.sessions.touch(id)
        duplicate = itemId !== undefined && (current.pending.some(item => item.id === itemId) || this.hasPrompt(id, itemId))
      } catch (error) { return { error } }
      if (duplicate) return { status: 'duplicate' as const }
      pending.appendNow({ type: 'agent.queue', data: { items: [...this.v1Items(current), { id: itemId ?? randomUUID(), text }] } })
      return { status: 'queued' as const }
    })
    if ('error' in outcome) throw outcome.error
    return outcome.status
  }
  private hasPrompt(id: string, messageId: string): boolean {
    return this.readLog(id).some(event => event.type === 'prompt' && event.data.messageId === messageId)
  }
  async removeQueued(id: string, item: string) {
    const active = this.active.get(id)
    if (!active || active.queue === null) throw new NativeAgentError('session_not_running')
    const pending = active.queue
    const outcome = await pending.enqueue(() => {
      // Like queue(): a failed read is returned, never thrown, because a throw inside the FIFO aborts the main turn.
      let current: QueueState
      try { current = queueStateOf(this.events(id)) } catch (error) { return { error } }
      // Refused even for an id that is not pending: the node cannot write a snapshot over v3 work.
      if (blocksV1Producer(current)) return { error: new NativeAgentError('native_queue_producer_unavailable') }
      pending.appendNow({ type: 'agent.queue', data: { items: this.v1Items({ ...current, pending: current.pending.filter(i => i.id !== item) }) } })
      return {}
    })
    if ('error' in outcome) throw outcome.error
  }
  /* ── Ephemeral side chat (D-135): see side-chat.ts. Reads and answers write nothing. ── */
  private sideChatSession(id: string) {
    try {
      this.ready()
      this.sessions.assertAvailable(id)
      const events = this.events(id)
      const policy = events.find(event => event.type === 'agent.policy')
      if (policy?.type !== 'agent.policy') throw new NativeAgentError('session_not_found')
      const input = nativeAgentInputSchema.parse({ projectId: policy.data.projectId, connectionId: policy.data.connectionId, model: policy.data.model,
        mode: policy.data.mode, domains: policy.data.domains, protectedPaths: policy.data.protectedPaths, attachmentIds: policy.data.attachmentIds,
        contextTokens: policy.data.contextTokens, budget: policy.data.budget, retention: policy.data.retention, prompt: 'side chat' })
      return { events, input }
    } catch (error) { throw this.sideChatFailure(error) }
  }
  private sideChatFailure(error: unknown): SideChatError | NativeAgentError {
    if (error instanceof SideChatError) return error
    // The Q1 floor keeps its own typed 409 body on every route that reaches the queue.
    if (error instanceof NativeAgentError && error.code === 'native_queue_producer_unavailable') return error
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : ''
    if (code === 'session_not_found') return new SideChatError('session_not_found')
    if (code === 'session_expired') return new SideChatError('session_unavailable')
    if (code === 'egress_unavailable') return new SideChatError('egress_unavailable')
    if (code === 'idempotency_conflict') return new SideChatError('operation_conflict')
    if (['session_busy', 'writer_busy', 'writer_fenced', 'stale_lease', 'session_not_running', 'trace_sealed'].includes(code)) return new SideChatError('session_busy')
    if (code === 'invalid_event') return new SideChatError('validation_failed')
    return new SideChatError('agent_unavailable')
  }
  async sideChatRespond(id: string, raw: unknown, signal?: AbortSignal): Promise<SideChatRespondResponse> {
    const request = sideChatRespondRequestSchema.parse(raw)
    const { events, input } = this.sideChatSession(id)
    let model: ReturnType<typeof selectedModel>
    try { model = selectedModel(this.connections, input) } catch { throw new SideChatError('connection_unavailable') }
    // One slot per request, released when the provider call settles (including a client abort).
    const running = this.sideChatInFlight.get(id) ?? 0
    if (running >= this.sideChatConcurrency) throw new SideChatError('too_many_requests')
    this.sideChatInFlight.set(id, running + 1)
    try {
      return await runSideChat({ sessionId: id, budget: input.budget, connections: this.connections, scrubber: this.scrubber, model, input, events, request, signal })
    } finally {
      const left = (this.sideChatInFlight.get(id) ?? 1) - 1
      if (left <= 0) this.sideChatInFlight.delete(id); else this.sideChatInFlight.set(id, left)
    }
  }
  /** Appends one history-only `agent.note`; the same operation id and content never appends twice. */
  async sideChatSave(id: string, raw: unknown): Promise<SideChatSaveResponse> {
    const request = sideChatSaveRequestSchema.parse(raw)
    this.sideChatSession(id)
    const input = { type: 'agent.note' as const, data: { text: encodeSideChatSavedNote(request.operationId, request.messages) } }
    // An explicit bound, never a silent cut: a transcript this large is refused so the caller can keep it elsewhere.
    const encodedBytes = Buffer.byteLength(input.data.text, 'utf8')
    if (encodedBytes > SIDE_CHAT_SAVE_MAX_BYTES) throw new SideChatError('too_large', { bytes: encodedBytes, boundBytes: SIDE_CHAT_SAVE_MAX_BYTES })
    const options = { idempotencyKey: `side-chat-save:${request.operationId}` }
    try {
      const owner = this.active.get(id)
      const queue = owner?.queue ?? owner?.preparing ?? null
      let result: AppendResult
      if (queue !== null) {
        // Through the running turn's FIFO so the append cannot interleave with its own. The
        // operation never throws into the FIFO: a failure there would abort the main turn.
        const outcome = await queue.enqueue(() => { try { return { result: queue.appendNow(input, options) } } catch (error) { return { error } } })
        if ('error' in outcome) throw outcome.error
        result = outcome.result
      } else {
        this.runs.heartbeat()
        result = this.runs.homeFence().transaction('side_chat_save', () => this.log.appendFromHomeWithin(id, { kind: 'agent', threadId: id }, input, options))
        this.log.notify([id])
      }
      return { operationId: request.operationId, eventId: result.event.id, seq: result.event.seq, duplicate: result.duplicate }
    } catch (error) { throw this.sideChatFailure(error) }
  }
  /** Posts one message to the main session exactly once per operation id (prompt id = derived UUID). */
  async sideChatSend(id: string, raw: unknown): Promise<SideChatSendResponse> {
    const request = sideChatSendRequestSchema.parse(raw)
    this.sideChatSession(id)
    const messageId = sideChatMessageId(request.operationId)
    const incoming = this.scrubber.scrub(request.text)
    const answer = (delivery: SideChatSendResponse['delivery'], duplicate: boolean): SideChatSendResponse => ({ operationId: request.operationId, messageId, delivery, duplicate })
    // The receipt is the durable log, never process memory: a recorded prompt (consumed) or a pending queue item.
    const receipt = () => {
      const prompt = this.readLog(id).find(event => event.type === 'prompt' && event.data.messageId === messageId)
      if (prompt?.type === 'prompt') {
        // Short prompts are stored inline and compared exactly; long ones are stored as an artifact, so the
        // stored checksum of the full scrubbed text is compared, never a bounded excerpt.
        const same = prompt.version === SESSION_EVENT_VERSION ? prompt.data.text === incoming
          : prompt.data.artifact.checksum === `sha256:${createHash('sha256').update(incoming, 'utf8').digest('hex')}`
        return { kind: 'prompt' as const, same }
      }
      const item = queueStateOf(this.events(id)).pending.find(entry => entry.id === messageId)
      if (!item) return null
      // An artifact item is compared by the checksum of the full scrubbed text, never by its excerpt.
      const same = item.kind === 'inline' ? this.scrubber.scrub(item.text) === incoming
        : item.artifact.checksum === `sha256:${createHash('sha256').update(incoming, 'utf8').digest('hex')}`
      return { kind: 'queued' as const, same }
    }
    try {
      const found = receipt()
      if (found && !found.same) throw new SideChatError('operation_conflict')
      if (found?.kind === 'prompt') return answer('already_sent', true)
      // A pending item is only a receipt while a turn can still consume it. With nothing running
      // (the turn was stopped, failed or the node restarted) it falls through to a fresh start, whose
      // prompt id is the same, so the stale item is filtered as consumed instead of waiting forever.
      if (found?.kind === 'queued' && this.active.has(id)) return answer('queued', true)
      try {
        // `prompt` decides under its own checks whether a turn started or the text was queued, so the
        // answer reports what actually happened even if a turn became active since the checks above.
        const outcome = await this.prompt(id, request.text, messageId)
        if (outcome === 'started') return answer('started', false)
        if (outcome === 'queued') return answer('queued', false)
        return receipt()?.kind === 'prompt' ? answer('already_sent', true) : answer('queued', true)
      } catch (error) {
        // The turn is between its final append and its teardown; the caller retries. Starting a new
        // turn here would race the old one for the writer.
        const code = error instanceof Error && 'code' in error ? error.code : ''
        if (code === 'session_not_running' || code === 'trace_sealed') throw new NativeAgentError('session_busy')
        throw error
      }
    } catch (error) { throw this.sideChatFailure(error) }
  }
  leaveSession(id: string) { this.ready(); this.runs.heartbeat(); return this.sessions.leave(id) }
  setRetention(id: string, mode: 'keep' | 'ttl' | 'session') { this.ready(); this.runs.heartbeat(); return this.sessions.setRetention(id, mode) }
  async deleteSession(id: string) {
    this.ready()
    this.runs.heartbeat()
    this.runs.reconcile()
    if (this.active.has(id)) throw new NativeAgentError('session_busy')
    try { await this.sessions.remove(id) } catch (error) { throw new NativeAgentError(error instanceof Error && ['session_busy','writer_busy','session_not_found','cleanup_unconfirmed'].includes('code' in error ? String(error.code) : error.message) ? ('code' in error ? String(error.code) : error.message) : 'deletion_failed') }
    return { sessionId: id, deleted: true as const }
  }
  /** Reports what happened: a turn started, the text was queued behind a running one, or the id was already queued or sent. */
  async prompt(id: string, text: string, messageId?: string): Promise<'started' | 'queued' | 'duplicate'> {
    this.ready()
    this.runs.heartbeat()
    this.sessions.assertAvailable(id)
    if (this.active.has(id)) return this.queue(id, text, true, messageId)
    const events = this.events(id)
    const event = events.find(e => e.type === 'agent.policy')!
    if (event.type !== 'agent.policy') throw new NativeAgentError('session_not_found')
    const policy = { ...event.data, nodePorts: [...this.nodePorts()] }
    const input = nativeAgentInputSchema.parse({ projectId: policy.projectId, connectionId: policy.connectionId, model: policy.model,
      mode: policy.mode, domains: policy.domains, protectedPaths: policy.protectedPaths, attachmentIds: policy.attachmentIds,
      contextTokens: policy.contextTokens, budget: policy.budget, retention: policy.retention, prompt: text })
    const model = selectedModel(this.connections, input)
    this.ensureRoots(policy, id)
    const handle = this.log.open(id, { kind: 'agent' })
    let history: AgentMessage[]
    try {
      history = await this.replay(id, events, model.api, model.provider, model.id)
    } catch (error) {
      handle.close()
      throw error
    }
    this.launch(id, input, policy, handle, text, history, messageId)
    return 'started'
  }
  private attempt(id: string, input: NativeAgentInput) {
    this.runs.heartbeat()
    this.runs.reconcile()
    const run = this.runs.create({ sessionId: id })
    const attempt = this.runs.start(run.id)
    this.runs.configureExecution(attempt, nativeRunBudgetSchema.parse(input.budget ?? {}))
    this.runs.retain(attempt, { key: `native-${run.id}`, kind: 'scratch', retainUntil: Number.MAX_SAFE_INTEGER })
    return attempt
  }
  private fencedHandle(handle: SessionHandle, attempt: Attempt): SessionHandle {
    return { sessionId: handle.sessionId, epoch: handle.epoch, get closed() { return handle.closed },
      close: () => handle.close(),
      append: (input, options = {}) => this.runs.append(attempt, input,
        { ...options, expectedSeq: options.expectedSeq ?? this.log.session(handle.sessionId)!.lastSeq + 1 }),
    }
  }
  private launch(id: string, input: NativeAgentInput, policy: SandboxPolicy, rawHandle: SessionHandle, prompt: string, history: AgentMessage[], firstMessageId?: string) {
    let attempt: Attempt
    try { this.sessions.touch(id); attempt = this.attempt(id, input) } catch (error) { rawHandle.close(); throw error }
    const abort = new AbortController()
    const active: Active = { policy, handle: this.fencedHandle(rawHandle, attempt), abort, attempt, settled: Promise.resolve(), queue: null, preparing: null }
    this.active.set(id, active)
    active.settled = (async () => {
      let next: string | undefined = prompt
      let queuedId: string | undefined = firstMessageId
      let prepare: PrepareTurn | undefined
      while (next !== undefined) {
        const timer = setInterval(() => {
          try { this.runs.renew(active.attempt); this.runs.checkExecution(active.attempt) }
          catch { abort.abort() }
        }, 1000)
        timer.unref()
        try { await this.execute(id, input, policy, active, next, history, queuedId, prepare) }
        finally { clearInterval(timer) }
        const state = this.runs.get(active.attempt.run_id).state
        if (abort.signal.aborted || state !== 'completed') break
        // The prior turn is complete and its FIFO drained. Choose the next item from fresh events.
        // Mutation admission stays closed (`active.queue` is null) until that turn's preparation ends.
        let selected: ExecutableQueueItem | undefined, unreadable: unknown
        try { selected = queueStateOf(this.events(id)).pending[0] } catch (error) { unreadable = error ?? new NativeAgentError('stored_data_invalid') }
        next = undefined; queuedId = undefined; prepare = undefined; history = []
        if (selected === undefined && unreadable === undefined) break
        // Nothing has started yet: an unavailable session simply does not continue.
        try { this.sessions.assertAvailable(id) } catch { break }
        // Allocate the next R1 run/attempt first. Every await after this point is owned by it, so a
        // failure is recorded on a live attempt instead of being swallowed after a completed turn.
        active.attempt = this.attempt(id, input)
        active.handle = this.fencedHandle(rawHandle, active.attempt)
        next = ''
        queuedId = selected?.id
        // An unreadable log at selection time is this attempt's own accurate failure (never reported as a
        // missing input); the stored events and the pending input are left untouched.
        prepare = selected === undefined
          ? { prepare: async () => { throw unreadable }, verify: this.ownerCheck(id, active, active.attempt) }
          : this.queuedTurn(id, input, active, active.attempt, selected)
      }
    })().catch(() => {
      try { this.runs.complete(active.attempt, 'failed') } catch { /* A fenced owner cannot complete or append. */ }
    }).finally(() => { rawHandle.close(); this.active.delete(id) })
  }

  /**
   * Prepare one queued turn on its already allocated attempt: resolve the full
   * input, replay history, and verify the owner again after every await.
   *
   * Inline legacy text is scrubbed afresh; an artifact is read through the
   * store (session, id, checksum, size, media type and exact digest), decoded
   * as strict UTF-8 and scrubbed with the current registry. An excerpt or a
   * guessed path is never executed. Nothing here appends a prompt marker or
   * reaches a provider: `execute` calls `verify()` synchronously on return, so no
   * await separates the last check from the first dispatch step.
   */
  private ownerCheck(id: string, active: Active, attempt: Attempt): () => void {
    return () => {
      active.abort.signal.throwIfAborted()
      // `closed` is defense in depth: close() aborts every active turn first, so the signal above fires first.
      if (this.closed) throw new NativeAgentError('agent_unavailable')
      this.sessions.assertAvailable(id)
      // Identity is defense in depth as well: `active` is replaced only after the turn settles and
      // `active.attempt` only between turns, so no reachable state fails this clause today. It guards a
      // future refactor that lets a second owner exist.
      if (this.active.get(id) !== active || active.attempt !== attempt) throw new NativeAgentError('writer_fenced')
      this.runs.checkExecution(attempt)
    }
  }
  private queuedTurn(id: string, input: NativeAgentInput, active: Active, attempt: Attempt, item: ExecutableQueueItem): PrepareTurn {
    const verify = this.ownerCheck(id, active, attempt)
    return {
      verify,
      prepare: async () => {
        // Synchronous: image staging in `execute` awaited before this call, so a lost owner must not start a read.
        verify()
        const model = selectedModel(this.connections, input)
        const prompt = item.kind === 'inline'
          ? this.scrubber.scrub(item.text)
          : this.scrubber.scrub(await this.readInputText(id, item.artifact, active.abort.signal))
        // A held read must not be followed by a replay for a lost owner.
        verify()
        const history = await this.replay(id, this.events(id), model.api, model.provider, model.id, active.abort.signal)
        // `execute` runs `verify()` synchronously on return, before anything else can happen.
        return { prompt, history }
      },
    }
  }

  private async execute(id: string, input: NativeAgentInput, policy: SandboxPolicy, active: Active, prompt: string, history: AgentMessage[], queuedId?: string, prepare?: PrepareTurn) {
    const handle = active.handle
    const abort = active.abort
    const signal = abort.signal
    const attempt = active.attempt
    let step = 0
    let promptId: string = queuedId ?? randomUUID()
    let promptOrigin: 'typed' | 'queued' = queuedId ? 'queued' : 'typed'
    const turnId = randomUUID()
    let queue: NativeAppendQueue | null = null
    const created = new NativeAppendQueue({
      append: (event, options) => handle.append(event, options),
      abort: () => abort.abort(),
      onFailure: async ({ code }) => {
        if (queue === null) return
        this.writeFailureTerminal(queue, turnId, () => step, signal, code)
      },
    })
    queue = created
    // A queued turn keeps mutation admission closed while it prepares; stop and failure recording
    // reach it through `preparing`. A direct turn has nothing to prepare and opens at once.
    if (prepare) active.preparing = created; else active.queue = created
    const tools = nativeTools({
      policy, log: this.log, handle, scrubber: this.scrubber,
      queue: async text => { await this.queue(id, text, false) },
      executeCommand: this.commandRunner, index: this.index,
      append: (event, options) => created.append(event, options),
      awaitToolCall: (toolCallId, toolSignal) => created.waitForToolCall(toolCallId, toolSignal),
      abortTurn: () => {
        if (created.failed === null) void created.fail('input_artifact_storage_failed')
        abort.abort()
      },
      guard: () => { signal.throwIfAborted(); if (this.runs.checkExecution(attempt) === 'wrapping_up') throw new Error('report_only') },
    })
    let cleanupUnconfirmed = false
    let agent: Agent | null = null
    const stop = () => agent?.abort()
    signal.addEventListener('abort', stop, { once: true })
    try {
      await created.append({ type: 'agent.state', data: { status: 'running', error: null } })
      const model = selectedModel(this.connections, input)
      const images: import('@earendil-works/pi-ai').ImageContent[] = []
      for (const attachment of policy.attachmentMetadata ?? []) {
        if (!attachment.mediaType.startsWith('image/')) continue
        if (!model.input.includes('image')) throw new NativeAgentError('image_not_supported')
        const file = await open(attachment.path, 'r')
        try { images.push({ type: 'image', data: (await file.readFile()).toString('base64'), mimeType: attachment.mediaType }) } finally { await file.close() }
      }
      if (prepare) {
        try {
          const prepared = await prepare.prepare()
          // Synchronously on return: abort, availability, active identity, home and attempt fence. Nothing
          // awaits between this check, the prompt append and the provider call.
          prepare.verify()
          prompt = prepared.prompt; history = prepared.history
        } catch (error) {
          // Unreadable input or an unreadable log is this attempt's own content-free failure. If the owner was
          // lost (stop, close, leave, a deposed fence) that is the truth to record instead: it falls through to
          // the ordinary cancelled or failed terminal below and never claims a missing input.
          const code = preparationFailureCode(error)
          let ownerLost = false
          try { prepare.verify() } catch { ownerLost = true }
          if (code !== null && !ownerLost) await created.fail(code)
          throw error
        }
        active.preparing = null
        active.queue = created
      }
      agent = new Agent({ initialState: { model, systemPrompt: orientation(policy), tools,
        ...(history.length ? { messages: [{ role: 'system', content: orientation(policy), toolsAdded: tools.map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: Date.now() }, ...history] } : {}) },
        streamFn: connectionStream(this.connections, this.scrubber, input, attempt, this.runs), toolExecution: 'sequential',
        // Reasoning is stored only as K2 reasoning, never recycled into any provider request.
        convertToLlm: messages => messages.map(m => m.role === 'assistant' ? { ...m, content: m.content.filter(c => c.type !== 'thinking') } : m),
      })
      agent.subscribe(event => {
        if (event.type === 'message_end') {
          const message = event.message
          if (message.role === 'user') {
            const text = typeof message.content === 'string'
              ? message.content
              : message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            return this.appendPrompt(created, id, text, promptOrigin, promptId, policy.attachments.length, signal, () => this.runs.checkExecution(attempt)).then(() => undefined)
          }
          if (message.role === 'assistant') {
            const messageStep = step++
            return this.appendAssistant(created, id, message, turnId, messageStep, signal, () => this.runs.checkExecution(attempt))
          }
        }
        if (event.type === 'tool_execution_end') {
          if (event.result.details?.code === 'cleanup_unconfirmed') { cleanupUnconfirmed = true; agent?.abort() }
          return created.append({
            type: 'tool.result',
            data: {
              toolCallId: event.toolCallId,
              status: event.isError ? 'error' : 'ok',
              result: JSON.stringify(event.result.content),
              error: event.isError ? event.result.details?.code ?? 'tool_failed' : null,
              durationMs: Math.round(event.durationMs ?? 0),
            },
          }).then(() => undefined)
        }
        return undefined
      })
      signal.throwIfAborted()
      await agent.prompt(this.runs.checkExecution(attempt) === 'wrapping_up' ? 'Wrap up and report only. Do not call tools.' : prompt, images)
      if (agent.state.errorMessage) throw new Error('model_failed')
      if (cleanupUnconfirmed) throw new Error('cleanup_unconfirmed')
      signal.throwIfAborted()
      await this.writeTerminal(created, turnId, step, 'completed', 'completed', 'stop')
      this.runs.complete(attempt, 'completed')
    } catch {
      // A queue failure already wrote exactly one content-free error and terminal.
      if (created.failed !== null) {
        await created.drain()
        try {
          if (!['canceled', 'completed', 'failed'].includes(this.runs.get(attempt.run_id).state)) {
            this.runs.complete(attempt, created.failed === 'aborted' ? 'canceled' : 'failed')
          }
        } catch { /* A fenced owner cannot complete. */ }
        return
      }
      // Budget/quota stops already committed their truthful R1 terminal event.
      if (['canceled', 'completed', 'failed'].includes(this.runs.get(attempt.run_id).state)) {
        await created.drain()
        return
      }
      const cancelled = signal.aborted && !cleanupUnconfirmed
      await this.writeTerminal(created, turnId, step,
        cleanupUnconfirmed ? 'failed' : cancelled ? 'cancelled' : 'failed',
        cleanupUnconfirmed ? 'failed' : cancelled ? 'cancelled' : 'failed',
        cleanupUnconfirmed ? 'cleanup_unconfirmed' : cancelled ? 'stopped_by_user' : 'agent_failed',
        cleanupUnconfirmed ? 'cleanup_unconfirmed' : cancelled ? null : 'agent_failed')
      this.runs.complete(attempt, cleanupUnconfirmed ? 'failed' : cancelled ? 'canceled' : 'failed')
    } finally {
      signal.removeEventListener('abort', stop)
      if (active.queue === created) active.queue = null
      if (active.preparing === created) active.preparing = null
    }
  }

  private appendPrompt(
    queue: NativeAppendQueue,
    sessionId: string,
    text: string,
    origin: 'typed' | 'queued',
    messageId: string,
    attachmentCount: number,
    signal: AbortSignal,
    check: () => void,
  ): Promise<AppendResult> {
    const scrubbed = this.scrubber.scrub(text)
    if (isInlineInput(Buffer.byteLength(scrubbed, 'utf8'))) {
      return queue.append({ type: 'prompt', data: { origin, messageId, text: scrubbed, attachmentCount } })
    }
    return queue.enqueue(async () => {
      check()
      const written = await this.writeInput(sessionId, scrubbed, 'prompt', signal)
      const mediaType = inputMediaTypeFor('prompt')
      return queue.appendNow({ type: 'prompt', data: { origin, messageId, attachmentCount } }, {
        eventVersion: 2,
        inputArtifact: { ...written, mediaType, excerpt: utf8Excerpt(scrubbed) },
      })
    })
  }

  private appendAssistant(
    queue: NativeAppendQueue,
    sessionId: string,
    message: Extract<import('@earendil-works/pi-ai').AssistantMessage, { role: 'assistant' }>,
    turnId: string,
    messageStep: number,
    signal: AbortSignal,
    check: () => void,
  ): Promise<void> {
    const toolCalls = message.content.flatMap(content => content.type === 'toolCall' ? [content] : [])
    for (const call of toolCalls) queue.expectToolCall(call.id)
    const text = message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
    const reasoning = message.content.filter(c => c.type === 'thinking').map(c => c.thinking).join('\n')
    return queue.enqueue(async () => {
      queue.appendNow({ type: 'assistant.message', spanId: turnId, data: { messageId: turnId, step: messageStep, text } })
      for (const call of toolCalls) {
        await this.appendToolCallWithin(queue, sessionId, call.id, call.name, call.arguments as Record<string, unknown>, signal, check)
      }
      if (reasoning) {
        queue.appendNow({ type: 'reasoning', spanId: turnId, expiresAt: this.sessions.expiry(sessionId), data: { messageId: turnId, step: messageStep, text: reasoning } })
      }
    })
  }

  private async appendToolCallWithin(
    queue: NativeAppendQueue,
    sessionId: string,
    toolCallId: string,
    name: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
    check: () => void,
  ): Promise<void> {
    const scrubbed = this.scrubber.scrub(argumentsValue) as Record<string, unknown>
    const canonical = JSON.stringify(scrubbed)
    const base = { toolCallId, name, source: 'builtin' as const, parsedFrom: 'native' as const, diffPath: null }
    if (isInlineInput(Buffer.byteLength(canonical, 'utf8'))) {
      queue.appendNow({ type: 'tool.call', data: { ...base, arguments: scrubbed } })
    } else {
      check()
      const written = await this.writeInput(sessionId, canonical, 'tool.call', signal)
      const mediaType = inputMediaTypeFor('tool.call')
      queue.appendNow({ type: 'tool.call', data: base }, {
        eventVersion: 2,
        inputArtifact: { ...written, mediaType, excerpt: utf8Excerpt(canonical) },
      })
    }
    queue.acknowledgeToolCall(toolCallId)
  }

  private async writeInput(sessionId: string, text: string, type: 'prompt' | 'tool.call', signal: AbortSignal) {
    try {
      return await this.inputArtifacts.write(sessionId, text, inputMediaTypeFor(type), { signal })
    } catch (error) {
      if (error instanceof SessionInputError && error.code === 'aborted') throw new NativeAgentError('aborted')
      throw new NativeAgentError('input_artifact_storage_failed')
    }
  }

  private async writeTerminal(
    queue: NativeAppendQueue,
    turnId: string,
    steps: number,
    status: 'completed' | 'failed' | 'cancelled',
    outcome: 'completed' | 'failed' | 'cancelled',
    stopReason: string,
    errorCode: string | null = null,
  ): Promise<void> {
    const state = queue.append({ type: 'agent.state', data: { status, error: errorCode } })
    const done = queue.append({ type: 'turn.done', data: { messageId: turnId, outcome, stopReason, steps } })
    queue.seal()
    await Promise.all([state, done])
    await queue.drain()
  }

  /** The queue's single failure path: at most one error and one terminal pair. */
  private writeFailureTerminal(
    queue: NativeAppendQueue,
    turnId: string,
    stepOf: () => number,
    signal: AbortSignal,
    code: string,
  ): void {
    const aborted = signal.aborted
    const fenced = ['writer_fenced', 'closed', 'session_not_found'].includes(code)
    const budget = ['budget_exhausted', 'report_budget_exhausted', 'quota_exhausted'].includes(code)
    if (fenced || budget) return
    const reported = Object.hasOwn(PREPARATION_REPORTS, code)
      ? { code, message: PREPARATION_REPORTS[code as keyof typeof PREPARATION_REPORTS] }
      : { code: 'input_artifact_storage_failed', message: 'Session input artifact storage failed' }
    if (!aborted) {
      queue.appendNow({ type: 'error', data: reported })
    }
    queue.appendNow({
      type: 'agent.state',
      data: { status: aborted ? 'cancelled' : 'failed', error: aborted ? null : reported.code },
    })
    queue.appendNow({
      type: 'turn.done',
      data: {
        messageId: turnId,
        outcome: aborted ? 'cancelled' : 'failed',
        stopReason: aborted ? 'stopped_by_user' : reported.code,
        steps: stepOf(),
      },
    })
  }

  private async replay(
    sessionId: string,
    events: SessionEvent[],
    api: AssistantMessage['api'],
    provider: AssistantMessage['provider'],
    model: string,
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = []
    for (const event of events) {
      const timestamp = Date.parse(event.createdAt)
      if (event.type === 'prompt') {
        const text = event.version === 1
          ? event.data.text
          : this.scrubber.scrub(await this.readInputText(sessionId, event.data.artifact, signal))
        messages.push({ role: 'user', content: text, timestamp })
      }
      if (event.type === 'assistant.message') messages.push({ role: 'assistant', content: [{ type: 'text', text: event.data.text }], api, provider, model, usage: emptyUsage(), stopReason: 'stop', timestamp })
      if (event.type === 'tool.call') {
        const last = messages.at(-1)
        if (last?.role === 'assistant') {
          const argumentsValue = event.version === 1
            ? event.data.arguments
            : this.parseInputArguments(await this.readInputText(sessionId, event.data.artifact, signal))
          last.content.push({ type: 'toolCall', id: event.data.toolCallId, name: event.data.name, arguments: argumentsValue as import('@earendil-works/pi-ai').JsonObject })
          last.stopReason = 'toolUse'
        }
      }
      if (event.type === 'tool.result') {
        const call = events.find(e => e.type === 'tool.call' && e.data.toolCallId === event.data.toolCallId)
        if (call?.type === 'tool.call') messages.push({ role: 'toolResult', toolCallId: event.data.toolCallId, toolName: call.data.name,
          content: [{ type: 'text', text: event.data.result ?? event.data.error ?? '' }], isError: event.data.status === 'error', timestamp })
      }
    }
    return messages
  }

  private async readInputText(sessionId: string, reference: SessionInputArtifactRef, signal?: AbortSignal): Promise<string> {
    try {
      const bytes = await this.inputArtifacts.read(sessionId, reference, { signal })
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new NativeAgentError('input_artifact_unavailable')
    }
  }

  private parseInputArguments(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
      return this.scrubber.scrub(parsed) as Record<string, unknown>
    } catch {
      throw new NativeAgentError('input_artifact_unavailable')
    }
  }

  async close() { if (this.closed) return; this.closed = true; clearInterval(this.maintenance); for (const active of this.active.values()) active.abort.abort(); await Promise.allSettled([...this.active.values()].map(a => a.settled)); await this.maintenanceTask; this.projectRoots.close() }
}
