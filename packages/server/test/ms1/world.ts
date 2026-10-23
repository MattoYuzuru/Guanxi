/** The parent side of the MS1 rehearsal: the executor node, the fake llama-server behind it, the home node as a
 * killable child process, and read-only views of the home's database for assertions.
 *
 * Everything is loopback. The two nodes talk the real signed F2 protocol over HTTP; time is injected and moves only
 * when the home reaches the gap between two relay cycles. */
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import type { LeadDelegateInput } from '@guanxi/contract'
import { FederationChannel } from '../../src/federation/channel.ts'
import { Connections } from '../../src/connections/service.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import { OllamaClient } from '../../src/ollama/client.ts'
import { BalanceProbes } from '../../src/probes/balances.ts'
import type { DispatchPolicy } from '../../src/remote-attempts/dispatch.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { LlamaServerClient } from '../../src/runtime/llama-server/client.ts'
import { LlamaServerRuntime } from '../../src/runtime/llama-server/runtime.ts'
import { Vault } from '../../src/vault/vault.ts'
import { identity, SimNode } from '../federation/harness.ts'
import { startFakeLlama, type FakeLlama } from '../fixtures/fake-llama-server.ts'
import { ms1Script } from './llama-script.ts'
import type { HomeConfig } from './home-process.ts'

const exec = promisify(execFile)
export const START = 1_800_000_000_000
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const OWNER = 'local'
const HOME_SCRIPT = fileURLToPath(new URL('./home-process.ts', import.meta.url))
const FIXTURES = new URL('../external-agents/', import.meta.url)

export async function until(predicate: () => boolean | Promise<boolean>, what: string, ms = 90_000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(`timed out waiting for ${what}`)
}
type Message = Record<string, any> & { event: string }
export interface Gap { run: string; cycle: number; now: number }

/** One incarnation of the home node. */
export class HomeProcess {
  readonly child: ChildProcess
  readonly messages: Message[] = []
  readonly stderr: string[] = []
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private readonly listeners = new Set<() => void>()
  private closed = false
  constructor(child: ChildProcess, onMessage: (message: Message) => void) {
    this.child = child
    child.stderr?.on('data', chunk => { this.stderr.push(String(chunk)) })
    child.on('message', (message: Message) => { this.messages.push(message); onMessage(message); for (const listener of [...this.listeners]) listener() })
    this.exited = new Promise(resolve => child.once('exit', (code, signal) => { this.closed = true; for (const listener of [...this.listeners]) listener(); resolve({ code, signal }) }))
  }
  get alive() { return !this.closed }
  send(message: Record<string, unknown>) { this.child.send(message) }
  find(event: string): Message | undefined { return this.messages.find(m => m.event === event) }
  all(event: string): Message[] { return this.messages.filter(m => m.event === event) }
  async wait<T>(what: string, probe: () => T | undefined, ms = 90_000): Promise<T> {
    let value: T | undefined
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`timed out waiting for ${what}\n${this.stderr.join('').slice(-3000)}`)) }, ms)
      const check = () => {
        const fatal = this.find('fatal')
        if (fatal) { clearTimeout(timer); this.listeners.delete(check); reject(new Error(`home process failed: ${fatal.error}`)); return }
        value = probe()
        if (value !== undefined) { clearTimeout(timer); this.listeners.delete(check); resolve(); return }
        if (this.closed) { clearTimeout(timer); this.listeners.delete(check); reject(new Error(`home process exited while waiting for ${what}\n${this.stderr.join('').slice(-3000)}`)) }
      }
      this.listeners.add(check); check()
    })
    return value as T
  }
  async kill() { if (this.alive) { this.child.kill('SIGKILL'); await this.exited } }
}

export interface WorldOptions {
  /** Plan items, one relay cycle each. */
  items: number
  /** Simulated time added before every relay cycle after the first. */
  gapMs?: number
  leadDeadlineMs?: number
  /** Called at every gap, while no model call is in flight and before the clock has been told to the executor. */
  onGap?: (gap: Gap, world: World) => void | Promise<void>
}

