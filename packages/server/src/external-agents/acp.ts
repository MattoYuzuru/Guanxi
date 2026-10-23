import { PROTOCOL_VERSION, type InitializeRequest, type NewSessionRequest, type PromptRequest, type SessionNotification } from '@agentclientprotocol/sdk'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'
import { z } from 'zod'
import type { AgentProcess, ProcessCleanup } from './process.ts'
import { JsonRpcClient } from './rpc.ts'
import { protocolObject as object } from './quota.ts'
import { ExternalAgentError, type AdapterId, type AgentOutput, type LeadTurn, type LeadUsage } from './types.ts'

const textUpdate = z.object({ sessionUpdate: z.literal('agent_message_chunk'), content: z.object({ type: z.literal('text'), text: z.string() }) })
const planUpdate = z.object({ sessionUpdate: z.literal('plan'), entries: z.array(z.object({ content: z.string(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'), status: z.enum(['pending', 'in_progress', 'completed']) })) })
const toolUpdate = z.object({ sessionUpdate: z.literal('tool_call'), toolCallId: z.string(), title: z.string(),
  kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional() })
const selectedUpdate = z.union([textUpdate, planUpdate, toolUpdate])
const MODEL_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'usage_update'])
export interface AcpEvents { update(value: SessionNotification): void }

/** SDK wire types/constants, own quiet transport: SDK client errors can print raw thought frames. */
export class AcpClient {
  private readonly client: JsonRpcClient
  private readonly agent: AgentProcess
  private sessionId: string | null = null
  private capabilities: Record<string, unknown> = {}
  private lead: LeadTurn | null = null
  private promptSent = false
  private usage: LeadUsage = { inputTokens: null, outputTokens: null, cost: null }
  constructor(process: AgentProcess, events: AcpEvents) {
    this.agent = process
    this.client = new JsonRpcClient(process, true)
    this.client.on((method, params) => {
      if (method !== 'session/update' || params.sessionId !== this.sessionId || this.sessionId === null) return
      if (this.lead && this.promptSent) {
        // Activity is any update for the prompted session, including thoughts that are never stored.
        const raw = object(params.update)
        if (raw.sessionUpdate === 'usage_update') {
          const cost = object(raw.cost)
          if (typeof cost.amount === 'number' && Number.isFinite(cost.amount) && cost.amount >= 0 && typeof cost.currency === 'string') {
            this.usage = { ...this.usage, cost: { amount: cost.amount, currency: cost.currency } }
            this.lead.onUsage({ ...this.usage })
          }
        }
        // Only updates that show the model working count; command or mode bookkeeping does not.
        if (MODEL_UPDATES.has(String(raw.sessionUpdate))) this.lead.onActivity()
      }
      // Thought chunks and unknown extensions never reach handlers, including malformed ones.
      const update = selectedUpdate.safeParse(params.update)
      if (update.success) events.update({ sessionId: this.sessionId, update: update.data })
    })
  }
  async initialize(adapter: AdapterId, expectedVersion: string) {
    const result = object(await this.client.request('initialize', { protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: `${PRODUCT_FILE_PREFIX}_external`, version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } satisfies InitializeRequest))
    // agentInfo is optional in ACP v1. Its absence leaves the version unknown, not mismatched.
    const reported = object(result.agentInfo).version
    const observedVersion = typeof reported === 'string' ? reported : null
    if (result.protocolVersion !== 1 || (result.agentInfo != null && observedVersion !== expectedVersion)) throw new ExternalAgentError('adapter_version_mismatch')
    if (adapter === 'gemini-cli') {
      const methods = Array.isArray(result.authMethods) ? result.authMethods : []
      if (!methods.some(method => object(method).id === 'gemini-api-key')) throw new ExternalAgentError('api_key_auth_unavailable')
      await this.client.request('authenticate', { methodId: 'gemini-api-key' })
    }
    this.capabilities = object(result.agentCapabilities)
    return { ...result, observedVersion }
  }
  async prompt(model: string, text: string, cwd: string, lead?: LeadTurn, settings: { effort?: string; pin?: boolean } = {}): Promise<AgentOutput> {
    if (lead && object(this.capabilities.mcpCapabilities).http !== true) throw new ExternalAgentError('mcp_http_unsupported')
    // Programmatic settings are the bridge's highest-priority tier: they keep user/project/local files from moving the endpoint the
    // credential is sent to or from relaxing the permission mode (K5 answers every permission request with a refusal).
    const pinned = settings.pin ? { _meta: { claudeCode: { options: { settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, permissions: { defaultMode: 'default' }, apiKeyHelper: '' } } } } } : {}
    const mcpServers = (lead?.mcpServers ?? []).map(server => ({ type: 'http' as const, name: server.name, url: server.url,
      headers: server.headers.map(header => ({ name: header.name, value: header.value })) }))
    let session: Record<string, unknown> | undefined
    let sessionId = ''
    let mode: 'new' | 'load' | 'seeded' = 'new'
    if (lead?.resume && this.capabilities.loadSession === true) {
      try {
        // History replayed by the agent arrives before this response, while no session is selected.
        session = object(await this.client.request('session/load', { sessionId: lead.resume.acpSessionId, cwd, mcpServers, ...pinned }))
        sessionId = lead.resume.acpSessionId
        mode = 'load'
      } catch (error) {
        // Only an agent refusal falls back to a seeded session; a lost process is a failure.
        if (!(error instanceof ExternalAgentError) || error.code !== 'provider_failed') throw error
      }
    }
    if (!session) {
      session = object(await this.client.request('session/new', { cwd, mcpServers, ...pinned } satisfies NewSessionRequest))
      if (typeof session.sessionId !== 'string' || !session.sessionId) throw new ExternalAgentError('protocol_failed')
      sessionId = session.sessionId
      if (lead?.seededPrompt !== undefined) mode = 'seeded'
    }
    let options = Array.isArray(session.configOptions) ? session.configOptions.map(object) : []
    const option = options.find(o => o.category === 'model' || o.id === 'model')
    // A loaded session keeps the model it was created with unless the agent reports its options.
    if (model !== 'default' && !(mode === 'load' && !option)) {
      if (!option || option.type !== 'select' || !optionValues(option.options).includes(model) || typeof option.id !== 'string') throw new ExternalAgentError('model_unavailable')
      if (option.currentValue !== model) {
        const selected = object(await this.client.request('session/set_config_option', { sessionId, configId: option.id, value: model }))
        if (!Array.isArray(selected.configOptions) || !selected.configOptions.some(o => object(o).id === option.id && object(o).currentValue === model)) throw new ExternalAgentError('model_selection_failed')
        // The levels an agent offers depend on the selected model, so the effort is read from the options after the switch.
        options = selected.configOptions.map(object)
      }
    }
    // Operator-chosen effort, through the agent's own option: the vendor's settings files are never edited. A loaded session that
    // reports no options keeps the effort it was created with, like its model.
    const effort = settings.effort
    if (effort !== undefined) {
      const level = options.find(o => o.id === 'effort')
      if (!(mode === 'load' && !level)) {
        if (!level || level.type !== 'select' || typeof level.id !== 'string' || !optionValues(level.options).includes(effort)) throw new ExternalAgentError('effort_unavailable')
        if (level.currentValue !== effort) {
          const selected = object(await this.client.request('session/set_config_option', { sessionId, configId: level.id, value: effort }))
          if (!Array.isArray(selected.configOptions) || !selected.configOptions.some(o => object(o).id === level.id && object(o).currentValue === effort)) throw new ExternalAgentError('effort_selection_failed')
        }
      }
    }
    let textOutput = ''
    // Aggregate before scrub/event persistence, so a secret split over chunks cannot survive.
    this.sessionId = sessionId
    this.lead = lead ?? null
    this.usage = { inputTokens: null, outputTokens: null, cost: null }
    lead?.onSession({ acpSessionId: sessionId, mode, loadSession: this.capabilities.loadSession === true })
    this.agent.setCancelHandler(() => this.agent.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }))
    this.onText = chunk => { textOutput += chunk }
    try {
      const promptText = mode === 'seeded' ? lead?.seededPrompt ?? text : text
      this.promptSent = true
      const request = this.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] } satisfies PromptRequest)
      const settled = lead ? await this.withHibernation(request, lead, sessionId) : { result: object(await request), hibernated: false }
      const usage = object(settled.result?.usage)
      if (lead && settled.result?.usage != null) {
        const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
        this.usage = { ...this.usage, inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens) }
        lead.onUsage({ ...this.usage })
      }
      if (settled.hibernated) return { text: textOutput, stopReason: 'hibernated', usage: { ...this.usage } }
      const result = settled.result!
      if (result.stopReason !== 'end_turn') throw new ExternalAgentError(result.stopReason === 'cancelled' ? 'cancelled' : 'provider_failed')
      return { text: textOutput, stopReason: result.stopReason, ...(lead ? { usage: { ...this.usage } } : {}) }
    } finally {
      this.agent.setCancelHandler(null); this.onText = () => undefined; this.sessionId = null; this.lead = null; this.promptSent = false
    }
  }
  /** Cooperative stop: ask the agent to cancel and keep reading, so its final usage is observed. */
  private withHibernation(request: Promise<unknown>, lead: LeadTurn, sessionId: string) {
    return new Promise<{ result: Record<string, unknown> | null; hibernated: boolean }>((resolve, reject) => {
      let hibernated = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (action: () => void) => { clearTimeout(timer); lead.hibernateSignal.removeEventListener('abort', onAbort); action() }
      const onAbort = () => {
        hibernated = true
        void this.agent.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }).catch(() => undefined)
        timer = setTimeout(() => settle(() => resolve({ result: null, hibernated: true })), lead.cancelGraceMs ?? 5_000)
      }
      lead.hibernateSignal.addEventListener('abort', onAbort, { once: true })
      if (lead.hibernateSignal.aborted) onAbort()
      request.then(value => settle(() => resolve({ result: object(value), hibernated })),
        error => settle(() => hibernated ? resolve({ result: null, hibernated: true }) : reject(error)))
    })
  }
  private onText: (text: string) => void = () => undefined
  text(notification: SessionNotification) {
    if (notification.update.sessionUpdate === 'agent_message_chunk' && notification.update.content.type === 'text') this.onText(notification.update.content.text)
  }
  async close(): Promise<ProcessCleanup> { return this.client.close() }
}
function optionValues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(option => {
    const item = object(option)
    if (typeof item.value === 'string') return [item.value]
    return Array.isArray(item.options) ? item.options.flatMap(child => typeof object(child).value === 'string' ? [String(object(child).value)] : []) : []
  })
}
