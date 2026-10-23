/** Two production-booted Guanxi nodes on one Mac, linked the way the operator links two machines: each reaches the other only
 * through a loopback port forward (here an HTTP forwarder in the test process that logs every federation request, and can be
 * cut like a dropped `ssh -L`). Both nodes are real child processes running `ms1-live start`, the executor in front of the
 * fake llama-server in attach mode. Nothing is injected into either node: no clock, no transport, no relay class. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { main } from '../../src/ms1-live/cli.ts'
import { startFakeLlama, type FakeLlama, type FakeLlamaState } from '../fixtures/fake-llama-server.ts'
import { ms1Script } from '../ms1/llama-script.ts'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../../scripts/ms1-live/ms1-live.ts', import.meta.url))
const FIXTURES = new URL('../external-agents/', import.meta.url)

export const freePort = () => new Promise<number>(resolve => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) }) })
export async function until(predicate: () => boolean | Promise<boolean>, what: string, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(`timed out waiting for ${what}`)
}
export async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [], err: string[] = []
  const code = await main(args, { out: text => out.push(text), err: text => err.push(text) }, env)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** The "ssh -L": a loopback listener that forwards to another loopback port. Like a TCP forward it keeps no state, but this one
 * rewrites Host so the peer's own-port allowlist accepts it (a real forward uses the same number on both ends). */
