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
 * project's source repository (`ls-tree`, `cat-file`), never from its working tree: untracked and ignored files (where secrets live), a
 * dirty tree and symlinks on disk are out of reach by construction. Only object plumbing runs (`rev-parse`, `ls-tree`, `cat-file`; never
 * `grep`, `diff`, `status` or `show`), through the relay's `gitEnv`/`gitFlags` (no system or global config, hooks path, fsmonitor and
 * external protocols off, replace objects ignored) plus these explicit overrides: `GIT_NO_LAZY_FETCH=1` (a missing blob of a partial clone is
 * an error, never a fetch over the network or a repository-configured transport command), `GIT_LITERAL_PATHSPECS=1`, and `-c` settings for
 * submodule recursion, the attributes file and the untracked cache. The repository's own `.git/config` is otherwise read by git as usual; the
 * commands above do not consult filters, textconv, hooks or attributes.
 * The commit a result names is a valid `plan.base`, and the relay clones that same commit for the executor.
 *
 * Bounds come from `ProjectViewPolicy`, are reported in every result and never apply silently: a cut result says so and carries the
 * cursor to continue. Every string that leaves is scrubbed. Paths the name policy hides are never opened by any tool, so no output
 * field of a search or a read can depend on their content. */

export interface ProjectViewPolicy {
  /** Entries per tree page when the caller names none, and the largest page it may ask for. */
  treeEntries: number; maxTreeEntries: number
  /** Bytes of file text per read page when the caller names none, and the largest page it may ask for. */
  pageBytes: number; maxPageBytes: number
  /** Largest blob the view scrubs and pages; a bigger one answers `file_too_large` with its size (a search skips it and says so). */
  maxFileBytes: number
  /** Matches per search page when the caller names none, and the largest page it may ask for. */
  searchMatches: number; maxSearchMatches: number
  /** Characters of one search line; a longer line is cut around the match with an explicit marker. */
  lineChars: number
  /** Serialized size of any one result; entries, matches or text are dropped from the end to fit, and the result says so. */
  maxResultBytes: number
  /** Wall time of one git process. */
  timeoutMs: number
  /** Longest project-relative path (bytes) a request may name; also bounds one listing record. */
  maxPathBytes: number
  /** Longest search text (characters). */
  maxTextChars: number
  /** Most blob bytes one search reads (each blob is at most `maxFileBytes`); the result reports what was not scanned. */
  maxScanBytes: number
}
export const DEFAULT_PROJECT_VIEW_POLICY: Readonly<ProjectViewPolicy> = Object.freeze({
  treeEntries: 200, maxTreeEntries: 2_000, pageBytes: 16_384, maxPageBytes: 65_536, maxFileBytes: 4_194_304,
  searchMatches: 100, maxSearchMatches: 500, lineChars: 400, maxResultBytes: 262_144, timeoutMs: 15_000,
  maxPathBytes: 4_096, maxTextChars: 1_000, maxScanBytes: 67_108_864,
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
 * by the egress scrubber, and only when its value is registered. Each rule is tested against one path segment. */
const SECRET_SEGMENT = [
  // Credential directories and dotfiles.
  /^\.(?:ssh|aws|gnupg|kube|docker|dockercfg|azure|gcloud|gsutil|npmrc|yarnrc\.yml|pypirc|netrc|pgpass|htpasswd|git-credentials|s3cfg|boto|terraformrc)$/i,
  /^_netrc$/i, /^terraform\.rc$/i, /^kubeconfig$/i, /\.kubeconfig$/i,
  /^\.vault/i, /^\.firebase/i, /^\.token$/i, /\.token$/i, /\.ovpn$/i,
  // Private keys and keystores.
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /\.(?:pem|key|p8|p12|pfx|ppk|jks|jceks|keystore|kdbx|gpg|asc|pgp)$/i,
  // Credential files by name.
  /^credentials/i,
  /^client_secret.*\.json$/i,
  /service[-_]?account.*\.json$/i,
  // `secret.*` / `secrets.*` in a data format (a `secrets.ts` is code), and a directory called `secret(s)`.
  /^secrets?\.(?:json|ya?ml|toml|ini|cfg|conf|properties|xml|txt|enc|env)$/i,
  /^\.?secrets?$/i,
  /\.secrets?$/i,
  // Terraform state and variables, including `.backup`, `.json` and numbered copies.
  /\.tfstate(?:\.|$)/i, /\.tfvars(?:\.|$)/i,
]
/** Credential files that are named by their place, not by one segment. */
const SECRET_PATH = [/(?:^|\/)\.config\/gh\/hosts\.yml$/i]
/** True when any segment of a project-relative path names a file or directory no lead tool may read, list or search. */
export function deniedPath(path: string): boolean {
  return blocked(path) || SECRET_PATH.some(rule => rule.test(path)) || path.split('/').some(segment => SECRET_SEGMENT.some(rule => rule.test(segment)))
}
/** A project-relative path: `''` is the root. Anything that is not a plain relative path is `path_invalid`; a denied name is `path_denied`. */
export function viewPath(raw: string | undefined, allowRoot: boolean, maxBytes = DEFAULT_PROJECT_VIEW_POLICY.maxPathBytes): string {
  if (raw === undefined) { if (!allowRoot) fail('path_invalid'); return '' }
  if (Buffer.byteLength(raw) > maxBytes || /[\u0000-\u001f\u007f\\]/.test(raw) || raw.startsWith('/') || raw.startsWith('~')) return fail('path_invalid')
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
  if (trimmed === '' || trimmed === '.') { if (!allowRoot) fail('path_invalid'); return '' }
  if (trimmed.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) fail('path_invalid')
  if (deniedPath(trimmed)) fail('path_denied')
  return trimmed
}

// ---- git --------------------------------------------------------------------------------------

const HEX = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const CURSOR = /^([a-f0-9]{40}|[a-f0-9]{64}):(\d{1,15})$/
/** Repository-local configuration must not widen what plumbing does: no submodule recursion, no attributes file, no untracked cache. */
const CONFIG_OVERRIDES = ['-c', 'submodule.recurse=false', '-c', 'grep.recurseSubmodules=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.untrackedCache=false']
/** A sink may answer with a promise (the process is paused until it settles), so a long scan can yield to the event loop. */
type Sink = (chunk: Buffer) => boolean | void | Promise<boolean | void>
interface GitRun { code: number | null; stopped: boolean }
/** One git process: absolute binary, argv only, no shell, hard timeout (rejects at once, without waiting for the pipes to close), killed when
 * `signal` aborts (`project_view_cancelled`). The sink sees stdout chunks; returning `false` ends the process early (not a failure), and a
 * throw ends it with that error. */
function runGit(bin: string, signal: AbortSignal, root: string, args: readonly string[], timeoutMs: number, sink: Sink, stdin?: string): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProjectViewError('project_view_cancelled'))
    const child = spawn(bin, [...gitFlags, ...CONFIG_OVERRIDES, ...args], { cwd: root,
      env: { ...gitEnv, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] })
    let settled = false, stopped = false
    const finish = (settle: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); settle() }
    const fatal = (error: unknown) => finish(() => { child.kill('SIGKILL'); reject(error) })
    const timer = setTimeout(() => fatal(new ProjectViewError('project_view_timeout')), timeoutMs)
    const onAbort = () => fatal(new ProjectViewError('project_view_cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => finish(() => reject(new ProjectViewError('project_view_unavailable'))))
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled || stopped) return
      const stop = () => { stopped = true; child.kill('SIGKILL') }
      try {
        const answer = sink(chunk)
        if (answer instanceof Promise) {
          child.stdout!.pause()
          answer.then(keep => { if (settled || stopped) return; if (keep === false) stop(); else child.stdout!.resume() }, fatal)
        } else if (answer === false) stop()
      } catch (error) { fatal(error) }
    })
    child.on('close', code => finish(() => resolve({ code, stopped })))
    if (stdin !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(stdin) }
  })
}
/** Buffers stdout up to `maxBytes`; more is `project_view_output_limit`. */
function collect(maxBytes: number): { sink: Sink; text(): string; bytes(): Buffer } {
  const chunks: Buffer[] = []
  let size = 0
  return { sink: chunk => { size += chunk.length; if (size > maxBytes) fail('project_view_output_limit'); chunks.push(chunk) },
    text: () => Buffer.concat(chunks).toString('utf8'), bytes: () => Buffer.concat(chunks) }
}
/** Splits stdout into delimiter-terminated records. A record longer than `maxRecord` is never buffered: its bytes are dropped until the
 * delimiter and `onRecord` receives `null`, so memory per pending record is bounded whatever git prints. */
