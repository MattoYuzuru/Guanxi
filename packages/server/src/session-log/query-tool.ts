/**
 * The agent query tool over the session log (K2, ADR-0023 §5).
 *
 * The node decides the audience from where the calling agent's model runs; the
 * agent cannot choose it. An agent on a remote provider receives 0 reasoning
 * events: the log filters them out in SQL before anything is serialised, so a
 * reasoning event never reaches the tool result (D-113).
 */
import {
  SESSION_QUERY_TOOL_NAME,
  sessionQueryToolArgsSchema,
  sessionQueryToolResultSchema,
  type SessionAudience,
  type SessionEvent,
  type SessionQueryToolResult,
} from '@guanxi/contract'
import { ToolError, type ToolDefinition } from '../tools/types.ts'
import { SessionLogError, type SessionLog } from './log.ts'

export type AgentAudience = Extract<SessionAudience, 'local_agent' | 'remote_agent'>

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]'])

/**
 * `local_agent` only for a model endpoint on this machine's loopback interface.
 * Anything else, including an unparsable endpoint or none, is `remote_agent`.
 */
export function audienceForModelEndpoint(endpoint: string | URL | null | undefined): AgentAudience {
  if (!endpoint) return 'remote_agent'
  let host: string
  try {
    host = (endpoint instanceof URL ? endpoint : new URL(endpoint)).hostname.toLowerCase()
  } catch {
    return 'remote_agent'
  }
  if (LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/u.test(host)) return 'local_agent'
  return 'remote_agent'
}

export function querySessionLog(
  log: SessionLog,
  sessionId: string,
  audience: AgentAudience,
  rawArgs: unknown,
): SessionQueryToolResult {
  const parsed = sessionQueryToolArgsSchema.safeParse(rawArgs ?? {})
  if (!parsed.success) throw new ToolError('Invalid session_log_query arguments')
  const args = parsed.data
  const limit = args.limit ?? 20
  const types = args.types ? new Set(args.types) : null

  let events: SessionEvent[]
  if (args.text) {
    const hits = log.search(args.text, { sessionId, audience, limit: 100 })
    const wanted = new Set(hits.map((hit) => hit.seq))
    events = log
      .readAll(sessionId, audience)
      .filter((event) => wanted.has(event.seq) && event.seq > (args.afterSeq ?? 0))
  } else {
    events = log.readAll(sessionId, audience).filter((event) => event.seq > (args.afterSeq ?? 0))
  }
  if (types) events = events.filter((event) => types.has(event.type))

  return sessionQueryToolResultSchema.parse({
    sessionId,
    audience,
    events: events.slice(0, limit),
    reasoningExcluded: audience === 'remote_agent',
  })
}

/** A tool an agent loop can register; it reads only the session it was created for. */
export function createSessionQueryTool(options: {
  log: SessionLog
  sessionId: string
  audience: AgentAudience
}): ToolDefinition {
  return {
    name: SESSION_QUERY_TOOL_NAME,
    description:
      'Search and read this session\'s event log: prompts, assistant messages, tool calls and results, usage and lifecycle events.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Full-text search terms' },
        types: { type: 'array', items: { type: 'string' }, description: 'Event types to keep' },
        afterSeq: { type: 'number', description: 'Only events after this sequence number' },
        limit: { type: 'number', description: 'At most this many events (1-100)' },
      },
      required: [],
    },
    mutating: false,
    needsWorkspace: false,
    async execute(args) {
      try {
        const result = querySessionLog(options.log, options.sessionId, options.audience, args)
        return { content: JSON.stringify(result) }
      } catch (error) {
        if (error instanceof SessionLogError && error.code === 'egress_not_ready') {
          throw new ToolError('The session log cannot be read until secret redaction is ready')
        }
        throw error
      }
    },
  }
}
