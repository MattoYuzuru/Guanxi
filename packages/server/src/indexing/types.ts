/** X1 internal kernel contract. No client wire fields or embedding implementation. */
export interface IndexSettings {
  /** IX2 activates at this many eligible text files. IX0/IX1 work below it. */
  ftsMinFiles: number
  /** Explicit per-file safety policy; skipped files appear in coverage. */
  maxFileBytes: number
  pollMs: number
}
export const DEFAULT_INDEX_SETTINGS: Readonly<IndexSettings> = Object.freeze({ ftsMinFiles: 1000, maxFileBytes: 2 * 1024 * 1024, pollMs: 5000 })
export interface SymbolEntry { name: string; kind: string; line: number }
export interface SourceFile { path: string; hash: string; text: string; language: string }
export interface TreeSnapshot { rootKey: string; commit: string | null; observedAt: string; fingerprint: string; files: SourceFile[]; skipped: number }
export interface Provenance {
  source: 'live-tree+content-cache'
  observedAt: string
  commit: string | null
  indexCommit: string | null
  indexAgeMs: number | null
  coverage: { eligible: number; indexed: number; skipped: number; symbols: number }
  freshness: 'verified-snapshot'
  embeddings: false
}
export interface IndexBuildResult { provenance: Provenance; skipped: boolean }
export interface SearchHit { path: string; line: number; text: string }
export interface SearchResult { hits: SearchHit[]; provenance: Provenance; engine: 'fts5+grep' | 'node-grep'; truncated: boolean }
export interface MapResult { entries: { path: string; symbols: SymbolEntry[]; source: 'tree-sitter' | 'markdown' | 'file' | 'lsp' }[]; provenance: Provenance; truncated: boolean; tokenBound: number; tokenMeasure: 'utf8-bytes' }
export interface IndexRequest { kind: 'build' | 'search' | 'map'; root: string; path?: string; text?: string; budget?: number; limit?: number }
export interface IndexWorkerData { request: IndexRequest; database: string; settings: IndexSettings; grammarDisabled?: string[]; grammarDirectories?: Record<string, string>; crashPoint?: 'content' | 'manifest'; embeddings?: boolean; changeFingerprint?: string; secretDigest?: string; secrets?: readonly { ref: string; value: string }[] }
