import { join } from 'node:path'
import type { NodeIdentity } from '@guanxi/contract/federation'
import { ConnectionError } from '../connections/errors.ts'
import type { Connections } from '../connections/service.ts'
import type { ExternalPolicy } from '../external-agents/types.ts'
import { FederationChannel } from '../federation/channel.ts'
import { FederationError } from '../federation/crypto.ts'
import type { FederationHostOptions } from '../federation/plugin.ts'
import type { Federation } from '../federation/service.ts'
import { LOCAL_ACCOUNT_ID } from '../http/local-guard.ts'
import type { LeadPluginConfig } from '../leads/plugin.ts'
import { OwnedCheckoutAllocator } from '../relay/checkout.ts'
import { RemoteRelayRuntime } from '../relay/remote-runtime.ts'
import type { RelayRuntimePolicy } from '../relay/runtime.ts'
import type { RelayStartHost } from '../relay/start.ts'
import type { RelayDelegationBrief } from '../relay/delegation-brief.ts'
import { ledgerJudgeInput, relayJudgeModel, type RelayStartJudgeContext, type RelayStartJudgeSource } from '../relay/judge-start.ts'
import type { Reserves } from '../relay/types.ts'
import type { RunStore } from '../runs/store.ts'
import { LlamaServerHost } from '../runtime/llama-server/process.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import { MS1_EXECUTOR_CONNECTION, MS1_LEAD_CONNECTION, Ms1LiveError, type Ms1LiveJudge, type Ms1LiveSettings } from './config.ts'
import { readCredentials, type PairedCredentials } from './identity.ts'
import { loopbackTransport } from './transport.ts'

/** The owner account every connection and project of this node belongs to (the node is single-owner today). */
const OWNER = LOCAL_ACCOUNT_ID

/** What the home gives the existing relay plugin host: the pieces `start()` already knows how to use. */
export interface Ms1LiveHomeRelay {
  runtime: RelayRuntimePolicy
  reserves: Reserves
  allocate: NonNullable<RelayStartHost['allocate']>
  limits: NonNullable<RelayStartHost['limits']>
}
export interface Ms1LiveLeadWiring {
  externalAgents: ExternalPolicy
  leads: Omit<LeadPluginConfig, 'db' | 'child'> & { alwaysOn: true; child?: undefined
    relay: { consent: 'full-access'; domains?: readonly string[]; pollMs?: number }
    validateExecutor: NonNullable<LeadPluginConfig['validateExecutor']>; limits: NonNullable<LeadPluginConfig['limits']> }
}
export interface Ms1LiveWarmState { state: 'not_applicable' | 'warming' | 'ready' | 'unavailable'; code?: string; observedAt?: number }

/** What `start()` hands back to its caller: public facts and two harmless actions. It reaches neither the private key nor the
 * federation host options, and nothing in it leads back to the node that holds them. */
export interface Ms1LiveView {
  readonly role: 'home' | 'executor'
  readonly identity: NodeIdentity
  readonly peer: NodeIdentity
  readonly model: string
  readonly connectionId: string
  readonly leadConnectionId: string
  readonly hasLead: boolean
  readonly federationPort: number
  warmState(): Ms1LiveWarmState
  startWarming(): Promise<Ms1LiveWarmState>
  /** The attestation this node gives the dispatch layer for `model`, or null when the model is not served here. */
  attestedModel(model: string): ReturnType<NonNullable<NonNullable<FederationHostOptions['dispatch']>['localModel']>>
}

/** One node's share of the MS1 live pairing, built from validated configuration before any file or listener exists.
 *
 * It owns no listener and no process: `start()` asks it for federation options, ensures its connections once the K3
 * registry exists, and asks the home for relay wiring once the federation service exists. Holding the private key in a
 * private field, it hands it only to the federation host options that the node's own plugin consumes. */
export class Ms1LiveNode {
  readonly settings: Ms1LiveSettings
  readonly role: 'home' | 'executor'
  readonly identity: NodeIdentity
  readonly peer: NodeIdentity
  readonly model: string
  readonly #privateKey: string
  private readonly channel: FederationChannel
  private readonly llama: LlamaServerHost | null
  private connection = ''
  private leadConnection = ''
  private warm: Ms1LiveWarmState
  private readonly lifetime = new AbortController()
  private warming: Promise<Ms1LiveWarmState> | null = null
  private closed = false

