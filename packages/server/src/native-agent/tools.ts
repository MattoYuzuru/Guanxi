import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AppendOptions, AppendResult, SessionEventInput, SessionHandle, SessionLog } from '../session-log/log.ts'
import type { SessionEventType } from '@guanxi/contract'
import { querySessionLog } from '../session-log/query-tool.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { resolveInWorkspace } from '../tools/jail.ts'
import { sandboxCommand, quote, type SandboxPolicy, type CommandResult } from './sandbox.ts'
import type { ProjectIndexService } from '../indexing/plugin.ts'
import { directSymbols } from '../indexing/lsp.ts'
import { boundMap } from '../indexing/engine.ts'
import { ProjectIndex } from '../indexing/service.ts'
import { ResourceGovernor } from '../runtime/resource-governor.ts'
import { type MapResult } from '../indexing/types.ts'
import { dirname, relative, sep, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { randomBytes } from 'node:crypto'
import { NativeOutputs } from './outputs.ts'

export interface NativeToolContext {
  index?: ProjectIndexService
  policy: SandboxPolicy
  log: SessionLog
  handle: SessionHandle
  scrubber: EgressScrubber
  executeCommand?: typeof sandboxCommand
  /** Directory `shell` commands start in. Absent: `policy.scratch`, which is also the sandbox's HOME/TMPDIR.
   * A native session deliberately starts in scratch; the relay sets this to its checkout so relative plan paths
   * resolve the way its acceptance gates do. */
  cwd?: string
  guard?(): void
  /** Largest serialized result of a paged tool (`file_read`, `tool_output_read`) the caller can keep whole. Absent: the tool's own bounds. */
  pageBytes?: number
  queue(text: string): void | Promise<void>
  /** Enqueue one native trace append through the attempt FIFO. */
  append?<T extends SessionEventType>(input: SessionEventInput<T>, options?: AppendOptions): Promise<AppendResult>
  /** Wait for the exact tool.call durable commit before any tool body effect. */
  awaitToolCall?(toolCallId: string, signal?: AbortSignal): Promise<void>
  /** Abort the turn after a missing/rejected durable acknowledgment. */
  abortTurn?(): void
}
/** Exit code of a command line whose `cd` failed. 125 is the infrastructure code the container guard already uses for its own
 * `cd "$HOME"`: it is neither the command's status (a failed `cd X && cmd` exits 1, which a red test or a missing file also does)
 * nor the shell's 126/127. */
export const CWD_FAILED_EXIT = 125
/** The fixed code of a failed `cd`; a per-call random suffix follows it on the stderr line. */
const CWD_MARKER = 'cwd_unavailable'
/** `command` run in `directory`, and the way to read its result. The command does not run when the directory cannot be entered.
 *
 * The failure is `failed(result)`: exit 125 **and** a stderr line that is exactly this call's marker line. The suffix is random per
 * call, so a command that prints `cwd_unavailable` (or a prefix of the line) and exits 125 keeps its own result; the line is compared
 * whole and anywhere in stderr, so a wrapper that writes its own stderr first (a sandbox or guard warning) does not hide the failure.
 * The line is in the command text, so a command that reads its parent's arguments could still forge it: that only damages its own verdict. */
export function inDirectory(directory: string, command: string): { line: string; failed(result: Pick<CommandResult, 'code' | 'stderr'>): boolean } {
  const marker = `${CWD_MARKER}:${randomBytes(16).toString('hex')}`
  return {
    line: `cd ${quote(directory)} 2>/dev/null || { echo ${marker} >&2; exit ${CWD_FAILED_EXIT}; }; ${command}`,
    failed: result => result.code === CWD_FAILED_EXIT && result.stderr.split('\n').some(row => row === marker),
  }
}
export function nativeTools(ctx: NativeToolContext): AgentTool[] {
  const { policy, handle, scrubber } = ctx
  const outputs = new NativeOutputs(policy.runtimeBase ?? dirname(policy.scratch), handle.sessionId, scrubber)
  const path = (value: string, write = false) => {
    const roots = [...(!write || policy.mode === 'full-access' ? policy.roots : []), policy.scratch, ...(!write ? policy.attachments : [])]
    for (const root of roots) {
      try { return resolveInWorkspace(root, value) } catch { /* try the next allowed root */ }
    }
    throw new Error('path_denied')
  }
  const indexed = async (kind: 'search' | 'map', requested: string, text: string | undefined, budget: number | undefined, signal?: AbortSignal) => {
    const target = path(requested)
    const root = [...policy.roots, policy.scratch, ...policy.attachments].find(root => target === root || target.startsWith(root + sep))
    if (!root) throw new Error('path_denied')
    const scopedPath = relative(root, target)
    if (ctx.index && policy.roots.includes(root)) {
      if (kind === 'search') return JSON.stringify(await ctx.index.search(root, text!, scopedPath, signal))
      const result = await ctx.index.map(root, budget, scopedPath, signal)
      // Direct LSP is optional and is attempted only for a single-file request.
      // Directory maps stay cheap and use the content cache.
      if (result.entries.length === 1 && result.entries[0]!.path === scopedPath) {
        const symbols = await directSymbols(policy, root, join(root, scopedPath), ctx.executeCommand ?? sandboxCommand, scrubber, signal)
        if (symbols) { result.entries[0]!.symbols = symbols; result.entries[0]!.source = 'lsp' }
      }
      return JSON.stringify(boundMap(scrubber.scrub(result) as MapResult, budget ?? 2048))
    }
    // The same captured scanner and OS boundary serve scratch, attachments and
    // installations with no index plugin. No host-filesystem scanner fallback.
    const governor = new ResourceGovernor()
    const fallback = new ProjectIndex({ dataDir: policy.runtimeBase ?? dirname(policy.scratch), scrubber, governor, ephemeral: true })
    try { return JSON.stringify(kind === 'search'
      ? await fallback.search(root, text!, scopedPath, signal)
      : await fallback.map(root, budget, scopedPath, signal)) }
    finally { await fallback.close(); await governor.close() }
  }
  /** `accepted: null` accepts any exit code: the caller reads `code` itself (the relay's shell, whose model must see a failing test's output). */
  const run = async (command: string, signal?: AbortSignal, accepted: readonly number[] | null = [0], fixed = true, cwd?: string) => {
    // The sandbox starts every command in HOME/TMPDIR=scratch. A caller with one unit of work (the relay
    // checkout) names it here, exactly as the gate command names its own clean checkout.
    const entered = cwd ? inDirectory(cwd, command) : undefined
    const result = await (ctx.executeCommand ?? sandboxCommand)(policy, entered?.line ?? command, signal, 120_000, fixed, scrubber)
    const clean = scrubber.scrub(result)
    // The command never started: say so with a fixed code rather than hand the model a plausible exit.
    if (entered?.failed(clean)) throw new Error(CWD_MARKER)
    if (clean.code === null || (accepted !== null && !accepted.includes(clean.code))) throw new Error('tool_failed')
    return JSON.stringify(clean)
  }
  /** One page of a text file starting at byte `offset`. The result is the command result with the cursor fields in front; `stdout`
   * stays last, so a reader that cuts the tail of the text still has `more` and `nextOffset`.
   *
   * `nextOffset` is a position in the FILE, so it is only issued while the page is exactly the bytes it came from. Redaction (a registered
   * secret is replaced by a marker of another length) and invalid bytes (each decodes to three bytes of text) break that, but only where they
   * are: a page ends in front of the first redacted region or the first character the file does not hold, and a page that would start there has
   * no honest cursor (`page_cursor_unavailable`). A real U+FFFD (EF BF BD) is kept: the page's bytes are compared with the file's. Without a
   * page budget the whole remainder is returned as before, and a cursor that cannot be trusted is `null`. */
  const fileRead = async (requested: string, rawOffset: unknown, signal?: AbortSignal) => {
    // Decimal digits only, as a string or a number: no sign, fraction, exponent, hex or padding.
    if (rawOffset !== undefined && rawOffset !== '' && !/^\d{1,15}$/.test(String(rawOffset))) throw new Error('invalid_offset')
    const offset = rawOffset === undefined || rawOffset === '' ? 0 : Number(rawOffset)
    const target = quote(path(requested)), execute = ctx.executeCommand ?? sandboxCommand
    const raw = await execute(policy, offset === 0 ? `/bin/cat -- ${target}` : `/usr/bin/tail -c +${offset + 1} -- ${target}`, signal, 120_000, true, scrubber)
    const result = scrubber.scrub(raw)
    if (result.code !== 0) throw new Error('tool_failed')
    const dump = async (from: number, count: number) => scrubber.scrub(await execute(policy, `/usr/bin/od -An -v -tx1 -j ${from} -N ${count} -- ${target}`, signal, 120_000, true, scrubber))
    // `od` pads its columns differently on macOS and Linux: compare the bytes, not the layout.
    const hex = (out: { code: number | null; stdout: string; truncated: boolean }) => out.code === 0 && !out.truncated ? out.stdout.split(/\s+/).join('') : null
    if (offset > 0 && result.stdout.startsWith('\uFFFD')) {
      // Either the offset is inside a multi-byte character (every continuation byte decodes to a replacement character) or the file really
      // has U+FFFD here, which a cursor this tool returned can point at. The bytes at the offset tell them apart.
      if (hex(await dump(offset, 3)) !== 'efbfbd') throw new Error('invalid_offset')
    }
    // The bytes of the scrubbed text that are the file's own: everything before the first change redaction made.
    let same = Infinity
    if (result.stdout !== raw.stdout) {
      let i = 0
      while (i < raw.stdout.length && i < result.stdout.length && raw.stdout.charCodeAt(i) === result.stdout.charCodeAt(i)) i++
      if (i > 0 && /[\uD800-\uDBFF]/.test(result.stdout[i - 1]!)) i--
      same = Buffer.byteLength(result.stdout.slice(0, i))
    }
    const data = Buffer.from(result.stdout), limit = ctx.pageBytes
    for (let page = data.length; ;) {
      let text = new StringDecoder('utf8').write(data.subarray(0, page))
      let used = Buffer.byteLength(text)
      if (used === 0 && data.length > 0) throw new Error('page_too_small')
      const more = used < data.length || result.truncated
      let cursor = true
      if (more && used > same) {
        if (limit === undefined) cursor = false
        else { text = new StringDecoder('utf8').write(data.subarray(0, same)); used = Buffer.byteLength(text); if (used === 0) throw new Error('page_cursor_unavailable') }
      }
      if (more && cursor && text.includes('\uFFFD') && hex(await dump(offset, used)) !== Buffer.from(text).toString('hex')) {
        // The file does not hold every character of this page: end it in front of the first one it does not hold.
        text = text.slice(0, text.indexOf('\uFFFD')); used = Buffer.byteLength(text)
        if (used === 0) throw new Error('page_cursor_unavailable')
      }
      // `truncated` keeps its old meaning for a reader that has only seen it: the text below is not the whole of what follows the offset.
      const body = JSON.stringify({ more, nextOffset: cursor ? offset + used : null, offset, code: result.code, stderr: result.stderr, truncated: more, stdout: text })
      if (limit === undefined || Buffer.byteLength(body) <= limit) return body
      if (page === 0) throw new Error('page_too_small')
      page = Math.max(0, Math.min(page - 1, Math.floor(page * limit / Buffer.byteLength(body)) - 1))
    }
  }
  const tool = (name: string, description: string, properties: Record<string, ReturnType<typeof Type.String>>, execute: (args: Record<string, string>, signal?: AbortSignal) => Promise<string>): AgentTool => ({
    name, label: name, description, parameters: Type.Object(properties),
    async execute(_id, raw, signal) {
      try {
        await ctx.awaitToolCall?.(_id, signal)
        ctx.guard?.()
        signal?.throwIfAborted()
        // Whole results are scrubbed before the model, trace, or next tool sees them.
        const content = await execute(scrubber.scrub(raw as Record<string, string>), signal)
        ctx.guard?.()
        return { content: [{ type: 'text', text: await outputs.bound(content) }], details: null }
      } catch (error) {
        // A fixed code is safe to return: it carries no free text. Everything else (an OS message, a
        // path, a provider's words) stays behind the generic code and never reaches the model or trace.
        const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : 'tool_denied_or_failed'
        if (code === 'input_artifact_storage_failed' || code === 'tool_call_trace_missing') {
          ctx.abortTurn?.()
          return { content: [{ type: 'text', text: 'input_artifact_storage_failed' }], details: { code: 'input_artifact_storage_failed' }, isError: true }
        }
        return { content: [{ type: 'text', text: code === 'cleanup_unconfirmed' ? code : signal?.aborted ? 'cancelled' : code }], details: { code }, isError: true }
      }
    },
  })
  return [
    tool('tool_output_read', 'Read a session output artifact by its returned ID and byte offset. Results are paged at 8 KiB; nextOffset resumes without a hidden content cap.', { artifact: Type.String(), offset: Type.String() }, async a => outputs.read(a.artifact!, Number(a.offset), ctx.pageBytes)),
    tool('project_info', 'Read immutable roots, scratch, network policy, attachments and instruction paths. No token budget is invented.', {}, async () => JSON.stringify({ ...policy, budgets: 'model/runtime limits; no additional cap', instructions: policy.roots.map(root => `${root}/AGENTS.md`) })),
    tool('file_read', 'Read a UTF-8 text file in roots, scratch or attachments. Absolute paths select another root. offset is a byte offset (default 0); the result has more and nextOffset, so a large file is read page by page with offset=nextOffset.', { path: Type.String(), offset: Type.Optional(Type.String()) }, async (a, s) => fileRead(a.path!, a.offset, s)),
    tool('file_write', 'Write UTF-8 content. Read-only writes only to scratch. Protected paths are always denied.', { path: Type.String(), content: Type.String() }, async (a, s) => run(`printf %s ${quote(a.content!)} > ${quote(path(a.path!, true))}`, s)),
    tool('shell', 'Run a shell command under the access policy and a PID-namespace execution owner. macOS requires the local container runtime and provisioned execution image; no host-shell fallback. Fixed pwd/ls/cat/head/tail/wc commands also work without that runtime.', { command: Type.String() }, async (a, s) => {
      if (!/^(pwd|ls|cat|head|tail|wc)( [a-zA-Z0-9_./ -]+)?$/.test(a.command!)) return run(a.command!, s, ctx.cwd ? null : [0], false, ctx.cwd)
      const [program, ...args] = a.command!.split(/ +/)
      const binaries: Record<string, string> = { pwd: '/bin/pwd', ls: '/bin/ls', cat: '/bin/cat', head: '/usr/bin/head', tail: '/usr/bin/tail', wc: '/usr/bin/wc' }
      return run([quote(binaries[program!]!), ...args.map(quote)].join(' '), s, ctx.cwd ? null : [0], true, ctx.cwd)
    }),
    tool('search', 'Search literal text with FTS5 and Node grep fallback. Result includes checked-out commit, index age, coverage and explicit truncation. Ignored, .env and registered-secret files are excluded.', { path: Type.String(), text: Type.String() }, async (a, s) => indexed('search', a.path!, a.text, undefined, s)),
    tool('repo_map', 'repo.map: repository files and cached tree-sitter symbols. budget is a positive token upper bound measured as UTF-8 bytes for the complete JSON result, including provenance. Small budgets may be refused. Wire alias repo_map.', { path: Type.String(), budget: Type.String() }, async (a, s) => indexed('map', a.path!, undefined, Number(a.budget), s)),
    tool('fetch', 'Fetch an allowlisted HTTP(S) URL. Read-only permits GET, HEAD, OPTIONS; redirects and raw tunnels are denied. Body is text.', { url: Type.String(), method: Type.String(), body: Type.String() }, async (a, s) => {
      const url = new URL(a.url!)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('url_denied')
      const method = a.method!.toUpperCase()
      if (!/^[A-Z]+$/.test(method) || (policy.mode === 'read-only' && !['GET', 'HEAD', 'OPTIONS'].includes(method))) throw new Error('method_denied')
      return run(`/usr/bin/curl --disable --noproxy '' --silent --show-error --fail --max-time 60 --request ${quote(method)} ${method === 'HEAD' ? '--head' : ''} ${a.body ? `--data-raw ${quote(a.body)}` : ''} -- ${quote(url.href)}`, s)
    }),
    tool('attachments', 'List the selected, read-only attachments. Use file_read for text; unsupported binary formats need a converter.', {}, async () => JSON.stringify(policy.attachmentMetadata ?? policy.attachments)),
    tool('plan', 'Replace the light session plan (off-ledger). Completed agent items request verification; they do not prove completion. items is a JSON array.', { items: Type.String() }, async a => {
      const items = JSON.parse(a.items!)
      const result = await ctx.append?.({ type: 'agent.plan', data: { items } })
      return JSON.stringify(result?.event.data ?? { items })
    }),
    tool('queue', 'Queue a follow-up prompt after the current turn. The person can remove pending prompts.', { text: Type.String() }, async a => { await ctx.queue(a.text!); return 'queued' }),
    tool('note_add', 'Save a session note.', { text: Type.String() }, async a => { await ctx.append?.({ type: 'agent.note', data: { text: a.text! } }); return 'saved' }),
    tool('session_log_query', 'Read only this session log. Reasoning is excluded for every model by this conservative binding.', { query: Type.String() }, async a => JSON.stringify(querySessionLog(ctx.log, handle.sessionId, 'remote_agent', JSON.parse(a.query!)))),
  ]
}
