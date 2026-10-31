import { recoverChatJobs } from './jobs/chat-recovery.ts'
import { importProviderKeysFile } from './connections/dotenv.ts'
export { importLocalProviderKeys } from './connections/import-local.ts'
import { relayPlugin, RELAY_SERVICE, type RelayConfig, type RelayService } from './relay/plugin.ts'
import { relayStartRoutes } from './relay/routes.ts'
import { RelayRuntimeSource, type RelayRuntimePolicy } from './relay/runtime.ts'
import { createOperationalRelay, type OperationalRelay, type OperationalRelayOptions } from './relay/operational.ts'
import type { RelayStartHost } from './relay/start.ts'
import { RelayError, type Reserves } from './relay/types.ts'
import { realpath } from 'node:fs/promises'
/**
 * Точка входа сервера.
 *
 * Слушает петлевой интерфейс: Ollama не имеет аутентификации, и выставлять наружу
 * что-либо, что имеет к ней доступ, нельзя. Смена адреса — осознанное действие
 * через переменную окружения, а не значение по умолчанию.
 */
import { federationRoutes } from './federation/routes.ts'
import { createFederationPlugin, FEDERATION_SERVICE, type FederationHostOptions } from './federation/plugin.ts'
import type { Federation } from './federation/service.ts'
import { FederationError } from './federation/crypto.ts'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { PRODUCT_NAME } from '@guanxi/contract'
import { createApp } from './app.ts'
import { createAppContext } from './context.ts'
import { apiPortFromEnv, dataDirFromEnv, devOriginsFromEnv, portFromEnv, WEB_PORT_ENV, DEFAULT_WEB_PORT } from './config/listen-env.ts'
import { defaultDbPath, openDb } from './store/db.ts'
import { bootServerKernel } from './runtime/kernel.ts'
import { UiCatalogReviewService } from './ui-catalog/service.ts'
import { approvalSignerPath, helperSigner } from './ui-catalog/signer.ts'
import { findSourceCheckoutUiRoot } from './ui-catalog/source-checkout.ts'
import { RELEASE_BUILD } from './release.ts'

import { connectionsPlugin, CONNECTIONS_SERVICE } from './connections/plugin.ts'
import type { VaultPolicy } from './vault/vault.ts'
import type { Connections } from './connections/service.ts'
import { ConnectionError } from './connections/errors.ts'
import { connectionRoutes } from './connections/routes.ts'
import type { IndexSettings } from './indexing/types.ts'
import { projectIndexPlugin } from './indexing/plugin.ts'
import { nativeAgentPlugin, NATIVE_AGENT_SERVICE, type NativeAgentService } from './native-agent/plugin.ts'
import { nativeAgentRoutes } from './native-agent/routes.ts'
import { externalAgentPlugin } from './external-agents/plugin.ts'
import { createLeadPlugin, type LeadPluginConfig } from './leads/plugin.ts'
import { relayStartsChildReporter, relayStartsChildStarter } from './leads/children.ts'
import type { ChildStarter } from './leads/types.ts'
import { DURABLE_RUNS_SERVICE, type DurableRunsService } from './runs/plugin.ts'
import { LOCAL_ACCOUNT_ID } from './http/local-guard.ts'
import { notificationsPlugin, NOTIFICATIONS_SERVICE } from './notifications/plugin.ts'
import type { NotificationInbox } from './notifications/inbox.ts'
import { notificationRoutes } from './notifications/routes.ts'
import type { DeliverySettings } from './notifications/delivery.ts'
import { createDefaultCommandRunner, createOsNotifier, type CommandRunner } from './notifications/os-adapter.ts'
import { voicePlugin, VOICE_SERVICE, type VoiceGlossary } from './voice/plugin.ts'
import { glossaryRoutes } from './voice/routes.ts'
import { workPlugin, WORK_SERVICE } from './work/plugin.ts'
import type { WorkLedger } from './work/ledger.ts'
import { workRoutes } from './work/routes.ts'
import type { ExternalPolicy } from './external-agents/types.ts'
import { Ms1LiveNode, type Ms1LiveHomeRelay } from './ms1-live/boot.ts'
import { federationListener } from './ms1-live/listener.ts'
import { Ms1LiveError, type Ms1LiveSettings } from './ms1-live/config.ts'
import { runBoundedStop } from './ms1-live/stop.ts'

