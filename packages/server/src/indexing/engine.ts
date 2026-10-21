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
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > budget) {
    if (!result.entries.length) throw new Error('index_budget_too_small')
    const last = result.entries.at(-1)!
    if (last.symbols.length) last.symbols.pop()
    else result.entries.pop()
    result.truncated = true
  }
  // This is a bound of the entire envelope, including provenance and the bound itself.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > budget) throw new Error('index_budget_exceeded')
  return result
}

export async function executeIndex(data: IndexWorkerData, allow: AllowContent, checkpoint: () => Promise<void> = async () => {}): Promise<unknown> {
  const { request, settings } = data
  // IX3 has no loader/provider/model route in X1, even if a caller sets the future flag.
  const tree = await snapshot(request.root, settings, allow)
  let store: IndexStore | undefined
  try {
    if (request.kind === 'build') {
      store = new IndexStore(data.database, true)
      const fts = tree.files.length >= settings.ftsMinFiles
      for (const file of tree.files) {
        await checkpoint()
        const cached = store.map(file.hash, file.language)
        const map = cached ?? await symbols(file.text, file.language, data.grammarDisabled)
        // Readiness and registered values are rechecked immediately before each write.
        if (!(await allow(file.text)) || !(await allow(file.path))) throw new Error('index_secret_changed')
        if (!cached || cached.source === 'file' && file.language !== 'file' || fts && !store.hasFts(file.hash)) store.put(file.hash, file.text, file.language, map, fts)
        if (data.crashPoint === 'content') process.exit(86)
      }
      await checkpoint()
      // A changed tree is never published as current. Durable content remains reusable.
      const current = await snapshot(request.root, settings, allow)
      if (tree.fingerprint !== current.fingerprint || tree.commit !== current.commit) throw new Error('index_tree_changed')
      store.publish(tree, data.crashPoint === 'manifest' ? () => process.exit(86) : undefined)
      return provenance(tree, store)
    }
    try { store = new IndexStore(data.database) } catch { /* IX0 is available without a database */ }
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
  } finally { store?.close() }
}
