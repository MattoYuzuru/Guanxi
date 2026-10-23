/** The MS1 rehearsal's home node, as a real child process.
 *
 * It composes what a production host composes, from the same classes, and substitutes only the edges that
 * cannot exist on one machine: the K5 agent is the ACP fixture, the executor node is reached over loopback
 * HTTP with the real signed F2 channel, and time is an injected clock that moves only at the gaps between
 * relay cycles. The parent kills it with a real SIGKILL at a named boundary and starts a new process on the
 * same data directory, so every recovery below is a recovery from disk.
 *
 * Protocol (`process.send`): `ready`, `gap`, `lead-started`, `lead-first`, `notice`, `resumed`, `fatal`; the
 * parent answers `go`, `gap-ack`, `start-lead`, `resume`, `shutdown`. Nothing else is written to stdout. */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { NodeIdentity } from '@guanxi/contract/federation'
import { connectionsPlugin, CONNECTIONS_SERVICE } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { externalAgentPlugin, EXTERNAL_AGENT_SERVICE, type ExternalAgentService } from '../../src/external-agents/plugin.ts'
import type { AgentInstallation } from '../../src/external-agents/types.ts'
import { FederationChannel } from '../../src/federation/channel.ts'
import { federationRoutes } from '../../src/federation/routes.ts'
import { relayStartsChildReporter, relayStartsChildStarter } from '../../src/leads/children.ts'
import { createLeadPlugin, LEAD_SERVICE, type LeadHostService } from '../../src/leads/plugin.ts'
import { OwnedCheckoutAllocator } from '../../src/relay/checkout.ts'
import { ledgerJudgeInput, relayJudgeModel, type RelayStartJudgeSource } from '../../src/relay/judge-start.ts'
import { signalPolicy, startBrief } from '../relay/judge-fixture.ts'
import { RemoteRelayRuntime } from '../../src/relay/remote-runtime.ts'
import { RelayRuntimeSource, type RelayRuntimeSession } from '../../src/relay/runtime.ts'
import { RelayStarts } from '../../src/relay/start.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { DURABLE_RUNS_SERVICE, type DurableRunsService } from '../../src/runs/plugin.ts'
import { bootServerKernel } from '../../src/runtime/kernel.ts'
import { openDb } from '../../src/store/db.ts'

export interface HomeConfig {
  /** Node data directory: `node.sqlite`, `connections.sqlite`, the agent fixture. */
  dir: string
  project: string
  checkouts: string
  owner: string
  home: { identity: NodeIdentity; privateKey: string }
  target: NodeIdentity
  executorUrl: string
  /** Injected wall clock at boot. */
  clock: number
  /** A restart: wait out the predecessor's home lease in simulated time before anything else runs. */
  restart: boolean
  crash: { label: string; nth: number } | null
  /** Simulated time added before each relay cycle after the first. */
  gapMs: number
  /** R1 attempt and owner lease, in simulated milliseconds. It must exceed `gapMs`. */
  ttlMs: number
  /** Relay reserves of the fake llama-server window. */
  reserves: { turn: number; safety: number; handoff: number; tool: number; stepMedian: number; effective: number }
  limits: { maxCaps: { cycles: number; tokens: number; moneyMicros: number; wallMs: number }; maxDeadlineMs: number }
  model: string
  /** Allowed executor connection name, resolved to an id at boot. */
  executorName: string
  /** A value registered with the egress scrubber, which a gate prints: it must never be found at rest or in the packet. */
  canary: string
  /** R3: every relay start carries the signals layer and a J2 cascade on the executor's own runtime. */
  judge: boolean
}
type Parent = { cmd: string; [key: string]: unknown }

const cfg = JSON.parse(readFileSync(process.env['MS1_CONFIG']!, 'utf8')) as HomeConfig
const send = (message: Record<string, unknown>) => { process.send!(message) }
const waiting = new Map<string, Array<(message: Parent) => void>>()
const inbox = new Map<string, Parent[]>()
process.on('message', (message: Parent) => {
  const resolver = waiting.get(message.cmd)?.shift()
  if (resolver) resolver(message)
  else inbox.set(message.cmd, [...(inbox.get(message.cmd) ?? []), message])
})
const next = (cmd: string): Promise<Parent> => {
  const queued = inbox.get(cmd)?.shift()
  if (queued) return Promise.resolve(queued)
  return new Promise(resolve => waiting.set(cmd, [...(waiting.get(cmd) ?? []), resolve]))
}

const sim = { now: cfg.clock }
const clock = () => sim.now
const counts = new Map<string, number>()
/** Every durable boundary reports here; the named one kills the whole process. */
const fault = (label: string) => {
  const n = (counts.get(label) ?? 0) + 1
  counts.set(label, n)
  if (cfg.crash && cfg.crash.label === label && cfg.crash.nth === n) process.kill(process.pid, 'SIGKILL')
}

