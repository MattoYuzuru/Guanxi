import { parseChatModelSelection, chatModelSelection, type ChatModelsResponse } from '@guanxi/contract'
import type { ModelService } from '../models/service.ts'
import type { OllamaClient } from '../ollama/client.ts'
import type { OllamaChatChunk } from '../ollama/types.ts'
import type { Connections } from './service.ts'
import { ConnectionError } from './errors.ts'

export interface ChatModelHost { models(): ModelService; connections?: () => Connections }
export async function assertChatSelection(host: ChatModelHost, model: string, numCtx: number, signal?: AbortSignal) {
  const selection = parseChatModelSelection(model)
  if (model.startsWith('k3:') && !selection) throw new ConnectionError('validation_failed', 'Invalid provider selection')
  if (!selection) return host.models().assertContextAllowed(model, numCtx, signal)
  if (!host.connections) throw new ConnectionError('egress_unavailable', 'Connections unavailable')
  await host.connections().assertChatModel('local', selection.connectionId, selection.modelId)
}
export async function providerChatGroups(connections: Connections, signal?: AbortSignal): Promise<ChatModelsResponse['groups']> {
  const snapshot = connections.snapshot('local')
  if (!snapshot.vault.unlocked) return []
  return Promise.all(snapshot.connections.filter(row => row.kind === 'model_api' && row.secretRef).map(async row => {
    const catalog = await connections.chatModels('local', row.id, signal)
    return { id: row.id, label: row.name, kind: 'provider' as const, discovery: { state: catalog.state, source: catalog.source, observedAt: catalog.observedAt, confidence: catalog.confidence }, models: catalog.models.map(modelId => ({
      selection: chatModelSelection(row.id, modelId), modelId, source: catalog.source,
      observedAt: catalog.observedAt!, confidence: catalog.confidence === 'unknown' ? 'low' as const : catalog.confidence,
    })) }
  }))
}
/** Adapt the legacy turn loop to K3 without creating another execution or persistence owner. */
export function providerChatClient(connections: Connections, selection: { connectionId: string; modelId: string }, jobId: string): Pick<OllamaClient, 'chatStream'> {
  return { async *chatStream(request, signal) {
    const queue: OllamaChatChunk[] = []
    let wake = () => {}
    let ended = false
    let failure: unknown
    const chunk = (content: string, done: boolean): OllamaChatChunk => ({ model: request.model, created_at: new Date().toISOString(),
      message: { role: 'assistant', content }, done })
    const notify = (value: OllamaChatChunk) => { queue.push(value); wake() }
    // Only the leading orientation is the cacheable system prompt. Compaction
    // checkpoints may also have role=system; retain them in history, not this prefix.
    const hasOrientation = request.messages[0]?.role === 'system'
    const history = hasOrientation ? request.messages.slice(1) : request.messages
    const pending = connections.complete('local', selection.connectionId, {
      systemPrompt: hasOrientation ? request.messages[0]!.content : '',
      messages: history.map(message => message.role === 'assistant'
        ? { role: 'assistant' as const, content: [{ type: 'text' as const, text: message.content }], api: 'openai-completions' as const,
          provider: 'openai', model: selection.modelId, stopReason: 'stop' as const, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
        : { role: 'user' as const, content: message.content, timestamp: Date.now() }),
    }, { model: selection.modelId, runId: jobId, requestId: jobId, signal,
      options: { temperature: request.options?.temperature, ...(request.think ? { reasoning: request.think === true ? 'medium' : request.think } : {}) },
      onText: text => notify(chunk(text, false)),
    }).then(result => {
      notify({ ...chunk('', true), done_reason: result.stopReason === 'length' ? 'length' : 'stop',
        prompt_eval_count: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite, eval_count: result.usage.output })
    }, error => { failure = error }).finally(() => { ended = true; wake() })
    try {
      while (!ended || queue.length) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>(resolve => { wake = resolve })
      }
      if (failure) throw failure
    } finally { await pending }
  } }
}