export class Forward {
  readonly requests: Array<{ path: string; action?: string }> = []
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  readonly port: number
  readonly target: number
  constructor(port: number, target: number) { this.port = port; this.target = target }
  async listen() {
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        let action: string | undefined
        try { action = (JSON.parse(body.toString('utf8')) as { action?: string }).action } catch { /* not JSON */ }
        this.requests.push({ path: req.url!.replace('/api/federation', ''), ...(action ? { action } : {}) })
        const upstream = httpRequest({ host: '127.0.0.1', port: this.target, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${this.target}` } }, response => {
          res.writeHead(response.statusCode!, response.headers); response.pipe(res)
        })
        upstream.on('error', () => res.destroy())
        upstream.end(body)
      })
    })
    server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', resolve) })
    this.server = server
  }
  /** The forward dies: nothing accepts, and open connections drop. */
  async cut() { const server = this.server; this.server = null; for (const s of this.sockets) s.destroy(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()) }
  async restore() { if (!this.server) await this.listen() }
  paths(prefix: string) { return this.requests.filter(r => r.path.startsWith(prefix)) }
}

/** Where a local Ollama would be: it must never be asked anything on a relay path. */
export class Tripwire {
  readonly requests: string[] = []
  private server!: Server
  port = 0
  async listen() {
    this.server = createHttpServer((req, res) => { this.requests.push(`${req.method} ${req.url}`); res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"tripwire"}') })
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as { port: number }).port
  }
  close() { this.server.closeAllConnections(); return new Promise<void>(resolve => this.server.close(() => resolve())) }
}

type Event = Record<string, any> & { event: string }
export class LiveNode {
  child!: ChildProcess
  readonly events: Event[] = []
  readonly stderr: string[] = []
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = Promise.resolve({ code: null, signal: null })
  alive = false
  readonly name: string
  readonly config: string
  readonly dataDir: string
  readonly port: number
  readonly env: NodeJS.ProcessEnv
  constructor(name: string, config: string, dataDir: string, port: number, env: NodeJS.ProcessEnv) { this.name = name; this.config = config; this.dataDir = dataDir; this.port = port; this.env = env }
  spawn(extra: string[] = []) {
    this.events.length = 0
    const child = spawn(process.execPath, [SCRIPT, 'start', '--config', this.config, '--data-dir', this.dataDir, '--json', ...extra], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child; this.alive = true
    let pending = ''
    child.stdout!.on('data', chunk => {
      pending += String(chunk)
      for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
        const line = pending.slice(0, i); pending = pending.slice(i + 1)
        try { this.events.push(JSON.parse(line)) } catch { /* not an event */ }
      }
    })
    child.stderr!.on('data', chunk => { this.stderr.push(String(chunk)) })
    this.exit = new Promise(resolve => child.once('exit', (code, signal) => { this.alive = false; resolve({ code, signal }) }))
  }
  find(event: string): Event | undefined { return this.events.find(e => e.event === event) }
  async wait(event: string, ms = 60_000): Promise<Event> {
    await until(() => this.find(event) !== undefined || !this.alive, `${this.name} ${event}`, ms)
    const found = this.find(event)
    if (!found) throw new Error(`${this.name} exited before ${event}\n${this.events.map(e => JSON.stringify(e)).join('\n')}\n${this.stderr.join('').slice(-3000)}`)
    return found
  }
  get url() { return `http://127.0.0.1:${this.port}` }
  async api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(this.url + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error' })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  async stop() { if (this.alive) { this.child.kill('SIGTERM'); await Promise.race([this.exit, new Promise(resolve => setTimeout(resolve, 15_000))]); if (this.alive) { this.child.kill('SIGKILL'); await this.exit } } }
  /** A read-only view of this node's database (WAL: safe beside the writer). */
  db<T>(read: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(this.dataDir, 'guanxi.db'), { readOnly: true })
    try { return read(db) } finally { db.close() }
  }
  rows<T = Record<string, any>>(sql: string, ...args: Array<string | number>): T[] { return this.db(db => db.prepare(sql).all(...args).map(row => ({ ...row }) as T)) }
  one<T = Record<string, any>>(sql: string, ...args: Array<string | number>): T | undefined { return this.rows<T>(sql, ...args)[0] }
  count(sql: string, ...args: Array<string | number>): number { return Number(this.one<{ n: number }>(sql, ...args)?.n ?? 0) }
}

export interface LiveOptions {
  fake?: Partial<FakeLlamaState>
  /** Add a `home.lead` section whose bridge and CLI are the ACP fixture agent. */
  lead?: boolean
  /** What the home's peer file holds in place of the executor: `key` is the executor's id with another public key (the
   * executor's answers then fail verification), `stranger` is another node altogether (the executor refuses the home). */
  wrongPeer?: 'key' | 'stranger'
  /** The executor's peer file holds another node in place of the home. */
  wrongHome?: boolean
  start?: boolean
}
export const LEAD_LIMITS = { maxCaps: { cycles: 40, tokens: 2_000_000, moneyMicros: 500_000, wallMs: 12 * 3_600_000 }, maxDeadlineMs: 24 * 3_600_000, allowDetach: false }

export async function createLiveWorld(t: { after(fn: () => unknown): void }, options: LiveOptions = {}) {
  mkdirSync(join(process.cwd(), '.lane-data'), { recursive: true })
  // Colima shares the working directory, not the system temp directory: the gate sandbox must see the checkouts.
  const dir = realpathSync(mkdtempSync(join(process.cwd(), '.lane-data', 'ms1live-')))
  const world = new LiveWorld(dir, options)
  t.after(async () => { await world.close() })
  try { await world.init() } catch (error) { await world.close(); throw error }
  return world
}

export class LiveWorld {
  readonly homeDir: string
  readonly execDir: string
  readonly project: string
  readonly checkouts: string
  fake!: FakeLlama
  tripwire = new Tripwire()
  toExecutor!: Forward
  toHome!: Forward
  home!: LiveNode
  executor!: LiveNode
  base = ''
  projectId = ''
  homeConfig = ''
  execConfig = ''
  leadConnection = ''
  private closers: Array<() => unknown> = []
  readonly dir: string
  readonly options: LiveOptions
  constructor(dir: string, options: LiveOptions) {
    this.dir = dir; this.options = options
    this.homeDir = join(dir, 'home'); this.execDir = join(dir, 'exec'); this.project = join(dir, 'project'); this.checkouts = join(dir, 'checkouts')
  }
  private async git(args: string[], cwd = this.project) {
    return (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd })).stdout.trim()
  }
  private patch(file: string, change: (config: any) => void) { const config = JSON.parse(readFileSync(file, 'utf8')); change(config); writeFileSync(file, JSON.stringify(config, null, 2)) }

  async init() {
    mkdirSync(this.project, { recursive: true })
    writeFileSync(join(this.project, 'README.md'), 'MS1 live fixture project\n')
    await this.git(['init', '-q', '-b', 'main']); await this.git(['add', '.']); await this.git(['commit', '-q', '-m', 'fixture'])
    this.base = await this.git(['rev-parse', 'HEAD'])
    const modelPath = join(this.dir, 'model.gguf')
    writeFileSync(modelPath, 'GGUF-ms1-live-weights')
    this.fake = await startFakeLlama({ alias: 'fixture', modelPath, nCtx: 16000, replies: [ms1Script], ...this.options.fake })
    this.closers.push(() => this.fake.close())
    await this.tripwire.listen(); this.closers.push(() => this.tripwire.close())
    const [homePort, execPort, toHomePort, toExecPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
    this.toExecutor = new Forward(toExecPort, execPort); this.toHome = new Forward(toHomePort, homePort)
    await this.toExecutor.listen(); await this.toHome.listen()
    this.closers.push(() => this.toExecutor.cut(), () => this.toHome.cut())

    // The operator's steps, through the same commands: init on each side, then exchange the public files.
    const initHome = await cli(['init', '--role', 'home', '--dir', this.homeDir, '--port', String(homePort), '--peer-port', String(toExecPort), '--model', 'fixture', '--json'])
    const initExec = await cli(['init', '--role', 'executor', '--dir', this.execDir, '--port', String(execPort), '--peer-port', String(toHomePort), '--model', 'fixture', '--llama-url', this.fake.url, '--json'])
    if (initHome.code !== 0 || initExec.code !== 0) throw new Error(`init failed ${initHome.out}${initHome.err}${initExec.out}${initExec.err}`)
    this.homeConfig = join(this.homeDir, 'ms1-live.json'); this.execConfig = join(this.execDir, 'ms1-live.json')
    const strangerOffer = async () => {
      const stranger = join(this.dir, `stranger-${Math.random().toString(16).slice(2)}`)
      await cli(['init', '--role', 'executor', '--dir', stranger, '--json'])
      return join(stranger, 'peer-offer.json')
    }
    if (this.options.wrongPeer === 'stranger') copyFileSync(await strangerOffer(), join(this.homeDir, 'peer.json'))
    else if (this.options.wrongPeer === 'key') {
      // The executor's own id and identity, with somebody else's public key.
      const offer = JSON.parse(readFileSync(join(this.execDir, 'peer-offer.json'), 'utf8'))
      offer.identity.publicKey = JSON.parse(readFileSync(await strangerOffer(), 'utf8')).identity.publicKey
      writeFileSync(join(this.homeDir, 'peer.json'), JSON.stringify(offer))
    } else copyFileSync(join(this.execDir, 'peer-offer.json'), join(this.homeDir, 'peer.json'))
    if (this.options.wrongHome) copyFileSync(await strangerOffer(), join(this.execDir, 'peer.json'))
    else copyFileSync(join(this.homeDir, 'peer-offer.json'), join(this.execDir, 'peer.json'))
    // Timing is policy: shorter than production's, longer than a loaded test machine's worst pause.
    const link = { requestTimeoutMs: 30_000, holderTtlMs: 10_000, safetyMs: 500, maxModelAgeMs: 60_000, maxReservationMs: 30_000 }
    const reserves = { turn: 1000, safety: 200, handoff: 1500, tool: 1000, stepMedian: 1000, effective: 14000 }
    this.patch(this.execConfig, config => { config.link = link })
    if (this.options.lead) this.writeLeadFixture()
    this.patch(this.homeConfig, config => {
      config.link = link
      config.home.reserves = reserves; config.home.checkoutRoot = this.checkouts; config.home.pollMs = 200
      if (this.options.lead) {
        const agent = join(this.homeDir, 'claude-code', 'fixture-agent.mjs')
        config.home.lead = { adapter: 'claude-code', bridge: agent, bridgeVersion: '0.94.0', claudeExecutable: agent, billingAccount: 'claude-code-account',
          model: 'model-fixture', runDeadlineMs: 120_000, domains: [], pollMs: 200, limits: LEAD_LIMITS }
      }
    })
    const env = (): NodeJS.ProcessEnv => {
      const base = { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${this.tripwire.port}`, GUANXI_WEB_PORT: '5999' }
      for (const key of ['GUANXI_API_PORT', 'GUANXI_DATA_DIR', 'PORT', 'HOST', 'GUANXI_MS1_LIVE_CONFIG']) delete (base as Record<string, unknown>)[key]
      return base
    }
    this.executor = new LiveNode('executor', this.execConfig, join(this.execDir, 'data'), execPort, env())
    this.home = new LiveNode('home', this.homeConfig, join(this.homeDir, 'data'), homePort, env())
    this.closers.push(() => this.home.stop(), () => this.executor.stop())
    if (this.options.start !== false) await this.startAll()
  }
  /** Executor first (it must be reachable when the home looks), then the home. */
  async startAll(extraHome: string[] = []) {
    this.executor.spawn(); await this.executor.wait('started')
    this.home.spawn(extraHome); await this.home.wait('started')
    this.leadConnection = this.home.find('started')!['leadConnectionId'] ?? ''
  }
  /** Restart the home so that it starts the lead once (`--lead-prompt-file`/`--project`): the project must exist first. */
  async restartHomeWithLead(brief: unknown, prompt = 'Make the fixture project green') {
    await this.home.stop()
    this.writeScenario(brief)
    const file = join(this.dir, 'lead-prompt.txt')
    writeFileSync(file, prompt)
    this.home.spawn(['--lead-prompt-file', file, '--project', this.projectId])
    await this.home.wait('started')
    return this.home.wait('lead-started')
  }
  /** The fixture ACP agent as the lead bridge and as the Claude Code CLI (it answers `auth status` too). */
  private writeLeadFixture() {
    const agentDir = join(this.homeDir, 'claude-code')
    mkdirSync(agentDir, { recursive: true })
    const executable = join(agentDir, 'fixture-agent.mjs')
    writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL('fixture-process.mjs', FIXTURES), 'utf8'))
    chmodSync(executable, 0o700)
    copyFileSync(new URL('fixtures/claude-code-0.94.0.json', FIXTURES), join(agentDir, 'tape.json'))
  }
  writeScenario(brief: unknown) {
    const tape = JSON.parse(readFileSync(new URL('fixtures/claude-code-0.94.0.json', FIXTURES), 'utf8'))
    writeFileSync(join(this.homeDir, 'claude-code', 'scenario.json'), JSON.stringify({ tape, lead: { loadSession: true, briefs: [brief],
      usagePerTurn: { inputTokens: 1000, outputTokens: 200, amount: 0.5 }, resumeDelayMs: 1500 } }))
  }
  agentEvents(): Array<Record<string, any>> {
    try { return readFileSync(join(this.homeDir, 'claude-code', 'lead-events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
  }
  /** The project the relay works on, registered through the public HTTP API as an operator would. */
  async registerProject(): Promise<string> {
    const workspace = await this.home.api('POST', '/api/workspaces', { rootPath: this.project, name: 'ms1-live-fixture' })
    if (workspace.status !== 201) throw new Error(`workspace ${workspace.status} ${JSON.stringify(workspace.body)}`)
    const project = await this.home.api('POST', '/api/projects', { name: 'ms1-live-fixture' })
    if (project.status !== 201) throw new Error(`project ${project.status}`)
    const roots = await this.home.api('PATCH', `/api/agent/projects/${project.body.id}/roots`, { workspaceIds: [workspace.body.id] })
    if (roots.status !== 200) throw new Error(`roots ${roots.status} ${JSON.stringify(roots.body)}`)
    return this.projectId = project.body.id
  }
  /** A relay start body: `items` plan items, each written and proved by the fake model's script. */
  relayInput(key: string, items = 2, overrides: Record<string, unknown> = {}) {
    const ids = Array.from({ length: items }, (_, i) => `i${i + 1}`)
    return { key, projectId: this.projectId, connectionId: this.home.find('started')!['connectionId'], model: 'fixture', consent: 'full-access', domains: [],
      plan: { revision: 'r1', base: this.base, goal: 'Write ms1-<item>.txt for each item and prove it.', protectedPaths: [],
        items: ids.map((id, i) => ({ id, title: `artifact ${id}`, dependsOn: i ? [ids[i - 1]!] : [], acceptance: ['grep', '-q', `ms1-green-${id}`, `ms1-${id}.txt`], protectedPaths: [] })) },
      caps: { cycles: 10, tokens: 1_000_000, wallMs: 3_600_000, moneyMicros: null }, ...overrides }
  }
  async startRelay(key: string, items = 2, overrides: Record<string, unknown> = {}) {
    return this.home.api('POST', '/api/relay', this.relayInput(key, items, overrides))
  }
  async relayStatus(key: string) { return (await this.home.api('GET', `/api/relay/starts/${key}`)).body }
  ledger(runId: string): any { return JSON.parse(String(this.home.one('SELECT snapshot FROM relay_runs WHERE run_id=?', runId)?.['snapshot'])) }
  async close() {
    for (const close of [...this.closers].reverse()) { try { await Promise.race([close(), new Promise(resolve => setTimeout(resolve, 15_000).unref())]) } catch { /* best effort */ } }
    // A quarantined sandbox keeps its directory; `.lane-data` is ignored by git.
    try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* leave it for the next cleanup */ }
  }
}
