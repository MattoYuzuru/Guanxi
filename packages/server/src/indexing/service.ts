import type { ChildProcess } from 'node:child_process'
import { indexProcess, stopIndexProcess, grammarDirectories } from './process.ts'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, realpath, mkdtemp, writeFile, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { EgressScrubber } from '../egress/types.ts'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'
import { HeadroomMonitor, type HeadroomObservation } from './headroom.ts'
import { DEFAULT_INDEX_SETTINGS, type IndexRequest, type IndexSettings, type IndexWorkerData, type MapResult, type Provenance, type SearchResult } from './types.ts'
import { hash, inside, projectFingerprint } from './snapshot.ts'
import { IndexStore } from './store.ts'
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
  private readonly tracked = new Set<string>()
  private readonly workers = new Set<ChildProcess>()
  private readonly abort = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private building = false
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
    this.tracked.add(canonical)
    void this.tick()
  }
  /** Explicit removal is immediate; a deleted root is untracked by the next tick. */
  async untrack(root: string): Promise<boolean> {
    let canonical = root
    try { canonical = await realpath(root) } catch { /* already gone */ }
    const removed = this.tracked.delete(canonical)
    if (removed) {
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
  private fingerprint(root: string, commit: string | null, tree: string, digest: string): string {
    return hash(JSON.stringify([root, commit, tree, digest]))
  }
  private publishedFingerprint(root: string): string | undefined {
    try {
      const store = new IndexStore(this.database)
      try { return store.root(hash(root))?.fingerprint } finally { store.close() }
    } catch { return undefined }
  }
  private publishedProvenance(root: string, commit: string | null): Provenance {
    try {
      const store = new IndexStore(this.database)
      try {
        const key = hash(root), row = store.root(key), indexed = store.indexed(key)
        return { source: 'live-tree+content-cache', observedAt: new Date().toISOString(), commit, indexCommit: row?.commit_id ?? null,
          indexAgeMs: row ? Math.max(0, Date.now() - Date.parse(row.indexed_at)) : null,
          coverage: { eligible: indexed.size, indexed: indexed.size, skipped: 0, symbols: 0 }, freshness: 'verified-snapshot', embeddings: false }
      } finally { store.close() }
    } catch {
      return { source: 'live-tree+content-cache', observedAt: new Date().toISOString(), commit, indexCommit: null, indexAgeMs: null,
        coverage: { eligible: 0, indexed: 0, skipped: 0, symbols: 0 }, freshness: 'verified-snapshot', embeddings: false }
    }
  }
  private async root(path: string): Promise<string> {
    this.abort.signal.throwIfAborted()
    const [root, data] = await Promise.all([realpath(path), realpath(this.options.dataDir)])
    if (root === '/' || inside(root, data) || !this.options.ephemeral && inside(data, root)) throw new Error('index_root_denied')
    return root
  }
  private safe(text: string): boolean {
    try { return this.options.scrubber.isReady() && this.options.scrubber.scrub(text) === text } catch { return false }
  }
  private invoke(request: IndexRequest, signal?: AbortSignal, extras: Partial<IndexWorkerData> = {}): Promise<unknown> {
    const task = this.invokeWorker(request, signal, extras)
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }
  private async invokeWorker(request: IndexRequest, signal?: AbortSignal, extras: Partial<IndexWorkerData> = {}): Promise<unknown> {
    const root = await this.root(request.root)
    if (!this.options.scrubber.isReady()) throw new Error('index_scrubber_unavailable')
    signal?.throwIfAborted()
    if (request.kind === 'build') await mkdir(join(this.options.dataDir, 'knowledge-index'), { recursive: true, mode: 0o700 })
    this.runtime ??= this.prepareRuntime()
    const runtime = await this.runtime
    const worker = await indexProcess(join(runtime, this.captured[0]!.name), root, this.options.dataDir)
    this.workers.add(worker)
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])])
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const abort = () => { void stopIndexProcess(worker); reject(new Error('index_cancelled')) }
        combined.addEventListener('abort', abort, { once: true })
        worker.on('message', (message: { kind: string; id: number; code?: string; result: unknown }) => {
          if (message.kind === 'check') {
            // The worker scrubs; the parent only answers whether the registered
            // snapshot it was given is still current. No secret text crosses IPC
            // in either direction.
            let allowed = true
            if (extras.secretDigest) {
              try { allowed = this.secretDigest(this.secretSnapshot()) === extras.secretDigest } catch { allowed = false }
            }
            if (worker.connected) worker.send({ id: message.id, allowed }, () => {})
          } else if (message.kind === 'result') resolve(message.result)
          else reject(new Error(message.code && /^index_[a-z_]+$/.test(message.code) ? message.code : 'index_unavailable'))
        })
        worker.once('error', () => reject(new Error('index_unavailable')))
        worker.once('close', code => { combined.removeEventListener('abort', abort); reject(new Error(code === 0 ? 'index_unavailable' : 'index_interrupted')) })
        if (combined.aborted) abort()
        else worker.send({ data: { ...extras, request: { ...request, root }, database: this.database, settings: this.settings, grammarDirectories } satisfies IndexWorkerData }, error => { if (error) reject(new Error('index_unavailable')) })
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
    return directory
  }
  async build(root: string, signal?: AbortSignal): Promise<Provenance> {
    const canonical = await this.root(root)
    this.abort.signal.throwIfAborted()
    if (!this.options.scrubber.isReady()) throw new Error('index_scrubber_unavailable')
    let secrets = this.secretSnapshot()
    let digest = this.secretDigest(secrets)
    const tree = await projectFingerprint(canonical, this.settings, async path => this.safe(path))
    signal?.throwIfAborted()
    let changeFingerprint = this.fingerprint(canonical, tree.commit, tree.fingerprint, digest)
    // An unchanged tree means no content scan, purge, publish or manifest
    // rewrite. Registration state is part of the fingerprint because a newly
    // registered value must still trigger a purge.
    if (changeFingerprint === this.publishedFingerprint(canonical)) {
      this.lastBuild = 'complete'
      this.emit('skip', canonical)
      return this.publishedProvenance(canonical, tree.commit)
    }
    const control = new AbortController()
    const observation = this.lastHeadroom = await this.headroom()
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
          this.emit('build', canonical)
          const result = await this.invoke({ kind: 'build', root: canonical }, combined, { changeFingerprint, secrets, secretDigest: digest }) as Provenance
          this.lastBuild = 'complete'
          this.emit('publish', canonical)
          return result
        } catch (error) {
          // A registration that lands during the build invalidates the worker's
          // snapshot. Restart so the new purge and content checks see it.
          if (attempt < 2 && !combined.aborted && error instanceof Error && error.message === 'index_secret_changed') {
            secrets = this.secretSnapshot()
            digest = this.secretDigest(secrets)
            changeFingerprint = this.fingerprint(canonical, tree.commit, tree.fingerprint, digest)
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
      for (const root of [...this.tracked]) {
        try {
          const named = await lstat(root)
          if (!named.isDirectory() && !named.isFile()) { await this.untrack(root); continue }
          await this.build(root)
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
