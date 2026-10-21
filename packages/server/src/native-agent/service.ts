import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, lstat, writeFile, rm, open } from 'node:fs/promises'
import { resolve, join, sep, dirname } from 'node:path'
import { nativeAgentInputSchema, agentExecResultSchema, type NativeAgentInput, type AgentProgress, type AgentExecResult, type SessionEvent } from '@guanxi/contract'
import type { AppContext } from '../context.ts'
import type { SessionHandle, SessionLog } from '../session-log/log.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { Connections } from '../connections/service.ts'
import { selectedModel, connectionStream, emptyUsage } from './model.ts'
import { orientation } from './orientation.ts'
import { nativeTools } from './tools.ts'
import { NativeProjectRoots } from './projects.ts'
import type { SandboxPolicy } from './sandbox.ts'
import { resolveInWorkspace } from '../tools/jail.ts'

export class NativeAgentError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}
interface Active { policy: SandboxPolicy; handle: SessionHandle; abort: AbortController; settled: Promise<void> }
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
  private active = new Map<string, Active>()
  private closed = false
  private projectRoots: NativeProjectRoots
  readonly host: NativeHost
  readonly log: SessionLog
  readonly connections: Connections
  readonly scrubber: EgressScrubber
  readonly dataDir: string
  constructor(host: NativeHost, log: SessionLog, connections: Connections, scrubber: EgressScrubber, dataDir: string) {
    this.host = host; this.log = log; this.connections = connections; this.scrubber = scrubber; this.dataDir = dataDir
    this.projectRoots = new NativeProjectRoots(join(dataDir, 'native-projects.sqlite'), host)
  }

  async create(raw: unknown): Promise<{ sessionId: string }> {
    this.ready()
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
    await mkdir(scratch, { recursive: true, mode: 0o700 })
    await mkdir(attachmentDir, { recursive: true, mode: 0o700 })
    let handle: SessionHandle | undefined
    try {
      const attachments: string[] = []
      const attachmentMetadata: NonNullable<SandboxPolicy['attachmentMetadata']> = []
      for (const id of input.attachmentIds) {
        const attachment = await this.host.artifactTransfers.download(id, { scope: 'project', projectId: project.id }, new AbortController().signal)
        this.ready()
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
      const policy: SandboxPolicy = { mode: input.mode, roots: [...new Set(roots)], scratch: await realpath(scratch), attachments, protectedPaths, domains: input.domains, runtimeBase: dataRoot, attachmentMetadata, hiddenPaths: [await realpath(this.dataDir)] }
      this.ready()
      this.ensureRoots(policy, sessionId)
      handle = this.log.open(sessionId, { kind: 'agent' })
      const { prompt: _prompt, ...settings } = input
      handle.append({ type: 'agent.policy', data: { ...settings, ...policy } })
      this.launch(sessionId, input, policy, handle, input.prompt, [])
      return { sessionId }
    } catch (error) {
      handle?.close()
      await rm(scratch, { recursive: true, force: true })
      await rm(attachmentDir, { recursive: true, force: true })
      throw error
    }
  }
  private ensureRoots(policy: SandboxPolicy, id: string) {
    if (policy.mode !== 'full-access') return
    for (const [otherId, active] of this.active) {
      if (otherId === id || active.policy.mode !== 'full-access') continue
      if (policy.roots.some(root => active.policy.roots.some(other => inside(root, other) || inside(other, root)))) throw new NativeAgentError('root_busy')
    }
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
      if (event.type === 'tool.result' && event.data.status === 'error') {
        for (const reason of ['container_runtime_unavailable', 'container_path_unsupported', 'container_home_root_denied'] as const) {
          if (event.data.result?.includes(reason)) shellUnavailable = reason
        }
      }
    }
    const consumed = new Set(events.filter(e => e.type === 'prompt').map(e => e.data.messageId))
    queue = queue.filter(item => !consumed.has(item.id))
    if (status === 'running' && !this.active.has(id)) { status = 'interrupted'; error = 'process_restarted' }
    return this.scrubber.scrub({ sessionId: id, projectId: policy.data.projectId, connectionId: policy.data.connectionId,
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
  queue(id: string, text: string) {
    this.ready()
    if (!text.trim()) throw new NativeAgentError('validation_failed')
    const active = this.active.get(id)
    if (!active) throw new NativeAgentError('session_not_running')
    const queue = this.progress(id).queue
    active.handle.append({ type: 'agent.queue', data: { items: [...queue, { id: randomUUID(), text }] } })
  }
  removeQueued(id: string, item: string) {
    const active = this.active.get(id)
    if (!active) throw new NativeAgentError('session_not_running')
    active.handle.append({ type: 'agent.queue', data: { items: this.progress(id).queue.filter(i => i.id !== item) } })
  }
  prompt(id: string, text: string) {
    if (this.active.has(id)) { this.queue(id, text); return }
    const events = this.events(id)
    const event = events.find(e => e.type === 'agent.policy')!
    if (event.type !== 'agent.policy') throw new NativeAgentError('session_not_found')
    const policy = event.data
    const input = nativeAgentInputSchema.parse({ projectId: policy.projectId, connectionId: policy.connectionId, model: policy.model,
      mode: policy.mode, domains: policy.domains, protectedPaths: policy.protectedPaths, attachmentIds: policy.attachmentIds,
      contextTokens: policy.contextTokens, prompt: text })
    const model = selectedModel(this.connections, input)
    this.ensureRoots(policy, id)
    const history = replay(events, model.api, model.provider, model.id)
    this.launch(id, input, policy, this.log.open(id, { kind: 'agent' }), text, history)
  }
  private launch(id: string, input: NativeAgentInput, policy: SandboxPolicy, handle: SessionHandle, prompt: string, history: AgentMessage[]) {
    const abort = new AbortController()
    handle.append({ type: 'agent.state', data: { status: 'running', error: null } })
    const active: Active = { policy, handle, abort, settled: Promise.resolve() }
    this.active.set(id, active)
    active.settled = this.execute(id, input, policy, handle, prompt, history, abort.signal)
      .catch(() => {
        try { handle.append({ type: 'agent.state', data: { status: abort.signal.aborted ? 'cancelled' : 'failed', error: 'agent_failed' } }) } catch { /* Readiness/storage failure: replay reports interrupted. */ }
      })
      .finally(() => { handle.close(); this.active.delete(id) })
  }
  private async execute(id: string, input: NativeAgentInput, policy: SandboxPolicy, handle: SessionHandle, prompt: string, history: AgentMessage[], signal: AbortSignal) {
    let step = 0
    let promptId: string = randomUUID()
    let promptOrigin: 'typed' | 'queued' = 'typed'
    const turnId = randomUUID()
    const tools = nativeTools({ policy, log: this.log, handle, scrubber: this.scrubber, queue: text => this.queue(id, text) })
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
      streamFn: connectionStream(this.connections, this.scrubber, input, id), toolExecution: 'sequential',
      // Reasoning is stored only as K2 reasoning, never recycled into any provider request.
      convertToLlm: messages => messages.map(m => m.role === 'assistant' ? { ...m, content: m.content.filter(c => c.type !== 'thinking') } : m),
    })
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
          if (reasoning) handle.append({ type: 'reasoning', spanId: turnId, data: { messageId: turnId, step: step - 1, text: reasoning } })
        }
      }
      if (event.type === 'tool_execution_end') handle.append({ type: 'tool.result', data: { toolCallId: event.toolCallId, status: event.isError ? 'error' : 'ok',
        result: JSON.stringify(event.result.content), error: event.isError ? 'tool_failed' : null, durationMs: Math.round(event.durationMs ?? 0) } })
    })
    try {
      let next: string | undefined = prompt
      while (next !== undefined) {
        signal.throwIfAborted()
        await agent.prompt(next, images)
        if (agent.state.errorMessage) throw new Error('model_failed')
        const queue = this.progress(id).queue
        next = queue[0]?.text
        if (next !== undefined) { promptId = queue[0]!.id; promptOrigin = 'queued' }
      }
      signal.throwIfAborted()
      handle.append({ type: 'agent.state', data: { status: 'completed', error: null } })
      handle.append({ type: 'turn.done', data: { messageId: turnId, outcome: 'completed', stopReason: 'stop', steps: step } })
    } catch {
      handle.append({ type: 'agent.state', data: { status: signal.aborted ? 'cancelled' : 'failed', error: signal.aborted ? null : 'agent_failed' } })
      handle.append({ type: 'turn.done', data: { messageId: turnId, outcome: signal.aborted ? 'cancelled' : 'failed', stopReason: signal.aborted ? 'stopped_by_user' : 'agent_failed', steps: step } })
    } finally { signal.removeEventListener('abort', stop) }
  }
  async close() { if (this.closed) return; this.closed = true; for (const active of this.active.values()) active.abort.abort(); await Promise.allSettled([...this.active.values()].map(a => a.settled)); this.projectRoots.close() }
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