  private constructor(settings: Ms1LiveSettings, credentials: PairedCredentials) {
    this.settings = settings; this.role = settings.role
    this.identity = credentials.local.identity; this.peer = credentials.peer
    this.#privateKey = credentials.local.privateKey
    const model = normalizeOllamaModelReference(settings.model)
    if (!model || /:cloud$/i.test(settings.model)) throw new Ms1LiveError('model_invalid', 'model')
    this.model = model
    this.channel = new FederationChannel({ local: this.identity, privateKey: this.#privateKey, peer: this.peer,
      transport: loopbackTransport({ base: settings.peer.url, timeoutMs: settings.link.requestTimeoutMs, messageTimeoutMs: settings.link.messageTimeoutMs }) })
    // Attach mode only: this node owns no llama-server process, signals none and runs none. `create` does no I/O.
    this.llama = settings.role === 'executor'
      ? LlamaServerHost.create({ kind: 'attach', baseUrl: settings.executor!.llamaServer.baseUrl, model: settings.model,
        ...(settings.executor!.llamaServer.cachePrompt === undefined ? {} : { cachePrompt: settings.executor!.llamaServer.cachePrompt }) })
      : null
    this.warm = { state: this.llama ? 'warming' : 'not_applicable' }
  }

  /** Validates configuration, key and pairing. Throws `Ms1LiveError`; touches nothing on disk but reads. */
  static create(settings: Ms1LiveSettings): Ms1LiveNode { return new Ms1LiveNode(settings, readCredentials(settings)) }

  /** The signed channel to the peer: preflight uses it standalone, the federation host options use the same one. */
  peerChannel(): FederationChannel { return this.channel }
  /** A home asserts that it stays awake: R1 refuses remote attempts and lead hibernation otherwise. */
  get alwaysOn(): boolean { return this.role === 'home' && this.settings.home?.alwaysOn === true }
  /** The read-only view `start()` returns. */
  view(): Ms1LiveView {
    const connections = () => ({ connection: this.connection, lead: this.leadConnection })
    return Object.freeze({
      role: this.role, identity: this.identity, peer: this.peer, model: this.model, federationPort: this.federationPort, hasLead: this.hasLead,
      get connectionId() { return connections().connection }, get leadConnectionId() { return connections().lead },
      warmState: () => this.warmState(), startWarming: () => this.startWarming(),
      attestedModel: (model: string) => this.federationHost().dispatch?.localModel?.(model) ?? null,
    })
  }
  /** The loopback port of this node's federation listener: the only port the operator forwards. */
  get federationPort(): number { return this.settings.listen.federationPort }
  get hasLead(): boolean { return this.role === 'home' && this.settings.home?.lead !== undefined }
  /** The id of the local-runtime connection a relay start names (home) or the executor serves under (executor). */
  get connectionId(): string { return this.connection }
  get leadConnectionId(): string { return this.leadConnection }
  warmState(): Ms1LiveWarmState { return this.warm }

  /** Options for the federation plugin. The plugin adds the governor and, with `localModel`, the K3 registry. */
  federationHost(): Omit<FederationHostOptions, 'db'> {
    const { link } = this.settings
    const channel = (nodeId: string) => {
      if (nodeId !== this.peer.id) throw new FederationError('wrong_executor')
      return this.channel
    }
    const runtime = this.llama?.runtime ?? undefined
    return {
      identity: this.identity, privateKey: this.#privateKey, peers: [this.peer],
      attempts: { maxReservationMs: link.maxReservationMs },
      dispatch: { ttlMs: link.holderTtlMs, safetyMs: link.safetyMs, maxModelAgeMs: link.maxModelAgeMs, channel,
        ...(runtime ? {
          relayRuntime: runtime,
          // A configuration assertion, not an observation: this node's operator attached exactly one llama-server serving exactly one
          // model, so `observedAt` is the time the assertion is made (now) and cannot go stale. What was actually served is proved
          // per call by the counted chain (the executor re-observes digest and window and re-counts before `/completion`).
          // Any other model, and every `:cloud` reference, is unknown here.
          localModel: (model: string) => normalizeOllamaModelReference(model) === this.model && !/:cloud$/i.test(model) && this.connection
            ? { connectionId: this.connection, model, placement: 'installed_local' as const, source: 'ms1-live attach configuration (asserted when asked, not observed)', observedAt: Date.now() }
            : null,
        } : {}) },
    }
  }

