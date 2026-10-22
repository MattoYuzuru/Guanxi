import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AppendOptions, AppendResult, SessionEventInput, SessionHandle, SessionLog } from '../session-log/log.ts'
import type { SessionEventType } from '@guanxi/contract'
import { querySessionLog } from '../session-log/query-tool.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { resolveInWorkspace } from '../tools/jail.ts'
import { sandboxCommand, quote, type SandboxPolicy } from './sandbox.ts'
import type { ProjectIndexService } from '../indexing/plugin.ts'
import { directSymbols } from '../indexing/lsp.ts'
import { boundMap } from '../indexing/engine.ts'
import { ProjectIndex } from '../indexing/service.ts'
import { ResourceGovernor } from '../runtime/resource-governor.ts'
import { type MapResult } from '../indexing/types.ts'
import { dirname, relative, sep, join } from 'node:path'
import { NativeOutputs } from './outputs.ts'

export interface NativeToolContext {
  index?: ProjectIndexService
  policy: SandboxPolicy
  log: SessionLog
  handle: SessionHandle
  scrubber: EgressScrubber
  executeCommand?: typeof sandboxCommand
  guard?(): void
  queue(text: string): void | Promise<void>
  /** Enqueue one native trace append through the attempt FIFO. */
  append?<T extends SessionEventType>(input: SessionEventInput<T>, options?: AppendOptions): Promise<AppendResult>
  /** Wait for the exact tool.call durable commit before any tool body effect. */
  awaitToolCall?(toolCallId: string, signal?: AbortSignal): Promise<void>
  /** Abort the turn after a missing/rejected durable acknowledgment. */
  abortTurn?(): void
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
  const run = async (command: string, signal?: AbortSignal, accepted = [0], fixed = true) => {
    const result = await (ctx.executeCommand ?? sandboxCommand)(policy, command, signal, 120_000, fixed, scrubber)
    const clean = scrubber.scrub(result)
    if (clean.code === null || !accepted.includes(clean.code)) throw new Error('tool_failed')
    return JSON.stringify(clean)
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
        const safeCodes = ['cleanup_unconfirmed', 'supervision_unavailable', 'container_runtime_unavailable', 'container_path_unsupported', 'container_home_root_denied', 'container_runtime_protected', 'hardlinked_writable_file', 'path_denied', 'command_denied', 'method_denied', 'url_denied', 'runtime_overlaps_roots', 'input_artifact_storage_failed', 'tool_call_trace_missing']
        const code = error instanceof Error && (safeCodes.includes(error.message) || /^index_[a-z_]+$/.test(error.message)) ? error.message : 'tool_denied_or_failed'
        if (code === 'input_artifact_storage_failed' || code === 'tool_call_trace_missing') {
          ctx.abortTurn?.()
          return { content: [{ type: 'text', text: 'input_artifact_storage_failed' }], details: { code: 'input_artifact_storage_failed' }, isError: true }
        }
        return { content: [{ type: 'text', text: code === 'cleanup_unconfirmed' ? code : signal?.aborted ? 'cancelled' : code }], details: { code }, isError: true }
      }
    },
  })
  return [
    tool('tool_output_read', 'Read a session output artifact by its returned ID and byte offset. Results are paged at 8 KiB; nextOffset resumes without a hidden content cap.', { artifact: Type.String(), offset: Type.String() }, async a => outputs.read(a.artifact!, Number(a.offset))),
    tool('project_info', 'Read immutable roots, scratch, network policy, attachments and instruction paths. No token budget is invented.', {}, async () => JSON.stringify({ ...policy, budgets: 'model/runtime limits; no additional cap', instructions: policy.roots.map(root => `${root}/AGENTS.md`) })),
    tool('file_read', 'Read a UTF-8 file in roots, scratch or attachments. Absolute paths select another root.', { path: Type.String() }, async (a, s) => run(`/bin/cat -- ${quote(path(a.path!))}`, s)),
    tool('file_write', 'Write UTF-8 content. Read-only writes only to scratch. Protected paths are always denied.', { path: Type.String(), content: Type.String() }, async (a, s) => run(`printf %s ${quote(a.content!)} > ${quote(path(a.path!, true))}`, s)),
    tool('shell', 'Run a shell command under the access policy and a PID-namespace execution owner. macOS requires the local container runtime and provisioned execution image; no host-shell fallback. Fixed pwd/ls/cat/head/tail/wc commands also work without that runtime.', { command: Type.String() }, async (a, s) => {
      if (!/^(pwd|ls|cat|head|tail|wc)( [a-zA-Z0-9_./ -]+)?$/.test(a.command!)) return run(a.command!, s, [0], false)
      const [program, ...args] = a.command!.split(/ +/)
      const binaries: Record<string, string> = { pwd: '/bin/pwd', ls: '/bin/ls', cat: '/bin/cat', head: '/usr/bin/head', tail: '/usr/bin/tail', wc: '/usr/bin/wc' }
      return run([quote(binaries[program!]!), ...args.map(quote)].join(' '), s)
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
