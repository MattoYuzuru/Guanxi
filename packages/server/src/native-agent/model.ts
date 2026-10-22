import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { Model, Api, AssistantMessage, TranscriptContext, Usage } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { NativeAgentInput } from '@guanxi/contract'
import type { Connections } from '../connections/service.ts'
import { piModels } from '../connections/pi.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { OllamaChatMessage } from '../ollama/types.ts'
import type { Attempt } from '../runs/types.ts'
import type { RunStore } from '../runs/store.ts'
import { randomUUID } from 'node:crypto'

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
export function selectedModel(connections: Connections, input: NativeAgentInput): Model<Api> {
  const connection = connections.snapshot('local').connections.find(c => c.id === input.connectionId)
  if (!connection) throw new Error('connection_not_found')
  if (connection.kind === 'model_api') {
    const model = piModels(connection.provider).find(m => m.id === input.model)
    if (!model) throw new Error('model_not_found')
    return model
  }
  if (connection.kind !== 'local_runtime' || !input.contextTokens) throw new Error('model_not_supported')
  // Metadata only: all actual local dispatch still goes through the K3 governor/adapter.
  return { id: input.model, name: input.model, api: 'openai-completions', provider: 'ollama', baseUrl: 'http://127.0.0.1',
    input: ['text'], reasoning: false, contextWindow: input.contextTokens, maxTokens: input.contextTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}
export function connectionStream(connections: Connections, scrubber: EgressScrubber, input: NativeAgentInput, attempt: Attempt, runs: RunStore): StreamFn {
  return (model, context, options) => {
    const stream = new AssistantMessageEventStream()
    void (async () => {
      let result: AssistantMessage
      try {
        runs.checkExecution(attempt, true)
        const clean = scrubber.scrub(context)
        const call = { model: input.model, runId: attempt.run_id, requestId: randomUUID(), signal: options?.signal, ...(model.provider === 'ollama'
          ? { onStarted: () => runs.modelStarted(attempt) } : { onResponseObserved: () => runs.modelStarted(attempt) }) }
        if (model.provider !== 'ollama') result = await connections.complete('local', input.connectionId, clean, call)
        else result = await local(connections, input, clean, call)
        runs.recordCost(attempt, { key: call.requestId, inputTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
          outputTokens: result.usage.output, costMicrounits: model.provider === 'ollama' ? null : Math.round(result.usage.cost.total * 1000000), currency: model.provider === 'ollama' ? 'unknown' : 'USD' })
        runs.checkExecution(attempt)
        result = scrubber.scrub(result)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'quota_exhausted') {
          try { runs.stopExecution(attempt, 'quota_exhausted') } catch { /* Fencing wins over a late quota observation. */ }
        }
        result = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: emptyUsage(), timestamp: Date.now(), stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: 'model_failed' }
      }
      if (result.stopReason === 'error' || result.stopReason === 'aborted') stream.push({ type: 'error', reason: result.stopReason, error: result })
      else stream.push({ type: 'done', reason: result.stopReason as 'stop' | 'length' | 'toolUse', message: result })
    })()
    return stream
  }
}
async function local(connections: Connections, input: NativeAgentInput, context: TranscriptContext,
  call: { runId: string; requestId: string; signal?: AbortSignal; onStarted?: () => void }): Promise<AssistantMessage> {
  const messages: OllamaChatMessage[] = context.messages.map(m => {
    if (m.role === 'system') return { role: 'system', content: typeof m.content === 'string' ? m.content : m.content.map(c => c.text).join('\n') }
    if (m.role === 'toolResult') return { role: 'tool', content: m.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), tool_name: m.toolName }
    if (m.role === 'user') return { role: 'user', content: typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') }
    return { role: 'assistant', content: m.content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
      tool_calls: m.content.filter(c => c.type === 'toolCall').map(c => ({ function: { name: c.name, arguments: c.arguments } })) }
  })
  const tools = getCurrentTools(context.messages).map(tool => ({ type: 'function' as const, function: { name: tool.name,
    description: tool.description, parameters: tool.parameters as { type: 'object'; properties: Record<string, unknown> } } }))
  const chunk = await connections.localChat('local', input.connectionId, { model: input.model, messages, tools,
    stream: false, options: { num_ctx: input.contextTokens } }, call)
  const content: AssistantMessage['content'] = []
  if (chunk.message?.content) content.push({ type: 'text', text: chunk.message.content })
  if (chunk.message?.thinking) content.push({ type: 'thinking', thinking: chunk.message.thinking })
  for (const tool of chunk.message?.tool_calls ?? []) content.push({ type: 'toolCall', id: randomUUID(), name: tool.function.name,
    arguments: typeof tool.function.arguments === 'string' ? JSON.parse(tool.function.arguments) : tool.function.arguments })
  const usage = emptyUsage()
  usage.input = chunk.prompt_eval_count ?? 0; usage.output = chunk.eval_count ?? 0; usage.totalTokens = usage.input + usage.output
  return { role: 'assistant', content, api: 'openai-completions', provider: 'ollama', model: input.model, usage,
    stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : chunk.done_reason === 'length' ? 'length' : 'stop', timestamp: Date.now() }
}