export { RELEASE_BUILD } from './release.ts'
export { JobStore, JobStoreError } from './store/jobs.ts'
export { QuickRunStore } from './store/quick-runs.ts'
export { RecipeStore } from './store/recipes.ts'
export { ArtifactStore, ArtifactStoreError } from './store/artifacts.ts'
export type {
  ArtifactDownloadHeaders,
  ArtifactOrphanInventory,
  ArtifactReadOptions,
  ArtifactStoreErrorCode,
  ArtifactStoreHooks,
  ArtifactStoreOptions,
  ArtifactWriteOptions,
} from './store/artifacts.ts'
export { JobService, JobServiceError } from './jobs/service.ts'
export {
  RESOURCE_GOVERNOR_CLOSE_REASON,
  SINGLE_PERMIT_POLICY_BASIS,
  ResourceGovernor,
  ResourceGovernorError,
  operationOwner,
} from './runtime/resource-governor.ts'
export { RESOURCE_GOVERNOR_SERVICE, resourceGovernorPlugin } from './runtime/governor-plugin.ts'
export { OLLAMA_ADAPTER_SERVICE, ollamaAdapterPlugin } from './ollama/plugin.ts'
export type { OllamaAdapter, OllamaAdapterConfig } from './ollama/plugin.ts'
export { LEGACY_SERVER_PROFILE, SESSION_LOG_LAYER, bootServerKernel } from './runtime/kernel.ts'
export type { ServerKernel, ServerKernelOptions } from './runtime/kernel.ts'
export * from './egress/index.ts'
export * from './session-log/index.ts'
export type {
  AdmissionExplanation,
  AdmissionPriority,
  AdmissionRequest,
  AdmissionTicket,
  AdmissionTicketState,
  GovernorDecisionCode,
  ModelResourceRequest,
  ResourceGovernorSnapshot,
  ResourceLease,
  ResourceOperation,
  ResourceOwner,
} from './runtime/resource-governor.ts'
export {
  CHAT_JOB_OPERATION,
  CHAT_OUTPUT_CHUNK_BYTES,
  ChatJobExecutionOwner,
  chatIdempotencyScope,
  chatRequestFingerprint,
} from './jobs/chat-execution.ts'
export {
  ChatRecoveryError,
  DEFAULT_CHAT_RECOVERY_OUTPUT_PAGE_SIZE,
  DEFAULT_CHAT_RECOVERY_SCAN_PAGE_SIZE,
  reconcileLostChatExecution,
  recoverChatJobs,
} from './jobs/chat-recovery.ts'
export type {
  ChatRecoveryCheckpoint,
  ChatRecoveryOptions,
  ChatRecoveryReport,
} from './jobs/chat-recovery.ts'
export type { JobServiceErrorCode, JobServiceOptions } from './jobs/service.ts'
export { PUBLIC_JOB_IDEMPOTENCY_SCOPE } from './http/jobs-routes.ts'
export type {
  AppendJobEventInput,
  ChatJobAssociation,
  CreateChatJobInput,
  CreateChatJobResult,
  CreateJobInput,
  CreateJobResult,
  JobStoreErrorCode,
  TerminalizeJobInput,
  TerminalizeChatJobInput,
  TerminalizeJobResult,
  TransitionJobInput,
  TransitionJobResult,
} from './store/jobs.ts'

const APP_VERSION = '0.1.0'

export const DEFAULT_PORT = 4310

const here = dirname(fileURLToPath(import.meta.url))

/** Bound of one `ms1-live` executor stop: the process either closes cleanly inside it or exits non-zero with
 * `{"event":"stop","forced":true}`. Named policy, not a per-run guess; the home role is unbounded. */
export const MS1_LIVE_STOP_BOUND_MS = 10_000

/** The forced bound is an executor policy. A home must abort its relay, settle pins and reap detached Claude Code
 * process groups, so its close stays unbounded. A plain caller may still ask for a bound. */
export function stopBoundMsFor(role: 'home' | 'executor' | undefined, requested: number | undefined): number | undefined {
  if (role === 'home') return undefined
  if (role === 'executor') return requested ?? MS1_LIVE_STOP_BOUND_MS
  return requested
}

