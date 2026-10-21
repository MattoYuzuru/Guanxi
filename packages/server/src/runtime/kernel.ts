/**
 * The server's kernel node. K1 loads the Resource Governor and the Ollama
 * adapter as plugins; K2 adds the egress scrubber and, once the host has
 * opened the node database, the session log. The legacy application context
 * consumes their services.
 */
import type { ProfileLayer } from '@guanxi/kernel'
import { bootNode, type NodeKernel } from '@guanxi/kernel/node'
import { egressScrubberPlugin } from '../egress/plugin.ts'
import { EGRESS_SCRUBBER_SERVICE, type EgressScrubber } from '../egress/types.ts'
import { OLLAMA_ADAPTER_SERVICE, ollamaAdapterPlugin, type OllamaAdapter } from '../ollama/plugin.ts'
import type { SessionLog, SessionLogOptions } from '../session-log/log.ts'
import { SESSION_LOG_PLUGIN_ID, SESSION_LOG_SERVICE, createSessionLogPlugin } from '../session-log/plugin.ts'
import { createDurableRunsPlugin, DURABLE_RUNS_PLUGIN_ID, DURABLE_RUNS_SERVICE, type DurableRunsService } from '../runs/plugin.ts'
import type { RunStoreOptions } from '../runs/store.ts'
import { createFederationPlugin, FEDERATION_PLUGIN_ID, FEDERATION_SERVICE, type FederationHostOptions } from '../federation/plugin.ts'
import type { Federation } from '../federation/service.ts'
import type { Db } from '../store/db.ts'
import { RESOURCE_GOVERNOR_SERVICE, resourceGovernorPlugin } from './governor-plugin.ts'
import type { ResourceGovernor } from './resource-governor.ts'

export const LEGACY_SERVER_PROFILE: ProfileLayer = Object.freeze({
  name: 'profile:legacy-server',
  insert: [
    { id: 'resource-governor', plugin: resourceGovernorPlugin.manifest.id },
    { id: 'ollama', plugin: ollamaAdapterPlugin.manifest.id },
    { id: 'egress-scrubber', plugin: egressScrubberPlugin.manifest.id, config: { expectedSources: ['vault'] } },
  ],
})

/** Added when the host passes the node database. */
export const SESSION_LOG_LAYER: ProfileLayer = Object.freeze({
  name: 'profile:session-log',
  insert: [{ id: 'session-log', plugin: SESSION_LOG_PLUGIN_ID }],
})

export interface ServerKernel {
  readonly node: NodeKernel
  readonly governor: ResourceGovernor
  readonly ollama: OllamaAdapter
  readonly scrubber: EgressScrubber
  /** Present when the kernel was booted with the node database. */
  readonly sessionLog: SessionLog | null
  readonly federation: Federation | null
  readonly durableRuns: DurableRunsService | null
}

export interface ServerKernelOptions {
  /** The node database; with it the kernel also loads the session log. */
  db?: Db
  federation?: Omit<FederationHostOptions, 'db'>
  runs?: Omit<RunStoreOptions, 'db' | 'log' | 'scrubber'> & { tickMs?: number }
  sessionLog?: Omit<SessionLogOptions, 'db' | 'scrubber'> & { purgeIntervalMs?: number }
}

export async function bootServerKernel(
  profile: readonly ProfileLayer[] = [LEGACY_SERVER_PROFILE],
  options: ServerKernelOptions = {},
): Promise<ServerKernel> {
  const withLog = options.db !== undefined
  if (options.federation && !withLog) throw new Error('federation requires the node database')
  const layers = withLog ? [...profile, SESSION_LOG_LAYER, { name: 'profile:durable-runs',
    insert: [{ id: 'durable-runs', plugin: DURABLE_RUNS_PLUGIN_ID }] }] : profile
  if (options.federation) (layers as ProfileLayer[]).push({ name: 'profile:federation', insert: [{ id: 'federation', plugin: FEDERATION_PLUGIN_ID }] })
  const node = await bootNode({
    plugins: [
      resourceGovernorPlugin,
      ollamaAdapterPlugin,
      egressScrubberPlugin,
      ...(withLog ? [createSessionLogPlugin({ ...options.sessionLog, db: options.db! }),
        createDurableRunsPlugin({ ...options.runs, db: options.db! })] : []),
      ...(options.federation ? [createFederationPlugin({ ...options.federation, db: options.db! })] : []),
    ],
    profile: layers,
    // The legacy context keeps the instances handed out below, so these rows
    // must not reload until their consumers are plugins themselves.
    pinned: layers.flatMap((layer) => layer.insert?.map((row) => row.id) ?? []),
  })
  const governor = node.service<ResourceGovernor>(RESOURCE_GOVERNOR_SERVICE)
  const ollama = node.service<OllamaAdapter>(OLLAMA_ADAPTER_SERVICE)
  const scrubber = node.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)
  const sessionLog = withLog ? node.service<SessionLog>(SESSION_LOG_SERVICE) ?? null : null
  if (!governor || !ollama || !scrubber || (withLog && !sessionLog)) {
    await node.dispose()
    throw new Error('the server kernel profile did not provide its services')
  }
  const durableRuns = withLog ? node.service<DurableRunsService>(DURABLE_RUNS_SERVICE) ?? null : null
  return { node, governor, ollama, scrubber, sessionLog, durableRuns,
    federation: options.federation ? node.service<Federation>(FEDERATION_SERVICE) ?? null : null }
}
