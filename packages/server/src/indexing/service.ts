import type { ChildProcess } from 'node:child_process'
import { indexProcess, stopIndexProcess, grammarDirectories } from './process.ts'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, realpath, mkdtemp, writeFile, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { EgressScrubber } from '../egress/types.ts'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'
import { HeadroomMonitor, type HeadroomObservation } from './headroom.ts'
import { DEFAULT_INDEX_SETTINGS, type IndexRequest, type IndexSettings, type IndexWorkerData, type IndexBuildResult, type MapResult, type Provenance, type SearchResult } from './types.ts'
import { hash, inside } from './snapshot.ts'
import { boundMap } from './engine.ts'

const built = existsSync(new URL('./index-worker.js', import.meta.url))
const names = built ? ['index-worker.js'] : ['worker.ts', 'engine.ts', 'snapshot.ts', 'store.ts', 'parser.ts', 'types.ts']
const CAPTURED = names.map(name => ({ name, bytes: readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      .replace(/(['"])web-tree-sitter\1/g, JSON.stringify(import.meta.resolve('web-tree-sitter')))
      .replace(/(['"])ignore\1/g, JSON.stringify(import.meta.resolve('ignore')))
      .replaceAll('createRequire(import.meta.url)', `createRequire(${JSON.stringify(new URL(`./${name}`, import.meta.url).href)})`) }))

export interface IndexServiceOptions {
  dataDir: string
  scrubber: EgressScrubber
  governor: ResourceGovernor
  settings?: Partial<IndexSettings>
  ephemeral?: boolean
  headroomPollMs?: number
  headroom?: () => Promise<HeadroomObservation>
  onIndexEvent?: (event: IndexEvent) => void
}
export type IndexEvent = { type: 'build' | 'publish' | 'skip' | 'untrack'; root: string }
export class ProjectIndex {
  readonly settings: IndexSettings
  readonly database: string
  private readonly options: IndexServiceOptions
  private readonly tracked = new Map<string, AbortController>()
  private readonly workers = new Set<ChildProcess>()
  private readonly abort = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private building = false
  private buildTask?: Promise<Provenance>
  private activeBuild?: AbortController
  private activeRoot?: string
  private readonly captured: { name: string; bytes: string }[]
  private runtime?: Promise<string>
  private readonly pending = new Set<Promise<unknown>>()
  private closing?: Promise<void>
  private headroom: () => Promise<HeadroomObservation>
  private lastHeadroom: HeadroomObservation | null = null
  private lastBuild: 'never' | 'complete' | 'deferred' | 'interrupted' = 'never'
  constructor(options: IndexServiceOptions) {
    this.options = options
    this.captured = CAPTURED
    this.settings = { ...DEFAULT_INDEX_SETTINGS, ...options.settings }
    for (const [key, n] of Object.entries(this.settings)) if (!Number.isSafeInteger(n) || n < (key === 'ftsMinFiles' ? 0 : 1)) throw new Error('index_settings_invalid')
    this.database = join(options.dataDir, 'knowledge-index', 'index.sqlite')
    const monitor = new HeadroomMonitor()
    this.headroom = options.headroom ?? (() => monitor.sample())
    this.timer = setInterval(() => { void this.tick() }, this.settings.pollMs)
    this.timer.unref()
  }
  status() { return { build: this.lastBuild, headroom: this.lastHeadroom, embeddings: false as const, roots: this.tracked.size, settings: { ...this.settings } } }
  async track(root: string) {
    const canonical = await this.root(root)
    if (!this.tracked.has(canonical)) this.tracked.set(canonical, new AbortController())
    void this.tick()
  }
  /** Explicit removal is immediate; a deleted root is untracked by the next tick. */
  async untrack(root: string): Promise<boolean> {
    let canonical = root
    try { canonical = await realpath(root) } catch { /* already gone */ }
    const control = this.tracked.get(canonical)
    const removed = this.tracked.delete(canonical)
    if (removed) {
      control?.abort()
      this.emit('untrack', canonical)
      if (this.activeRoot === canonical) this.activeBuild?.abort()
    }
    return removed
  }
  private emit(type: IndexEvent['type'], root: string): void {
    try { this.options.onIndexEvent?.({ type, root }) } catch { /* observers cannot break indexing */ }
  }
  private secretSnapshot(): readonly { ref: string; value: string }[] {
    const snapshot = this.options.scrubber.snapshot
    if (!snapshot) throw new Error('index_scrubber_unavailable')
    return snapshot.call(this.options.scrubber).map(({ ref, value }) => ({ ref, value }))
  }
  private secretDigest(secrets: readonly { ref: string; value: string }[]): string {
    return hash(JSON.stringify([...secrets].sort((a, b) => a.ref.localeCompare(b.ref))))
  }
  private async root(path: string): Promise<string> {
    this.checkCancellation()
    const [root, data] = await Promise.all([realpath(path), realpath(this.options.dataDir)])
    if (root === '/' || inside(root, data) || !this.options.ephemeral && inside(data, root)) throw new Error('index_root_denied')
    return root
  }
  private checkCancellation(signal?: AbortSignal): void {
    if (this.abort.signal.aborted || signal?.aborted) throw new Error('index_cancelled')
  }
  private invoke(request: IndexRequest, signal?: AbortSignal, extras: Partial<IndexWorkerData> = {}): Promise<unknown> {
    const task = this.invokeWorker(request, signal, extras)
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }
  private async invokeWorker(request: IndexRequest, signal?: AbortSignal, extras: Partial<IndexWorkerData> = {}): Promise<unknown> {
    const root = await this.root(request.root)
    if (root !== request.root) throw new Error('index_tree_changed')
    const admittedRoot = request.kind === 'build' ? await lstat(root) : undefined
    if (admittedRoot?.isSymbolicLink()) throw new Error('index_tree_changed')
    // Linux keeps the admitted inode mounted after a host rename. Metadata-only
    // checks prevent that old tree from publishing under the replaced root name.
    const checkRoot = async () => {
      if (!admittedRoot) return
      try {
        const current = await lstat(root)
        if (current.isSymbolicLink() || current.dev !== admittedRoot.dev || current.ino !== admittedRoot.ino ||
          current.mtimeMs !== admittedRoot.mtimeMs) throw new Error('index_tree_changed')
      } catch { throw new Error('index_tree_changed') }
    }
    if (!this.options.scrubber.isReady()) throw new Error('index_scrubber_unavailable')
    this.checkCancellation(signal)
    if (request.kind === 'build') await mkdir(join(this.options.dataDir, 'knowledge-index'), { recursive: true, mode: 0o700 })
    this.runtime ??= this.prepareRuntime()
    const runtime = await this.runtime
    this.checkCancellation(signal)
    const dataDir = await realpath(this.options.dataDir)
    const worker = await indexProcess(join(runtime, this.captured[0]!.name), root, dataDir)
    this.workers.add(worker)
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])])
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        let receivedResult = false
        const abort = () => { void stopIndexProcess(worker); reject(new Error('index_cancelled')) }
        combined.addEventListener('abort', abort, { once: true })
        worker.on('message', async (message: { kind: string; id: number; code?: string; result: unknown }) => {
          if (message.kind === 'check') {
            try { await checkRoot() } catch (error) { reject(error); return }
            // The worker scrubs; the parent only answers whether the registered
            // snapshot it was given is still current. No secret text crosses IPC
            // in either direction.
            let allowed = true
            if (extras.secretDigest) {
              try { allowed = this.secretDigest(this.secretSnapshot()) === extras.secretDigest } catch { allowed = false }
            }
            if (worker.connected) worker.send({ id: message.id, allowed }, () => {})
          } else if (message.kind === 'build' && request.kind === 'build') this.emit('build', root)
          else if (message.kind === 'result') {
            receivedResult = true
            try { await checkRoot(); resolve(message.result) } catch (error) { reject(error) }
          }
          else reject(new Error(message.code && /^index_[a-z_]+$/.test(message.code) ? message.code : 'index_unavailable'))
        })
        worker.once('error', () => reject(new Error('index_unavailable')))
        worker.once('close', code => {
          combined.removeEventListener('abort', abort)
          if (!receivedResult) reject(new Error(code === 0 ? 'index_unavailable' : 'index_interrupted'))
        })
        if (combined.aborted) abort()
        else worker.send({ data: { ...extras, request: { ...request, root }, database: join(dataDir, 'knowledge-index', 'index.sqlite'), settings: this.settings, grammarDirectories } satisfies IndexWorkerData }, error => { if (error) reject(new Error('index_unavailable')) })
      })
      if (!this.options.scrubber.isReady()) throw new Error('index_scrubber_unavailable')
      return this.options.scrubber.scrub(result)
    } finally { await stopIndexProcess(worker); this.workers.delete(worker) }
  }
  private async prepareRuntime(): Promise<string> {
    const directory = await mkdtemp(join(this.options.dataDir, 'index-runtime-'))
    // A nearest package.json keeps Node's package lookup inside the sandboxed
    // runtime. An ancestor checkout package.json is unreadable there.
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n', { mode: 0o400, flag: 'wx' })
    await Promise.all(this.captured.map(source => writeFile(join(directory, source.name), source.bytes, { mode: 0o400, flag: 'wx' })))
    return realpath(directory)
  }
  async build(root: string, signal?: AbortSignal): Promise<Provenance> {
    this.checkCancellation(signal)
    // A query can schedule an idle tick just before an explicit build. Keep
    // this service's writers in order; the governor still refuses other owners.
    const previous = this.buildTask
    const task = (async () => {
      await previous?.catch(() => undefined)
      return this.buildRoot(root, signal)
    })()
    this.buildTask = task
    this.pending.add(task)
    const settled = () => {
      this.pending.delete(task)
      if (this.buildTask === task) this.buildTask = undefined
    }
    void task.then(settled, settled)
    return task
  }
  private async buildRoot(root: string, signal?: AbortSignal): Promise<Provenance> {
    this.checkCancellation(signal)
    const canonical = await this.root(root)
    this.checkCancellation(signal)
    if (!this.options.scrubber.isReady()) throw new Error('index_scrubber_unavailable')
    let secrets = this.secretSnapshot()
    let digest = this.secretDigest(secrets)
    this.checkCancellation(signal)
    const control = new AbortController()
    const observation = this.lastHeadroom = await this.headroom()
    this.checkCancellation(signal)
    if (!observation.allowed) { this.lastBuild = 'deferred'; throw new Error('index_headroom') }
    const lease = this.options.governor.tryIdleLease(() => control.abort())
    if (!lease) { this.lastBuild = 'deferred'; throw new Error('index_governor_busy') }
    this.activeBuild = control
    this.activeRoot = canonical
    const combined = AbortSignal.any([control.signal, this.abort.signal, ...(signal ? [signal] : [])])
    const monitor = setInterval(() => {
      void this.headroom().then(sample => { this.lastHeadroom = sample; if (!sample.allowed) control.abort() }, () => control.abort())
    }, this.options.headroomPollMs ?? 1000)
    monitor.unref()
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.invoke({ kind: 'build', root: canonical }, combined, { secrets, secretDigest: digest }) as IndexBuildResult
          this.lastBuild = 'complete'
          this.emit(result.skipped ? 'skip' : 'publish', canonical)
          return result.provenance
        } catch (error) {
          // A registration that lands during the build invalidates the worker's
          // snapshot. Restart so the new purge and content checks see it.
          if (attempt < 2 && !combined.aborted && error instanceof Error && error.message === 'index_secret_changed') {
            secrets = this.secretSnapshot()
            digest = this.secretDigest(secrets)
            continue
          }
          throw error
        }
      }
    } catch (error) { this.lastBuild = 'interrupted'; throw error }
    finally {
      clearInterval(monitor)
      if (this.activeBuild === control) this.activeBuild = undefined
      if (this.activeRoot === canonical) this.activeRoot = undefined
      lease.release()
    }
  }
  private async tick() {
    if (this.building || this.abort.signal.aborted || !this.options.scrubber.isReady()) return
    this.building = true
    try {
      for (const [root, control] of [...this.tracked]) {
        if (this.tracked.get(root) !== control) continue
        try {
          const named = await lstat(root)
          if (!named.isDirectory() && !named.isFile()) { await this.untrack(root); continue }
          await this.build(root, control.signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') await this.untrack(root)
        }
      }
    } finally { this.building = false }
  }
  async search(root: string, text: string, path?: string, signal?: AbortSignal, limit = 200): Promise<SearchResult> {
    this.activeBuild?.abort()
    const secrets = this.secretSnapshot()
    const result = await this.invoke({ kind: 'search', root, text, path, limit }, signal, { secrets }) as SearchResult
    if (!this.options.ephemeral) await this.track(root)
    return result
  }
  async map(root: string, budget = 2048, path?: string, signal?: AbortSignal): Promise<MapResult> {
    this.activeBuild?.abort()
    const secrets = this.secretSnapshot()
    const result = await this.invoke({ kind: 'map', root, path, budget }, signal, { secrets }) as MapResult
    if (!this.options.ephemeral) await this.track(root)
    return boundMap(result, budget)
  }
  close(): Promise<void> {
    return this.closing ??= this.finishClose()
  }
  private async finishClose() {
    clearInterval(this.timer)
    this.abort.abort()
    await Promise.allSettled([...this.pending])
    await Promise.all([...this.workers].map(w => stopIndexProcess(w)))
    this.workers.clear()
    this.tracked.clear()
    if (this.runtime) await rm(await this.runtime, { recursive: true, force: true })
  }
}
