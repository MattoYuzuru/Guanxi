/**
 * Per-session MCP tool budget.
 *
 * A large server must not put every tool name, title, description and input
 * schema into the model context. The injected counter measures the serialized
 * form of each tool, so callers can use their own token estimator. The hard
 * guarantee is:
 *
 *     countToolContext(toolContext(tools, count, budget), count) <= budget
 *
 * Counters must return zero for the empty string. When every serialized tool
 * fits, the tools are listed directly. Otherwise the context exposes exactly
 * two meta-tools (`mcp_search_tools` and `mcp_load_tool`) and reports how many
 * tools were replaced. If even those do not fit, the context is empty with
 * `mode: 'none'`, which also keeps the guarantee at a zero budget.
 */
import type { McpTool } from './types.ts'

export type McpToolCounter = (text: string) => number

export const MCP_SEARCH_TOOL_NAME = 'mcp_search_tools'
export const MCP_LOAD_TOOL_NAME = 'mcp_load_tool'

export const MCP_SEARCH_TOOL_DESCRIPTION =
  'Search MCP tools available in this session by name or description. Returns names and one-line summaries.'
export const MCP_LOAD_TOOL_DESCRIPTION =
  'Load one MCP tool by name. Returns its full description and input schema.'

export interface McpFullToolContext {
  mode: 'full'
  tools: McpTool[]
}

export interface McpSearchToolContext {
  mode: 'search'
  tools: McpTool[]
  /** Number of original tools replaced by the two meta-tools. */
  omitted: number
}

export interface McpNoneToolContext {
  mode: 'none'
  tools: []
  /** Number of original tools omitted because no meta-tool fit. */
  omitted: number
}

export type McpToolContext = McpFullToolContext | McpSearchToolContext | McpNoneToolContext

export interface McpToolSearchResult {
  name: string
  summary: string
}

const MAX_SUMMARY_CHARS = 160

/** Fresh meta-tool objects so callers cannot mutate a shared constant. */
export function mcpMetaTools(): McpTool[] {
  return [
    {
      name: MCP_SEARCH_TOOL_NAME,
      description: MCP_SEARCH_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name or keyword to search for.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: MCP_LOAD_TOOL_NAME,
      description: MCP_LOAD_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact MCP tool name.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ]
}

function assertBudget(budget: number): number {
  if (!Number.isFinite(budget) || budget < 0) {
    throw new TypeError('tool budget must be a finite non-negative number')
  }
  return budget
}

function checkedCount(count: McpToolCounter, text: string): number {
  if (typeof count !== 'function') throw new TypeError('tool counter must be a function')
  const value = count(text)
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError('tool counter must return a finite non-negative number')
  }
  return value
}

/** The exact model-facing projection counted by the budget. */
function toolContextEntry(tool: McpTool): string {
  return JSON.stringify({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })
}

function countTools(tools: readonly McpTool[], count: McpToolCounter): number {
  let total = 0
  for (const tool of tools) total += checkedCount(count, toolContextEntry(tool))
  return total
}

/** Sum of per-tool serialized-entry counts, including names and schemas. */
export function countToolContext(context: McpToolContext, count: McpToolCounter): number {
  return countTools(context.tools, count)
}

/**
 * Builds the model-facing context. Full mode only when every serialized tool
 * fits. Search mode has the two meta-tools; when even they do not fit, the
 * context is empty with `mode: 'none'` so the budget guarantee holds.
 */
export function toolContext(
  tools: readonly McpTool[],
  count: McpToolCounter,
  budget: number,
): McpToolContext {
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array')
  const available = assertBudget(budget)
  const full = [...tools]
  if (countTools(full, count) <= available) {
    return { mode: 'full', tools: full }
  }

  const omitted = full.length
  const meta = mcpMetaTools()
  if (countTools(meta, count) <= available) {
    return { mode: 'search', tools: meta, omitted }
  }
  return { mode: 'none', tools: [], omitted }
}

function oneLine(description: unknown): string {
  if (typeof description !== 'string') return ''
  const text = description.replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  if (chars.length <= MAX_SUMMARY_CHARS) return text
  return `${chars.slice(0, MAX_SUMMARY_CHARS - 1).join('')}…`
}

/**
 * `mcp_search_tools` implementation: name plus a one-line summary. An empty
 * query lists the first `limit` tools. Duplicate names keep the first match.
 */
export function searchMcpTools(
  tools: readonly McpTool[],
  query: string,
  limit = 20,
): McpToolSearchResult[] {
  if (typeof query !== 'string') throw new TypeError('query must be a string')
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer')
  const needle = query.trim().toLowerCase()
  const results: McpToolSearchResult[] = []
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) continue
    const summary = oneLine(tool.description)
    const matches = needle.length === 0 ||
      tool.name.toLowerCase().includes(needle) ||
      summary.toLowerCase().includes(needle)
    if (!matches) continue
    seen.add(tool.name)
    results.push({ name: tool.name, summary })
    if (results.length >= limit) break
  }
  return results
}

/** `mcp_load_tool` implementation: the full tool, including its schema. */
export function loadMcpTool(tools: readonly McpTool[], name: string): McpTool | undefined {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('name must be a non-empty string')
  const found = tools.find(tool => tool.name === name)
  return found === undefined ? undefined : { ...found }
}