  /** Creates (once, by name) the connections this node needs. Called after the K3 registry loads, before federation does. */
  prepare(connections: Connections): void {
    // The home's relay start looks its connection up under the local owner; the executor's dispatch runs its model call
    // under the account of the federation identity (the node that asked is a device of that account).
    const owner = this.role === 'executor' ? this.identity.accountId : OWNER
    const existing = connections.snapshot(owner).connections
    const ensure = (name: string, kind: 'local_runtime' | 'agent', create: () => { id: string }): string => {
      const found = existing.find(c => c.name === name)
      if (found) {
        if (found.kind !== kind || (kind === 'local_runtime' && !found.unattended)) throw new Ms1LiveError('connection_conflict', name)
        return found.id
      }
      return create().id
    }
    this.connection = ensure(MS1_EXECUTOR_CONNECTION, 'local_runtime', () => {
      try { return connections.create(owner, { name: MS1_EXECUTOR_CONNECTION, kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true }) } catch (error) {
        // The relay's connection must be unattended; a connections policy that forbids it cannot serve this pairing.
        if ((error as { code?: string } | null)?.code === 'policy_denied') throw new Ms1LiveError('unattended_unavailable', 'connectionsPolicy')
        throw error
      }
    })
    // This connection exists for relay calls, which always carry a transport (the remote session, or the attached server). A call
    // without one would be answered by this node's own Ollama, which the pairing exists to avoid: a native agent or a chat that
    // picked the connection by name must be refused, not served silently from the wrong machine.
    const guarded = this.connection
    const localChat = connections.localChat.bind(connections)
    connections.localChat = (accountId, id, request, call) => id === guarded && !call.transport
      ? Promise.reject(new ConnectionError('policy_denied', 'This connection serves relay calls on the executor only'))
      : localChat(accountId, id, request, call)
    if (this.hasLead) {
      this.leadConnection = ensure(MS1_LEAD_CONNECTION, 'agent', () =>
        connections.create(owner, { name: MS1_LEAD_CONNECTION, kind: 'agent', provider: 'claude-code' as 'codex', auth: 'cli_login' }))
    }
  }

  /** Home: relay inference on the executor, through the existing relay plugin host. */
  homeRelay(federation: Federation, runs: RunStore, dataDir: string): Ms1LiveHomeRelay {
    const home = this.settings.home
    if (this.role !== 'home' || !home) throw new Ms1LiveError('role_mismatch', 'role')
    const remote = new RemoteRelayRuntime({ federation, runs, executorNodeId: this.peer.id, model: this.settings.model,
      ...(home.callDeadlineMs ? { callDeadlineMs: home.callDeadlineMs } : {}),
      ...(home.reservationMs ? { reservationMs: home.reservationMs } : {}), ...(home.pollMs ? { pollMs: home.pollMs } : {}) })
    const allocator = new OwnedCheckoutAllocator({ root: home.checkoutRoot ?? join(dataDir, 'relay-checkouts') })
    return { runtime: Object.freeze({ maximumAgeMs: home.maximumAgeMs, observer: remote }), reserves: Object.freeze({ ...home.reserves }), allocate: allocator.allocate,
      limits: Object.freeze({ structuredOutput: home.structuredOutput }) }
  }

