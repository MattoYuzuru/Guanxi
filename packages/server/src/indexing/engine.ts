import { snapshot, inside } from './snapshot.ts'
import type { AllowContent } from './snapshot.ts'
import { IndexStore } from './store.ts'
import { symbols } from './parser.ts'
import { resolve } from 'node:path'
import type { IndexWorkerData, MapResult, Provenance, SearchResult, TreeSnapshot } from './types.ts'

function provenance(tree: TreeSnapshot, store?: IndexStore): Provenance {
  const row = store?.root(tree.rootKey)
  const indexed = store?.indexed(tree.rootKey) ?? new Map()
  return { source: 'live-tree+content-cache', observedAt: tree.observedAt, commit: tree.commit, indexCommit: row?.commit_id ?? null,
    indexAgeMs: row ? Math.max(0, Date.now() - Date.parse(row.indexed_at)) : null,
    coverage: { eligible: tree.files.length, indexed: tree.files.filter(f => indexed.get(f.path) === f.hash).length, skipped: tree.skipped, symbols: 0 }, freshness: 'verified-snapshot', embeddings: false }
}
/** Measures the complete serialized result, not only its entries. Byte-level
 * tokenizers cannot emit more tokens than UTF-8 bytes. No tokenizer is invented. */
export function boundMap(result: MapResult, budget: number): MapResult {
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('index_budget_invalid')
  result.tokenBound = budget
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= budget) return result
  if (!result.entries.length) throw new Error('index_budget_too_small')
  result.truncated = true
  const entries = result.entries
  const fits = () => Buffer.byteLength(JSON.stringify(result), 'utf8') <= budget
  result.entries = []
  if (!fits()) throw new Error('index_budget_too_small')
  // Prefix search avoids repeatedly serializing a large repository once for
  // every discarded symbol/file.
  let low = 0, high = entries.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    result.entries = entries.slice(0, mid)
    if (fits()) low = mid
    else high = mid - 1
  }
  result.entries = entries.slice(0, low)
  // The shorter spelling 'true' can save one byte by itself. A truncation
  // flag must still correspond to omitted content at that exact boundary.
  if (low === entries.length) result.entries.pop()
  const next = entries[low]
  if (next) {
    const partial = { ...next, symbols: [] as typeof next.symbols }
    result.entries.push(partial)
    if (!fits()) result.entries.pop()
    else {
      let count = 0, end = next.symbols.length
      while (count < end) {
        const mid = Math.ceil((count + end) / 2)
        partial.symbols = next.symbols.slice(0, mid)
        if (fits()) count = mid
        else end = mid - 1
      }
      partial.symbols = next.symbols.slice(0, count)
    }
  }
  // This is a bound of the entire envelope, including provenance and the bound itself.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > budget) throw new Error('index_budget_exceeded')
  return result
}

export async function executeIndex(data: IndexWorkerData, allow: AllowContent, checkpoint: () => Promise<void> = async () => {}, parse = symbols): Promise<unknown> {
  const { request, settings } = data
  // IX3 has no loader/provider/model route in X1, even if a caller sets the future flag.
  const tree = await snapshot(request.root, settings, allow)
  let store: IndexStore | undefined
  try {
    if (request.kind === 'build') {
      store = new IndexStore(data.database, true)
      await store.purgeUnsafe(allow)
      const fts = tree.files.length >= settings.ftsMinFiles
      for (const file of tree.files) {
        await checkpoint()
        const cached = store.map(file.hash, file.language)
        const map = cached ?? await parse(file.text, file.language, data.grammarDisabled, data.grammarDirectories)
        // Readiness and registered values are rechecked immediately before each write.
        if (!(await allow(file.text)) || !(await allow(file.path))) throw new Error('index_secret_changed')
        if (!cached || cached.source === 'file' && file.language !== 'file' || fts && !store.hasFts(file.hash)) store.put(file.hash, file.text, file.language, map, fts)
        if (data.crashPoint === 'content') process.exit(86)
      }
      await checkpoint()
      // A changed tree is never published as current. Durable content remains reusable.
      const current = await snapshot(request.root, settings, allow)
      if (tree.fingerprint !== current.fingerprint || tree.commit !== current.commit) throw new Error('index_tree_changed')
      store.publish(tree, data.crashPoint === 'manifest' ? () => process.exit(86) : undefined, data.changeFingerprint)
      return provenance(tree, store)
    }
    try { store = new IndexStore(data.database) } catch { /* IX0 is available without a database */ }
    store?.db.exec('BEGIN')
    const source = provenance(tree, store)
    const selectedPath = request.path ? resolve(request.root, request.path) : request.root
    if (!inside(request.root, selectedPath)) throw new Error('index_path_denied')
    const files = tree.files.filter(f => inside(selectedPath, resolve(request.root, f.path)))
    if (request.kind === 'map') {
      const entries: MapResult['entries'] = []
      for (const file of files) {
        const map = store?.map(file.hash, file.language)
        if (map && map.source !== 'file') source.coverage.symbols++
        entries.push({ path: file.path, symbols: map?.entries ?? [], source: map?.source ?? 'file' })
      }
      return boundMap({ entries, provenance: source, tokenBound: request.budget ?? 2048, tokenMeasure: 'utf8-bytes', truncated: false }, request.budget ?? 2048)
    }
    const text = request.text ?? ''
    if (!text || text.includes('\n') || text.includes('\r')) throw new Error('index_query_invalid')
    const limit = request.limit ?? 200
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('index_limit_invalid')
    let candidates: Set<string> | undefined
    if (store && [...text].length >= 3) {
      try { candidates = store.fts(text) } catch { /* query/tokenizer unavailable: literal fallback */ }
    }
    const result: SearchResult = { hits: [], provenance: source, engine: candidates ? 'fts5+grep' : 'node-grep', truncated: false }
    for (const file of files) {
      // Content identity, never a stale path manifest, controls FTS use. Files
      // changed since the last build always pass through the literal fallback.
      if (candidates && store!.hasFts(file.hash) && !candidates.has(file.hash)) continue
      const lines = file.text.split('\n')
      for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(text)) {
        if (result.hits.length === limit) { result.truncated = true; return result }
        result.hits.push({ path: file.path, line: i + 1, text: lines[i]! })
      }
    }
    return result
  } finally {
    if (request.kind === 'build' && store) await store.purgeUnsafe(allow)
    store?.close()
  }
}