function records(delimiter: number, maxRecord: number, onRecord: (record: Buffer | null) => boolean | void): Sink {
  let pending: Buffer[] = [], pendingBytes = 0, discarding = false
  return chunk => {
    let start = 0
    for (;;) {
      const at = chunk.indexOf(delimiter, start)
      const piece = chunk.subarray(start, at < 0 ? chunk.length : at)
      if (!discarding) {
        if (pendingBytes + piece.length > maxRecord) { discarding = true; pending = []; pendingBytes = 0 }
        else if (piece.length) { pending.push(piece); pendingBytes += piece.length }
      }
      if (at < 0) return
      const record = discarding ? null : Buffer.concat(pending)
      pending = []; pendingBytes = 0; discarding = false
      if (onRecord(record) === false) return false
      start = at + 1
    }
  }
}
/** Parses `git cat-file --batch` output for blobs requested in order, checking each header against the size `ls-tree` reported. */
function blobFrames(expected: readonly number[], onBlob: (index: number, blob: Buffer) => boolean | void): { sink: Sink; done(): boolean } {
  let index = 0, state: 'header' | 'body' | 'tail' = 'header', header: Buffer[] = [], headerBytes = 0, remaining = 0, body: Buffer[] = []
  const sink: Sink = chunk => {
    let pos = 0
    while (pos < chunk.length) {
      if (state === 'header') {
        const nl = chunk.indexOf(10, pos), end = nl < 0 ? chunk.length : nl
        headerBytes += end - pos
        if (headerBytes > 256 || index >= expected.length) fail('project_view_unavailable')
        header.push(chunk.subarray(pos, end))
        if (nl < 0) return
        pos = nl + 1
        const match = /^[a-f0-9]{40,64} blob (\d+)$/.exec(Buffer.concat(header).toString('utf8'))
        header = []; headerBytes = 0
        if (!match || Number(match[1]) !== expected[index]) return fail('project_view_unavailable')
        remaining = Number(match[1]); body = []; state = 'body'
      }
      if (state === 'body') {
        const take = Math.min(remaining, chunk.length - pos)
        if (take) body.push(chunk.subarray(pos, pos + take))
        remaining -= take; pos += take
        if (remaining > 0) return
        state = 'tail'
        if (onBlob(index, Buffer.concat(body)) === false) return false
        body = []
      }
      if (state === 'tail') {
        if (pos >= chunk.length) return
        if (chunk[pos] !== 10) fail('project_view_unavailable')
        pos++; index++; state = 'header'
      }
    }
  }
  return { sink, done: () => index === expected.length && state === 'header' }
}