async function main() {
  mkdirSync(cfg.dir, { recursive: true })
  const db = openDb(join(cfg.dir, 'node.sqlite'))
  const homeChannel = () => new FederationChannel({ local: cfg.home.identity, privateKey: cfg.home.privateKey, peer: cfg.target, clock,
    transport: async request => {
      const url = new URL(request.url)
      const path = url.pathname.replace('/api/federation', '')
      const response = await fetch(cfg.executorUrl + url.pathname + url.search, { method: request.method, headers: request.headers,
        ...(request.method === 'GET' ? {} : { body: await request.text() }), redirect: 'error' })
      // The pin is acknowledged by the executor but no relay run exists yet: the "remote pin" boundary.
      if (path === '/attempts/runtime/pin' && response.ok) fault('net:pin:acked')
      return response
    } })
  const kernel = await bootServerKernel(undefined, { db,
    federation: { identity: cfg.home.identity, privateKey: cfg.home.privateKey, peers: [cfg.target], clock,
      attempts: { maxReservationMs: 5000, leaseClock: clock },
      // F2-reap: the restarted home reconciles its journaled pins by itself, shortly after boot and then every 500 ms.
      dispatch: { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: clock, channel: () => homeChannel(), relayPinMaintenanceMs: 500 } },
    // `leaseClock` defaults to the injected clock, so simulated time moves wall time and leases together.
    runs: { alwaysOn: true, clock, ownerTtlMs: cfg.ttlMs, maxAttemptTtlMs: cfg.ttlMs, tickMs: 250,
      fault: (operation, point) => { if (['before_begin', 'before_commit', 'committed'].includes(point)) fault(`${operation}:${point}`) } } })
  const runs = kernel.node.service<DurableRunsService>(DURABLE_RUNS_SERVICE)!.store
  const federation = kernel.federation!
  // A node that follows a killed one cannot own the home lease until the predecessor's has lapsed; the
  // simulated downtime is exactly that lapse. A first boot claims at once.
  for (let attempt = 0; cfg.restart; attempt++) {
    try { runs.heartbeat(); break } catch (error) {
      if ((error as { code?: string }).code !== 'writer_busy' || attempt >= 4) throw error
      sim.now += cfg.ttlMs + 60_000
    }
  }
  kernel.scrubber.register('secret://ms1/canary', cfg.canary)

  await kernel.node.plugin(connectionsPlugin, { databasePath: join(cfg.dir, 'connections.sqlite'), localHost: () => 'http://127.0.0.1:11434',
    policy: { ownerDevice: true, nodeKeyOptIn: true }, keychain: async () => ({ key: () => Buffer.alloc(32, 7) }),
    transport: async () => { throw new Error('Network forbidden') } })
  const connections = kernel.node.service<Connections>(CONNECTIONS_SERVICE)!
  const ensure = (name: string, create: () => { id: string }) =>
    connections.snapshot(cfg.owner).connections.find(c => c.name === name)?.id ?? create().id
  const leadConnection = ensure('ms1-lead', () => connections.create(cfg.owner, { name: 'ms1-lead', kind: 'agent', provider: 'claude-code' as 'codex', auth: 'cli_login' }))
  const executorConnection = ensure(cfg.executorName, () => connections.create(cfg.owner, { name: cfg.executorName, kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true }))

  // K5: the ACP fixture agent, byte for byte the one the K5 and LW suites use.
  const agentDir = join(cfg.dir, 'claude-code')
  mkdirSync(agentDir, { recursive: true })
  const executable = join(agentDir, 'fixture-agent.mjs')
  if (!existsSync(executable)) {
    writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('../external-agents/fixture-process.mjs', import.meta.url), 'utf8'))
    chmodSync(executable, 0o700)
    copyFileSync(new URL('../external-agents/fixtures/claude-code-0.94.0.json', import.meta.url), join(agentDir, 'tape.json'))
  }
  const installation: AgentInstallation = { adapter: 'claude-code', connectionId: leadConnection, ownerAccountId: cfg.owner, nodeId: 'ms1-home',
    billingAccount: 'claude-code-account', executable, version: '0.94.0', claudeExecutable: executable }
  await kernel.node.plugin(externalAgentPlugin, { dataDir: cfg.dir, policy: { nodeId: 'ms1-home', installations: [installation], runDeadlineMs: 60_000 } })
  kernel.node.service<ExternalAgentService>(EXTERNAL_AGENT_SERVICE)!.setProjectRoles(cfg.owner, cfg.owner, 'p',
    { lead: { backend: 'claude-code', connectionId: leadConnection, model: 'model-fixture', params: {} } })

  // F2-d on the home: every relay model call is executed and counted by the executor node.
  const relayStore = new RelayStore(db, runs, kernel.scrubber, clock, point => fault(`relay:${point}`))
  const gapped = new Map<string, number>()
  const gap = async (runId: string | null) => {
    if (!runId) return
    let cycle: number, state: string
    try { ({ cycle, state } = relayStore.read(runId)) } catch { return }
    // The first observation of a cycle, between two sealed ones: nothing is in flight.
    if (state !== 'boot' || cycle < 1 || cycle <= (gapped.get(runId) ?? 0)) return
    gapped.set(runId, cycle)
    fault(`gap:${cycle}`)
    sim.now += cfg.gapMs
    runs.tick()
    send({ event: 'gap', run: runId, cycle, now: sim.now })
    await next('gap-ack')
  }
  class GappedRemote extends RemoteRelayRuntime {
    override open(): RelayRuntimeSession {
      const session = super.open()
      let runId: string | null = null
      const bind = session.bind.bind(session), observe = session.observe.bind(session)
      session.bind = attempt => { runId = attempt.run_id; bind(attempt) }
      session.observe = async (reference, signal) => { await gap(runId); return observe(reference, signal) }
      return session
    }
  }
  const remote = new GappedRemote({ federation, runs, executorNodeId: cfg.target.id, model: cfg.model, clock, pollMs: 20, pinRenewMs: 3_600_000 })
  const source = new RelayRuntimeSource(connections, () => { throw new Error('Ollama models must not be consulted') },
    { maximumAgeMs: 10_000, observer: remote }, clock)
  const allocator = new OwnedCheckoutAllocator({ root: cfg.checkouts })
  // R3: the signals layer needs no model; J2 counts and runs on the executor through the relay's own meter and session.
  const judge: RelayStartJudgeSource = context => ({
    signals: ledgerJudgeInput(signalPolicy, context.clock),
    cascade: { brief: startBrief(context.input, { accountId: cfg.owner, executorNodeId: cfg.target.id }),
      model: relayJudgeModel(context, { accountId: cfg.owner, maxAgeMs: 10_000 }) },
  })
  const starts = new RelayStarts(db, runs, kernel.sessionLog!, connections, kernel.scrubber, relayStore, {
    runtime: source, reserves: cfg.reserves, clock, nodePorts: () => [], ...(cfg.judge ? { judge } : {}),
    project: async id => ({ projectId: id, roots: [cfg.project], source: 'ms1 fixture project', observedAt: sim.now }),
    allocate: (policy, signal) => allocator.allocate(policy, signal) })

  // The federation endpoint the executor calls back: renewals and the signed dispatch events.
  const app = new Hono()
  app.use('/api/federation/attempts/events', async (c, next) => {
    const body = await c.req.raw.clone().json().catch(() => null) as { entry?: { event?: { kind?: string } } } | null
    const kind = body?.entry?.event?.kind
    if (kind === 'terminal') fault('net:terminal:before_ingest')
    await next()
    if (kind === 'terminal') fault('net:terminal:after_ingest')
  })
  app.route('/api/federation', federationRoutes(() => federation))
  const port = await new Promise<number>(resolve => { const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, info => resolve(info.port)); server = s })

  send({ event: 'ready', pid: process.pid, port, clock: sim.now, leadConnection, executorConnection })
  await next('go')

  const pollMs = 200
  await kernel.node.plugin(createLeadPlugin({ db, clock, tickMs: 250, renewMs: 1000, cancelGraceMs: 3_000, retryMs: () => 1_000, fault,
    // The mirror's last step is the boundary between "the relay run finished" and "the lead's promise resolves".
    child: relayStartsChildStarter(starts, { consent: 'full-access', domains: [], pollMs, runs: {
      get: id => runs.get(id), renew: attempt => runs.renew(attempt),
      complete: (attempt, outcome) => { fault(`mirror:complete:${outcome}:before`); runs.complete(attempt, outcome); fault(`mirror:complete:${outcome}:after`) } } }),
    reporter: relayStartsChildReporter(starts, relayStore),
    validateExecutor: executor => {
      if (executor.connectionId !== executorConnection || executor.model !== cfg.model) throw Object.assign(new Error('executor_not_allowed'), { code: 'executor_not_allowed' })
    },
    limits: cfg.limits,
    notify: notice => send({ event: 'notice', notice }) }))
  const lead = kernel.node.service<LeadHostService>(LEAD_SERVICE)!

  send({ event: 'loaded' })
  let stopping = false
  process.on('message', async (message: Parent) => {
    if (message.cmd === 'start-lead') {
      const { runId, first } = lead.startLead({ ownerAccountId: cfg.owner, actorAccountId: cfg.owner, projectId: 'p', prompt: String(message['prompt']) })
      send({ event: 'lead-started', runId })
      first.then(result => send({ event: 'lead-first', result }), error => send({ event: 'lead-first', error: String(error?.code ?? error) }))
    } else if (message.cmd === 'cancel') {
      send({ event: 'canceled', result: await lead.cancel(String(message['runId'])) })
    } else if (message.cmd === 'resume') {
      const result = await lead.resume(String(message['runId']), String(message['prompt']))
      send({ event: 'resumed', result })
    } else if (message.cmd === 'shutdown' && !stopping) {
      stopping = true
      await starts.close().catch(() => undefined)
      await kernel.node.dispose().catch(() => undefined)
      server.close()
      db.close()
      process.exit(0)
    }
  })
}
let server: ReturnType<typeof serve>
main().catch(error => {
  send({ event: 'fatal', error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error) })
  process.exit(1)
})
