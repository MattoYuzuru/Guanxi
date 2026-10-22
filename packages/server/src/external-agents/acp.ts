import { PROTOCOL_VERSION, type InitializeRequest, type NewSessionRequest, type PromptRequest, type SessionNotification } from '@agentclientprotocol/sdk'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'
import { z } from 'zod'
import type { AgentProcess, ProcessCleanup } from './process.ts'
import { JsonRpcClient } from './rpc.ts'
import { protocolObject as object } from './quota.ts'
import { ExternalAgentError, type AdapterId, type AgentOutput } from './types.ts'

const textUpdate = z.object({ sessionUpdate: z.literal('agent_message_chunk'), content: z.object({ type: z.literal('text'), text: z.string() }) })
const planUpdate = z.object({ sessionUpdate: z.literal('plan'), entries: z.array(z.object({ content: z.string(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'), status: z.enum(['pending', 'in_progress', 'completed']) })) })
const toolUpdate = z.object({ sessionUpdate: z.literal('tool_call'), toolCallId: z.string(), title: z.string(),
  kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional() })
const selectedUpdate = z.union([textUpdate, planUpdate, toolUpdate])
export interface AcpEvents { update(value: SessionNotification): void }

/** SDK wire types/constants, own quiet transport: SDK client errors can print raw thought frames. */
export class AcpClient {
  private readonly client: JsonRpcClient
  private readonly agent: AgentProcess
  private sessionId: string | null = null
  constructor(process: AgentProcess, events: AcpEvents) {
    this.agent = process
    this.client = new JsonRpcClient(process, true)
    this.client.on((method, params) => {
      if (method !== 'session/update' || params.sessionId !== this.sessionId || this.sessionId === null) return
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
    return { ...result, observedVersion }
  }
  async prompt(model: string, text: string, cwd: string): Promise<AgentOutput> {
    const session = object(await this.client.request('session/new', { cwd, mcpServers: [] } satisfies NewSessionRequest))
    if (typeof session.sessionId !== 'string' || !session.sessionId) throw new ExternalAgentError('protocol_failed')
    const options = Array.isArray(session.configOptions) ? session.configOptions.map(object) : []
    const option = options.find(o => o.category === 'model' || o.id === 'model')
    if (model !== 'default') {
      if (!option || option.type !== 'select' || !optionValues(option.options).includes(model) || typeof option.id !== 'string') throw new ExternalAgentError('model_unavailable')
      if (option.currentValue !== model) {
        const selected = object(await this.client.request('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value: model }))
        if (!Array.isArray(selected.configOptions) || !selected.configOptions.some(o => object(o).id === option.id && object(o).currentValue === model)) throw new ExternalAgentError('model_selection_failed')
      }
    }
    let textOutput = ''
    // Aggregate before scrub/event persistence, so a secret split over chunks cannot survive.
    this.sessionId = session.sessionId
    this.agent.setCancelHandler(() => this.agent.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.sessionId } }))
    this.onText = chunk => { textOutput += chunk }
    try {
      const result = object(await this.client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] } satisfies PromptRequest))
      if (result.stopReason !== 'end_turn') throw new ExternalAgentError(result.stopReason === 'cancelled' ? 'cancelled' : 'provider_failed')
      return { text: textOutput, stopReason: result.stopReason }
    } finally { this.agent.setCancelHandler(null); this.onText = () => undefined; this.sessionId = null }
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