let container: Promise<void> | undefined
/** The acceptance gates run in K4's container sandbox on macOS: say so at once instead of timing out in a relay. */
function containerRuntime(): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve()
  return container ??= exec('docker', ['info', '--format', '{{.OSType}}'], { timeout: 15_000, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env['PATH'] ?? ''}` } })
    .then(() => undefined, error => { throw new Error(`The MS1 rehearsal needs the local container runtime (Colima) for its acceptance gates: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`) })
}

export async function createWorld(t: { after(fn: () => unknown): void }, options: WorldOptions) {
  await containerRuntime()
  // Colima shares the checkout, not macOS tmpdir(): the allocator root must live under the working directory.
  mkdirSync(join(process.cwd(), '.lane-data'), { recursive: true })
  const dir = realpathSync(mkdtempSync(join(process.cwd(), '.lane-data', 'ms1-')))
  const world = new World(dir, options)
  t.after(async () => { await world.close() })
  try { await world.init() } catch (error) { await world.close(); throw error }
  return world
}

export class World {
  readonly dir: string
  readonly options: WorldOptions
  readonly homeDir: string
  readonly project: string
  readonly checkouts: string
  readonly gaps: Gap[] = []
  /** The newest simulated time the home has told us. */
  now = START
  homeUrl: string | null = null
  base = ''
  homeKeys = identity('ms1-home', { scopes: ['config', 'replicas', 'commands', 'telemetry', 'attempts'] })
  readonly targetKeys = identity('ms1-executor', { scopes: ['config', 'replicas', 'commands', 'telemetry', 'attempts'] })
  /** Registered with the home's egress scrubber and printed by the first item's gate; see `brief`. */
  readonly canary = `ms1-canary-${randomBytes(12).toString('hex')}`
  homes: HomeProcess[] = []
  /** Every federation request the executor received, in order (the pin carries its action). */
  readonly requests: string[] = []
  executorUrl = ''
  target!: SimNode
  fake!: FakeLlama
  llama!: LlamaServerRuntime
  leadConnection = ''
  executorConnection = ''
  private closers: Array<() => unknown> = []
  private configIndex = 0
  constructor(dir: string, options: WorldOptions) {
    this.dir = dir; this.options = options
    this.homeDir = join(dir, 'home'); this.project = join(dir, 'project'); this.checkouts = join(dir, 'checkouts')
  }

  private async git(args: string[], cwd = this.project) {
    return (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd })).stdout.trim()
  }
  async init() {
    mkdirSync(this.project, { recursive: true })
    writeFileSync(join(this.project, 'README.md'), 'MS1 rehearsal fixture project\n')
    await this.git(['init', '-q', '-b', 'main']); await this.git(['add', '.']); await this.git(['commit', '-q', '-m', 'fixture'])
    this.base = await this.git(['rev-parse', 'HEAD'])
    await this.startExecutor()
  }

  /** The executor node: its own federation node, an operational llama-server stand-in, and an HTTP port. */
  private async startExecutor() {
    const modelPath = join(this.dir, 'model.gguf')
    writeFileSync(modelPath, 'GGUF-ms1-weights')
    this.fake = await startFakeLlama({ alias: 'fixture', modelPath, nCtx: 16000, replies: [ms1Script] })
    this.closers.push(() => this.fake.close())
    const governor = new ResourceGovernor()
    let target!: SimNode
    const clock = () => target.time
    const toHome = new FederationChannel({ local: this.targetKeys.identity, privateKey: this.targetKeys.privateKey, peer: this.homeKeys.identity, clock,
      transport: async request => {
        if (!this.homeUrl) throw new Error('the home node is down')
        const url = new URL(request.url)
        return fetch(this.homeUrl + url.pathname + url.search, { method: request.method, headers: request.headers,
          ...(request.method === 'GET' ? {} : { body: await request.text() }), redirect: 'error' })
      } })
    // As in the F2-d fixture, the policy is completed once the node exists: its connections need the node's scrubber.
    const policy: DispatchPolicy = { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: clock, channel: () => toHome }
    target = this.target = new SimNode(this.targetKeys, ':memory:', { attempts: { governor, maxReservationMs: 5000, leaseClock: clock }, dispatch: policy })
    target.time = START
    target.federation.trust(this.homeKeys.identity)
    const store = new ConnectionStore(join(this.dir, 'executor-connections.sqlite'), target.scrubber)
    const vault = new Vault(store, async () => { throw new Error('No fixture keychain') }, target.scrubber, { ownerDevice: true, nodeKeyOptIn: true })
    const abort = new AbortController()
    const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async () => { throw new Error('Ollama must not be used') } })
    const connections = new Connections(store, vault, new BalanceProbes(store, vault), target.scrubber, abort.signal, { client: () => client }, governor, () => 'http://127.0.0.1:11434')
    const connection = connections.create('owner', { name: 'Executor fixture', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
    this.llama = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: this.fake.url }), model: 'fixture', clock, countTimeoutMs: 5000 })
    policy.connections = connections
    policy.localModel = model => ({ connectionId: connection.id, model, placement: 'installed_local', source: 'fixture installed inventory', observedAt: target.time })
    policy.relayRuntime = this.llama
    const server = serve({ port: 0, hostname: '127.0.0.1', fetch: async (request: Request) => {
      const path = new URL(request.url).pathname.replace('/api/federation', '')
      this.requests.push(path === '/attempts/runtime/pin' ? `${path}:${(await request.clone().json().catch(() => ({})) as { action?: string }).action}` : path)
      return target.app.fetch(request)
    } })
    await new Promise<void>(resolve => server.once('listening', resolve))
    this.executorUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    this.closers.push(async () => {
      (server as unknown as { closeAllConnections(): void }).closeAllConnections(); server.close(); abort.abort()
      target.federation.close(); await this.llama.close(); await connections.close(); vault.close(); store.close()
      target.close(); await governor.close()
    })
  }

  /** Start (or restart) the home node. Returns once it is listening and has told us its clock. */
  async startHome(opts: { crash?: { label: string; nth: number }; restart?: boolean; gapMs?: number } = {}): Promise<HomeProcess> {
    const config: HomeConfig = {
      dir: this.homeDir, project: this.project, checkouts: this.checkouts, owner: OWNER, home: { identity: this.homeKeys.identity, privateKey: this.homeKeys.privateKey },
      target: this.targetKeys.identity, executorUrl: this.executorUrl, clock: this.now, restart: opts.restart ?? false, crash: opts.crash ?? null,
      gapMs: opts.gapMs ?? this.options.gapMs ?? 75 * MINUTE, ttlMs: 100 * MINUTE,
      reserves: { turn: 1000, safety: 200, handoff: 1500, tool: 1000, stepMedian: 1000, effective: 14000 },
      limits: { maxCaps: { cycles: 60, tokens: 4_000_000, moneyMicros: 1_000_000, wallMs: 24 * HOUR }, maxDeadlineMs: 72 * HOUR },
      model: 'fixture', executorName: 'ms1-executor', canary: this.canary }
    const path = join(this.dir, `home-${this.configIndex++}.json`)
    writeFileSync(path, JSON.stringify(config))
    const child = fork(HOME_SCRIPT, [], { env: { ...process.env, MS1_CONFIG: path }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const home = new HomeProcess(child, message => this.onMessage(home, message))
    this.homes.push(home)
    const ready = await home.wait('the home node to be ready', () => home.find('ready'))
    this.homeUrl = `http://127.0.0.1:${ready['port']}`
    this.leadConnection = ready['leadConnection']; this.executorConnection = ready['executorConnection']
    this.now = ready['clock']; this.target.time = this.now
    return home
  }
  /** Start the home, give it the lead scenario and let it load the lead service. */
  async boot(opts: { crash?: { label: string; nth: number }; restart?: boolean; briefs?: (world: World) => LeadDelegateInput[]; scenario?: Record<string, unknown> } = {}): Promise<HomeProcess> {
    const home = await this.startHome(opts)
    // The briefs name the executor connection, which the home creates and reports when it is ready.
    if (!opts.restart) { const briefs = opts.briefs?.(this) ?? [this.brief()]; this.writeScenario(briefs[0]!, { briefs, ...opts.scenario }) }
    home.send({ cmd: 'go' })
    await home.wait('the lead service to load', () => home.find('loaded'))
    return home
  }
  /** Ask the lead to start. Resolves with its run id once the run exists; `first` settles when its first turn does. */
  async startLead(home: HomeProcess, prompt = 'Make the fixture project green'): Promise<{ runId: string; first: Promise<Message> }> {
    const seen = home.all('lead-started').length
    home.send({ cmd: 'start-lead', prompt })
    const started = await home.wait('the lead to start', () => home.all('lead-started')[seen])
    return { runId: started['runId'], first: home.wait('the lead\'s first turn', () => home.all('lead-first')[seen]) }
  }
  private onMessage(home: HomeProcess, message: Message) {
    if (message.event !== 'gap') return
    const gap: Gap = { run: message['run'], cycle: message['cycle'], now: message['now'] }
    this.gaps.push(gap)
    void (async () => {
      try { await this.options.onGap?.(gap, this) } catch (error) { home.messages.push({ event: 'fatal', error: `onGap: ${error instanceof Error ? error.stack : String(error)}` }) }
      // The executor learns the new time only now, with the home quiet and nothing in flight.
      this.now = gap.now; this.target.time = gap.now
      if (home.alive) home.send({ cmd: 'gap-ack' })
    })()
  }
  /** The ACP lead the home will run: one delegation with the given plan, resumed once by the wake. */
  writeScenario(brief: LeadDelegateInput, extra: Record<string, unknown> = {}) {
    const agentDir = join(this.homeDir, 'claude-code')
    mkdirSync(agentDir, { recursive: true })
    const tape = JSON.parse(readFileSync(new URL('fixtures/claude-code-0.94.0.json', FIXTURES), 'utf8'))
    writeFileSync(join(agentDir, 'scenario.json'), JSON.stringify({ tape, lead: { loadSession: true, briefs: [brief],
      usagePerTurn: { inputTokens: 1000, outputTokens: 200, amount: 0.5 }, resumeDelayMs: 1500, ...extra } }))
  }
  brief(overrides: Partial<LeadDelegateInput> = {}): LeadDelegateInput {
    const ids = Array.from({ length: this.options.items }, (_, i) => `i${i + 1}`)
    return {
      objective: 'Produce one green artifact per item', definitionOfDone: ['every item gate is green in a clean checkout'],
      plan: { revision: 'r1', base: this.base, goal: 'Write ms1-<item>.txt for each item and prove it.', protectedPaths: [],
        items: ids.map((id, i) => ({ id, title: `artifact ${id}`, dependsOn: i ? [ids[i - 1]!] : [],
          // The first gate also prints the registered canary, assembled at run time so that the plan itself never contains it.
          acceptance: i ? ['grep', '-q', `ms1-green-${id}`, `ms1-${id}.txt`]
            : ['sh', '-c', `p=${this.canary.slice(0, 11)}; s=${this.canary.slice(11)}; echo "$p$s"; grep -q ms1-green-${id} ms1-${id}.txt`], protectedPaths: [] })) },
      caps: { cycles: 40, tokens: 2_000_000, moneyMicros: 500_000, wallMs: 12 * HOUR },
      executor: { connectionId: this.executorConnection, model: 'fixture' }, deadlineMs: this.options.leadDeadlineMs ?? 48 * HOUR, onDeadline: 'wrap_up', onCancel: 'cancel',
      ...overrides,
    }
  }

  // ---- read-only views of the home database (WAL: safe beside the writer, and after a kill) ----
  db<T>(read: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(this.homeDir, 'node.sqlite'), { readOnly: true })
    try { return read(db) } finally { db.close() }
  }
  rows<T = Record<string, any>>(sql: string, ...args: Array<string | number>): T[] {
    return this.db(db => db.prepare(sql).all(...args).map(row => ({ ...row }) as T))
  }
  one<T = Record<string, any>>(sql: string, ...args: Array<string | number>): T | undefined { return this.rows<T>(sql, ...args)[0] }
  count(sql: string, ...args: Array<string | number>): number { return Number((this.one<{ n: number }>(sql, ...args))?.n ?? 0) }
  costs(runId: string) { return this.rows('SELECT entry_key,input_tokens,output_tokens,cost_microunits,currency FROM run_costs WHERE run_id=? ORDER BY entry_key', runId) }
  state(runId: string): string { return String(this.one('SELECT state FROM durable_runs WHERE id=?', runId)?.['state']) }
  wakes(runId: string) { return this.rows('SELECT wake_seq,kind,acknowledged_at,suppressed_at,attempt_id FROM outbox WHERE run_id=? ORDER BY wake_seq', runId) }
  relayStarts() {
    if (!this.one("SELECT 1 AS x FROM sqlite_master WHERE name='relay_public_starts'")) return []
    return this.rows<{ key: string; run_id: string; status: string }>('SELECT key,run_id,status FROM relay_public_starts ORDER BY rowid')
  }
  ledger(runId: string): any { return JSON.parse(String(this.one('SELECT snapshot FROM relay_runs WHERE run_id=?', runId)?.['snapshot'])) }
  packet(runId: string): any | null {
    const row = this.one('SELECT * FROM lead_wakes WHERE run_id=? ORDER BY wake_seq DESC', runId)
    if (!row) return null
    const field = Object.keys(row).find(key => /packet/.test(key) && typeof row[key] === 'string')
    return field ? JSON.parse(row[field]) : null
  }
  /** The fixture agent's own append-only log of what it was asked and what it did. */
  agentEvents(): Array<Record<string, any>> {
    try { return readFileSync(join(this.homeDir, 'claude-code', 'lead-events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
  }
  wakePrompts() { return this.agentEvents().filter(e => e.event === 'prompt' && String(e['text']).includes('guanxi.wake/v1')) }
  /** Live processes of the lead agent: the fixture executable path is unique to this world. */
  async agentProcesses(): Promise<string[]> {
    const { stdout } = await exec('/bin/ps', ['-Ao', 'pid=,command='])
    return stdout.split('\n').filter(line => line.includes(join(this.homeDir, 'claude-code', 'fixture-agent.mjs')))
  }

  /** The finished work, applied to a pristine clone of the project at the plan base, and the acceptance commands run there. */
  async cleanCheckout(relayRunId: string) {
    const ledger = this.ledger(relayRunId)
    const seal = this.one('SELECT bundle FROM relay_seals WHERE run_id=? ORDER BY cycle DESC LIMIT 1', relayRunId)
    const root = mkdtempSync(join(this.dir, 'clean-'))
    const bundle = join(root, 'work.bundle'), checkout = join(root, 'checkout'), pristine = join(root, 'pristine')
    writeFileSync(bundle, seal?.['bundle'] as Uint8Array)
    const git = (args: string[], cwd: string) => exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd }).then(r => r.stdout.trim())
    await git(['clone', '-q', '--no-hardlinks', this.project, checkout], root); await git(['clone', '-q', '--no-hardlinks', this.project, pristine], root)
    await git(['fetch', '-q', bundle, 'HEAD'], checkout); await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], checkout)
    const run = async (cwd: string, argv: string[]) => exec(argv[0]!, argv.slice(1), { cwd }).then(() => 0, (error: { code?: number }) => error.code ?? -1)
    const items = ledger.plan.items as Array<{ id: string; acceptance: string[] }>
    return { head: await git(['rev-parse', 'HEAD'], checkout), ledgerHead: ledger.head as string,
      results: await Promise.all(items.map(async item => ({ item: item.id, code: await run(checkout, item.acceptance) }))),
      /** The same commands in a clone that never received the work: they must fail, or the check above proves nothing. */
      control: await Promise.all(items.map(async item => ({ item: item.id, code: await run(pristine, item.acceptance) }))) }
  }

  /** Work files in the owned checkout(s): the proof that the model's writes landed there and not in the project. */
  async ownedFiles(): Promise<string[]> {
    const { stdout } = await exec('/usr/bin/find', [this.checkouts, '-name', 'ms1-i*.txt', '-not', '-path', '*/.git/*'])
    return stdout.split('\n').filter(Boolean).map(path => path.slice(path.lastIndexOf('/') + 1)).sort()
  }
  /** The project the plan was cut from is only ever read: its working tree and HEAD never move. */
  async projectUntouched(): Promise<{ status: string; head: string }> {
    return { status: await this.git(['status', '--porcelain', '--untracked-files=all']), head: await this.git(['rev-parse', 'HEAD']) }
  }
  /** Is a process of this world's lead agent alive by pid? */
  static alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }

  async close() {
    for (const home of this.homes) { if (home.alive) { home.child.kill('SIGKILL'); await home.exited } }
    // A killed home can leave its agent behind until the next start; these are this world's own processes, found by its unique path.
    for (const line of await this.agentProcesses().catch(() => [] as string[])) { try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL') } catch { /* gone */ } }
    for (const close of this.closers.reverse()) { try { await Promise.race([close(), new Promise(resolve => setTimeout(resolve, 8000).unref())]) } catch { /* best effort */ } }
    // A quarantined sandbox keeps its directory; the lane's `.lane-data` is ignored by git.
    try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* leave it for the next cleanup */ }
  }
}
