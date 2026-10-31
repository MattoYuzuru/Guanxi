import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import { LEAD_PROJECT_READ_TOOL, LEAD_PROJECT_SEARCH_TOOL, LEAD_PROJECT_TREE_TOOL } from '@guanxi/contract'
import type { EgressScrubber } from '../egress/types.ts'
import { blocked } from '../indexing/snapshot.ts'
import { gitEnv, gitFlags } from '../relay/workspace.ts'

/** Read-only view of a project's COMMITTED files for the lead (MS1 finding 2).
 *
 * The lead's cwd is an empty private directory, so the node serves the project instead. Everything is read from git objects of the
 * project's source repository (`ls-tree`, `cat-file`, `grep <commit>`), never from its working tree: untracked and ignored files (where
 * secrets live), a dirty tree and symlinks on disk are out of reach by construction, and no hook, filter or config runs (the relay's
 * `gitEnv`/`gitFlags`). The commit a result names is a valid `plan.base`, and the relay clones that same commit for the executor.
 *
 * Bounds come from `ProjectViewPolicy`, are reported in every result and never apply silently: a cut result says so and carries the
 * cursor to continue. Every string that leaves is scrubbed. */

export interface ProjectViewPolicy {
  /** Entries per tree page when the caller names none, and the largest page it may ask for. */
  treeEntries: number; maxTreeEntries: number
  /** Bytes of file text per read page when the caller names none, and the largest page it may ask for. */
  pageBytes: number; maxPageBytes: number
  /** Largest blob the view scrubs and pages; a bigger one answers `file_too_large` with its size. */
  maxFileBytes: number
  /** Matches per search page when the caller names none, and the largest page it may ask for. */
  searchMatches: number; maxSearchMatches: number
  /** Characters of one search line; a longer line is cut with an explicit marker. */
  lineChars: number
  /** Serialized size of any one result; entries, matches or text are dropped from the end to fit, and the result says so. */
  maxResultBytes: number
  /** Wall time of one git process. */
  timeoutMs: number
}
export const DEFAULT_PROJECT_VIEW_POLICY: Readonly<ProjectViewPolicy> = Object.freeze({
  treeEntries: 200, maxTreeEntries: 2_000, pageBytes: 16_384, maxPageBytes: 65_536, maxFileBytes: 4_194_304,
  searchMatches: 100, maxSearchMatches: 500, lineChars: 400, maxResultBytes: 262_144, timeoutMs: 15_000,
})

/** A fixed, free-text-free failure. `detail` is bounded numbers or field names only, never a path, a message or a value. */
export class ProjectViewError extends Error {
  readonly code: string
  readonly detail: string | null
  constructor(code: string, detail: string | null = null) { super(code); this.name = 'ProjectViewError'; this.code = code; this.detail = detail }
  get text(): string { return this.detail === null ? this.code : `${this.code}: ${this.detail}` }
}
const fail = (code: string, detail: string | null = null): never => { throw new ProjectViewError(code, detail) }

// ---- paths ------------------------------------------------------------------------------------

/** Credential names beyond the scanner's rule. A name list is not a classifier: a secret inside an ordinary source file is caught only
 * by the egress scrubber, and only when its value is registered. */