// ---- inputs and tool definitions --------------------------------------------------------------

const ref = z.string().optional()
const cursor = z.number().int().min(0).safe().optional()
const pageCursor = z.string().optional()
const amount = z.number().int().min(1).safe().optional()
const treeInput = z.object({ path: z.string().optional(), ref, recursive: z.boolean().optional(), offset: cursor, cursor: pageCursor, limit: amount }).strict()
const readInput = z.object({ path: z.string(), ref, offset: cursor, cursor: pageCursor, limit: amount }).strict()
const searchInput = z.object({ text: z.string().min(1), path: z.string().optional(), ref, offset: cursor, cursor: pageCursor, limit: amount }).strict()
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const parsed = schema.safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  return fail('invalid_input', parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '))
}
/** `cursor` (`<commit>:<offset>`, issued by a previous page) pins a continuation to the commit of the first page, so a moving `HEAD` can
 * neither skip nor repeat anything. It excludes `ref` and `offset`. */
function pin(input: { ref?: string | undefined; offset?: number | undefined; cursor?: string | undefined }): { ref: string | undefined; offset: number } {
  if (input.cursor === undefined) return { ref: input.ref, offset: input.offset ?? 0 }
  if (input.ref !== undefined || input.offset !== undefined) fail('invalid_input', 'cursor: cannot be combined with ref or offset')
  const match = CURSOR.exec(input.cursor)
  if (!match) return fail('invalid_input', 'cursor: not a cursor issued by this tool')
  return { ref: match[1]!, offset: Number(match[2]) }
}

