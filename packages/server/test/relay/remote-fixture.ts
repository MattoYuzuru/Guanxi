import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FederationChannel } from '../../src/federation/channel.ts'
import { signValue } from '../../src/federation/crypto.ts'
import { Connections } from '../../src/connections/service.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import { OllamaClient } from '../../src/ollama/client.ts'
import { BalanceProbes } from '../../src/probes/balances.ts'
import type { DispatchPolicy } from '../../src/remote-attempts/dispatch.ts'
import { ConnectionRelayModel } from '../../src/relay/model.ts'
import type { JsonSchema } from '../../src/relay/json-schema.ts'
import { RelayRuntimeSource } from '../../src/relay/runtime.ts'
import { RemoteRelayRuntime } from '../../src/relay/remote-runtime.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { LlamaServerClient } from '../../src/runtime/llama-server/client.ts'
import { LlamaServerRuntime } from '../../src/runtime/llama-server/runtime.ts'
import { Vault } from '../../src/vault/vault.ts'
import { identity, SimNode } from '../federation/harness.ts'
import { reply, startFakeLlama, type FakeLlamaState } from '../fixtures/fake-llama-server.ts'

export const keys = (id: string) => identity(id, { scopes: ['config', 'replicas', 'commands', 'telemetry', 'attempts'] })
/** The shape undici gives a dropped loopback link: a bare `fetch failed` carrying the network cause. */
export const networkFailure = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
export function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
export async function until(predicate: () => boolean | Promise<boolean>, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('fixture did not reach the expected state')
}
/** Read a file, verify the item, hand off: the same three-step script the operational fixture uses. */
export const relayScript = reply(prompt => {
  const state = globalThis as unknown as { work?: number }
  if (prompt.startsWith('<|user|>\nWrite a fresh')) return 'Completed fixture acceptance.'
  state.work = (state.work ?? 0) + 1
  return JSON.stringify(state.work === 1 ? { action: 'tool', name: 'file_read', args: { path: 'src/item.txt' } }
    : state.work === 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' })
})
export interface RemoteOptions {
  fake?: Partial<FakeLlamaState>
  ttlMs?: number; safetyMs?: number; cancelWaitMs?: number; maximumAgeMs?: number; callDeadlineMs?: number
  /** The executor serves no relay runtime (an older or differently configured node). */
  noRelayRuntime?: boolean
  relayLimits?: { maxConcurrentCountsPerPeer?: number; maxPinsPerPeer?: number; pinTtlMs?: number }
  /** F2-reap: the home session's pin heartbeat, and the nodes' maintenance timers (off by default so tests drive reconciliation themselves). */
  pinRenewMs?: number; maintenanceMs?: number
  /** The executor's own holder TTL, when it differs from the home's. */
  targetTtlMs?: number
  dir?: string
}
type Rule = (path: string, request: Request) => Promise<void> | void
type Override = (path: string, request: Request) => Promise<Response | undefined> | Response | undefined
type After = (path: string, response: Response) => void
export interface Sent { path: string; body: unknown }
/** Two in-process nodes joined by signed in-memory channels, a fake llama-server behind the executor and no
 * llama-server of any kind on the home. Nothing leaves the process. */
export async function remoteFixture(t: { after(fn: () => unknown): void }, o: RemoteOptions = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'guanxi-f2d-')), modelPath = join(dir, 'model.gguf')
  writeFileSync(modelPath, 'GGUF-remote-weights')
  const fake = await startFakeLlama({ alias: 'fixture', modelPath, nCtx: 16000, replies: ['{"action":"handoff"}'], ...o.fake })
  const clock = { mono: 1_000_000 }, hg = new ResourceGovernor(), tg = new ResourceGovernor()
  let home!: SimNode, target!: SimNode
  const probes: Array<(path: string) => void> = [], rules: Rule[] = [], overrides: Override[] = [], afters: After[] = [], seen: string[] = [], sent: Sent[] = []
  const channel = (from: SimNode, to: SimNode) => new FederationChannel({ local: from.keys.identity, privateKey: from.keys.privateKey, peer: to.keys.identity,
    clock: () => from.time, transport: async request => {
      const path = new URL(request.url).pathname.replace('/api/federation', '')
      // Synchronous probes see the world at the instant the request is issued, before any await.
      for (const probe of probes) probe(path)
      seen.push(path)
      sent.push({ path, body: request.method === 'POST' ? await request.clone().json().catch(() => null) : null })
      for (const rule of rules) await rule(path, request)
      for (const override of overrides) { const replaced = await override(path, request); if (replaced) return replaced }
      const response = await to.app.request(request)
      for (const after of afters) after(path, response)
      return response
    } })
  const hp: DispatchPolicy = { ttlMs: o.ttlMs ?? 3000, safetyMs: o.safetyMs ?? 100, maxModelAgeMs: 5000, leaseClock: () => clock.mono, channel: () => channel(home, target), relayPinMaintenanceMs: o.maintenanceMs ?? 0 }
  const tp: DispatchPolicy = { ...hp, ...(o.targetTtlMs ? { ttlMs: o.targetTtlMs } : {}), ...(o.relayLimits ? { relayLimits: o.relayLimits } : {}), channel: () => channel(target, home) }
  home = new SimNode(keys('home'), ':memory:', { attempts: { governor: hg, maxReservationMs: 5000, leaseClock: () => clock.mono }, dispatch: hp })
  target = new SimNode(keys('target'), ':memory:', { attempts: { governor: tg, maxReservationMs: 5000, leaseClock: () => clock.mono }, dispatch: tp })
  home.trust(target); target.trust(home)
  const connectionsFor = (node: SimNode, name: string, governor: ResourceGovernor, life: AbortController) => {
    const store = new ConnectionStore(join(dir, `${name}.sqlite`), node.scrubber)
    const vault = new Vault(store, async () => { throw new Error('No fixture keychain') }, node.scrubber, { ownerDevice: true, nodeKeyOptIn: true })
    // Ollama is never reachable: a request to it would mean a local fallback.
    const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async () => { throw new Error('Ollama must not be used') } })
    const connections = new Connections(store, vault, new BalanceProbes(store, vault), node.scrubber, life.signal, { client: () => client }, governor, () => 'http://127.0.0.1:11434')
    return { store, vault, connections }
  }
  const lifeHome = new AbortController(), lifeTarget = new AbortController()
  const h = connectionsFor(home, 'home', hg, lifeHome), tc = connectionsFor(target, 'target', tg, lifeTarget)
  const homeConnection = h.connections.create('local', { name: 'Home fixture', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  const targetConnection = tc.connections.create('owner', { name: 'Executor fixture', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  const llama = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: fake.url }), model: 'fixture', clock: () => target.time, countTimeoutMs: 5000 })
  tp.connections = tc.connections
  tp.localModel = model => ({ connectionId: targetConnection.id, model, placement: 'installed_local', source: 'fixture installed inventory', observedAt: target.time })
  if (!o.noRelayRuntime) tp.relayRuntime = llama
  // Nothing here writes a pin on the executor: the relay's own pin arrives only through the signed pin message.
  const remote = new RemoteRelayRuntime({ federation: home.federation, runs: home.runs, executorNodeId: 'target', model: 'fixture', clock: () => home.time,
    ...(o.cancelWaitMs ? { cancelWaitMs: o.cancelWaitMs } : {}), pollMs: 10, ...(o.callDeadlineMs ? { callDeadlineMs: o.callDeadlineMs } : {}), ...(o.pinRenewMs ? { pinRenewMs: o.pinRenewMs } : {}) })
  const source = new RelayRuntimeSource(h.connections, () => { throw new Error('Ollama models must not be consulted') },
    { maximumAgeMs: o.maximumAgeMs ?? 10_000, observer: remote }, () => home.time)
  const homeCtx = { identity: home.keys.identity, readOnly: false, version: { major: 1, minor: 4 } }
  t.after(async () => {
    lifeHome.abort(); lifeTarget.abort()
    target.federation.close(); await llama.close(); await tc.connections.close(); await h.connections.close()
    tc.vault.close(); h.vault.close(); tc.store.close(); h.store.close()
    home.close(); target.close(); await hg.close(); await tg.close(); await fake.close()
    if (!o.dir) rmSync(dir, { recursive: true, force: true })
  })
  /** A relay run with a first attempt, a prepared remote runtime bound to it, and the model facade the executor uses. */
  async function relay(id = 'relay') {
    const run = home.runs.create({ id, sessionId: `${id}-session` }), attempt = home.runs.start(run.id)
    const controller = new AbortController()
    const prepared = await source.prepare(homeConnection.id, 'fixture', 1000, controller.signal)
    await prepared.prepareBind!({ runId: run.id, sessionId: run.session_id, epoch: attempt.epoch }, controller.signal)
    prepared.bind!(attempt)
    const model = new ConnectionRelayModel(h.connections, homeConnection.id, 'fixture', prepared.meter)
    const window = await model.observe(controller.signal)
    const call = async (prompt: string, extra: { signal?: AbortSignal; maxInput?: number; maxOutput?: number; prime?: boolean; onStarted?: () => void; responseSchema?: JsonSchema } = {}) => {
      const signal = extra.signal ?? controller.signal
      if (extra.prime !== false) await model.countAsync!(prompt, signal)
      return model.call(prompt, { runId: run.id, requestId: randomUUID(), maxOutput: extra.maxOutput ?? 1000, maxInput: extra.maxInput ?? 14800, window, signal,
        onStarted: () => { extra.onStarted?.(); home.runs.modelStarted(attempt) }, ...(extra.responseSchema ? { responseSchema: extra.responseSchema } : {}) })
    }
    return { run, attempt, prepared, model, window, call, controller }
  }
  const completions = () => fake.requests('/completion')
  const costs = (runId: string) => home.db.prepare('SELECT * FROM run_costs WHERE run_id=?').all(runId) as Array<{ run_id: string; entry_key: string; input_tokens: number; output_tokens: number }>
  /** The executor acknowledges every pin (with a genuine signature) without making one: the home believes it is pinned, the executor knows nothing. */
  const forgePinAck = () => overrides.push(async (path, request) => {
    if (path !== '/attempts/runtime/pin') return undefined
    const { model: _model, ...entry } = await request.clone().json() as Record<string, unknown>
    return Response.json({ entry, signature: signValue(target.keys.privateKey, entry) })
  })
  const pinKey = (runId: string) => `relay:${runId}`
  return { home, target, hg, tg, clock, fake, llama, remote, source, h, tc, homeConnection, targetConnection, forgePinAck, pinKey, relay, completions, costs, homeCtx,
    seen, sent, rules, probes, overrides, afters, channel: (from: 'home' | 'target') => from === 'home' ? channel(home, target) : channel(target, home), dir, modelPath,
    refusePin() { rules.push(path => { if (path === '/attempts/runtime/pin') throw networkFailure() }) } }
}