const SECRET_SEGMENT = [
  /^\.(?:ssh|aws|gnupg|kube|docker|npmrc|pypirc|netrc|pgpass|htpasswd|git-credentials)$/i,
  /^_netrc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /^credentials/i,
  /^client_secret.*\.json$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars)$/i,
]
/** True when any segment of a project-relative path names a file or directory no lead tool may read, list or search. */
export function deniedPath(path: string): boolean {
  return blocked(path) || path.split('/').some(segment => SECRET_SEGMENT.some(rule => rule.test(segment)))
}
const MAX_PATH = 4_096
/** A project-relative path: `''` is the root. Anything that is not a plain relative path is `path_invalid`; a denied name is `path_denied`. */
export function viewPath(raw: string | undefined, allowRoot: boolean): string {
  if (raw === undefined) { if (!allowRoot) fail('path_invalid'); return '' }
  if (raw.length > MAX_PATH || /[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith('/') || raw.startsWith('~')) return fail('path_invalid')
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
  if (trimmed === '' || trimmed === '.') { if (!allowRoot) fail('path_invalid'); return '' }
  if (trimmed.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) fail('path_invalid')
  if (deniedPath(trimmed)) fail('path_denied')
  return trimmed
}

// ---- git --------------------------------------------------------------------------------------

const GIT = '/usr/bin/git'
const HEX = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
interface GitRun { code: number | null; stdout: Buffer; stopped: boolean }
interface GitOptions {
  timeoutMs: number
  /** Streaming mode: called with each complete record; returning `false` ends the process early (not a failure). */
  records?: { delimiter: number; onRecord(record: Buffer): boolean | void }
  /** Buffered mode: bytes beyond this kill the process (`project_view_output_limit`). */
  maxBytes?: number
}
/** One git process: absolute binary, argv only, no shell, hard timeout. */
function git(root: string, args: readonly string[], options: GitOptions): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT, [...gitFlags, ...args], { cwd: root, env: { ...gitEnv, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0, tail: Buffer = Buffer.alloc(0), stopped = false, timedOut = false, overflow = false, settled = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
    const done = (finish: () => void) => { if (settled) return; settled = true; clearTimeout(timer); finish() }
    child.on('error', () => done(() => reject(new ProjectViewError('project_view_unavailable'))))
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped || overflow) return
      if (options.records) {
        let data = tail.length ? Buffer.concat([tail, chunk]) : chunk
        for (let at = data.indexOf(options.records.delimiter); at >= 0; at = data.indexOf(options.records.delimiter)) {
          if (options.records.onRecord(data.subarray(0, at)) === false) { stopped = true; child.kill('SIGKILL'); return }
          data = data.subarray(at + 1)
        }
        tail = Buffer.from(data)
        return
      }
      size += chunk.length
      if (options.maxBytes !== undefined && size > options.maxBytes) { overflow = true; child.kill('SIGKILL'); return }
      chunks.push(chunk)
    })
    child.on('close', code => done(() => {
      if (timedOut) return reject(new ProjectViewError('project_view_timeout'))
      if (overflow) return reject(new ProjectViewError('project_view_unavailable'))
      resolve({ code, stdout: Buffer.concat(chunks), stopped })
    }))
  })
}

// ---- inputs and tool definitions --------------------------------------------------------------

const ref = z.string().max(80).optional()
const cursor = z.number().int().min(0).safe().optional()
const amount = z.number().int().min(1).safe().optional()
const treeInput = z.object({ path: z.string().optional(), ref, recursive: z.boolean().optional(), offset: cursor, limit: amount }).strict()
const readInput = z.object({ path: z.string(), ref, offset: cursor, limit: amount }).strict()
const searchInput = z.object({ text: z.string().min(1).max(1_000), path: z.string().optional(), ref, offset: cursor, limit: amount }).strict()
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const parsed = schema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  return fail('invalid_input', parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '))
}

const REF_HELP = 'ref is "HEAD" (default) or a full commit id; every result names the commit it read, which is a valid plan.base.'
const COMMON = 'Read-only: committed files only, no untracked, ignored or secret files (dotenv, keys, credentials), output scrubbed. ' + REF_HELP
export interface ProjectViewToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
const stringProperty = (description: string) => ({ type: 'string', description })
const integerProperty = (description: string) => ({ type: 'integer', minimum: 0, description })
/** Hand-written JSON Schemas of the zod inputs above; a test proves they agree on samples. */
export const PROJECT_VIEW_TOOLS: readonly ProjectViewToolDefinition[] = Object.freeze([
  { name: LEAD_PROJECT_TREE_TOOL,
    description: `List the delegated project's files at a commit, one page at a time. path is a project-relative directory (default: the root); recursive lists every file below it. ${COMMON} ` +
      'The result has more, nextOffset (pass it as offset for the next page), total, withheld (entries not shown by policy) and the bounds in force.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { path: stringProperty('Project-relative directory; empty for the root.'), ref: stringProperty('"HEAD" or a full commit id.'),
      recursive: { type: 'boolean' }, offset: integerProperty('Index of the first entry (nextOffset of the previous page).'), limit: { type: 'integer', minimum: 1, description: 'Entries per page; the result reports the default and the maximum.' } } } },
  { name: LEAD_PROJECT_READ_TOOL,
    description: `Read a UTF-8 text file of the delegated project at a commit, one page at a time. path is project-relative. ${COMMON} ` +
      'offset and nextOffset are byte positions in the scrubbed text; while more is true, call again with offset=nextOffset. Binary files, symlinks and files above the maximum size are refused with a fixed code.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: stringProperty('Project-relative file path.'), ref: stringProperty('"HEAD" or a full commit id.'),
      offset: integerProperty('Byte offset of the page (0 for the start).'), limit: { type: 'integer', minimum: 1, description: 'Bytes per page; the result reports the default and the maximum.' } } } },
  { name: LEAD_PROJECT_SEARCH_TOOL,
    description: `Search the delegated project's files at a commit for a literal, case-sensitive, single-line text (not a regular expression). path limits the search to a file or directory. ${COMMON} ` +
      'The result lists path, line and the (clipped) line; more and nextOffset page through the matches.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 1000, description: 'Literal text, one line.' },
      path: stringProperty('Project-relative file or directory to search in; empty for everything.'), ref: stringProperty('"HEAD" or a full commit id.'),
      offset: integerProperty('Number of matches to skip (nextOffset of the previous page).'), limit: { type: 'integer', minimum: 1, description: 'Matches per page; the result reports the default and the maximum.' } } } },
])
export type ProjectViewToolName = typeof LEAD_PROJECT_TREE_TOOL | typeof LEAD_PROJECT_READ_TOOL | typeof LEAD_PROJECT_SEARCH_TOOL

