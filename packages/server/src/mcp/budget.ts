/**
 * Per-session MCP tool budget.
 *
 * A large server must not put every tool description into the model context.
 * The injected counter measures description text, so callers can use their
 * own token estimator. The hard guarantee is:
 *
 *     countToolContext(toolContext(tools, count, budget), count) <= budget
 *
 * When all descriptions fit, the tools are listed directly. Otherwise the
 * context exposes exactly two meta-tools (`mcp_search_tools` and
 * `mcp_load_tool`), reports how many tools were replaced, and keeps the
 * guarantee even at a zero budget by leaving the meta descriptions empty.
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

export type McpToolContext = McpFullToolContext | McpSearchToolContext

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

function descriptionOf(tool: McpTool): string {
  return typeof tool.description === 'string' ? tool.description : ''
}

/** Sum of per-tool description counts; names and schemas are not counted. */
export function countToolDescriptions(tools: readonly McpTool[], count: McpToolCounter): number {
  let total = 0
  for (const tool of tools) total += checkedCount(count, descriptionOf(tool))
  return total
}

export function countToolContext(context: McpToolContext, count: McpToolCounter): number {
  return countToolDescriptions(context.tools, count)
}

/**
 * Builds the model-facing context. Full mode only when every description
 * fits. Search mode always has two meta-tools; when even their descriptions
 * do not fit, the descriptions are emptied so the budget guarantee holds.
 */
export function toolContext(
  tools: readonly McpTool[],
  count: McpToolCounter,
  budget: number,
): McpToolContext {
  if (!Array.isArray(tools)) throw new TypeError('tools must be an array')
  const available = assertBudget(budget)
  const full = [...tools]
  if (countToolDescriptions(full, count) <= available) {
    return { mode: 'full', tools: full }
  }

  const omitted = full.length
  const meta = mcpMetaTools()
  if (countToolDescriptions(meta, count) <= available) {
    return { mode: 'search', tools: meta, omitted }
  }
  return {
    mode: 'search',
    tools: meta.map(tool => ({ ...tool, description: '' })),
    omitted,
  }
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