export interface StartOptions {
  port?: number
  host?: string
  dataDir?: string
  /** Директория со сборкой фронта. По умолчанию ищется рядом с пакетом. */
  webDir?: string
  devOrigins?: string[]
  providerKeysFile?: string
  /** Test seam: the wrapping-key source of the K3 vault, in place of the OS keychain. */
  connectionsKeychain?: () => Promise<import('./vault/keychain.ts').VaultKeychain>
  connectionsPolicy?: VaultPolicy
  indexSettings?: Partial<IndexSettings>
  federation?: Omit<FederationHostOptions, 'db'>
  /** Trusted node-local installed CLIs; no executable paths or account identity arrive over HTTP. */
  externalAgents?: ExternalPolicy
  /** T0-only proved runtime counter and owned-checkout adapter; neither comes from HTTP. */
  relay?: { runtime: RelayRuntimePolicy; reserves: Reserves; allocate?: RelayStartHost['allocate'] }
  /** Trusted opt-in for external-lead delegation and hibernation (LW). Needs `externalAgents` and a child
   * executor. `alwaysOn: true` is the host's explicit assertion that this node stays awake while leads
   * sleep (ADR-0019 decision 5); nothing here proves or arranges power. Not reachable over HTTP. */
  leads?: Omit<LeadPluginConfig, 'db' | 'child' | 'projectView'> & { alwaysOn: true;
    /** The lead's read-only view of the delegated project's committed files. On by default; `false` gives the lead no project tools.
     * An object overrides the policy (`policy`) or the root resolution (`roots`). */
    projectView?: false | Partial<NonNullable<LeadPluginConfig['projectView']>> } & (
    { child: ChildStarter; relay?: undefined } |
    /** Delegated plans run through this node's public relay start; consent and domains are owner choices
     * the lead can never make for itself. */
    { child?: undefined; relay: { consent: 'full-access'; domains?: readonly string[]; pollMs?: number }; validateExecutor: NonNullable<LeadPluginConfig['validateExecutor']>; limits: NonNullable<LeadPluginConfig['limits']> })
  /** Explicit opt-in to the operational local relay (llama-server counter plus owned checkouts).
   * Mutually exclusive with `relay`; an absent binary or model keeps the stock refusals. */
  operationalRelay?: OperationalRelayOptions
  /** Extra relay start-host fields for the trusted host, merged after the ones this function derives (runtime, allocator, reserves,
   * project resolution and node ports stay owned here). It is the seam for what a relay start gains later, such as a judge source
   * (`startHost.judge`): that lane adds the field to `RelayStartHost` and every boot, including `ms1Live`, passes it through. */
  relayHost?: Partial<Omit<RelayStartHost, 'runtime' | 'allocate' | 'reserves' | 'project' | 'nodePorts'>>
  /** Extra relay plugin configuration (for example `RelayConfig.judge`), merged after `db` and `startHost`. */
  relayConfig?: Partial<Omit<RelayConfig, 'db' | 'startHost'>>
  /** Explicit opt-in to one half of the MS1 live pairing (`docs/operations/ms1-live-run.md`): a `home` node whose relay
   * inference runs on an `executor` node through F2-d, or that `executor`. Loaded and validated from the operator's
   * configuration (`loadMs1LiveConfig`); it names files and loopback URLs, never a secret value. It builds the federation
   * node itself, so it excludes `federation`, `relay`, `operationalRelay`, and, when it carries a `lead` section,
   * `externalAgents` and `leads`. Without it nothing in this block runs. */
  ms1Live?: Ms1LiveSettings
  /** Bounded stop: after `boundMs` a still-running close emits one `forced` line and exits non-zero. An `ms1-live`
   * executor defaults to `MS1_LIVE_STOP_BOUND_MS`; a home role ignores the bound. The default forced writer is the JSON
   * line on stdout, never prompt or key material. */
  shutdown?: { boundMs?: number; forced?: (event: { event: 'stop'; forced: true }) => void }
  /**
   * Explicit opt-in to OS notification delivery. Off by default: without it ingestion writes
   * notification rows only. `runner`, `platform` and `resolveBinary` are host/test seams; the
   * production defaults are the current platform and the `execFile` runner.
   */
  notificationDelivery?: {
    os: boolean
    runner?: CommandRunner
    platform?: NodeJS.Platform
    resolveBinary?: (name: string) => string | null
  }
}

/** PATH lookup with no shell; the adapter still validates the returned absolute path. */
function resolveNotificationBinary(name: string): string | null {
  for (const directory of (process.env['PATH'] ?? '').split(':')) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (!isAbsolute(candidate)) continue
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return null
}

/** No settings persistence/UI yet: the boot default enables the in-app row and the OS channel. */
function defaultNotificationDeliverySettings(): DeliverySettings {
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    channelsByKind: {},
    defaults: ['in_app', 'os'],
    quietHours: null,
    criticalBypassesQuietHours: false,
    mutedKinds: [],
  }
}

/** Grace an open response gets to finish after `server.close()`, before its connection is dropped. The stop bound is
 * larger: this is the polite part of closing one listener, not the whole shutdown. */
const LISTENER_DRAIN_GRACE_MS = 1_500

/** `server.close()` stops accepting and drops idle connections at once. Only an MS1 live listener force-drops whatever is
 * still active after the grace; the plain dev server keeps waiting for its open responses. */
