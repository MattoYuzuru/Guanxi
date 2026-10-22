/** Bounded cross-process fixture. It uses the production store/service and a temp sidecar;
 * it never contacts a vendor, network, owner home or real account. */
import { readFileSync } from 'node:fs'
import type { Connections } from '../../src/connections/service.ts'
import type { EgressScrubber } from '../../src/egress/types.ts'
import type { SessionLog } from '../../src/session-log/log.ts'
import { ExternalAgents } from '../../src/external-agents/service.ts'
import { ExternalStore } from '../../src/external-agents/store.ts'
import type { AdapterId } from '../../src/external-agents/types.ts'

interface WorkerConfig {
  mode: 'service' | 'acquire' | 'migrate-claim'
  dbPath: string
  rootDir: string
  owner: string
  adapter: AdapterId
  billingAccount: string
  connectionId: string
  nodeId: string
  executable: string
  version: string
  concurrency: number
  tracePath?: string
  adapterPidPath?: string
  instanceId: string
  policyDigest: string
}

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as WorkerConfig
const send = (message: Record<string, unknown>) => new Promise<void>(resolve => {
  if (!process.send) return resolve()
  process.send(message, () => resolve())
})
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const scrubber = { isReady: () => true, scrub: <T>(value: T) => value } as unknown as EgressScrubber
const store = new ExternalStore(config.dbPath, scrubber)

async function waitForTrace() {
  if (!config.tracePath) return false
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { if (readFileSync(config.tracePath, 'utf8').includes('turn/start')) return true } catch { /* Not started yet. */ }
    await sleep(10)
  }
  return false
}

function onRelease(handler: () => void) {
  process.on('message', message => { if (message === 'release') handler() })
}

if (config.mode === 'service') {
  const install = {
    adapter: config.adapter, connectionId: config.connectionId, ownerAccountId: config.owner,
    nodeId: config.nodeId, billingAccount: config.billingAccount, executable: config.executable,
    version: config.version, concurrency: config.concurrency,
  }
  const row = { id: config.connectionId, accountId: config.owner, name: 'fixture worker', kind: 'agent' as const,
    provider: 'codex' as const, auth: 'cli_login' as const, unattended: false, secretRef: null, facts: {}, balance: null,
    createdAt: new Date().toISOString() }
  const connections = {
    store: { get: () => row, observe: () => row },
    dispatchAgent: (_owner: string, _id: string, _actor: string, _allowed: boolean,
      call: { signal?: AbortSignal }, launch: (connection: unknown, key: undefined, signal: AbortSignal) => unknown) =>
      launch(row, undefined, call.signal ?? new AbortController().signal),
  } as unknown as Connections
  const log = { open: () => ({ append() { /* fixture */ }, close() { /* fixture */ } }) } as unknown as SessionLog
  const agents = new ExternalAgents(connections, log, scrubber, config.rootDir, store,
    { nodeId: config.nodeId, installations: [install] })
  const binding = { backend: config.adapter, connectionId: config.connectionId, model: 'model-fixture', params: {} }
  const controller = new AbortController()
  onRelease(() => controller.abort())
  const run = agents.run({ ownerAccountId: config.owner, actorAccountId: config.owner, projectId: 'worker',
    role: 'lead', prompt: 'fixture worker', signal: controller.signal, sessionRoles: { lead: binding } })
  const outcome = run.then(() => ({ status: 'completed' as const }), error => ({ status: 'error' as const, code: error.code as string }))
  const started = await Promise.race([waitForTrace().then(value => ({ kind: 'started' as const, value })), outcome.then(value => ({ kind: 'settled' as const, value }))])
  if (started.kind === 'settled') {
    const settled = started.value
    await send(settled.status === 'error' && settled.code === 'account_busy'
      ? { type: 'busy', code: settled.code } : { type: 'failed', code: settled.status === 'error' ? settled.code : 'completed_early' })
    await agents.close(); store.close(); process.exit(0)
  }
  if (!started.value) {
    await send({ type: 'failed', code: 'fixture_not_started' })
    await agents.close(); store.close(); process.exit(1)
  }
  await send({ type: 'admitted', workerPid: process.pid,
    adapterPid: config.adapterPidPath ? Number(readFileSync(config.adapterPidPath, 'utf8')) : null })
  const result = await outcome
  await send({ type: 'released', code: result.status === 'error' ? result.code : null })
  await agents.close(); store.close()
  process.exit(0)
} else {
  let holder
  try {
    holder = store.acquire({
      instanceId: config.instanceId, owner: config.owner, adapter: config.adapter, billingAccount: config.billingAccount,
      kind: 'run', policyDigest: config.policyDigest, ceiling: config.concurrency,
    })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'failed'
    await send({ type: code === 'account_busy' ? 'busy' : 'failed', code })
    store.close(); process.exit(0)
  }
  await send({ type: 'held' })
  onRelease(() => {
    store.release(holder.holder); void send({ type: 'released' }).then(() => { store.close(); process.exit(0) })
  })
  await sleep(60_000)
}
