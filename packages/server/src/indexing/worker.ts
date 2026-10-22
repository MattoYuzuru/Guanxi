import { parentPort, workerData } from 'node:worker_threads'
import { executeIndex } from './engine.ts'
import { projectFingerprint, hash } from './snapshot.ts'
import { IndexStore } from './store.ts'
import { PARSER_VERSION } from './parser.ts'
import type { IndexWorkerData, IndexBuildResult, Provenance } from './types.ts'

let next = 0
const pending = new Map<number, (allowed: boolean) => void>()
const send = (message: unknown) => parentPort ? parentPort.postMessage(message) : process.send?.(message)
/** The server sends the registered values over IPC at build start, so this
 * hot loop never scrubs secret values on the server's main thread. */
const formsOf = (value: string): string[] => {
  const forms = new Set<string>([value])
  forms.add(JSON.stringify(value).slice(1, -1))
  try { forms.add(encodeURIComponent(value)) } catch { /* lone surrogate */ }
  return [...forms].filter(form => form.length > 0)
}
const marker = (ref: string) => `\u27E6REDACTED ${ref}\u27E7`
function scrubber(secrets: IndexWorkerData['secrets'] = []) {
  const forms = secrets.flatMap(({ ref, value }) => formsOf(value).map(text => ({ text, ref })))
  // Longest form first; the trusted parent re-scrubs the final result with the
  // canonical K2 implementation.
  forms.sort((a, b) => b.text.length - a.text.length)
  const text = (value: string) => {
    let output = value
    for (const form of forms) if (output.includes(form.text)) output = output.split(form.text).join(marker(form.ref))
    return output
  }
  const any = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(any)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), any(item)]))
    return value
  }
  return { text, any }
}
const check = (): Promise<boolean> => new Promise(resolve => { const id = next++; pending.set(id, resolve); send({ kind: 'check', id }) })
const receive = (message: { id: number; allowed: boolean }) => { pending.get(message.id)?.(message.allowed); pending.delete(message.id) }
async function run(data: IndexWorkerData) {
  const scrub = scrubber(data.secrets)
  const allow = async (value: string): Promise<boolean> => {
    if (data.request.kind === 'build' && !(await check())) throw new Error('index_secret_changed')
    return scrub.text(value) === value
  }
  const checkpoint = async () => { if (data.request.kind === 'build' && !(await check())) throw new Error('index_secret_changed') }
  try {
    if (data.request.kind === 'build' && data.secretDigest) {
      // Ignore policies contain project bytes too. Keep even the cheap metadata
      // walk inside the same read-only OS boundary as the content scanner.
      const tree = await projectFingerprint(data.request.root, data.settings, allow)
      data.changeFingerprint = hash(JSON.stringify([data.request.root, tree.commit, tree.fingerprint, data.secretDigest,
        PARSER_VERSION, data.settings.ftsMinFiles, data.settings.maxFileBytes]))
      await checkpoint()
      let cached: IndexStore | undefined
      let unchanged: Provenance | undefined
      try {
        cached = new IndexStore(data.database)
        const key = hash(data.request.root), row = cached.root(key)
        if (row?.fingerprint === data.changeFingerprint) {
          const count = cached.indexed(key).size
          unchanged = { source: 'live-tree+content-cache', observedAt: new Date().toISOString(), commit: tree.commit,
            indexCommit: row.commit_id, indexAgeMs: Math.max(0, Date.now() - Date.parse(row.indexed_at)),
            coverage: { eligible: count, indexed: count, skipped: 0, symbols: 0 }, freshness: 'verified-snapshot', embeddings: false }
        }
      } catch { /* Missing/uninitialized cache requires a content build. */ }
      finally { cached?.close() }
      if (unchanged) {
        send({ kind: 'result', result: scrub.any({ provenance: unchanged, skipped: true } satisfies IndexBuildResult) })
        return
      }
      send({ kind: 'build' })
      const provenance = await executeIndex(data, allow, checkpoint) as Provenance
      send({ kind: 'result', result: scrub.any({ provenance, skipped: false } satisfies IndexBuildResult) })
    } else send({ kind: 'result', result: scrub.any(await executeIndex(data, allow, checkpoint)) })
  }
  catch (error) { send({ kind: 'error', code: error instanceof Error && /^index_[a-z_]+$/.test(error.message) ? error.message : 'index_unavailable' }) }
  finally { if (parentPort) parentPort.close(); else process.disconnect?.() }
}
if (parentPort) { parentPort.on('message', receive); await run(workerData) }
else {
  process.on('message', receive)
  process.once('message', (message: { data: IndexWorkerData }) => { void run(message.data) })
}