const REF_HELP = 'ref is "HEAD" (default) or a full commit id; every result names the commit it read, which is a valid plan.base. ' +
  'When a result has more=true, continue with cursor=nextCursor (it keeps the same commit).'
const COMMON = 'Read-only: committed files only, no untracked, ignored or secret files (dotenv, keys, credentials), output scrubbed; paths hidden by policy are never opened. ' + REF_HELP
export interface ProjectViewToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
const stringProperty = (description: string) => ({ type: 'string', description })
const integerProperty = (description: string) => ({ type: 'integer', minimum: 0, description })
const cursorProperty = stringProperty('nextCursor of the previous page; cannot be combined with ref or offset.')
/** Hand-written JSON Schemas of the zod inputs above; a test proves they agree on samples. Lengths come from the policy and are reported in `bounds`. */
export const PROJECT_VIEW_TOOLS: readonly ProjectViewToolDefinition[] = Object.freeze([
  { name: LEAD_PROJECT_TREE_TOOL,
    description: `List the delegated project's files at a commit, one page at a time. path is a project-relative directory (default: the root); recursive lists every file below it. ${COMMON} ` +
      'The result has more, nextCursor, total, withheld (entries not shown by policy) and the bounds in force.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { path: stringProperty('Project-relative directory; empty for the root.'), ref: stringProperty('"HEAD" or a full commit id.'),
      recursive: { type: 'boolean' }, offset: integerProperty('Index of the first entry (use cursor to continue).'), cursor: cursorProperty,
      limit: { type: 'integer', minimum: 1, description: 'Entries per page; the result reports the default and the maximum.' } } } },
  { name: LEAD_PROJECT_READ_TOOL,
    description: `Read a UTF-8 text file of the delegated project at a commit, one page at a time. path is project-relative. ${COMMON} ` +
      'offset and nextOffset are byte positions in the scrubbed text. Binary files, symlinks and files above the maximum size are refused with a fixed code.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: stringProperty('Project-relative file path.'), ref: stringProperty('"HEAD" or a full commit id.'),
      offset: integerProperty('Byte offset of the page (0 for the start; use cursor to continue).'), cursor: cursorProperty,
      limit: { type: 'integer', minimum: 1, description: 'Bytes per page; the result reports the default and the maximum.' } } } },
  { name: LEAD_PROJECT_SEARCH_TOOL,
    description: `Search the delegated project's files at a commit for a literal, case-sensitive, single-line text (not a regular expression), over the text as you would read it (scrubbed). path limits the search to a file or directory. ${COMMON} ` +
      'The result lists path, line (of the scrubbed text) and the (clipped) line, and reports what the scan skipped (files too large or not text) in scan.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, description: 'Literal text, one line; the result reports the maximum length.' },
      path: stringProperty('Project-relative file or directory to search in; empty for everything.'), ref: stringProperty('"HEAD" or a full commit id.'),
      offset: integerProperty('Number of matches to skip (use cursor to continue).'), cursor: cursorProperty,
      limit: { type: 'integer', minimum: 1, description: 'Matches per page; the result reports the default and the maximum.' } } } },
])
export type ProjectViewToolName = typeof LEAD_PROJECT_TREE_TOOL | typeof LEAD_PROJECT_READ_TOOL | typeof LEAD_PROJECT_SEARCH_TOOL

/** What the audit records about a call: never file text, never the search query. */
export interface ProjectViewSummary { path: string | null; commit: string | null; bytes: number; truncated: boolean; withheld: number; queryChars?: number }
export interface ProjectViewResult { text: string; summary: ProjectViewSummary }

// ---- the view ---------------------------------------------------------------------------------

