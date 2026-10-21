import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, lstat, writeFile, rm, open } from 'node:fs/promises'
import { resolve, join, sep, dirname } from 'node:path'
import { nativeAgentInputSchema, agentExecResultSchema, type NativeAgentInput, type AgentProgress, type AgentExecResult, type SessionEvent, nativeRunBudgetSchema } from '@guanxi/contract'
import { RunStore } from '../runs/store.ts'
import type { Attempt } from '../runs/types.ts'
import type { Db } from '../store/db.ts'
import { NativeSessions } from './sessions.ts'
import type { AppContext } from '../context.ts'
import type { SessionHandle, SessionLog } from '../session-log/log.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { Connections } from '../connections/service.ts'
import { assertRootsClean } from './cleanup.ts'
import { selectedModel, connectionStream, emptyUsage } from './model.ts'
import { orientation } from './orientation.ts'
import { nativeTools } from './tools.ts'
import { NativeProjectRoots } from './projects.ts'
import { sandboxCommand, type SandboxPolicy } from './sandbox.ts'
import { apiPortFromEnv, portFromEnv, DEFAULT_WEB_PORT, WEB_PORT_ENV } from '../config/listen-env.ts'
import { resolveInWorkspace } from '../tools/jail.ts'

export class NativeAgentError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}
interface Active { policy: SandboxPolicy; handle: SessionHandle; abort: AbortController; settled: Promise<void>; attempt: Attempt }
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
  private commandRunner: typeof sandboxCommand
  constructor(host: NativeHost, log: SessionLog, connections: Connections, scrubber: EgressScrubber, dataDir: string, nodePorts = () => [apiPortFromEnv(process.env, 4310), portFromEnv(process.env, WEB_PORT_ENV, DEFAULT_WEB_PORT)], commandRunner = sandboxCommand, runtime: { db: Db; runs: RunStore }) {
    this.runs = runtime.runs
    this.sessions = new NativeSessions(runtime.db, log, dataDir)
    this.maintenance = setInterval(() => { void this.maintain() }, 60000)
    this.maintenance.unref()
    void this.maintain()
    this.commandRunner = commandRunner
    this.nodePorts = nodePorts
    this.host = host; this.log = log; this.connections = connections; this.scrubber = scrubber; this.dataDir = dataDir
    this.projectRoots = new NativeProjectRoots(join(dataDir, 'native-projects.sqlite'), host)
  }

  private maintain(): Promise<void> {
    if (this.maintaining || this.closed) return this.maintenanceTask
    this.maintaining = true
    this.maintenanceTask = Promise.resolve().then(async () => {
      this.runs.heartbeat()
      this.runs.reconcile()
      await this.sessions.maintain(new Set(this.active.keys()))
      await this.sessions.reapOrphans(id => this.preparing.has(id) || this.active.has(id), () => this.runs.heartbeat())
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
    if (!project) throw new NativeAgentError('project_not_found')
    return project
  }
  private events(id: string) {
    this.ready()
    const events = this.log.readAll(id, 'remote_agent')
    if (!events.some(e => e.type === 'agent.policy')) throw new NativeAgentError('session_not_found')
    return events
  }
  progress(id: string): AgentProgress {
    const events = this.events(id)
    const policy = events.find(e => e.type === 'agent.policy')!
    if (policy.type !== 'agent.policy') throw new NativeAgentError('session_not_found')
    let status: AgentProgress['status'] = 'interrupted', error: string | null = null
    let plan: AgentProgress['plan'] = [], queue: AgentProgress['queue'] = [], summary = ''
    let shellUnavailable: AgentProgress['shellUnavailable']
    for (const event of events) {
      if (event.type === 'agent.state') { status = event.data.status; error = event.data.error }
      if (event.type === 'agent.plan') plan = event.data.items
      if (event.type === 'agent.queue') queue = event.data.items
      if (event.type === 'assistant.message') summary = event.data.text
      if (event.type === 'tool.result' && event.data.status === 'error' && events.some(call => call.type === 'tool.call' && call.data.toolCallId === event.data.toolCallId && call.data.name === 'shell')) {
        for (const reason of ['container_runtime_unavailable', 'container_path_unsupported', 'container_home_root_denied', 'container_runtime_protected'] as const) {
          if (event.data.error === reason) shellUnavailable = reason
        }
      }
      if (event.type === 'tool.result' && event.data.status === 'ok' && events.some(call => call.type === 'tool.call' && call.data.toolCallId === event.data.toolCallId && call.data.name === 'shell')) shellUnavailable = undefined
    }
    const consumed = new Set(events.filter(e => e.type === 'prompt').map(e => e.data.messageId))
    queue = queue.filter(item => !consumed.has(item.id))
    const lifecycle = events.filter(e => e.type === 'run.lifecycle').at(-1)
    if (!this.active.has(id) && lifecycle?.type === 'run.lifecycle') {
      const run = this.runs.get(lifecycle.data.runId)
      if (run.state === 'canceled') { status = 'cancelled'; error = this.runs.executionReason(run.id) }
      else if (run.state === 'completed') status = 'completed'
      else if (run.state === 'failed') status = 'failed'
      else { status = run.state === 'input_required' ? 'input_required' : 'interrupted'; error = 'process_restarted' }
    } else if (status === 'running' && !this.active.has(id)) { status = 'interrupted'; error = 'process_restarted' }
    try { assertRootsClean(this.dataDir, [policy.data.scratch, ...policy.data.roots]) } catch { status = 'failed'; error = 'cleanup_unconfirmed' }
    return this.scrubber.scrub({ retention: this.sessions.retention(id), sessionId: id, projectId: policy.data.projectId, connectionId: policy.data.connectionId,
      model: policy.data.model, mode: policy.data.mode, status, plan, queue, summary, error,
      observedAt: events.at(-1)!.createdAt, source: 'session.log', confidence: 'high', ...(shellUnavailable ? { shellUnavailable } : {}) })
  }
  result(id: string): AgentExecResult {
    const progress = this.progress(id)
    if (progress.status === 'running') throw new NativeAgentError('session_busy')
    return agentExecResultSchema.parse({ version: 1, sessionId: id, status: progress.status, text: progress.summary, error: progress.error })
  }
  async wait(id: string) { await this.active.get(id)?.settled; return this.result(id) }
  stop(id: string) {
    const active = this.active.get(id)
    if (!active) { this.events(id); return }
    try { active.handle.append({ type: 'intervention', data: { action: 'stop', reason: 'explicit_stop' } }) }
    finally { active.abort.abort() }
  }
  queue(id: string, text: string, userActivity = true) {
    this.ready()
    if (!text.trim()) throw new NativeAgentError('validation_failed')
    const active = this.active.get(id)
    if (!active) throw new NativeAgentError('session_not_running')
    if (userActivity) this.sessions.touch(id)
    const queue = this.progress(id).queue
    active.handle.append({ type: 'agent.queue', data: { items: [...queue, { id: randomUUID(), text }] } })
  }
  removeQueued(id: string, item: string) {
    const active = this.active.get(id)
    if (!active) throw new NativeAgentError('session_not_running')
    active.handle.append({ type: 'agent.queue', data: { items: this.progress(id).queue.filter(i => i.id !== item) } })
  }
  leaveSession(id: string) { this.ready(); return this.sessions.leave(id) }
  setRetention(id: string, mode: 'keep' | 'ttl' | 'session') { this.ready(); return this.sessions.setRetention(id, mode) }
  async deleteSession(id: string) {
    this.ready()
    if (this.active.has(id)) throw new NativeAgentError('session_busy')
    try { await this.sessions.remove(id) } catch (error) { throw new NativeAgentError(error instanceof Error && ['session_busy','writer_busy','session_not_found','cleanup_unconfirmed'].includes('code' in error ? String(error.code) : error.message) ? ('code' in error ? String(error.code) : error.message) : 'deletion_failed') }
    return { sessionId: id, deleted: true as const }
  }
  prompt(id: string, text: string) {
    this.sessions.assertAvailable(id)
    if (this.active.has(id)) { this.queue(id, text); return }
    const events = this.events(id)
    const event = events.find(e => e.type === 'agent.policy')!
    if (event.type !== 'agent.policy') throw new NativeAgentError('session_not_found')
    const policy = { ...event.data, nodePorts: [...this.nodePorts()] }
    const input = nativeAgentInputSchema.parse({ projectId: policy.projectId, connectionId: policy.connectionId, model: policy.model,
      mode: policy.mode, domains: policy.domains, protectedPaths: policy.protectedPaths, attachmentIds: policy.attachmentIds,
      contextTokens: policy.contextTokens, budget: policy.budget, retention: policy.retention, prompt: text })
    const model = selectedModel(this.connections, input)
    this.ensureRoots(policy, id)
    const history = replay(events, model.api, model.provider, model.id)
    this.launch(id, input, policy, this.log.open(id, { kind: 'agent' }), text, history)
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
  private launch(id: string, input: NativeAgentInput, policy: SandboxPolicy, rawHandle: SessionHandle, prompt: string, history: AgentMessage[]) {
    let attempt: Attempt
    try { this.sessions.touch(id); attempt = this.attempt(id, input) } catch (error) { rawHandle.close(); throw error }
    const abort = new AbortController()
    const active: Active = { policy, handle: this.fencedHandle(rawHandle, attempt), abort, attempt, settled: Promise.resolve() }
    active.handle.append({ type: 'agent.state', data: { status: 'running', error: null } })
    this.active.set(id, active)
    active.settled = (async () => {
      let next: string | undefined = prompt
      let queuedId: string | undefined
      while (next !== undefined) {
        const timer = setInterval(() => {
          try { this.runs.renew(active.attempt); this.runs.checkExecution(active.attempt) }
          catch { abort.abort() }
        }, 1000)
        timer.unref()
        try { await this.execute(id, input, policy, active.handle, next, history, abort.signal, active.attempt, queuedId) }
        finally { clearInterval(timer) }
        const state = this.runs.get(active.attempt.run_id).state
        if (abort.signal.aborted || state !== 'completed') break
        const queue = this.progress(id).queue
        next = queue[0]?.text; queuedId = queue[0]?.id
        if (next !== undefined) {
          this.sessions.assertAvailable(id)
          history = replay(this.events(id), selectedModel(this.connections, input).api, selectedModel(this.connections, input).provider, input.model)
          active.attempt = this.attempt(id, input)
          active.handle = this.fencedHandle(rawHandle, active.attempt)
        }
      }
    })().catch(() => {
      try { this.runs.complete(active.attempt, 'failed') } catch { /* A fenced owner cannot complete or append. */ }
    }).finally(() => { rawHandle.close(); this.active.delete(id) })
  }
  private async execute(id: string, input: NativeAgentInput, policy: SandboxPolicy, handle: SessionHandle, prompt: string, history: AgentMessage[], signal: AbortSignal, attempt: Attempt, queuedId?: string) {
    let step = 0
    let promptId: string = queuedId ?? randomUUID()
    let promptOrigin: 'typed' | 'queued' = queuedId ? 'queued' : 'typed'
    const turnId = randomUUID()
    const tools = nativeTools({ policy, log: this.log, handle, scrubber: this.scrubber, queue: text => this.queue(id, text, false), executeCommand: this.commandRunner, guard: () => { signal.throwIfAborted(); if (this.runs.checkExecution(attempt) === 'wrapping_up') throw new Error('report_only') } })
    const model = selectedModel(this.connections, input)
    const images: import('@earendil-works/pi-ai').ImageContent[] = []
    for (const attachment of policy.attachmentMetadata ?? []) {
      if (!attachment.mediaType.startsWith('image/')) continue
      if (!model.input.includes('image')) throw new NativeAgentError('image_not_supported')
      const file = await open(attachment.path, 'r')
      try { images.push({ type: 'image', data: (await file.readFile()).toString('base64'), mimeType: attachment.mediaType }) } finally { await file.close() }
    }
    const agent = new Agent({ initialState: { model, systemPrompt: orientation(policy), tools,
      ...(history.length ? { messages: [{ role: 'system', content: orientation(policy), toolsAdded: tools.map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: Date.now() }, ...history] } : {}) },
      streamFn: connectionStream(this.connections, this.scrubber, input, attempt, this.runs), toolExecution: 'sequential',
      // Reasoning is stored only as K2 reasoning, never recycled into any provider request.
      convertToLlm: messages => messages.map(m => m.role === 'assistant' ? { ...m, content: m.content.filter(c => c.type !== 'thinking') } : m),
    })
    let cleanupUnconfirmed = false
    const stop = () => agent.abort()
    signal.addEventListener('abort', stop, { once: true })
    agent.subscribe(event => {
      if (event.type === 'message_end') {
        const message = event.message
        if (message.role === 'user') handle.append({ type: 'prompt', data: { origin: promptOrigin, messageId: promptId,
          text: typeof message.content === 'string' ? message.content : message.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), attachmentCount: policy.attachments.length } })
        if (message.role === 'assistant') {
          handle.append({ type: 'assistant.message', spanId: turnId, data: { messageId: turnId, step: step++, text: message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') } })
          for (const call of message.content.filter(c => c.type === 'toolCall')) handle.append({ type: 'tool.call', data: { toolCallId: call.id, name: call.name, arguments: call.arguments, source: 'builtin', parsedFrom: 'native', diffPath: null } })
          const reasoning = message.content.filter(c => c.type === 'thinking').map(c => c.thinking).join('\n')
          if (reasoning) handle.append({ type: 'reasoning', spanId: turnId, expiresAt: this.sessions.expiry(id), data: { messageId: turnId, step: step - 1, text: reasoning } })
        }
      }
      if (event.type === 'tool_execution_end' && event.result.details?.code === 'cleanup_unconfirmed') { cleanupUnconfirmed = true; agent.abort() }
      if (event.type === 'tool_execution_end') handle.append({ type: 'tool.result', data: { toolCallId: event.toolCallId, status: event.isError ? 'error' : 'ok',
        result: JSON.stringify(event.result.content), error: event.isError ? event.result.details?.code ?? 'tool_failed' : null, durationMs: Math.round(event.durationMs ?? 0) } })
    })
    try {
      signal.throwIfAborted()
      await agent.prompt(this.runs.checkExecution(attempt) === 'wrapping_up' ? 'Wrap up and report only. Do not call tools.' : prompt, images)
      if (agent.state.errorMessage) throw new Error('model_failed')
      if (cleanupUnconfirmed) throw new Error('cleanup_unconfirmed')
      signal.throwIfAborted()
      handle.append({ type: 'agent.state', data: { status: 'completed', error: null } })
      handle.append({ type: 'turn.done', data: { messageId: turnId, outcome: 'completed', stopReason: 'stop', steps: step } })
      this.runs.complete(attempt, 'completed')
    } catch {
      // Budget/quota stops already committed their truthful R1 terminal event.
      if (['canceled','completed','failed'].includes(this.runs.get(attempt.run_id).state)) return
      handle.append({ type: 'agent.state', data: { status: cleanupUnconfirmed ? 'failed' : signal.aborted ? 'cancelled' : 'failed', error: cleanupUnconfirmed ? 'cleanup_unconfirmed' : signal.aborted ? null : 'agent_failed' } })
      handle.append({ type: 'turn.done', data: { messageId: turnId, outcome: cleanupUnconfirmed ? 'failed' : signal.aborted ? 'cancelled' : 'failed', stopReason: cleanupUnconfirmed ? 'cleanup_unconfirmed' : signal.aborted ? 'stopped_by_user' : 'agent_failed', steps: step } })
      this.runs.complete(attempt, cleanupUnconfirmed ? 'failed' : signal.aborted ? 'canceled' : 'failed')
    } finally { signal.removeEventListener('abort', stop) }
  }
  async close() { if (this.closed) return; this.closed = true; clearInterval(this.maintenance); for (const active of this.active.values()) active.abort.abort(); await Promise.allSettled([...this.active.values()].map(a => a.settled)); await this.maintenanceTask; this.projectRoots.close() }
}
function replay(events: SessionEvent[], api: AssistantMessage['api'], provider: AssistantMessage['provider'], model: string): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (const event of events) {
    const timestamp = Date.parse(event.createdAt)
    if (event.type === 'prompt') messages.push({ role: 'user', content: event.data.text, timestamp })
    if (event.type === 'assistant.message') messages.push({ role: 'assistant', content: [{ type: 'text', text: event.data.text }], api, provider, model, usage: emptyUsage(), stopReason: 'stop', timestamp })
    if (event.type === 'tool.call') {
      const last = messages.at(-1)
      if (last?.role === 'assistant') { last.content.push({ type: 'toolCall', id: event.data.toolCallId, name: event.data.name, arguments: event.data.arguments as import('@earendil-works/pi-ai').JsonObject }); last.stopReason = 'toolUse' }
    }
    if (event.type === 'tool.result') {
      const call = events.find(e => e.type === 'tool.call' && e.data.toolCallId === event.data.toolCallId)
      if (call?.type === 'tool.call') messages.push({ role: 'toolResult', toolCallId: event.data.toolCallId, toolName: call.data.name,
        content: [{ type: 'text', text: event.data.result ?? event.data.error ?? '' }], isError: event.data.status === 'error', timestamp })
    }
  }
  return messages
}
