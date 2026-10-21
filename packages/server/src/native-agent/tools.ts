import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { SessionHandle, SessionLog } from '../session-log/log.ts'
import { querySessionLog } from '../session-log/query-tool.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { resolveInWorkspace } from '../tools/jail.ts'
import { sandboxCommand, quote, type SandboxPolicy } from './sandbox.ts'

export interface NativeToolContext {
  policy: SandboxPolicy
  log: SessionLog
  handle: SessionHandle
  scrubber: EgressScrubber
  queue(text: string): void
}
export function nativeTools(ctx: NativeToolContext): AgentTool[] {
  const { policy, handle, scrubber } = ctx
  const path = (value: string, write = false) => {
    const roots = [...(!write || policy.mode === 'full-access' ? policy.roots : []), policy.scratch, ...(!write ? policy.attachments : [])]
    for (const root of roots) {
      try { return resolveInWorkspace(root, value) } catch { /* try the next allowed root */ }
    }
    throw new Error('path_denied')
  }
  const run = async (command: string, signal?: AbortSignal, accepted = [0]) => {
    const result = await sandboxCommand(policy, command, signal)
    const clean = scrubber.scrub(result)
    if (clean.code === null || !accepted.includes(clean.code)) throw new Error('tool_failed')
    return JSON.stringify(clean)
  }
  const tool = (name: string, description: string, properties: Record<string, ReturnType<typeof Type.String>>, execute: (args: Record<string, string>, signal?: AbortSignal) => Promise<string>): AgentTool => ({
    name, label: name, description, parameters: Type.Object(properties),
    async execute(_id, raw, signal) {
      try {
        // Whole results are scrubbed before the model, trace, or next tool sees them.
        const content = await execute(scrubber.scrub(raw as Record<string, string>), signal)
        return { content: [{ type: 'text', text: scrubber.scrub(content) }], details: null }
      } catch (error) {
        const safeCodes = ['supervision_unavailable', 'hardlinked_writable_file', 'path_denied', 'command_denied', 'method_denied', 'url_denied', 'runtime_overlaps_roots']
        const code = error instanceof Error && safeCodes.includes(error.message) ? error.message : 'tool_denied_or_failed'
        return { content: [{ type: 'text', text: signal?.aborted ? 'cancelled' : code }], details: null, isError: true }
      }
    },
  })
  return [
    tool('project_info', 'Read immutable roots, scratch, network policy, attachments and instruction paths. No token budget is invented.', {}, async () => JSON.stringify({ ...policy, budgets: 'model/runtime limits; no additional cap', instructions: policy.roots.map(root => `${root}/AGENTS.md`) })),
    tool('file_read', 'Read a UTF-8 file in roots, scratch or attachments. Absolute paths select another root.', { path: Type.String() }, async (a, s) => run(`/bin/cat -- ${quote(path(a.path!))}`, s)),
    tool('file_write', 'Write UTF-8 content. Read-only writes only to scratch. Protected paths are always denied.', { path: Type.String(), content: Type.String() }, async (a, s) => run(`printf %s ${quote(a.content!)} > ${quote(path(a.path!, true))}`, s)),
    tool('shell', 'Run pwd/ls/cat/head/tail/wc with plain arguments. Arbitrary execution is unavailable until descendant supervision exists, in both modes.', { command: Type.String() }, async (a, s) => {
      if (!/^(pwd|ls|cat|head|tail|wc)( [a-zA-Z0-9_./ -]+)?$/.test(a.command!)) throw new Error('supervision_unavailable')
      const [program, ...args] = a.command!.split(/ +/)
      const binaries: Record<string, string> = { pwd: '/bin/pwd', ls: '/bin/ls', cat: '/bin/cat', head: '/usr/bin/head', tail: '/usr/bin/tail', wc: '/usr/bin/wc' }
      return run([quote(binaries[program!]!), ...args.map(quote)].join(' '), s)
    }),
    tool('search', 'Search literal text recursively in an allowed path, without following symlinks.', { path: Type.String(), text: Type.String() }, async (a, s) => run(`/usr/bin/grep -r -n -F -- ${quote(a.text!)} ${quote(path(a.path!))}`, s, [0, 1])),
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
      const result = handle.append({ type: 'agent.plan', data: { items } })
      return JSON.stringify(result.event.data)
    }),
    tool('queue', 'Queue a follow-up prompt after the current turn. The person can remove pending prompts.', { text: Type.String() }, async a => { ctx.queue(a.text!); return 'queued' }),
    tool('note_add', 'Save a session note.', { text: Type.String() }, async a => { handle.append({ type: 'agent.note', data: { text: a.text! } }); return 'saved' }),
    tool('session_log_query', 'Read only this session log. Reasoning is excluded for every model by this conservative binding.', { query: Type.String() }, async a => JSON.stringify(querySessionLog(ctx.log, handle.sessionId, 'remote_agent', JSON.parse(a.query!)))),
  ]
}
