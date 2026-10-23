import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  MCP_LOAD_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  countToolContext,
  countToolDescriptions,
  loadMcpTool,
  mcpMetaTools,
  searchMcpTools,
  toolContext,
  type McpToolCounter,
} from '../../src/mcp/budget.ts'
import type { McpTool } from '../../src/mcp/types.ts'

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const counters: McpToolCounter[] = [
  text => text.length,
  text => Math.ceil(text.length / 4),
  text => text.length === 0 ? 0 : text.split(/\s+/).length,
]

const budgets = [0, 1, 2, 3, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096, 100_000]

it('keeps count(context) <= budget over 250 random tool sets', () => {
  const next = mulberry32(0x51c0ffee)
  let full = 0
  let search = 0
  for (let iteration = 0; iteration < 250; iteration++) {
    const toolCount = Math.floor(next() * 16)
    const tools: McpTool[] = []
    for (let index = 0; index < toolCount; index++) {
      const words = Math.floor(next() * 24)
      tools.push({
        name: `server_${iteration}_tool_${index}`,
        description: Array.from({ length: words }, (_, word) => `word${word}`).join(' '),
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      })
    }
    const count = counters[Math.floor(next() * counters.length)]!
    const budget = budgets[Math.floor(next() * budgets.length)]!
    const context = toolContext(tools, count, budget)
    assert.ok(
      countToolContext(context, count) <= budget,
      `context exceeded budget ${budget} at iteration ${iteration}`,
    )
    if (context.mode === 'full') {
      full++
      assert.ok(countToolDescriptions(tools, count) <= budget)
    } else {
      search++
      assert.equal(context.omitted, tools.length)
      assert.deepEqual(
        context.tools.map(tool => tool.name),
        [MCP_SEARCH_TOOL_NAME, MCP_LOAD_TOOL_NAME],
      )
      assert.ok(countToolDescriptions(tools, count) > budget)
    }
  }
  assert.ok(full > 0, 'the property exercise should produce full contexts')
  assert.ok(search > 0, 'the property exercise should produce search contexts')
})

it('falls back to exactly two meta-tools and reports the omitted count', () => {
  const tools: McpTool[] = [
    { name: 'alpha_tool', description: 'Alpha helper\nthat does one thing', inputSchema: { type: 'object' } },
    { name: 'beta', description: 'Beta '.repeat(100), inputSchema: { type: 'object' } },
    { name: 'gamma', description: 'Unrelated', inputSchema: { type: 'object' } },
  ]
  const count = (text: string): number => text.length
  const context = toolContext(tools, count, 20)
  assert.equal(context.mode, 'search')
  assert.equal(context.omitted, tools.length)
  assert.equal(context.tools.length, 2)
  assert.deepEqual(
    context.tools.map(tool => tool.name),
    [MCP_SEARCH_TOOL_NAME, MCP_LOAD_TOOL_NAME],
  )
  assert.ok(countToolContext(context, count) <= 20)

  const results = searchMcpTools(tools, 'alpha')
  assert.deepEqual(results, [{ name: 'alpha_tool', summary: 'Alpha helper that does one thing' }])
  const schema = loadMcpTool(tools, 'alpha_tool')
  assert.deepEqual(schema, tools[0])
  assert.equal(loadMcpTool(tools, 'missing'), undefined)

  const long = searchMcpTools(tools, 'beta')
  assert.equal(long.length, 1)
  assert.equal(long[0]?.summary.endsWith('…'), true)
  assert.equal(long[0]?.summary.includes('\n'), false)
})

it('lists all descriptions when they fit and keeps a zero budget valid', () => {
  const tools: McpTool[] = [
    { name: 'one', description: 'abc' },
    { name: 'two', description: 'de' },
  ]
  const count = (text: string): number => text.length
  const full = toolContext(tools, count, 5)
  assert.equal(full.mode, 'full')
  assert.equal(full.tools.length, 2)
  assert.ok(countToolContext(full, count) <= 5)

  const zero = toolContext(tools, count, 0)
  assert.equal(zero.mode, 'search')
  assert.equal(zero.omitted, 2)
  assert.deepEqual(
    zero.tools.map(tool => tool.name),
    [MCP_SEARCH_TOOL_NAME, MCP_LOAD_TOOL_NAME],
  )
  assert.equal(countToolContext(zero, count), 0)
  assert.equal(zero.tools.every(tool => tool.description === ''), true)
  assert.equal(mcpMetaTools().length, 2)
})

it('rejects invalid budgets, counters and meta-tool inputs', () => {
  const tool: McpTool = { name: 'one', description: 'abc' }
  assert.throws(() => toolContext([], text => text.length, -1), TypeError)
  assert.throws(() => toolContext([], text => text.length, Number.POSITIVE_INFINITY), TypeError)
  assert.throws(() => toolContext([tool], () => Number.NaN, 10), TypeError)
  assert.throws(() => toolContext([tool], () => -1, 10), TypeError)
  assert.throws(() => searchMcpTools([], 'x', 0), TypeError)
  assert.throws(() => loadMcpTool([], ''), TypeError)
})
