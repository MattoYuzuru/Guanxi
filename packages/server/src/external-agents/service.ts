import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { z } from 'zod'
import type { Connection, ConnectionFact } from '@guanxi/contract'
import type { Connections } from '../connections/service.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { SessionLog, SessionHandle } from '../session-log/log.ts'
import { AcpClient } from './acp.ts'
import { CodexClient } from './codex.ts'
import { canonicalExecutable, isolatedEnvironment, AgentProcess, claudeAuthStatus } from './process.ts'
import { ExternalStore } from './store.ts'
import { ADAPTERS, API_ENV } from './profiles.ts'
import { claudeRateLimits, codexRateLimits } from './quota.ts'
import { ExternalAgentError, resolveRole, bindingSchema, rolesSchema, type ExternalPolicy, type AgentInstallation,
  type Roles, type Role, type RoleBinding, type QuotaObservation, type AdapterId } from './types.ts'

/** API-key adapters that can run host tools. The deny configuration below is not a sandbox and
 * its runtime enforcement is the vendor's; a non-owner prompt is refused before process launch. */
const HOST_TOOL_ADAPTERS = new Set<AdapterId>(['opencode', 'goose'])
const installationSchema = z.object({
  adapter: z.enum(['claude-code', 'copilot', 'gemini-cli', 'opencode', 'goose', 'codex']), connectionId: z.string().uuid(),
  ownerAccountId: z.string().min(1), nodeId: z.string().min(1), billingAccount: z.string().min(1),
  executable: z.string().min(1), version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/),
  claudeExecutable: z.string().optional(), claudeBare: z.boolean().optional(), concurrency: z.number().int().positive().optional(),
}).strict()

