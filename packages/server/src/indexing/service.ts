import { Worker } from 'node:worker_threads'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EgressScrubber } from '../egress/types.ts'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'
import { HeadroomMonitor, type HeadroomObservation } from './headroom.ts'
import { DEFAULT_INDEX_SETTINGS, type IndexRequest, type IndexSettings, type IndexWorkerData, type MapResult, type Provenance, type SearchResult } from './types.ts'
import { inside } from './snapshot.ts'
import { boundMap } from './engine.ts'

export interface IndexServiceOptions {
  dataDir: string
  scrubber: EgressScrubber
  governor: ResourceGovernor
  settings?: Partial<IndexSettings>
  headroom?: () => Promise<HeadroomObservation>
}
export class ProjectIndex {
  readonly settings: IndexSettings
  readonly database: string
  private readonly options: IndexServiceOptions
  private readonly tracked = new Set<string>()
  private readonly workers = new Set<Worker>()
  private readonly abort = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private building = false
  private readonly captured: { name: string; bytes: string }[]
  private runtime?: Promise<string>
  private headroom: () => Promise<HeadroomObservation>
  private lastHeadroom: HeadroomObservation | null = null
  private lastBuild: 'never' | 'complete' | 'deferred' | 'interrupted' = 'never'
  constructor(options: IndexServiceOptions) {
    this.options = options
    const built = existsSync(new URL('./index-worker.js', import.meta.url))
    const names = built ? ['index-worker.js'] : ['worker.ts', 'engine.ts', 'snapshot.ts', 'store.ts', 'parser.ts', 'types.ts']
    this.captured = names.map(name => ({ name, bytes: readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      .replace(/(['"])web-tree-sitter\1/g, JSON.stringify(import.meta.resolve('web-tree-sitter')))
      .replace(/(['"])ignore\1/g, JSON.stringify(import.meta.resolve('ignore')))
      .replaceAll('createRequire(import.meta.url)', `createRequire(${JSON.stringify(new URL(`./${name}`, import.meta.url).href)})`) }))
    this.settings = { ...DEFAULT_INDEX_SETTINGS, ...options.settings }
    for (const [key, n] of Object.entries(this.settings)) if (!Number.isSafeInteger(n) || n < (key === 'ftsMinFiles' ? 0 : 1)) throw new Error('index_settings_invalid')
    this.database = join(options.dataDir, 'knowledge-index', 'index.sqlite')
    const monitor = new HeadroomMonitor()
    this.headroom = options.headroom ?? (() => monitor.sample())
    this.timer = setInterval(() => { void this.tick() }, this.settings.pollMs)
    this.timer.unref()
  }
  status() { return { build: this.lastBuild, headroom: this.lastHeadroom, embeddings: false as const, settings: { ...this.settings } } }
  async track(root: string) {
    const canonical = await this.root(root)
    this.tracked.add(canonical)
    void this.tick()
  }
  private async root(path: string): Promise<string> {
    this.abort.signal.throwIfAborted()
    const [root, data] = await Promise.all([realpath(path), realpath(this.options.dataDir)])
    if (root === '/' || inside(root, data) || inside(data, root)) throw new Error('index_root_denied')
    return root
  }
  private safe(text: string): boolean {
    try { return this.options.scrubber.isReady() && this.options.scrubber.scrub(text) === text } catch { return false }
  }
  private async invoke(request: IndexRequest, signal?: AbortSignal, extras: Partial<IndexWorkerData> = {}): Promise<unknown> {
    const root = await this.root(request.root)
    if (!this.options.scrubber.isReady()) throw new Error('index_scrubber_unavailable')
    signal?.throwIfAborted()
    if (request.kind === 'build') await mkdir(join(this.options.dataDir, 'knowledge-index'), { recursive: true, mode: 0o700 })
    this.runtime ??= this.prepareRuntime()
    const runtime = await this.runtime
    const worker = new Worker(join(runtime, this.captured[0]!.name), { workerData: { ...extras, request: { ...request, root }, database: this.database, settings: this.settings } satisfies IndexWorkerData })
    this.workers.add(worker)
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])])
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const abort = () => { void worker.terminate(); reject(new Error('index_cancelled')) }
        combined.addEventListener('abort', abort, { once: true })
        worker.on('message', (message) => {
          if (message.kind === 'check') worker.postMessage({ id: message.id, allowed: this.safe(message.text) })
          else if (message.kind === 'result') resolve(message.result)
          else reject(new Error('index_unavailable'))
        })
        worker.once('error', () => reject(new Error('index_unavailable')))
        worker.once('exit', code => { combined.removeEventListener('abort', abort); reject(new Error(code === 0 ? 'index_unavailable' : 'index_interrupted')) })
        if (combined.aborted) abort()
      })
      if (!this.options.scrubber.isReady()) throw new Error('index_scrubber_unavailable')
      return this.options.scrubber.scrub(result)
    } finally { await worker.terminate(); this.workers.delete(worker) }
  }
  private async prepareRuntime(): Promise<string> {
    const directory = await mkdtemp(join(this.options.dataDir, 'index-runtime-'))
    await Promise.all(this.captured.map(source => writeFile(join(directory, source.name), source.bytes, { mode: 0o400, flag: 'wx' })))
    return directory
  }
  async build(root: string, signal?: AbortSignal): Promise<Provenance> {
    const control = new AbortController()
    const observation = this.lastHeadroom = await this.headroom()
    if (!observation.allowed) { this.lastBuild = 'deferred'; throw new Error('index_headroom') }
    const lease = this.options.governor.tryIdleLease(() => control.abort())
    if (!lease) { this.lastBuild = 'deferred'; throw new Error('index_governor_busy') }
    const combined = AbortSignal.any([control.signal, this.abort.signal, ...(signal ? [signal] : [])])
    const monitor = setInterval(() => {
      void this.headroom().then(sample => { this.lastHeadroom = sample; if (!sample.allowed) control.abort() }, () => control.abort())
    }, 1000)
    monitor.unref()
    try {
      const result = await this.invoke({ kind: 'build', root }, combined) as Provenance
      this.lastBuild = 'complete'
      return result
    } catch (error) { this.lastBuild = 'interrupted'; throw error }
    finally { clearInterval(monitor); lease.release() }
  }
  private async tick() {
    if (this.building || this.abort.signal.aborted || !this.options.scrubber.isReady()) return
    this.building = true
    try { for (const root of this.tracked) { try { await this.build(root) } catch { /* retry this root next tick */ } } }
    finally { this.building = false }
  }
  async search(root: string, text: string, path?: string, signal?: AbortSignal, limit = 200): Promise<SearchResult> {
    const result = await this.invoke({ kind: 'search', root, text, path, limit }, signal) as SearchResult
    await this.track(root)
    return result
  }
  async map(root: string, budget = 2048, path?: string, signal?: AbortSignal): Promise<MapResult> {
    const result = await this.invoke({ kind: 'map', root, path, budget }, signal) as MapResult
    await this.track(root)
    return boundMap(result, budget)
  }
  async close() {
    clearInterval(this.timer)
    this.abort.abort()
    await Promise.all([...this.workers].map(w => w.terminate()))
    this.workers.clear()
    this.tracked.clear()
    if (this.runtime) await rm(await this.runtime, { recursive: true, force: true })
  }
}