/** What the audit records about a call: never file text, never the search query. */
export interface ProjectViewSummary { path: string | null; commit: string | null; bytes: number; truncated: boolean; withheld: number; queryChars?: number }
export interface ProjectViewResult { text: string; summary: ProjectViewSummary }

// ---- the view ---------------------------------------------------------------------------------

interface Entry { mode: string; type: string; oid: string; size: number | null; path: string }
const ENTRY = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64}) +(-|\d+)\t([\s\S]+)$/
const parseEntry = (record: string): Entry | null => {
  const match = ENTRY.exec(record)
  return match ? { mode: match[1]!, type: match[2]!, oid: match[3]!, size: match[4] === '-' ? null : Number(match[4]), path: match[5]! } : null
}
const kindOf = (entry: Entry): 'dir' | 'file' | 'symlink' | 'submodule' =>
  entry.type === 'tree' ? 'dir' : entry.type === 'commit' ? 'submodule' : entry.mode === '120000' ? 'symlink' : 'file'
const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80

export interface ProjectViewOptions { scrubber: EgressScrubber; policy?: Partial<ProjectViewPolicy> }

export class ProjectView {
  readonly policy: Readonly<ProjectViewPolicy>
  private readonly scrubber: EgressScrubber
  constructor(options: ProjectViewOptions) {
    this.scrubber = options.scrubber
    const policy = { ...DEFAULT_PROJECT_VIEW_POLICY, ...options.policy }
    for (const [key, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new ProjectViewError('invalid_policy', key)
    if (policy.treeEntries > policy.maxTreeEntries || policy.pageBytes > policy.maxPageBytes || policy.searchMatches > policy.maxSearchMatches) throw new ProjectViewError('invalid_policy', 'default above maximum')
    this.policy = Object.freeze(policy)
  }

  run(tool: string, root: string, raw: unknown): Promise<ProjectViewResult> {
    switch (tool) {
      case LEAD_PROJECT_TREE_TOOL: return this.tree(root, raw)
      case LEAD_PROJECT_READ_TOOL: return this.read(root, raw)
      case LEAD_PROJECT_SEARCH_TOOL: return this.search(root, raw)
      default: return Promise.reject(new ProjectViewError('unknown_tool'))
    }
  }

  /** The top level of the project's git repository and the commit `ref` names. */
  private async open(rootPath: string, rawRef: string | undefined): Promise<{ root: string; commit: string }> {
    const requested = rawRef === undefined || rawRef === '' ? 'HEAD' : rawRef
    if (requested !== 'HEAD' && !HEX.test(requested)) fail('ref_invalid')
    let root: string
    try { root = await realpath(rootPath) } catch { return fail('project_view_unavailable') }
    const timeoutMs = this.policy.timeoutMs
    // The relay clones the repository and plans paths from its top level; a project root below it is not viewable either.
    const prefix = await git(root, ['rev-parse', '--show-prefix'], { timeoutMs, maxBytes: 4_096 })
    if (prefix.code !== 0 || prefix.stdout.toString('utf8').trim() !== '') fail('project_view_unavailable')
    const resolved = await git(root, ['rev-parse', '--verify', '--end-of-options', `${requested}^{commit}`], { timeoutMs, maxBytes: 4_096 })
    const commit = resolved.stdout.toString('utf8').trim()
    if (resolved.code !== 0 || !HEX.test(commit)) fail('ref_not_found')
    return { root, commit }
  }
  /** The tree entry at `path` itself (not its children), or null. */
  private async entryAt(root: string, commit: string, path: string): Promise<Entry | null> {
    const listed = await git(root, ['ls-tree', '-z', '--long', commit, '--', path], { timeoutMs: this.policy.timeoutMs, maxBytes: 65_536 })
    if (listed.code !== 0) fail('project_view_unavailable')
    for (const record of listed.stdout.toString('utf8').split('\0')) {
      const entry = record ? parseEntry(record) : null
      if (entry && entry.path === path) return entry
    }
    return null
  }
  private clamp(asked: number | undefined, fallback: number, maximum: number): number { return Math.min(asked ?? fallback, maximum) }
  /** Serialized, scrubbed, within `maxResultBytes`: `fit` is called with smaller sizes until the body fits. */
  private serialize(build: (shrink: number) => Record<string, unknown>, steps: number): string {
    for (let shrink = 0; ; shrink++) {
      const body = JSON.stringify(this.scrubber.scrub(build(shrink)))
      if (Buffer.byteLength(body) <= this.policy.maxResultBytes || shrink >= steps) {
        if (Buffer.byteLength(body) > this.policy.maxResultBytes) fail('result_too_large')
        return body
      }
    }
  }

  async tree(rootPath: string, raw: unknown): Promise<ProjectViewResult> {
    const input = parse(treeInput, raw)
    const path = viewPath(input.path, true)
    const { root, commit } = await this.open(rootPath, input.ref)
    if (path !== '') {
      const entry = await this.entryAt(root, commit, path)
      if (!entry) fail('not_found')
      if (entry!.type !== 'tree') fail('not_a_directory')
    }
    const offset = input.offset ?? 0
    const limit = this.clamp(input.limit, this.policy.treeEntries, this.policy.maxTreeEntries)
    const page: { path: string; type: string; size?: number }[] = []
    let total = 0, withheld = 0
    // The whole listing is streamed so `total` and `withheld` are exact; only the requested window is kept.
    const run = await git(root, ['ls-tree', ...(input.recursive ? ['-r'] : []), '-z', '--long', commit, ...(path === '' ? [] : ['--', `${path}/`])], {
      timeoutMs: this.policy.timeoutMs,
      records: { delimiter: 0, onRecord: record => {
        const entry = parseEntry(record.toString('utf8'))
        if (!entry) return
        if (deniedPath(entry.path)) { withheld++; return }
        if (total >= offset && page.length < limit) {
          const type = kindOf(entry)
          page.push(type === 'file' && entry.size !== null ? { path: entry.path, type, size: entry.size } : { path: entry.path, type })
        }
        total++
      } },
    })
    if (run.code !== 0) fail('project_view_unavailable')
    let kept = page.length
    const body = this.serialize(shrink => {
      kept = Math.max(0, page.length - shrink * Math.max(1, Math.ceil(page.length / 8)))
      const next = offset + kept
      return { commit, path, recursive: input.recursive === true, entries: page.slice(0, kept), offset, nextOffset: next < total ? next : null, more: next < total,
        total, withheld, truncated: next < total,
        bounds: { limit, defaultLimit: this.policy.treeEntries, maxLimit: this.policy.maxTreeEntries, maxResultBytes: this.policy.maxResultBytes } }
    }, 64)
    return { text: body, summary: { path, commit, bytes: Buffer.byteLength(body), truncated: offset + kept < total, withheld } }
  }

  async read(rootPath: string, raw: unknown): Promise<ProjectViewResult> {
    const input = parse(readInput, raw)
    const path = viewPath(input.path, false)
    const { root, commit } = await this.open(rootPath, input.ref)
    const entry = await this.entryAt(root, commit, path)
    if (!entry) fail('not_found')
    const kind = kindOf(entry!)
    if (kind === 'symlink') fail('symlink_denied')
    if (kind !== 'file') fail('not_a_file')
    const size = entry!.size ?? 0
    if (size > this.policy.maxFileBytes) fail('file_too_large', `size ${size} bytes, limit ${this.policy.maxFileBytes}`)
    const blob = await git(root, ['cat-file', 'blob', entry!.oid], { timeoutMs: this.policy.timeoutMs, maxBytes: size })
    if (blob.code !== 0 || blob.stdout.length !== size) fail('project_view_unavailable')
    // Git's own rule for binary content, then strict UTF-8: a file the lead cannot read as text is refused, never mangled.
    if (blob.stdout.subarray(0, 8_000).includes(0)) fail('binary_file')
    let original: string
    try { original = new TextDecoder('utf-8', { fatal: true }).decode(blob.stdout) } catch { return fail('binary_file') }
    // The whole file is scrubbed before it is paged, so a registered secret that straddles a page boundary is still redacted.
    const clean = this.scrubber.scrub(original)
    const text = Buffer.from(clean, 'utf8')
    const offset = input.offset ?? 0
    if (offset > text.length || (offset < text.length && isContinuation(text[offset]))) fail('invalid_offset')
    const limit = this.clamp(input.limit, this.policy.pageBytes, this.policy.maxPageBytes)
    let end = Math.min(text.length, offset + limit)
    const build = (at: number) => ({ commit, path, size, totalBytes: text.length, offset, nextOffset: at < text.length ? at : null, more: at < text.length,
      truncated: at < text.length, redacted: clean !== original,
      text: text.subarray(offset, at).toString('utf8'),
      bounds: { limit, defaultLimit: this.policy.pageBytes, maxLimit: this.policy.maxPageBytes, maxFileBytes: this.policy.maxFileBytes, maxResultBytes: this.policy.maxResultBytes } })
    for (;;) {
      // A page ends on a character boundary: the next offset must be a valid start.
      while (end > offset && isContinuation(text[end])) end--
      if (end === offset && offset < text.length) fail('page_too_small')
      const body = JSON.stringify(this.scrubber.scrub(build(end)))
      if (Buffer.byteLength(body) <= this.policy.maxResultBytes) {
        return { text: body, summary: { path, commit, bytes: Buffer.byteLength(body), truncated: end < text.length, withheld: 0 } }
      }
      end = offset + Math.floor((end - offset) * this.policy.maxResultBytes / Buffer.byteLength(body)) - 1
      if (end <= offset) fail('page_too_small')
    }
  }

  async search(rootPath: string, raw: unknown): Promise<ProjectViewResult> {
    const input = parse(searchInput, raw)
    // A newline would make `git grep -F` search for several patterns at once.
    if (/[\u0000\r\n]/.test(input.text)) fail('invalid_input', 'text: must be a single line')
    const path = viewPath(input.path, true)
    const { root, commit } = await this.open(rootPath, input.ref)
    if (path !== '' && !(await this.entryAt(root, commit, path))) fail('not_found')
    const offset = input.offset ?? 0
    const limit = this.clamp(input.limit, this.policy.searchMatches, this.policy.maxSearchMatches)
    const matches: { path: string; line: number; text: string }[] = []
    let seen = 0, withheld = 0, more = false, lineCut = false
    const clip = (line: string): string => {
      const points = Array.from(line)
      if (points.length <= this.policy.lineChars) return line
      lineCut = true
      const head = points.slice(0, this.policy.lineChars).join('')
      // The cut is a right-truncation: a registered secret that starts before it must not leave as a prefix.
      const safe = this.scrubber.scrubTruncatedPrefix ? this.scrubber.scrubTruncatedPrefix(head) : '[line withheld: clipped]'
      return `${safe}…[line clipped, ${points.length - this.policy.lineChars} more characters]`
    }
    const prefix = `${commit}:`
    const grep = await git(root, ['grep', '-F', '-I', '-n', '-z', '--no-color', '--no-textconv', '-e', input.text, commit, '--', ...(path === '' ? [] : [path])], {
      timeoutMs: this.policy.timeoutMs,
      records: { delimiter: 10, onRecord: record => {
        const line = record.toString('utf8')
        const first = line.indexOf('\0'), second = first < 0 ? -1 : line.indexOf('\0', first + 1)
        if (!line.startsWith(prefix) || second < 0) return
        const file = line.slice(prefix.length, first), number = Number(line.slice(first + 1, second))
        if (!Number.isSafeInteger(number)) return
        if (deniedPath(file)) { withheld++; return }
        if (seen++ < offset) return
        if (matches.length >= limit) { more = true; return false }
        matches.push({ path: file, line: number, text: clip(line.slice(second + 1).replace(/\r$/, '')) })
      } },
    })
    // `git grep` exits 1 for "no match"; killing it after the page is full is ours.
    if (!grep.stopped && grep.code !== 0 && grep.code !== 1) fail('project_view_unavailable')
    let kept = matches.length
    const body = this.serialize(shrink => {
      kept = Math.max(0, matches.length - shrink * Math.max(1, Math.ceil(matches.length / 8)))
      const next = offset + kept
      const cut = more || kept < matches.length
      return { commit, path, matches: matches.slice(0, kept), offset, nextOffset: cut ? next : null, more: cut, truncated: cut || lineCut, withheld,
        bounds: { limit, defaultLimit: this.policy.searchMatches, maxLimit: this.policy.maxSearchMatches, lineChars: this.policy.lineChars, maxResultBytes: this.policy.maxResultBytes } }
    }, 64)
    return { text: body, summary: { path, commit, bytes: Buffer.byteLength(body), truncated: more || kept < matches.length || lineCut, withheld, queryChars: Array.from(input.text).length } }
  }
}