interface Entry { mode: string; type: string; oid: string; size: number | null; path: string }
const ENTRY = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64}) +(-|BAD|\d+)\t([\s\S]+)$/
const parseEntry = (record: string): Entry | null => {
  const match = ENTRY.exec(record)
  return match ? { mode: match[1]!, type: match[2]!, oid: match[3]!, size: match[4] === '-' || match[4] === 'BAD' ? null : Number(match[4]), path: match[5]! } : null
}
const kindOf = (entry: Entry): 'dir' | 'file' | 'symlink' | 'submodule' =>
  entry.type === 'tree' ? 'dir' : entry.type === 'commit' ? 'submodule' : entry.mode === '120000' ? 'symlink' : 'file'
const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80
/** A window of `max` UTF-16 units of `line` around `at`, never splitting a surrogate pair, with explicit markers for what was cut. */
function clipAround(line: string, at: number, max: number): { text: string; clipped: boolean } {
  if (line.length <= max) return { text: line, clipped: false }
  let start = at > max / 2 ? Math.floor(at - max / 2) : 0
  start = Math.min(start, line.length - max)
  let end = start + max
  if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start]!)) start++
  if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--
  return { text: `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? `…[line clipped, ${line.length - (end - start)} more characters]` : ''}`, clipped: true }
}

export interface ProjectViewOptions { scrubber: EgressScrubber; policy?: Partial<ProjectViewPolicy>; /** Absolute path of the git binary (tests only). */ git?: string }