  /** Home: the judge of each relay start, from `home.judge`; undefined (no judge) when the section is absent.
   *
   * Signals are read from the relay ledger (J0/J1; what the ledger cannot see is published as unknown). The cascade is J2 only, on the
   * relay's own connection and the served model: the executor serves one model, so a J3 on another cannot be attested. Its brief is
   * built here from the start itself (plan, caps, observed window, `home.reserves`), the one document that binds exactly this start;
   * a lead's own delegation brief is not consulted. A sample that cannot fit the observed window refuses the start, loudly. */
  judgeSource(): RelayStartJudgeSource | undefined {
    const home = this.settings.home, judge = home?.judge
    if (this.role !== 'home' || !home || !judge) return undefined
    return (context: Readonly<RelayStartJudgeContext>) => ({
      signals: ledgerJudgeInput(judge.signals, context.clock),
      ...(judge.cascade ? { cascade: {
        brief: this.judgeBrief(context, judge.cascade, home.reserves),
        model: relayJudgeModel(context, { accountId: OWNER, maxAgeMs: home.maximumAgeMs, sampleTimeoutMs: judge.cascade.sampleTimeoutMs }),
      } } : {}),
    })
  }
  private judgeBrief(context: Readonly<RelayStartJudgeContext>, cascade: NonNullable<Ms1LiveJudge['cascade']>, reserves: Reserves): RelayDelegationBrief {
    const window = context.runtime.fact.contextTokens, { input } = context
    if (cascade.maxInputTokens + cascade.maxOutputTokens > window) throw new Ms1LiveError('judge_exceeds_window', 'home.judge.cascade')
    return {
      version: 1, objective: input.plan.goal, definitionOfDone: ['every plan item passes its acceptance command'], plan: structuredClone(input.plan),
      estimatesMs: Object.fromEntries(input.plan.items.map(item => [item.id, cascade.estimateMs])),
      identity: { accountId: OWNER, homeNodeId: this.identity.id, executorNodeId: this.peer.id },
      constraints: { roots: [...context.policy.project.roots], commands: input.plan.items.map(item => item.acceptance.join(' ')), network: 'none',
        protectedPaths: [...input.plan.protectedPaths], localOnly: true },
      resources: { windowTokens: window, keepAlive: 'the executor llama-server stays resident', reserves: { ...reserves } },
      caps: { ...input.caps },
      roles: { executor: { connectionId: input.connectionId, model: input.model },
        j2: { connectionId: input.connectionId, model: input.model, windowTokens: window, maxInputTokens: cascade.maxInputTokens, maxOutputTokens: cascade.maxOutputTokens,
          temperature: 0, tokenReserve: cascade.maxInputTokens + cascade.maxOutputTokens, moneyReserveMicros: 0, sampleTimeoutMs: cascade.sampleTimeoutMs },
        j3: null, fallbacks: [], onQuotaLow: 'stop' },
      judges: { samples: cascade.samples, checker: null,
        j3: { enabled: false, maxCallsPerRun: 0, maxCallsPerNight: 0, override: null, tokenCapPerNight: 0, moneyCapPerNightMicros: 0 } },
      wake: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, nightStartsHour: 20, completionHour: 8, completion: 'defer', failure: 'immediate' },
      report: { format: 'ms1-live', evidenceRefs: [] },
    }
  }

  /** Home: the K5 installation and the lead service options, from the owner's configuration alone. */
  leadWiring(): Ms1LiveLeadWiring | null {
    const lead = this.settings.home?.lead
    if (!lead || this.role !== 'home') return null
    const allowed = this.connection, model = this.model
    return {
      externalAgents: { nodeId: this.identity.id, ...(lead.runDeadlineMs ? { runDeadlineMs: lead.runDeadlineMs } : {}),
        installations: [{ adapter: 'claude-code', connectionId: this.leadConnection, ownerAccountId: OWNER, nodeId: this.identity.id,
          billingAccount: lead.billingAccount, executable: lead.bridge, version: lead.bridgeVersion, claudeExecutable: lead.claudeExecutable }] },
      leads: { alwaysOn: true,
        relay: { consent: 'full-access', domains: lead.domains, ...(lead.pollMs ? { pollMs: lead.pollMs } : {}) },
        // The only executor a lead may name is the one this pairing serves: one connection, one model.
        validateExecutor: executor => {
          if (executor.connectionId !== allowed || normalizeOllamaModelReference(executor.model) !== model) {
            throw Object.assign(new Error('executor_not_allowed'), { code: 'executor_not_allowed' })
          }
        },
        limits: { maxCaps: { ...lead.limits.maxCaps }, maxDeadlineMs: lead.limits.maxDeadlineMs, allowDetach: lead.limits.allowDetach } },
    }
  }

  /** Executor: hash the GGUF and prove the template round trip now, so the first relay start does not pay minutes of hashing
   * inside its freshness window. Reported, never required: a later request re-observes anyway. Idempotent; resolves when settled. */
  startWarming(): Promise<Ms1LiveWarmState> {
    const runtime = this.llama?.runtime
    if (!runtime || this.closed) return Promise.resolve(this.warm)
    this.warming ??= (async () => {
      try {
        const seen = await runtime.observe(this.model, this.lifetime.signal)
        this.warm = { state: 'ready', observedAt: seen.observedAt }
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : 'runtime_meter_unavailable'
        this.warm = { state: 'unavailable', code }
      }
      return this.warm
    })()
    return this.warming
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort()
    // The runtime's own lifetime is what stops a model-file hash in progress, so it is closed first, not after waiting for the hash.
    await Promise.allSettled([this.llama?.close(), this.warming])
  }
}