function drainListener(server: ReturnType<typeof serve> | undefined, force = false): Promise<void> {
  if (!server) return Promise.resolve()
  const closed = new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
  const connections = server as unknown as { closeIdleConnections?: () => void; closeAllConnections?: () => void }
  connections.closeIdleConnections?.()
  const timer = force ? setTimeout(() => connections.closeAllConnections?.(), LISTENER_DRAIN_GRACE_MS) : undefined
  return closed.finally(() => { if (timer) clearTimeout(timer) })
}

export async function start(options: StartOptions = {}) {
  if (options.leads && !options.externalAgents) throw new Error('leads require externalAgents')
  if (options.leads && !options.leads.child && !options.leads.relay) throw new Error('leads require a child executor')
  // Plan acceptance commands written by a lead run as relay gates under the owner's consent: the owner's policy must name
  // which executors a lead may use.
  if (options.leads?.relay && !options.leads.validateExecutor) throw new Error('leads.relay requires validateExecutor')
  // An uncapped Full-access relay run must never be the lead's choice: the owner's ceilings are mandatory with the relay.
  if (options.leads?.relay && !options.leads.limits) throw new Error('leads.relay requires limits')
  if (options.relay && options.operationalRelay) throw new RelayError('relay_policy_invalid')
  // MS1 live mode: validated and paired before any file, database or listener exists. A bad configuration, key or option
  // mix is a boot error, never a node that silently runs without its pairing.
  if (options.ms1Live && (options.federation || options.relay || options.operationalRelay)) throw new Ms1LiveError('option_conflict', 'federation|relay|operationalRelay')
  const live = options.ms1Live ? Ms1LiveNode.create(options.ms1Live) : null
  const refuseLive = async (code: string, field: string): Promise<never> => { await live?.close(); throw new Ms1LiveError(code, field) }
  if (live?.hasLead && (options.externalAgents || options.leads)) await refuseLive('option_conflict', 'externalAgents|leads')
  const port = options.port ?? apiPortFromEnv(process.env, live?.settings.listen.port ?? DEFAULT_PORT)
  let actualPort = port
  const host = options.host ?? process.env['HOST'] ?? '127.0.0.1'
  // The pairing's only link is a loopback port forward: the node never listens elsewhere in this mode.
  if (live && host !== '127.0.0.1') await refuseLive('listen_not_loopback', 'host')
  if (live && port === live.federationPort) await refuseLive('ports_collide', 'listen')
  // A live node holds keys, pins and relay ledgers: it lives beside its configuration unless told otherwise, and never in the owner's
  // default data directory, which a lane or a rehearsal could otherwise share with a real node by accident.
  const dataDir = options.dataDir ?? (live && !process.env['GUANXI_DATA_DIR'] ? join(dirname(live.settings.file), 'data') : dataDirFromEnv(process.env))
  if (live && [join(process.env['HOME'] ?? homedir(), '.guanxi'), join(homedir(), '.guanxi')].includes(resolve(dataDir))) await refuseLive('data_dir_default', 'dataDir')

  // The governor, the Ollama adapter (K1), the egress scrubber and the session
  // log (K2) run as kernel plugins; the legacy context consumes their services.
  // The database opens first because the session log plugin is bound to it.
  const dbPath = defaultDbPath(dataDir)
  let db: ReturnType<typeof openDb>
  try { db = openDb(dbPath) } catch (error) { await live?.close(); throw error }
  let kernel: Awaited<ReturnType<typeof bootServerKernel>>
  try {
    kernel = await bootServerKernel(undefined, { db, federation: options.federation, ...(options.leads || live?.alwaysOn ? { runs: { alwaysOn: true } } : {}) })
  } catch (error) {
    db.close()
    await live?.close()
    throw error
  }
  let context: Awaited<ReturnType<typeof createAppContext>>
  try {
    context = await createAppContext({
      dbPath,
      db,
      deferChatRecovery: true,
      appVersion: APP_VERSION,
      connections: () => {
        const service = kernel.node.service<Connections>(CONNECTIONS_SERVICE)
        if (!service) throw new ConnectionError('egress_unavailable', 'Connections unavailable')
        return service
      },
      governor: kernel.governor,
      ollama: kernel.ollama,
      sessionLog: kernel.sessionLog ?? undefined,
    })
  } catch (error) {
    await kernel.node.dispose().catch(() => undefined)
    db.close()
    await live?.close()
    throw error
  }

  // D-138: approvals are written only from a source checkout and never by a release build.
  const uiCatalog = new UiCatalogReviewService({
    uiRoot: RELEASE_BUILD ? null : findSourceCheckoutUiRoot(here),
    release: RELEASE_BUILD,
    signer: helperSigner({ helperPath: approvalSignerPath() }),
  })

  let operationalRelay: OperationalRelay | null = null
  let liveRelay: Ms1LiveHomeRelay | null = null
  let externalAgents = options.externalAgents, leads = options.leads
  try {
    await kernel.node.plugin(connectionsPlugin, {
      databasePath: join(dirname(defaultDbPath(dataDir)), 'connections.sqlite'),
      ...(options.connectionsKeychain ? { keychain: options.connectionsKeychain } : {}),
      localHost: () => context.settings.get().ollamaHost,
      // Unattended relay calls are the point of the live pairing; K3 still needs each connection's own consent.
      policy: options.connectionsPolicy ?? (live ? { ownerDevice: true, nodeKeyOptIn: true } : undefined),
    })
    // An explicit option and `GUANXI_PROVIDER_KEYS_FILE` come first; an MS1 API-key lead's own file is the fallback.
    // An explicit option (even an empty one: none) replaces the process environment; the live configuration's file is the last resort.
    const providerKeysFile = (options.providerKeysFile ?? process.env.GUANXI_PROVIDER_KEYS_FILE) || live?.providerKeysFile
    let providerKeysFailed = false, leadKeyImported: string | undefined
    if (providerKeysFile) {
      try {
        const result = await importProviderKeysFile(context.connections!(), 'local', providerKeysFile, { oauthToken: live?.leadUsesToken === true })
        leadKeyImported = result.imported.find(item => item.provider === live?.leadKeyProvider)?.connectionId
        if (result.errors?.length) throw new Error('provider_key_import_failed')
      } catch {
        providerKeysFailed = true
        context.connections!().lockVault('local')
        console.warn('provider_key_import_failed')
      }
    }
    await recoverChatJobs(context)
    await kernel.node.plugin(projectIndexPlugin, { dataDir: dirname(dbPath), settings: options.indexSettings })
    await kernel.node.plugin(nativeAgentPlugin, { db, host: context, dataDir: dirname(dbPath), nodePorts: () => [actualPort, portFromEnv(process.env, WEB_PORT_ENV, DEFAULT_WEB_PORT)] })
    operationalRelay = options.operationalRelay ? createOperationalRelay(options.operationalRelay, dirname(dbPath)) : null
    if (live) {
      // The federation node loads here, not at kernel boot: an executor's dispatch needs the K3 registry (a local-runtime
      // connection) and a home's relay runtime needs the federation service. Plugin order changes only under this option.
      // An API-key lead needs a key it was actually given: a failed import, or a named file without ANTHROPIC_API_KEY, never falls back to an
      // older key in the vault (only the absence of any file does: the key is then the one imported earlier).
      if (live.leadUsesVaultKey) {
        if (providerKeysFailed) throw new Ms1LiveError('lead_key_import_failed', 'home.lead.providerKeysFile')
        if (providerKeysFile && leadKeyImported === undefined) throw new Ms1LiveError('lead_key_missing', 'home.lead.providerKeysFile')
      }
      live.prepare(kernel.node.service<Connections>(CONNECTIONS_SERVICE)!)
      if (live.leadUsesVaultKey) await live.prepareLeadKey(kernel.node.service<Connections>(CONNECTIONS_SERVICE)!, leadKeyImported)
      await kernel.node.plugin(createFederationPlugin({ ...live.federationHost(), db }))
      kernel = { ...kernel, federation: kernel.node.service<Federation>(FEDERATION_SERVICE) ?? null }
      if (!kernel.federation) throw new FederationError('federation_unavailable', 503)
      if (live.role === 'home') liveRelay = live.homeRelay(kernel.federation, kernel.node.service<DurableRunsService>(DURABLE_RUNS_SERVICE)!.store, dirname(dbPath))
      const wiring = live.leadWiring()
      if (wiring) { externalAgents = wiring.externalAgents; leads = wiring.leads }
    }
    // One resolution of a project to its source roots: the relay start clones from it and the lead's read-only project view reads from it.
    const observeProject: RelayStartHost['project'] = async (id, signal) => {
      signal.throwIfAborted()
      const project = kernel.node.service<NativeAgentService>(NATIVE_AGENT_SERVICE)!.projects().find(p => p.id === id)
      if (!project) throw new RelayError('relay_project_unavailable')
      const roots = await Promise.all(project.filesystemBindings.map(async binding => {
        const workspace = context.workspaces.get(binding.workspaceId)
        if (!workspace) throw new RelayError('relay_project_unavailable')
        return realpath(workspace.rootPath)
      }))
      signal.throwIfAborted()
      return { projectId: id, roots, source: 'native-project-roots+workspace-store', observedAt: Date.now() }
    }
    const relayOptions = options.relay ?? operationalRelay?.relay ?? liveRelay ?? undefined
    // `relayHost` is typed without the fields start owns, but a JavaScript caller is not held to types.
    const { runtime: _r, allocate: _a, reserves: _v, project: _p, nodePorts: _n, ...hostExtras } = (options.relayHost ?? {}) as Record<string, unknown>
    await kernel.node.plugin(relayPlugin, { ...options.relayConfig, db, startHost: {
      // The pairing's judge (`home.judge`) is the default; a `relayHost.judge` given by the caller replaces it.
      ...(live?.judgeSource() ? { judge: live.judgeSource() } : {}),
      ...hostExtras,
      // The pairing's relay limits (`home.structuredOutput`) are the default; a `relayHost.limits` given by the caller overrides them field by field.
      ...(liveRelay?.limits ? { limits: { ...liveRelay.limits, ...(hostExtras.limits as object | undefined) } } : {}),
      ...(relayOptions ? { reserves: relayOptions.reserves, allocate: relayOptions.allocate,
        // A runtime that binds per start (F2-d) has an observer with `open` instead of a counter. In live mode there is no
        // local fallback at all: the model inventory callback refuses, so a stale remote can never become an Ollama call.
        ...(relayOptions.runtime.counter || relayOptions.runtime.observer?.open ? { runtime: new RelayRuntimeSource(kernel.node.service<Connections>(CONNECTIONS_SERVICE)!,
          live ? () => { throw new RelayError('runtime_meter_unavailable') } : () => context.models(), relayOptions.runtime) } : {}) } : {}),
      nodePorts: () => [actualPort, portFromEnv(process.env, WEB_PORT_ENV, DEFAULT_WEB_PORT)],
      project: observeProject,
    } })
    // MS2: three independent sidecars. Loading opens a database and starts nothing else.
    // A damaged sidecar disables only its own feature: its service stays unregistered and its routes
    // answer 503 `*_unavailable`; chat, models and every other route keep working.
    const sidecar = (name: string) => join(dirname(dbPath), name)
    const optional = async (name: string, load: () => Promise<unknown>) => {
      try { await load() } catch (error) {
        process.stderr.write(`guanxi: ${name} sidecar unavailable (${error instanceof Error ? error.name : 'error'})\n`)
      }
    }
    const deliveryOption = options.notificationDelivery
    const notificationDelivery = deliveryOption?.os === true
      ? {
          settings: () => defaultNotificationDeliverySettings(),
          os: createOsNotifier({
            platform: deliveryOption.platform ?? process.platform,
            runner: deliveryOption.runner ?? createDefaultCommandRunner(),
            appName: PRODUCT_NAME,
            resolveBinary: deliveryOption.resolveBinary ?? resolveNotificationBinary,
          }),
        }
      : undefined
    await optional('notifications', () => kernel.node.plugin(notificationsPlugin, {
      databasePath: sidecar('notifications.sqlite'),
      ...(notificationDelivery === undefined ? {} : { delivery: notificationDelivery }),
    }))
    await optional('voice', () => kernel.node.plugin(voicePlugin, { databasePath: sidecar('voice.sqlite') }))
    await optional('work', () => kernel.node.plugin(workPlugin, { databasePath: sidecar('work.sqlite') }))
    if (externalAgents) await kernel.node.plugin(externalAgentPlugin, { dataDir: dirname(dbPath), policy: externalAgents })
    if (leads) {
      const { alwaysOn: _assertion, relay: relayPolicy, child, projectView, ...lead } = leads
      const relayService = kernel.node.service<RelayService>(RELAY_SERVICE)
      const runs = kernel.node.service<DurableRunsService>(DURABLE_RUNS_SERVICE)
      if (relayPolicy && (!relayService || !runs)) throw new Error('leads.relay requires the relay service')
      await kernel.node.plugin(createLeadPlugin({ ...lead, db,
        // The lead reads the project it delegates through the node (read-only, committed files); `projectView: false` turns it off.
        ...(projectView === false ? {} : { projectView: { roots: async (id, signal) => (await observeProject(id, signal)).roots, ...projectView } }),
        child: child ?? relayStartsChildStarter(relayService!.publicStarts, { ...relayPolicy!, runs: runs!.store }),
        ...(lead.reporter || !relayPolicy ? {} : { reporter: relayStartsChildReporter(relayService!.publicStarts, relayService!, kernel.sessionLog ?? undefined) }) }))
    }
  } catch (error) {
    await context.maintenance?.close().catch(() => undefined)
    await context.chatExecution.shutdown().catch(() => undefined)
    context.jobService.closeSubscriptions()
    await kernel.node.dispose().catch(() => undefined)
    await operationalRelay?.close().catch(() => undefined)
    await live?.close().catch(() => undefined)
    context.db.close()
    throw error
  }
  const server = createApp(context, {
    host, port: () => actualPort,
    devOrigins: options.devOrigins ?? devOriginsFromEnv(process.env),
    uiCatalog,
    layouts: options.federation ? () => {
      const federation = kernel.node.service<Federation>(FEDERATION_SERVICE)
      if (!federation) throw new FederationError('federation_unavailable', 503)
      return federation.layouts
    } : undefined,
  })

  server.route('/api/connections', connectionRoutes(() => {
    const service = kernel.node.service<Connections>(CONNECTIONS_SERVICE)
    if (!service) throw new ConnectionError('egress_unavailable', 'Connections unavailable')
    return service
  }, 'local', options.devOrigins ?? devOriginsFromEnv(process.env)))
  server.route('/api/agent', nativeAgentRoutes(() => {
    const service = kernel.node.service<NativeAgentService>(NATIVE_AGENT_SERVICE)
    if (!service) throw new Error('agent_unavailable')
    return service
  }, options.devOrigins ?? devOriginsFromEnv(process.env)))
  server.route('/api/relay', relayStartRoutes(() => {
    const service = kernel.node.service<RelayService>(RELAY_SERVICE)
    if (!service) throw new RelayError('relay_closed')
    return service.publicStarts
  }, options.devOrigins ?? devOriginsFromEnv(process.env)))

  const localOrigins = options.devOrigins ?? devOriginsFromEnv(process.env)
  server.route('/api/notifications', notificationRoutes(
    () => kernel.node.service<NotificationInbox>(NOTIFICATIONS_SERVICE), LOCAL_ACCOUNT_ID, localOrigins))
  server.route('/api/voice/glossary', glossaryRoutes(
    () => kernel.node.service<VoiceGlossary>(VOICE_SERVICE), LOCAL_ACCOUNT_ID, localOrigins))
  server.route('/api/work', workRoutes(
    () => kernel.node.service<WorkLedger>(WORK_SERVICE), LOCAL_ACCOUNT_ID, localOrigins))

  if (options.federation) server.route('/api/federation', federationRoutes(() => {
    const service = kernel.node.service<Federation>(FEDERATION_SERVICE)
    if (!service) throw new FederationError('federation_unavailable', 503)
    return service
  }))

  // Неизвестный API-путь не должен проваливаться в SPA и возвращать HTML.
  server.all('/api/*', (c) =>
    c.json({ code: 'internal_error', message: 'API-маршрут не найден', details: null }, 404),
  )

  mountWeb(server, options.webDir ?? resolve(here, '../../web/dist'))

  const abortStart = async () => {
    await context.maintenance?.close().catch(() => undefined)
    await context.chatExecution.shutdown().catch(() => undefined)
    context.jobService.closeSubscriptions()
    context.sessionLog?.closeSubscriptions()
    await kernel.node.dispose().catch(() => undefined)
    await operationalRelay?.close().catch(() => undefined)
    await live?.close().catch(() => undefined)
    context.db.close()
  }
  let instance!: ReturnType<typeof serve>
  try {
    actualPort = await new Promise<number>((resolvePort, reject) => {
      const onError = (error: Error) => reject(error)
      instance = serve({ fetch: server.fetch, port, hostname: host }, (address) => {
        instance.off('error', onError)
        resolvePort(address.port)
      })
      instance.once('error', onError)
    })
  } catch (error) {
    await abortStart()
    throw error
  }
  // MS1 live mode: the signed node-to-node API has its own loopback listener and nothing else. The operator's ssh forward reaches
  // this port only, so the owner API (workspaces, projects, relay starts, connections) is never reachable through the link.
  let federationInstance: ReturnType<typeof serve> | undefined
  if (live) {
    const federationServer = federationListener({ host, port: live.federationPort, federation: () => kernel.node.service<Federation>(FEDERATION_SERVICE) })
    try {
      await new Promise<void>((resolveListening, reject) => {
        const onError = (error: Error) => reject(error)
        federationInstance = serve({ fetch: federationServer.fetch, port: live.federationPort, hostname: host }, () => {
          federationInstance!.off('error', onError)
          resolveListening()
        })
        federationInstance.once('error', onError)
      })
    } catch (error) {
      instance.close()
      await abortStart()
      throw error
    }
    // After both listeners are up: an executor hashes its model now, not inside the first relay's freshness window.
    if (live.role === 'executor') void live.startWarming()
  }
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const url = `http://${browserHost}:${actualPort}`

  let closing: Promise<void> | null = null
  const federation = kernel.node.service<Federation>(FEDERATION_SERVICE)
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      // Abort executor-side dispatch holders before waiting for a listener. Their model calls are outbound and are not
      // connections of either listener; aborting here means the llama-server `/completion` fetch dies with the node
      // instead of holding the close open for the model's own deadline. A home keeps the previous order (relay first,
      // federation with the plugin): closing federation early would turn a graceful stop into a refusal and leave the
      // relay pin journaled, because `settleRelayPin` cannot delete after the federation is closed.
      if (live?.role === 'executor') federation?.attemptDispatch?.close()
      // Stop accepting commands first; existing Chat streams get the drain grace to observe their truthful
      // internal-shutdown terminal event, then `closeAllConnections()` drops whatever is left.
      const listenersClosed = Promise.all([drainListener(instance, live !== null), drainListener(federationInstance, live !== null)])
      // MS1 live: an inbound observe or count may be waiting on a model-file hash. Stopping the runtime ends that work (the request
      // is answered with a refusal).
      const liveClosing = live?.close().catch(() => undefined)
      let shutdownError: unknown = null
      try {
        await context.maintenance?.close()
      } catch (error) {
        shutdownError = error
      }
      try {
        await kernel.node.service<NativeAgentService>(NATIVE_AGENT_SERVICE)?.shutdown()
        await context.chatExecution.shutdown()
      } catch (error) {
        shutdownError ??= error
      } finally {
        context.jobService.closeSubscriptions()
        // Inspector streams are open-ended; end them so the listener can close.
        context.sessionLog?.closeSubscriptions()
        await listenersClosed
        await liveClosing
        // Unload plugins before the database they may use is closed. Each
        // plugin cleanup is bounded by the kernel's step timeout.
        try {
          await kernel.node.dispose()
        } catch (error) {
          shutdownError ??= error
        }
        // After the relay plugin aborted and settled its runs: the child must outlive their cleanup.
        await operationalRelay?.close().catch((error: unknown) => { shutdownError ??= error })
        await live?.close().catch((error: unknown) => { shutdownError ??= error })
        context.db.close()
        process.removeListener('SIGINT', shutdown)
        process.removeListener('SIGTERM', shutdown)
      }
      if (shutdownError) throw shutdownError
    })()
    return closing
  }

  // An executor is a service: a stop that cannot finish inside the bound ends as a forced exit, never as a systemd
  // SIGKILL minutes later. The home stays unbounded, and a plain `start()` keeps the old behaviour unless asked.
  const stopBoundMs = stopBoundMsFor(live?.role, options.shutdown?.boundMs)
  const forcedStop = options.shutdown?.forced ?? ((event: { event: 'stop'; forced: true }) => { process.stdout.write(JSON.stringify(event) + '\n') })
  const shutdown = () => {
    if (stopBoundMs === undefined) {
      void close().then(() => process.exit(0), () => process.exit(1))
      return
    }
    runBoundedStop(close, { boundMs: stopBoundMs, forced: () => forcedStop({ event: 'stop', forced: true }), exit: code => process.exit(code) })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  return { url, port: actualPort, host, context, kernel, close, ms1Live: live?.view() ?? null }
}

/**
 * Раздаёт production-сборку, даже если она появилась уже после запуска сервера.
 *
 * Это важно для разработки: backend часто стартует раньше первого `vite build`.
 * `serveStatic` проверяет файл на каждом запросе, поэтому после сборки не нужен
 * рестарт процесса.
 */
export function mountWeb(server: ReturnType<typeof createApp>, webDir: string): void {
  // Собранный фронт раздаётся тем же процессом: одна команда, один порт.
  const serveFiles = serveStatic({ root: webDir })
  const serveIndex = serveStatic({ path: 'index.html', root: webDir })

  server.use('/*', serveFiles)
  // Роутинг на стороне клиента: всё неизвестное отдаём в index.html.
  server.get('*', async (context, next) => {
    if (existsSync(join(webDir, 'index.html'))) {
      return serveIndex(context, next)
    }

    return context.text(
      `Guanxi ${APP_VERSION}\n\nСборка фронта не найдена (${webDir}).\n` +
        `Для разработки запусти: npm run dev:web\nAPI доступен на /api/health\n`,
    )
  })
}