export interface RolePrompt {
  ownerAccountId: string
  /** Trusted original author identity; preserve it through every delegation hop. */
  actorAccountId: string
  projectId: string
  role: Role
  sessionRoles?: Roles
  prompt: string
  signal?: AbortSignal
  background?: boolean
}
export class ExternalAgents {
  private readonly connections: Connections
  private readonly log: SessionLog
  private readonly scrubber: EgressScrubber
  private readonly root: string
  private readonly policy: ExternalPolicy
  private readonly store: ExternalStore
  private readonly abort = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly active = new Map<string, number>()
  private readonly authenticating = new Set<string>()
  private closed = false
  private readonly configuredAt = new Date().toISOString()
  constructor(connections: Connections, log: SessionLog, scrubber: EgressScrubber, root: string, store: ExternalStore, policy: ExternalPolicy) {
    this.connections = connections; this.log = log; this.scrubber = scrubber; this.root = root; this.store = store
    if (!policy.nodeId || !Number.isSafeInteger(policy.frameBytes ?? 8 * 1024 * 1024) || (policy.frameBytes ?? 1) < 1 ||
      !Number.isSafeInteger(policy.requestTimeoutMs ?? 300_000) || (policy.requestTimeoutMs ?? 1) < 1 ||
      !Number.isSafeInteger(policy.runDeadlineMs ?? 300_000) || (policy.runDeadlineMs ?? 1) < 1 ||
      !Number.isSafeInteger(policy.quotaMaxAgeMs ?? 300_000) || (policy.quotaMaxAgeMs ?? 1) < 1) throw new ExternalAgentError('invalid_policy')
    const installations = policy.installations.map(i => Object.freeze(installationSchema.parse(i)))
    if (new Set(installations.map(i => `${i.ownerAccountId}/${i.connectionId}`)).size !== installations.length) throw new ExternalAgentError('duplicate_installation')
    // OS credential stores (for example the macOS login keychain) may not be isolated by HOME
    // or vendor config variables, so one subscription adapter is bound to one owner per node.
    const owners = new Map<string, Set<string>>()
    for (const install of installations) {
      if (ADAPTERS[install.adapter].payment !== 'subscription') continue
      const key = `${install.nodeId}/${install.adapter}`
      const set = owners.get(key) ?? new Set<string>()
      set.add(install.ownerAccountId)
      owners.set(key, set)
      if (set.size > 1) throw new ExternalAgentError('adapter_owner_conflict')
    }
    this.policy = Object.freeze({ ...policy, installations: Object.freeze(installations) })
  }
  private ready() {
    if (this.closed) throw new ExternalAgentError('agent_unavailable')
    if (!this.scrubber.isReady()) throw new ExternalAgentError('egress_unavailable')
  }
  private installation(owner: string, connectionId: string, adapter?: string) {
    this.ready()
    const install = this.policy.installations.find(i => i.ownerAccountId === owner && i.connectionId === connectionId)
    if (!install || (adapter && install.adapter !== adapter)) throw new ExternalAgentError('adapter_unconfigured')
    if (install.nodeId !== this.policy.nodeId) throw new ExternalAgentError('wrong_node')
    return install
  }
  private group(install: AgentInstallation) { return JSON.stringify([install.ownerAccountId, install.adapter, install.billingAccount]) }
  private assertOwner(owner: string, actor: string) { this.ready(); if (owner !== actor) throw new ExternalAgentError('owner_required') }
  setProjectRoles(owner: string, actor: string, projectId: string, roles: Roles) {
    this.assertOwner(owner, actor)
    const parsed = rolesSchema.parse(roles)
    for (const binding of Object.values(parsed)) if (binding) this.validateBinding(owner, binding)
    return this.store.setRoles(owner, projectId, parsed)
  }
  private validateBinding(owner: string, binding: RoleBinding) {
    const row = this.connections.store.get(owner, binding.connectionId)
    if (binding.backend === 'native') {
      if (!['model_api', 'local_runtime'].includes(row.kind)) throw new ExternalAgentError('invalid_native_connection')
    } else this.installation(owner, row.id, binding.backend)
  }
  resolve(owner: string, projectId: string, role: Role, sessionRoles: Roles = {}) {
    this.ready()
    const resolved = resolveRole(role, sessionRoles, this.store.roles(owner, projectId))
    this.validateBinding(owner, resolved.binding)
    return this.scrubber.scrub(resolved)
  }
  setEditorAllowed(owner: string, actor: string, connectionId: string, editor: string, allowed: boolean) {
    this.assertOwner(owner, actor)
    const row = this.connections.store.get(owner, connectionId)
    if (allowed && (row.auth === 'cli_login' || !['model_api', 'local_runtime'].includes(row.kind))) throw new ExternalAgentError('subscription_owner_only')
    this.store.grant(owner, connectionId, editor, allowed)
  }
  capabilities(owner: string) {
    this.ready()
    return this.scrubber.scrub(this.policy.installations.filter(i => i.ownerAccountId === owner).map(i => ({
      connectionId: i.connectionId, nodeId: i.nodeId, adapter: i.adapter, version: i.version,
      declaration: { value: ADAPTERS[i.adapter], source: ADAPTERS[i.adapter].source, observedAt: this.configuredAt, confidence: 'medium' },
      concurrencyPolicy: { value: i.concurrency ?? 1, source: 'node_operator_policy', observedAt: this.configuredAt, confidence: 'high' },
    })))
  }
  /** Paths/argv for the owner to sign in with the unmodified CLI on this node.
   * These are configuration locations only; no file contents or inherited credentials. */
  prepareLogin(owner: string, actor: string, connectionId: string) {
    this.assertOwner(owner, actor)
    const install = this.installation(owner, connectionId)
    return this.track(async () => {
      if (!['claude-code', 'codex', 'copilot'].includes(install.adapter)) throw new ExternalAgentError('api_or_local_required')
      const config = await isolatedEnvironment(this.root, install)
      const executable = await canonicalExecutable(install.adapter === 'claude-code' ? install.claudeExecutable ?? '' : install.executable)
      return this.scrubber.scrub({ nodeId: this.policy.nodeId, executable, args: install.adapter === 'claude-code' ? ['auth', 'login'] : install.adapter === 'codex' ? ['login'] : [],
        interaction: install.adapter === 'copilot' ? '/login' : null, environment: config.env })
    })
  }
  limits(owner: string, connectionId: string, now = Date.now()) {
    const install = this.installation(owner, connectionId)
    return { ...this.store.limits(owner, install.billingAccount, install.adapter, now, this.policy.quotaMaxAgeMs ?? 300_000),
      concurrency: this.store.learning(owner, install.billingAccount, install.adapter),
      activeOnThisNode: this.active.get(this.group(install)) ?? 0 }
  }
  /** T0 ingress for authenticated node reports. F1 must authenticate owner/node before calling.
   * This accepts quota facts only, never credentials, prompts or vendor configuration. */
  observeQuota(owner: string, connectionId: string, report: QuotaObservation, now = Date.now()) {
    const install = this.installation(owner, connectionId)
    if (report.ownerAccountId !== owner || report.adapter !== install.adapter || report.billingAccount !== install.billingAccount) throw new ExternalAgentError('quota_identity_mismatch')
    this.store.observe(report, now)
  }
  /** Official Claude statusline JSON can be forwarded by an owner-installed statusline integration.
   * Guanxi does not edit the vendor's settings or discover/read its files. */
  observeClaudeStatusline(owner: string, actor: string, connectionId: string, statusline: unknown, observedAt: string) {
    this.assertOwner(owner, actor)
    const install = this.installation(owner, connectionId, 'claude-code')
    this.recordQuota(install, 'claude:statusline.rate_limits', claudeRateLimits(statusline), observedAt)
  }
  /** Explicit classified observations only: a generic quota/429 error is not concurrency evidence.
   * A trusted adapter/peer can provide a vendor concurrency rejection without exposing raw errors. */
  observeConcurrency(owner: string, actor: string, connectionId: string, parallel: number, outcome: 'success' | 'concurrency_rejected') {
    this.assertOwner(owner, actor)
    const install = this.installation(owner, connectionId)
    if (!Number.isSafeInteger(parallel) || parallel < 1 || !['success', 'concurrency_rejected'].includes(outcome)) throw new ExternalAgentError('invalid_concurrency_observation')
    this.store.learn(owner, install.billingAccount, install.adapter, parallel, outcome, new Date().toISOString())
  }
  private recordQuota(install: AgentInstallation, source: string, windows: QuotaObservation['windows'], observedAt = new Date().toISOString()) {
    this.store.observe({ ownerAccountId: install.ownerAccountId, billingAccount: install.billingAccount, adapter: install.adapter,
      nodeId: install.nodeId, source: `${install.adapter}@${install.version}:${source}`, observedAt, confidence: 'medium', windows }, Date.now())
  }
  private observe(install: AgentInstallation, name: string, value: ConnectionFact['value'], source: string, confidence: ConnectionFact['confidence'] = 'medium') {
    this.connections.store.observe(install.ownerAccountId, install.connectionId, { [name]: {
      value, source: `${install.adapter}@${install.version}:${source}`, observedAt: new Date().toISOString(), confidence: value === null ? 'unknown' : confidence,
    } })
  }
  private payment(install: AgentInstallation, row: Connection, key: string | undefined, env: NodeJS.ProcessEnv, model: string) {
    if (['claude-code', 'codex', 'copilot'].includes(install.adapter)) {
      if (row.kind !== 'agent' || row.provider !== install.adapter || row.auth !== 'cli_login' || key) throw new ExternalAgentError('subscription_connection_required')
    } else {
      if (install.adapter === 'gemini-cli' && (row.provider !== 'google' || row.kind !== 'model_api' || !key)) throw new ExternalAgentError('gemini_api_key_required')
      if (row.kind === 'model_api' && row.auth === 'api_key' && key) {
        const variable = API_ENV[row.provider as keyof typeof API_ENV]
        if (!variable) throw new ExternalAgentError('api_provider_unavailable')
        env[variable] = key
      } else throw new ExternalAgentError('external_api_key_required')
      if (install.adapter === 'opencode') {
        // The provider-qualified advertised model must agree with the K3 payment connection.
        // Inline config is an official runtime override, not a vendor credential/settings edit.
        if (!model.startsWith(`${row.provider}/`) || model === `${row.provider}/`) throw new ExternalAgentError('payment_model_mismatch')
        const variable = API_ENV[row.provider as keyof typeof API_ENV]
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ enabled_providers: [row.provider], model, small_model: model,
          permission: { '*': 'deny' },
          provider: { [row.provider]: { options: { apiKey: `{env:${variable}}` } } } })
      }
      if (install.adapter === 'goose') {
        if (!['anthropic', 'openai', 'google', 'openrouter'].includes(row.provider) || model === 'default') throw new ExternalAgentError('payment_model_mismatch')
        env.GOOSE_PROVIDER = row.provider; env.GOOSE_MODEL = model
        env.GOOSE_DISABLE_KEYRING = '1'
        // Chat mode does not run autonomous tools; approvals are never granted by this client.
        env.GOOSE_MODE = 'chat'
        if (row.provider === 'google') { env.GOOGLE_API_KEY = key; delete env.GEMINI_API_KEY }
      }
    }
  }
  private track<T>(operation: () => Promise<T>) {
    this.ready()
    const task = operation()
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined)
    return task
  }
  run(input: RolePrompt) { return this.track(() => this.execute(input)) }
  private async execute(input: RolePrompt) {
    const resolved = this.resolve(input.ownerAccountId, input.projectId, input.role, input.sessionRoles)
    const binding = bindingSchema.parse(resolved.binding)
    const install = this.installation(input.ownerAccountId, binding.connectionId, binding.backend)
    if (input.actorAccountId !== input.ownerAccountId && HOST_TOOL_ADAPTERS.has(install.adapter)) throw new ExternalAgentError('host_tools_owner_only')
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new ExternalAgentError('empty_prompt')
    if (binding.params.temperature !== undefined || binding.params.maxTokens !== undefined ||
      (install.adapter !== 'codex' && binding.params.reasoning !== undefined)) throw new ExternalAgentError('unsupported_parameter')
    const runDeadlineMs = this.policy.runDeadlineMs ?? 300_000
    const signal = AbortSignal.any([this.abort.signal, ...(input.signal ? [input.signal] : []), AbortSignal.timeout(runDeadlineMs)])
    return this.connections.dispatchAgent(input.ownerAccountId, binding.connectionId, input.actorAccountId,
      this.store.editorAllowed(input.ownerAccountId, binding.connectionId, input.actorAccountId), { background: input.background, signal }, async (row, key, dispatchSignal) => {
        const group = this.group(install)
        if (this.authenticating.has(group)) throw new ExternalAgentError('account_busy')
        const parallel = (this.active.get(group) ?? 0) + 1
        const learned = this.store.learning(input.ownerAccountId, install.billingAccount, install.adapter)
        const ceiling = learned.rejectedAt === null ? Infinity : Math.max(1, learned.rejectedAt - 1)
        if (parallel > Math.min(install.concurrency ?? 1, ceiling)) throw new ExternalAgentError('account_busy')
        this.active.set(group, parallel)
        let handle: SessionHandle | undefined
        let process: AgentProcess | undefined
        let client: AcpClient | CodexClient | undefined
        let config: Awaited<ReturnType<typeof isolatedEnvironment>> | undefined
        const sessionId = randomUUID(); const messageId = randomUUID()
        try {
          const executable = await canonicalExecutable(install.executable)
          // API agents never reuse a vendor login/config from an earlier invocation.
          config = await isolatedEnvironment(this.root, row.auth === 'api_key' ? { ...install, connectionId: `${install.connectionId}:${randomUUID()}` } : install)
          this.payment(install, row, key, config.env, binding.model)
          if (install.adapter === 'claude-code') {
            if (!install.claudeExecutable) throw new ExternalAgentError('claude_binary_required')
            const claude = await canonicalExecutable(install.claudeExecutable)
            config.env.CLAUDE_CODE_EXECUTABLE = claude
            this.observe(install, 'bare', install.claudeBare ?? null, 'node_launch_policy', 'high')
            if (install.claudeBare) {
              this.observe(install, 'billing', null, 'bare_does_not_read_subscription')
              throw new ExternalAgentError('bare_subscription_unavailable')
            }
            const auth = await claudeAuthStatus(claude, config.env, config.cwd, dispatchSignal, this.policy.frameBytes ?? 8 * 1024 * 1024)
            this.observe(install, 'subscription_login', auth.loggedIn && auth.authMethod === 'claude.ai', 'claude_auth_status')
            // Login is an observation, not proof of whether this request will be extra usage.
            this.observe(install, 'billing', null, 'billing_not_reported')
            if (!auth.loggedIn || auth.authMethod !== 'claude.ai') throw new ExternalAgentError('claude_login_required')
          }
          dispatchSignal.throwIfAborted()
          handle = this.log.open(sessionId, { kind: 'agent' })
          handle.append({ type: 'agent.note', data: { text: JSON.stringify(this.scrubber.scrub({ role: input.role, source: resolved.source, binding,
            ownerAccountId: input.ownerAccountId, actorAccountId: input.actorAccountId, nodeId: install.nodeId, runDeadlineMs })) } })
          handle.append({ type: 'agent.state', data: { status: 'running', error: null } })
          const prompt = this.scrubber.scrub(input.prompt)
          handle.append({ type: 'prompt', data: { origin: input.actorAccountId === input.ownerAccountId ? 'typed' : 'remote', messageId, text: prompt, attachmentCount: 0 } })
          process = new AgentProcess(executable, ADAPTERS[install.adapter].args, config.env, config.cwd, this.scrubber, dispatchSignal, this.policy.frameBytes ?? 8 * 1024 * 1024)
          if (install.adapter === 'codex') {
            const codex = new CodexClient(process); client = codex
            codex.on((method, params) => {
              if (method === 'account/rateLimits/updated') this.recordQuota(install, method, codexRateLimits(params))
            })
            await codex.initialize(install.version)
            this.observe(install, 'adapter_version', install.version, 'initialize', 'high')
            const account = await codex.account()
            this.observe(install, 'subscription_login', true, 'account/read')
            this.observe(install, 'plan', account.plan, 'account/read')
            this.observe(install, 'billing', null, 'per_request_billing_not_reported')
            this.recordQuota(install, 'account/rateLimits/read', codexRateLimits(await codex.request('account/rateLimits/read')))
          } else {
            const acp = new AcpClient(process, {
              update: notification => {
                acp.text(notification)
                const update = notification.update
                if (update.sessionUpdate === 'plan') handle!.append({ type: 'agent.plan', data: { items: update.entries.map(e => ({ text: e.content,
                  status: e.status === 'completed' ? 'verification_requested' : e.status === 'in_progress' ? 'active' : 'pending' })) } })
                if (update.sessionUpdate === 'tool_call') handle!.append({ type: 'tool.call', data: { toolCallId: update.toolCallId, name: update.kind ?? 'other',
                  arguments: {}, source: 'builtin', parsedFrom: 'native', diffPath: null } })
                // Thought chunks, raw tool output and unknown extensions are never copied to logs.
              },
            }); client = acp
            await acp.initialize(install.adapter, install.version)
            this.observe(install, 'adapter_version', install.version, 'initialize', 'high')
          }
          const output = client instanceof CodexClient
            ? await client.prompt(binding.model, prompt, config.cwd, binding.params.reasoning, plan => handle!.append({ type: 'agent.plan', data: { items: plan.map(item => ({ text: item.step,
              status: item.status === 'completed' ? 'verification_requested' : item.status === 'inProgress' ? 'active' : 'pending' })) } }))
            : await client.prompt(binding.model, prompt, config.cwd)
          dispatchSignal.throwIfAborted()
          const safe = this.scrubber.scrub(output)
          handle.append({ type: 'assistant.message', data: { messageId, step: 0, text: safe.text } })
          handle.append({ type: 'turn.done', data: { messageId, outcome: 'completed', stopReason: safe.stopReason, steps: 1 } })
          handle.append({ type: 'agent.state', data: { status: 'completed', error: null } })
          this.store.learn(input.ownerAccountId, install.billingAccount, install.adapter, parallel, 'success', new Date().toISOString())
          return this.scrubber.scrub({ sessionId, ...safe })
        } catch (error) {
          const timedOut = dispatchSignal.aborted && (dispatchSignal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
          const cancelled = dispatchSignal.aborted && !timedOut
          const code = timedOut ? 'timeout' : cancelled ? 'cancelled' : error instanceof ExternalAgentError ? error.code : 'agent_failed'
          if (handle) {
            handle.append({ type: 'agent.state', data: { status: cancelled ? 'cancelled' : 'failed', error: code } })
            handle.append({ type: 'turn.done', data: { messageId, outcome: cancelled ? 'cancelled' : 'failed', stopReason: code, steps: 0 } })
          }
          throw new ExternalAgentError(code)
        } finally {
          try { if (client) await client.close(); else await process?.close() }
          finally {
            // API-key directories are throwaway; subscription config directories persist for sign-in.
            if (config && row.auth === 'api_key') await rm(config.configDirectory, { recursive: true, force: true }).catch(() => undefined)
            handle?.close(); const count = (this.active.get(group) ?? 1) - 1; if (count) this.active.set(group, count); else this.active.delete(group)
          }
        }
      })
  }
  signInWithChatGPT(owner: string, actor: string, connectionId: string, onAuthUrl: (url: string) => void, signal?: AbortSignal) {
    this.assertOwner(owner, actor)
    const install = this.installation(owner, connectionId, 'codex')
    return this.track(() => this.connections.dispatchAgent(owner, connectionId, actor, false,
      { signal: AbortSignal.any([this.abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(this.policy.requestTimeoutMs ?? 300_000)]) }, async (row, key, dispatchSignal) => {
        const group = this.group(install)
        if (this.active.get(group)) throw new ExternalAgentError('account_busy')
        this.authenticating.add(group)
        this.active.set(group, 1)
        let client: CodexClient | undefined
        let process: AgentProcess | undefined
        try {
          const executable = await canonicalExecutable(install.executable)
          const config = await isolatedEnvironment(this.root, install)
          this.payment(install, row, key, config.env, 'default')
          process = new AgentProcess(executable, ADAPTERS.codex.args, config.env, config.cwd, this.scrubber, dispatchSignal, this.policy.frameBytes ?? 8 * 1024 * 1024)
          client = new CodexClient(process)
          await client.initialize(install.version)
          const result = await client.login(onAuthUrl, dispatchSignal)
          this.observe(install, 'subscription_login', true, 'account/read')
          this.observe(install, 'plan', result.plan, 'account/read')
          return result
        } catch (error) { throw new ExternalAgentError(dispatchSignal.aborted ? 'cancelled' : error instanceof ExternalAgentError ? error.code : 'login_failed') }
        finally { try { if (client) await client.close(); else await process?.close() } finally { this.active.delete(group); this.authenticating.delete(group) } }
      }))
  }
  async close() { this.closed = true; this.abort.abort(); await Promise.allSettled([...this.tasks]) }
}
