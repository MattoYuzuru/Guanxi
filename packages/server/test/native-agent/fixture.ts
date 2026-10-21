import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, realpath, symlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createKernel } from '@guanxi/kernel'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { resourceGovernorPlugin } from '../../src/runtime/governor-plugin.ts'
import { ollamaAdapterPlugin } from '../../src/ollama/plugin.ts'
import { egressScrubberPlugin } from '../../src/egress/plugin.ts'
import type { EgressScrubber } from '../../src/egress/types.ts'
import { connectionsPlugin } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { piModels } from '../../src/connections/pi.ts'
import { createSessionLogPlugin } from '../../src/session-log/plugin.ts'
import type { SessionLog } from '../../src/session-log/log.ts'
import { openDb } from '../../src/store/db.ts'
import { ProjectStore } from '../../src/store/projects.ts'
import { ProjectService } from '../../src/projects/service.ts'
import { WorkspaceStore } from '../../src/store/workspaces.ts'
import { RunStore } from '../../src/runs/store.ts'
import { NativeAgents } from '../../src/native-agent/service.ts'
import { emptyUsage } from '../../src/native-agent/model.ts'

export async function fixture(t: { after(fn: () => unknown): void }, respond?: (call: number, context: string, signal?: AbortSignal) => Promise<AssistantMessage['content']>, localFetch?: typeof fetch, nodePorts?: () => number[], commandRunner?: typeof import('../../src/native-agent/sandbox.ts').sandboxCommand, options: { directory?: string; fault?: import('../../src/runs/store.ts').RunStoreOptions['fault']; logFault?: import('../../src/session-log/log.ts').SessionLogOptions['fault']; usage?: import('@earendil-works/pi-ai').Usage; clock?: () => number } = {}) {
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const dir = options.directory ?? await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'k4-agent-')))
  const data = join(dir, 'data'); await mkdir(data)
  const db = openDb(join(data, 'test.sqlite'))
  const kernel = createKernel()
  await kernel.plugin(resourceGovernorPlugin)
  await kernel.plugin(ollamaAdapterPlugin, { fetch: localFetch ?? (async () => { throw new Error('No external network in K4 tests') }) })
  await kernel.plugin(egressScrubberPlugin, { expectedSources: ['vault'] })
  await kernel.plugin(createSessionLogPlugin({ db, fault: options.logFault }))
  const fixtureUsage = options.usage
  const requests: string[] = []
  const model = piModels('deepseek')[0]!
  let calls = 0
  await kernel.plugin(connectionsPlugin, { databasePath: join(data, 'connections.sqlite'), localHost: () => '127.0.0.1:11434',
    keychain: async () => ({ key: () => randomBytes(32) }),
    pi: { async complete(_model, context, options) {
      const serialized = JSON.stringify(context); requests.push(serialized)
      const pending = respond ? respond(++calls, serialized, options.signal) : Promise.resolve([{ type: 'text' as const, text: 'fixture answer' }])
      await options.onResponse?.({ status: 200, headers: {} }, _model)
      let cancel!: () => void
      const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Error('fixture aborted')); options.signal?.addEventListener('abort', cancel, { once: true }); if (options.signal?.aborted) cancel() })
      let content: AssistantMessage['content']
      try { content = await Promise.race([pending, cancelled]) } finally { options.signal?.removeEventListener('abort', cancel) }
      return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, usage: fixtureUsage ?? emptyUsage(),
        stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() }
    } } })
  const connections = kernel.service<Connections>('connections.registry')!
  const connection = connections.create('local', { name: 'Fixture', provider: 'deepseek', kind: 'model_api', auth: 'api_key' })
  await connections.unlockVault('local')
  const secret = 'test_' + randomBytes(24).toString('hex')
  connections.saveSecret('local', connection.id, secret)
  const projects = new ProjectService(new ProjectStore(db)), workspaces = new WorkspaceStore(db)
  const project = projects.create('Fixture project')
  const log = kernel.service<SessionLog>('session.log')!, scrubber = kernel.service<EgressScrubber>('egress.scrubber')!
  const host = { projects, workspaces, artifactTransfers: { download: async () => { throw new Error('No attachment') } } } as unknown as ConstructorParameters<typeof NativeAgents>[0]
  let runs = new RunStore({ db, log, scrubber, fault: options.fault, clock: options.clock }); runs.heartbeat(); runs.reconcile()
  let agents = new NativeAgents(host, log, connections, scrubber, data, nodePorts, commandRunner, { db, runs })
  t.after(async () => { await agents.close(); runs.close(); await kernel.dispose(); db.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, data, db, get runs() { return runs }, connections, agents: () => agents, log, scrubber, secret, requests, projects, workspaces,
    input: { projectId: project.id, connectionId: connection.id, model: model.id, prompt: 'fixture prompt' },
    async restart(dataDirectory = data, reconcile = false) { await agents.close(); if (reconcile) { runs.close(); runs = new RunStore({ db, log, scrubber, fault: options.fault, clock: options.clock }); runs.heartbeat(); runs.reconcile() } agents = new NativeAgents(host, log, connections, scrubber, dataDirectory, nodePorts, commandRunner, { db, runs }) } }
}
