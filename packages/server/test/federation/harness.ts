/** Deterministic network scheduler. No sockets, timers, installed models or owner data. */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { NodeIdentity, FederationAuth } from '@guanxi/contract/federation'
import { openDb } from '../../src/store/db.ts'
import { SessionLog } from '../../src/session-log/log.ts'
import { RunStore } from '../../src/runs/store.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { Federation } from '../../src/federation/service.ts'
import { federationRoutes } from '../../src/federation/routes.ts'
import { requestProof, signValue } from '../../src/federation/crypto.ts'

export function identity(id: string, overrides: Partial<NodeIdentity> = {}) {
  const pair = generateKeyPairSync('ed25519')
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), identity: {
    id, accountId: 'owner', trust: 'owner_device', admin: true,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    scopes: ['config', 'replicas', 'commands', 'telemetry'], ...overrides,
  } as NodeIdentity }
}
export class SimNode {
  time = 1_000_000
  readonly keys: ReturnType<typeof identity>
  readonly db: ReturnType<typeof openDb>
  readonly scrubber: SecretScrubber
  readonly log: SessionLog
  readonly runs: RunStore
  readonly federation: Federation
  readonly app: Hono
  constructor(keys: ReturnType<typeof identity>, path = ':memory:') {
    this.keys = keys
    this.db = openDb(path)
    this.scrubber = new SecretScrubber()
    this.log = new SessionLog({ db: this.db, scrubber: this.scrubber, clock: () => new Date(this.time) })
    this.runs = new RunStore({ db: this.db, scrubber: this.scrubber, log: this.log, clock: () => this.time, leaseClock: () => this.time, alwaysOn: true })
    this.runs.heartbeat()
    this.federation = new Federation({ ...keys, db: this.db, scrubber: this.scrubber, log: this.log, runs: this.runs, clock: () => this.time })
    this.app = new Hono().route('/api/federation', federationRoutes(() => this.federation))
  }
  trust(other: SimNode) { this.federation.trust(other.keys.identity) }
  async request(target: SimNode, method: string, path: string, body: unknown = null, major = 1) {
    const url = `/api/federation${path}`
    const auth: FederationAuth = { nodeId: this.keys.identity.id, version: { major, minor: 0 }, issuedAt: this.time, nonce: randomUUID(), signature: '' }
    auth.signature = signValue(this.keys.privateKey, requestProof(method, url, body, auth))
    return target.app.request(`http://node${url}`, { method, headers: { 'X-Guanxi-Node': JSON.stringify(auth), 'Content-Type': 'application/json' },
      ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) })
  }
  context() { return { identity: this.keys.identity, readOnly: false, version: { major: 1, minor: 0 } } }
  close() { this.federation.close(); this.runs.close(); this.log.close(); this.db.close() }
}
export function rng(seed: number) {
  let state = seed >>> 0
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x100000000 }
}
interface Packet { from: SimNode; to: SimNode; due: number; deliver: () => Promise<void> }
export class SimNetwork {
  private packets: Packet[] = []
  private partitions = new Set<string>()
  readonly random: () => number
  tick = 0
  constructor(seed: number) { this.random = rng(seed) }
  partition(a: SimNode, b: SimNode) { this.partitions.add([a.keys.identity.id, b.keys.identity.id].sort().join('/')) }
  heal() { this.partitions.clear() }
  send(from: SimNode, to: SimNode, deliver: () => Promise<void>) { this.packets.push({ from, to, deliver, due: this.tick + Math.floor(this.random() * 20) }) }
  async step() {
    this.tick++
    const ready = this.packets.filter((p) => p.due <= this.tick && !this.partitions.has([p.from.keys.identity.id, p.to.keys.identity.id].sort().join('/')))
    if (!ready.length) return
    const selected = ready[Math.floor(this.random() * ready.length)]!
    this.packets.splice(this.packets.indexOf(selected), 1)
    await selected.deliver()
  }
  async drain() { this.heal(); while (this.packets.length) await this.step() }
  get pending() { return this.packets.length }
}