export class ProjectView {
  readonly policy: Readonly<ProjectViewPolicy>
  private readonly scrubber: EgressScrubber
  private readonly git: string
  /** Aborted by `close()`: ends every git process this view started and refuses new ones. */
  private readonly lifetime = new AbortController()
  constructor(options: ProjectViewOptions) {
    this.scrubber = options.scrubber
    this.git = options.git ?? '/usr/bin/git'
    const policy = { ...DEFAULT_PROJECT_VIEW_POLICY, ...options.policy }
    for (const [key, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new ProjectViewError('invalid_policy', key)
    if (policy.treeEntries > policy.maxTreeEntries || policy.pageBytes > policy.maxPageBytes || policy.searchMatches > policy.maxSearchMatches) throw new ProjectViewError('invalid_policy', 'default above maximum')
    this.policy = Object.freeze(policy)
  }

  /** Ends every running git process (`project_view_cancelled`) and refuses later calls; the node's shutdown calls it. */
  close(): void { this.lifetime.abort() }
  private signalFor(signal: AbortSignal | undefined): AbortSignal { return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal }

  run(tool: string, root: string, raw: unknown, signal?: AbortSignal): Promise<ProjectViewResult> {
    switch (tool) {
      case LEAD_PROJECT_TREE_TOOL: return this.tree(root, raw, signal)
      case LEAD_PROJECT_READ_TOOL: return this.read(root, raw, signal)
      case LEAD_PROJECT_SEARCH_TOOL: return this.search(root, raw, signal)
      default: return Promise.reject(new ProjectViewError('unknown_tool'))
    }
  }

  private path(raw: string | undefined, allowRoot: boolean): string { return viewPath(raw, allowRoot, this.policy.maxPathBytes) }
  private async buffered(signal: AbortSignal, root: string, args: readonly string[], maxBytes: number): Promise<{ code: number | null; text: string; bytes: Buffer }> {
    const out = collect(maxBytes)
    const run = await runGit(this.git, signal, root, args, this.policy.timeoutMs, out.sink)
    return { code: run.code, text: out.text(), bytes: out.bytes() }
  }
  /** The top level of the project's git repository and the commit `ref` names. */
  private async open(signal: AbortSignal, rootPath: string, rawRef: string | undefined): Promise<{ root: string; commit: string }> {
    const requested = rawRef === undefined || rawRef === '' ? 'HEAD' : rawRef
    if (requested !== 'HEAD' && !HEX.test(requested)) fail('ref_invalid')
    let root: string
    try { root = await realpath(rootPath) } catch { return fail('project_view_unavailable') }
    // The relay clones the repository and plans paths from its top level; a project root below it is not viewable either.
    const prefix = await this.buffered(signal, root, ['rev-parse', '--show-prefix'], 4_096)
    if (prefix.code !== 0 || prefix.text.trim() !== '') fail('project_view_unavailable')
    const resolved = await this.buffered(signal, root, ['rev-parse', '--verify', '--end-of-options', `${requested}^{commit}`], 4_096)
    const commit = resolved.text.trim()
    if (resolved.code !== 0 || !HEX.test(commit)) fail('ref_not_found')
    return { root, commit }
  }
  /** The tree entry at `path` itself (not its children), or null. */
  private async entryAt(signal: AbortSignal, root: string, commit: string, path: string): Promise<Entry | null> {
    const listed = await this.buffered(signal, root, ['ls-tree', '-z', '--long', commit, '--', path], this.policy.maxPathBytes + 512)
    if (listed.code !== 0) fail('project_view_unavailable')
    for (const record of listed.text.split('\0')) {
      const entry = record ? parseEntry(record) : null
      if (entry && entry.path === path) return entry
    }
    return null
  }
  private clamp(asked: number | undefined, fallback: number, maximum: number): number { return Math.min(asked ?? fallback, maximum) }
  /** Serialized, scrubbed, within `maxResultBytes`: `build` is called with a growing `shrink` until the body fits. */
  private serialize(build: (shrink: number) => Record<string, unknown>, steps: number): string {
    for (let shrink = 0; ; shrink++) {
      const body = JSON.stringify(this.scrubber.scrub(build(shrink)))
      if (Buffer.byteLength(body) <= this.policy.maxResultBytes || shrink >= steps) {
        if (Buffer.byteLength(body) > this.policy.maxResultBytes) fail('result_too_large')
        return body
      }
    }
  }
  private bounds(extra: Record<string, number>): Record<string, number> { return { ...extra, maxResultBytes: this.policy.maxResultBytes, maxPathBytes: this.policy.maxPathBytes } }

  async tree(rootPath: string, raw: unknown, abort?: AbortSignal): Promise<ProjectViewResult> {
    const signal = this.signalFor(abort)
    const input = parse(treeInput, raw)
    const path = this.path(input.path, true)
    const start = pin(input)
    const { root, commit } = await this.open(signal, rootPath, start.ref)
    if (path !== '') {
      const entry = await this.entryAt(signal, root, commit, path)
      if (!entry) fail('not_found')
      if (entry!.type !== 'tree') fail('not_a_directory')
    }
    const offset = start.offset
    const limit = this.clamp(input.limit, this.policy.treeEntries, this.policy.maxTreeEntries)
    const page: { path: string; type: string; size?: number }[] = []
    let total = 0, withheld = 0
    // The whole listing is streamed so `total` and `withheld` are exact; only the requested window is kept.
    const listing = records(0, this.policy.maxPathBytes + 512, record => {
      const entry = record === null ? null : parseEntry(record.toString('utf8'))
      if (!entry || deniedPath(entry.path)) { withheld++; return }
      if (total >= offset && page.length < limit) {
        const type = kindOf(entry)
        page.push(type === 'file' && entry.size !== null ? { path: entry.path, type, size: entry.size } : { path: entry.path, type })
      }
      total++
    })
    const run = await runGit(this.git, signal, root, ['ls-tree', ...(input.recursive ? ['-r'] : []), '-z', '--long', commit, ...(path === '' ? [] : ['--', `${path}/`])], this.policy.timeoutMs, listing)
    if (run.code !== 0) fail('project_view_unavailable')
    let kept = page.length
    const body = this.serialize(shrink => {
      kept = Math.max(0, page.length - shrink * Math.max(1, Math.ceil(page.length / 8)))
      const next = offset + kept
      return { commit, path, recursive: input.recursive === true, entries: page.slice(0, kept), offset, nextOffset: next < total ? next : null,
        nextCursor: next < total ? `${commit}:${next}` : null, more: next < total, total, withheld, truncated: next < total,
        bounds: this.bounds({ limit, defaultLimit: this.policy.treeEntries, maxLimit: this.policy.maxTreeEntries }) }
    }, 64)
    return { text: body, summary: { path, commit, bytes: Buffer.byteLength(body), truncated: offset + kept < total, withheld } }
  }

  async read(rootPath: string, raw: unknown, abort?: AbortSignal): Promise<ProjectViewResult> {
    const signal = this.signalFor(abort)
    const input = parse(readInput, raw)
    const path = this.path(input.path, false)
    const start = pin(input)
    const { root, commit } = await this.open(signal, rootPath, start.ref)
    const entry = await this.entryAt(signal, root, commit, path)
    if (!entry) fail('not_found')
    const kind = kindOf(entry!)
    if (kind === 'symlink') fail('symlink_denied')
    if (kind !== 'file') fail('not_a_file')
    // With lazy fetching off, git prints `BAD` for the size of a blob a partial clone does not hold: it is unavailable, not empty.
    if (entry!.size === null) return fail('project_view_unavailable')
    const size: number = entry!.size
    if (size > this.policy.maxFileBytes) fail('file_too_large', `size ${size} bytes, limit ${this.policy.maxFileBytes}`)
    const blob = await this.buffered(signal, root, ['cat-file', 'blob', entry!.oid], size)
    if (blob.code !== 0 || blob.bytes.length !== size) fail('project_view_unavailable')
    // Git's own rule for binary content, then strict UTF-8: a file the lead cannot read as text is refused, never mangled.
    if (blob.bytes.subarray(0, 8_000).includes(0)) fail('binary_file')
    let original: string
    try { original = new TextDecoder('utf-8', { fatal: true }).decode(blob.bytes) } catch { return fail('binary_file') }
    // The whole file is scrubbed before it is paged, so a registered secret that straddles a page boundary is still redacted.
    const clean = this.scrubber.scrub(original)
    const text = Buffer.from(clean, 'utf8')
    const offset = start.offset
    if (offset > text.length || (offset < text.length && isContinuation(text[offset]))) fail('invalid_offset')
    const limit = this.clamp(input.limit, this.policy.pageBytes, this.policy.maxPageBytes)
    let end = Math.min(text.length, offset + limit)
    const build = (at: number) => ({ commit, path, size, totalBytes: text.length, offset, nextOffset: at < text.length ? at : null,
      nextCursor: at < text.length ? `${commit}:${at}` : null, more: at < text.length, truncated: at < text.length, redacted: clean !== original,
      text: text.subarray(offset, at).toString('utf8'),
      bounds: this.bounds({ limit, defaultLimit: this.policy.pageBytes, maxLimit: this.policy.maxPageBytes, maxFileBytes: this.policy.maxFileBytes }) })
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

  /** Searches the scrubbed text of every allowed blob of the commit, in tree order. Paths the name policy hides are removed from the list
   * before any blob is requested, so they are never opened and nothing in the result (matches, counts, scan figures) can depend on them. */
  async search(rootPath: string, raw: unknown, abort?: AbortSignal): Promise<ProjectViewResult> {
    const signal = this.signalFor(abort)
    const input = parse(searchInput, raw)
    // A newline would make a multi-line pattern; the text is one line of the scrubbed text.
    if (/[\u0000\r\n]/.test(input.text)) fail('invalid_input', 'text: must be a single line')
    if (Array.from(input.text).length > this.policy.maxTextChars) fail('invalid_input', `text: longer than ${this.policy.maxTextChars} characters`)
    const path = this.path(input.path, true)
    const start = pin(input)
    const { root, commit } = await this.open(signal, rootPath, start.ref)
    let scope: string[] = []
    if (path !== '') {
      const entry = await this.entryAt(signal, root, commit, path)
      if (!entry) fail('not_found')
      scope = ['--', entry!.type === 'tree' ? `${path}/` : path]
    }
    const offset = start.offset
    const limit = this.clamp(input.limit, this.policy.searchMatches, this.policy.maxSearchMatches)
    // 1. The allowed blobs, from the tree object: `-z`, so a file name may hold any byte but NUL.
    // The scan budget is applied while listing: once the blobs kept would exceed `maxScanBytes` nothing more is stored, the rest is only counted.
    // A record that is not a parsable entry (longer than the path bound) is counted nowhere: it may be a hidden path, and a figure for it would say so.
    const queue: { path: string; oid: string; size: number }[] = []
    let skippedLarge = 0, skippedOther = 0, unscanned = 0, budget = 0
    const listing = records(0, this.policy.maxPathBytes + 512, record => {
      const entry = record === null ? null : parseEntry(record.toString('utf8'))
      if (!entry) return
      if (deniedPath(entry.path)) return
      if (kindOf(entry) !== 'file' || entry.size === null || entry.size === 0) { skippedOther++; return }
      if (entry.size > this.policy.maxFileBytes) { skippedLarge++; return }
      if (unscanned > 0 || budget + entry.size > this.policy.maxScanBytes) { unscanned++; return }
      budget += entry.size
      queue.push({ path: entry.path, oid: entry.oid, size: entry.size })
    })
    const listed = await runGit(this.git, signal, root, ['ls-tree', '-r', '-z', '--long', commit, ...scope], this.policy.timeoutMs, listing)
    if (listed.code !== 0) fail('project_view_unavailable')
    // 2. Only the kept blobs are read.
    // 3. One `cat-file --batch`, each blob scrubbed as a whole and searched line by line.
    const matches: { path: string; line: number; text: string }[] = []
    let seen = 0, more = false, lineCut = false, scanned = 0, skippedBinary = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let sinceYield = 0
    const frames = blobFrames(queue.map(file => file.size), (index, blob) => {
      sinceYield += blob.length
      if (blob.subarray(0, 8_000).includes(0)) { skippedBinary++; return }
      let text: string
      try { text = decoder.decode(blob) } catch { skippedBinary++; return }
      scanned++
      // The text as the lead would read it: a match inside a redacted region (also across lines) must not exist, or the search is an oracle.
      const clean = this.scrubber.scrub(text)
      let from = 0, line = 1, lineStart = 0
      for (;;) {
        const at = clean.indexOf(input.text, from)
        if (at < 0) return
        const begin = clean.lastIndexOf('\n', at - 1) + 1
        for (let nl = clean.indexOf('\n', lineStart); nl >= 0 && nl < begin; nl = clean.indexOf('\n', nl + 1)) line++
        lineStart = begin
        let finish = clean.indexOf('\n', at)
        if (finish < 0) finish = clean.length
        from = finish + 1
        if (seen++ < offset) continue
        if (matches.length >= limit) { more = true; return false }
        const excerpt = clipAround(clean.slice(begin, finish).replace(/\r$/, ''), at - begin, this.policy.lineChars)
        if (excerpt.clipped) lineCut = true
        matches.push({ path: queue[index]!.path, line, text: excerpt.text })
      }
    })
    // Scrubbing is synchronous: after about 8 MiB of blobs the process is paused and the event loop gets a turn.
    const scanSink: Sink = chunk => {
      const answer = frames.sink(chunk)
      if (answer === false || sinceYield < 8_388_608) return answer
      sinceYield = 0
      return new Promise<void>(resolve => { setImmediate(resolve) })
    }
    if (queue.length) {
      const run = await runGit(this.git, signal, root, ['cat-file', '--batch'], this.policy.timeoutMs, scanSink, queue.map(file => file.oid).join('\n') + '\n')
      if (!run.stopped && (run.code !== 0 || !frames.done())) fail('project_view_unavailable')
    }
    let kept = matches.length
    const body = this.serialize(shrink => {
      kept = Math.max(0, matches.length - shrink * Math.max(1, Math.ceil(matches.length / 8)))
      const next = offset + kept
      const cut = more || kept < matches.length
      return { commit, path, matches: matches.slice(0, kept), offset, nextOffset: cut ? next : null, nextCursor: cut ? `${commit}:${next}` : null,
        more: cut, truncated: cut || lineCut || unscanned > 0, note: 'Paths hidden by policy are never searched.',
        scan: { files: scanned, skippedTooLarge: skippedLarge, skippedNotText: skippedBinary + skippedOther, unscanned, complete: unscanned === 0 },
        bounds: this.bounds({ limit, defaultLimit: this.policy.searchMatches, maxLimit: this.policy.maxSearchMatches, lineChars: this.policy.lineChars,
          maxTextChars: this.policy.maxTextChars, maxFileBytes: this.policy.maxFileBytes, maxScanBytes: this.policy.maxScanBytes }) }
    }, 64)
    return { text: body, summary: { path, commit, bytes: Buffer.byteLength(body), truncated: more || kept < matches.length || lineCut || unscanned > 0, withheld: 0, queryChars: Array.from(input.text).length } }
  }
}
