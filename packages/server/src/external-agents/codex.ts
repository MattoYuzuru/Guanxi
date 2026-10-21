import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'
import { JsonRpcClient } from './rpc.ts'
import { ExternalAgentError, type AgentOutput } from './types.ts'
import { protocolObject as object } from './quota.ts'
import { z } from 'zod'

const planSchema = z.array(z.object({ step: z.string(), status: z.enum(['pending', 'inProgress', 'completed']) }))
export type CodexPlan = z.infer<typeof planSchema>

/** Codex's documented line-delimited app-server protocol. No OAuth implementation or token mode. */
export class CodexClient extends JsonRpcClient {
  async initialize(version: string) {
    const init = object(await this.request('initialize', { clientInfo: { name: `${PRODUCT_FILE_PREFIX}_external`, version: '0.1.0' }, capabilities: { experimentalApi: false } }))
    const reported = typeof init.userAgent === 'string' ? init.userAgent : ''
    const reportedVersion = reported.split(/\s/, 1)[0]?.split('/').at(-1)
    if (reportedVersion !== version) throw new ExternalAgentError('adapter_version_mismatch')
    await this.process.write({ method: 'initialized' })
  }
  async account() {
    const result = object(await this.request('account/read', { refreshToken: false }))
    const account = object(result.account)
    // Only the officially signed-in CLI's Plus/Pro mode is admitted. No API-key/token fallback.
    if (account.type !== 'chatgpt' || !['plus', 'pro'].includes(String(account.planType))) throw new ExternalAgentError('chatgpt_login_required')
    return { type: 'chatgpt', plan: String(account.planType) }
  }
  async login(onAuthUrl: (url: string) => void, signal: AbortSignal) {
    let complete!: (value: Record<string, unknown>) => void
    const messages: Record<string, unknown>[] = []
    const finish = new Promise<Record<string, unknown>>(resolve => { complete = resolve })
    const off = this.on((method, params) => { if (method === 'account/login/completed') { messages.push(params); complete(params) } })
    try {
      const result = object(await this.request('account/login/start', { type: 'chatgpt' }))
      const url = new URL(String(result.authUrl))
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password) throw new ExternalAgentError('invalid_auth_url')
      onAuthUrl(url.href)
      signal.throwIfAborted()
      const notification = messages.find(m => m.loginId === result.loginId) ?? await Promise.race([
        finish,
        this.process.closed.then(() => { throw new ExternalAgentError('agent_disconnected') }),
      ])
      if (notification.loginId !== result.loginId || notification.success !== true) throw new ExternalAgentError('login_failed')
      return await this.account()
    } finally { off() }
  }
  async prompt(model: string, text: string, cwd: string, reasoning?: string, onPlan: (plan: CodexPlan) => void = () => undefined): Promise<AgentOutput> {
    const result = object(await this.request('thread/start', { model, cwd, approvalPolicy: 'never', sandbox: 'read-only' }))
    const threadId = object(result.thread).id
    if (typeof threadId !== 'string') throw new ExternalAgentError('protocol_failed')
    const textByTurn = new Map<string, string>()
    const plansByTurn = new Map<string, CodexPlan[]>()
    const completed = new Map<string, Record<string, unknown>>()
    let expectedTurn: string | null = null
    let done!: (value: Record<string, unknown>) => void
    const completion = new Promise<Record<string, unknown>>(resolve => { done = resolve })
    // Attach before turn/start: notifications can arrive before its response.
    const off = this.on((method, params) => {
      if (params.threadId !== threadId) return
      if (method === 'item/agentMessage/delta' && typeof params.turnId === 'string' && typeof params.delta === 'string') textByTurn.set(params.turnId, (textByTurn.get(params.turnId) ?? '') + params.delta)
      if (method === 'turn/plan/updated' && typeof params.turnId === 'string') {
        const plan = planSchema.safeParse(params.plan)
        if (plan.success) {
          if (params.turnId === expectedTurn) onPlan(plan.data)
          else plansByTurn.set(params.turnId, [...(plansByTurn.get(params.turnId) ?? []), plan.data])
        }
      }
      if (method === 'turn/completed') {
        const turn = object(params.turn)
        if (typeof turn.id === 'string') {
          completed.set(turn.id, turn)
          if (turn.id === expectedTurn) done(turn)
        }
      }
    })
    try {
      const started = object(await this.request('turn/start', { threadId, input: [{ type: 'text', text }], ...(reasoning ? { effort: reasoning } : {}) }))
      const turnId = object(started.turn).id
      if (typeof turnId !== 'string') throw new ExternalAgentError('protocol_failed')
      expectedTurn = turnId
      for (const plan of plansByTurn.get(turnId) ?? []) onPlan(plan)
      const turn = completed.get(turnId) ?? await Promise.race([completion, this.process.closed.then(() => { throw new ExternalAgentError('agent_disconnected') })])
      if (turn.id !== turnId || turn.status !== 'completed') throw new ExternalAgentError('provider_failed')
      return { text: textByTurn.get(turnId) ?? '', stopReason: 'end_turn' }
    } finally { off() }
  }
}
