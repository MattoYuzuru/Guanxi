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

/** Runtime adapters that execute the model on this machine. */
const LOCAL_RUNTIMES: ReadonlySet<string> = new Set(['ollama'])

/** Where an agent's model actually runs, as far as the node knows it. */
export interface AgentExecution {
  /** The endpoint model requests go to. */
  endpoint: string | URL | null | undefined
  /** The runtime adapter serving the model (for example `ollama`); anything not known to run locally is remote. */
  runtime: string | null | undefined
  /** The model name; cloud-backed models served through a local daemon are remote. */
  model: string | null | undefined
}

function isLoopback(endpoint: string | URL | null | undefined): boolean {
  if (!endpoint) return false
  let host: string
  try {
    host = (endpoint instanceof URL ? endpoint : new URL(endpoint)).hostname.toLowerCase()
  } catch {
    return false
  }
  return LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/u.test(host)
}

/** Ollama serves `…:…-cloud` and `…:cloud` models from its local daemon but runs them on ollama.com. */
function isCloudBacked(model: string): boolean {
  return /cloud/iu.test(model)
}

/**
 * `local_agent` only when every fact says the model runs on this machine: a
 * loopback endpoint, a runtime adapter that executes locally, and a model that
 * is not cloud-backed. A loopback endpoint alone is not enough (a local proxy,
 * a port forward or an Ollama cloud model sends requests elsewhere). Anything
 * unknown is `remote_agent`, which never receives reasoning (D-113).
 */
export function audienceForAgent(execution: AgentExecution): AgentAudience {
  if (!isLoopback(execution.endpoint)) return 'remote_agent'
  if (!execution.runtime || !LOCAL_RUNTIMES.has(execution.runtime)) return 'remote_agent'
  if (!execution.model || isCloudBacked(execution.model)) return 'remote_agent'
  return 'local_agent'
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
  // Audience, session, cursor and types are predicates of the storage query,
  // applied before the limit, so a filter never empties a bounded answer (R6).
  let events: SessionEvent[]
  if (args.text) {
    const hits = log.search(args.text, { sessionId, audience, afterSeq: args.afterSeq, types: args.types, limit })
    events = log.read(sessionId, { audience, seqs: hits.map((hit) => hit.seq), limit }).events
  } else {
    events = log.read(sessionId, { audience, afterSeq: args.afterSeq, types: args.types, limit }).events
  }

  return sessionQueryToolResultSchema.parse({
    // The reads above refuse an id holding a registered value (`session_withheld`), so it is safe to return.
    sessionId,
    audience,
    events,
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
        if (error instanceof SessionLogError && error.code === 'session_withheld') {
          // Content-free: neither the id nor the secret reference (GPT re-check N1).
          throw new ToolError('This session log is withheld because its id contains a registered secret')
        }
        if (error instanceof SessionLogError && error.code === 'session_catching_up') {
          // The stored log lacks the tail of deferred Chat Jobs (GPT re-check N2).
          throw new ToolError('This session log is still being restored; try again later')
        }
        throw error
      }
    },
  }
}
