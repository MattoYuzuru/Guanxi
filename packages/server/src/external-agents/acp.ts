import { ClientSideConnection, PROTOCOL_VERSION, type SessionNotification, type SessionConfigOption } from '@agentclientprotocol/sdk'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'
import { AgentProcess } from './process.ts'
import { ExternalAgentError, type AdapterId, type AgentOutput } from './types.ts'

export interface AcpEvents {
  update(value: SessionNotification): void
  extension(method: string, value: Record<string, unknown>): void
}
export class AcpClient {
  private readonly process: AgentProcess
  private readonly client: ClientSideConnection
  private notificationError: Error | null = null
  constructor(process: AgentProcess, events: AcpEvents) {
    this.process = process
    const guard = (fn: () => void) => { try { fn() } catch { this.notificationError = new ExternalAgentError('event_failed') } }
    this.client = new ClientSideConnection(() => ({
      requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: value => guard(() => events.update(value)),
      extNotification: (method, value) => guard(() => events.extension(method, value)),
      // Do not advertise fs/terminal. The SDK rejects those methods as unavailable.
    }), process.stream)
  }
  async initialize(adapter: AdapterId, version: string) {
    const result = await this.client.initialize({ protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: `${PRODUCT_FILE_PREFIX}_external`, version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    if (result.protocolVersion !== 1 || result.agentInfo?.version !== version) throw new ExternalAgentError('adapter_version_mismatch')
    if (adapter === 'gemini-cli') {
      const method = result.authMethods?.find(m => m.id === 'gemini-api-key')
      if (!method) throw new ExternalAgentError('api_key_auth_unavailable')
      await this.client.authenticate({ methodId: method.id })
    }
    return result
  }
  async prompt(model: string, text: string, cwd: string): Promise<AgentOutput> {
    const session = await this.client.newSession({ cwd, mcpServers: [] })
    const option = session.configOptions?.find(o => o.category === 'model' || o.id === 'model')
    if (model !== 'default') {
      if (!option || option.type !== 'select' || !optionValues(option).includes(model)) throw new ExternalAgentError('model_unavailable')
      if (option.currentValue !== model) {
        const selected = await this.client.setSessionConfigOption({ sessionId: session.sessionId, configId: option.id, value: model })
        if (!selected.configOptions.some(o => o.id === option.id && o.currentValue === model)) throw new ExternalAgentError('model_selection_failed')
      }
    }
    let textOutput = ''
    // Aggregate before scrub/event persistence, so a secret split over chunks cannot survive.
    const previous = this.onText
    this.onText = (id, chunk) => { if (id === session.sessionId) textOutput += chunk }
    try {
      const result = await this.client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text }] })
      if (this.notificationError) throw this.notificationError
      if (result.stopReason !== 'end_turn') throw new ExternalAgentError(result.stopReason === 'cancelled' ? 'cancelled' : 'provider_failed')
      return { text: textOutput, stopReason: result.stopReason }
    } finally { this.onText = previous }
  }
  onText: (sessionId: string, text: string) => void = () => undefined
  text(notification: SessionNotification) {
    if (notification.update.sessionUpdate === 'agent_message_chunk' && notification.update.content.type === 'text') this.onText(notification.sessionId, notification.update.content.text)
  }
  async close() { await this.process.close(); await this.client.closed }
}
function optionValues(option: SessionConfigOption): string[] {
  if (option.type !== 'select') return []
  return option.options.flatMap(o => 'value' in o ? [o.value] : o.options.map(child => child.value))
}
