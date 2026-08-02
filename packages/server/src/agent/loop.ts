/**
 * Агентный цикл: запрос к модели → вызовы инструментов → результаты обратно в модель.
 *
 * Цикл единственный и последовательный. Это не упрощение, а вывод из замера:
 * два параллельных запроса к одной модели на M2 Pro заняли 5.18 с против 4.08 с
 * у тех же двух запросов последовательно. Ускорителя один, и делить его между
 * агентами — значит только добавлять накладные расходы.
 */
import { randomUUID } from 'node:crypto'
import type { ChatStreamEvent, Message, Thread, ToolCall, Workspace } from '@alamo/contract'
import { MAX_AGENT_STEPS, APPROVAL_TIMEOUT_MS } from '@alamo/contract'
import { buildContextState, buildUsage, estimateTokens, type PrefillTracker } from '../context/usage.ts'
import { OllamaError, type OllamaClient } from '../ollama/client.ts'
import type { OllamaChatMessage } from '../ollama/types.ts'
import type { ThreadStore } from '../store/threads.ts'
import { PathOutsideWorkspaceError } from '../tools/jail.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { ToolError } from '../tools/types.ts'
import type { ApprovalGate } from './approvals.ts'
import { ContentGate } from './content-gate.ts'
import { CHAT_SYSTEM_PROMPT, agentSystemPrompt } from './prompts.ts'
import { parseToolCalls } from './tool-parser.ts'

export interface RunTurnParams {
  thread: Thread
  workspace: Workspace | null
  client: OllamaClient
  store: ThreadStore
  registry: ToolRegistry
  approvals: ApprovalGate
  tracker: PrefillTracker
  /** Модель заявляет capability `tools` — влияет на текст системного промпта. */
  modelSupportsTools: boolean
  /** Выполнять инструменты без подтверждения в этом ходе. */
  autoApprove: boolean
  /** Разрешено ли выполнение команд оболочки. */
  enableBash: boolean
  signal: AbortSignal
}

function toOllamaMessages(messages: readonly Message[]): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = []

  for (const message of messages) {
    result.push({ role: message.role, content: message.content })

    // Результаты инструментов должны переживать следующий пользовательский ход.
    // В базе они лежат внутри assistant-сообщения, а Ollama ожидает отдельные
    // сообщения role=tool.
    for (const call of message.toolCalls) {
      const content = call.result ?? (call.error ? `Ошибка: ${call.error}` : null)
      if (content) result.push({ role: 'tool', content, tool_name: call.name })
    }
  }

  return result
}

/** Оценка неизменного префикса следующего запроса по последнему сохранённому ходу. */
function reusablePrefixTokens(messages: readonly Message[]): number {
  const lastUsageMessage = [...messages].reverse().find((message) => message.usage)
  if (!lastUsageMessage?.usage) return 0

  const lastCompaction = [...messages]
    .filter((message) => message.isCompaction)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]

  // Компакция переписала начало истории после последнего замера — кэш сброшен.
  if (lastCompaction && lastCompaction.createdAt >= lastUsageMessage.createdAt) return 0

  return lastUsageMessage.usage.promptTokens + lastUsageMessage.usage.evalTokens
}

function describeError(error: unknown): string {
  if (error instanceof PathOutsideWorkspaceError) {
    return `Отказано: путь вне рабочей директории (${error.requestedPath})`
  }
  if (error instanceof ToolError) return error.message
  if (error instanceof OllamaError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export async function* runTurn(params: RunTurnParams): AsyncGenerator<ChatStreamEvent> {
  const { thread, workspace, client, store, registry, approvals, tracker, signal } = params

  let seq = 0
  const event = <T extends ChatStreamEvent['type']>(
    type: T,
    data: Extract<ChatStreamEvent, { type: T }>['data'],
  ): ChatStreamEvent => ({ type, seq: seq++, data }) as ChatStreamEvent

  const systemPrompt =
    thread.mode === 'agent' && workspace
      ? agentSystemPrompt({
          workspaceRoot: workspace.rootPath,
          toolNames: registry.list().map((tool) => tool.name),
          supportsNativeTools: params.modelSupportsTools,
        })
      : CHAT_SYSTEM_PROMPT

  const persistedMessages = store.messages(thread.id)
  const working: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...toOllamaMessages(persistedMessages),
  ]

  const useTools = thread.mode === 'agent' && registry.size > 0
  const knownTools = registry.names()

  let step = 0
  let expectedPrefixTokens = reusablePrefixTokens(persistedMessages)

  try {
    while (step < MAX_AGENT_STEPS) {
      if (signal.aborted) {
        yield event('done', { messageId: '', stopReason: 'stopped_by_user', steps: step })
        return
      }

      const assistantMessage = store.addMessage({
        threadId: thread.id,
        role: 'assistant',
        content: '',
      })

      yield event('start', { messageId: assistantMessage.id, model: thread.model, step })

      const gate = new ContentGate()
      let thinking = ''
      let finalChunk: Awaited<ReturnType<typeof client.chat>> | null = null
      let nativeToolCalls: NonNullable<OllamaChatMessage['tool_calls']> | undefined

      const stream = client.chatStream(
        {
          model: thread.model,
          messages: working,
          ...(useTools ? { tools: registry.toOllamaTools() } : {}),
          ...(thread.options.think !== 'off' ? { think: thread.options.think } : {}),
          keep_alive: '10m',
          options: {
            num_ctx: thread.options.numCtx,
            temperature: thread.options.temperature,
          },
        },
        signal,
      )

      for await (const chunk of stream) {
        if (chunk.message?.thinking) {
          thinking += chunk.message.thinking
          yield event('thinking', { delta: chunk.message.thinking })
        }

        if (chunk.message?.tool_calls?.length) {
          nativeToolCalls = chunk.message.tool_calls
        }

        if (chunk.message?.content) {
          const safe = gate.push(chunk.message.content)
          if (safe) yield event('token', { delta: safe })
        }

        if (chunk.done) finalChunk = chunk
      }

      if (signal.aborted) {
        store.updateMessage(assistantMessage.id, { content: gate.content })
        yield event('done', {
          messageId: assistantMessage.id,
          stopReason: 'stopped_by_user',
          steps: step + 1,
        })
        return
      }

      const usage = finalChunk
        ? buildUsage(finalChunk, tracker, thread.model, expectedPrefixTokens)
        : null

      const parsed = parseToolCalls(nativeToolCalls, gate.content, { knownTools })

      // Придержанный текст оказался обычным ответом — показываем его.
      if (parsed.calls.length === 0) {
        const withheld = gate.withheld
        if (withheld) {
          gate.markFlushed()
          yield event('token', { delta: withheld })
        }
      }

      const visibleContent = parsed.calls.length > 0 ? parsed.cleanedContent : gate.content

      /* ── Ответ без инструментов: ход закончен ── */
      if (parsed.calls.length === 0) {
        store.updateMessage(assistantMessage.id, {
          content: visibleContent,
          thinking: thinking || null,
          usage,
        })

        if (usage) yield event('usage', usage)
        yield event(
          'context',
          buildContextState({
            usedTokens: usage?.promptTokens ?? estimateTokens(visibleContent),
            allocatedTokens: thread.options.numCtx,
            usage,
            model: thread.model,
            tracker,
          }),
        )
        yield event('done', {
          messageId: assistantMessage.id,
          stopReason: finalChunk?.done_reason === 'length' ? 'length' : 'stop',
          steps: step + 1,
        })
        return
      }

      /* ── Есть вызовы инструментов ── */
      const executed: ToolCall[] = []

      for (const call of parsed.calls) {
        const tool = registry.get(call.name)
        const toolCall: ToolCall = {
          id: randomUUID(),
          name: call.name,
          arguments: call.arguments,
          status: 'running',
          result: null,
          error: null,
          durationMs: null,
          source: 'builtin',
          parsedFrom: call.parsedFrom,
          diff: null,
        }

        if (!tool) {
          toolCall.status = 'error'
          toolCall.error = `Инструмент «${call.name}» недоступен`
          executed.push(toolCall)
          store.recordToolRun(thread.id, assistantMessage.id, toolCall)
          yield event('tool_call', toolCall)
          yield event('tool_result', {
            toolCallId: toolCall.id,
            status: 'error',
            result: null,
            error: toolCall.error,
            durationMs: 0,
          })
          working.push({ role: 'tool', content: toolCall.error, tool_name: call.name })
          continue
        }

        const needsApproval =
          tool.mutating && !params.autoApprove && !approvals.isRemembered(thread.id, tool.name)

        if (needsApproval) {
          if (tool.preview) {
            try {
              const preview = await tool.preview(call.arguments, {
                workspaceRoot: workspace?.rootPath ?? null,
                enableBash: params.enableBash,
                signal,
              })
              toolCall.diff = preview.diff ?? null
            } catch (error) {
              toolCall.status = 'error'
              toolCall.error = describeError(error)
              toolCall.durationMs = 0
              executed.push(toolCall)
              store.recordToolRun(thread.id, assistantMessage.id, toolCall)
              yield event('tool_call', toolCall)
              yield event('tool_result', {
                toolCallId: toolCall.id,
                status: toolCall.status,
                result: null,
                error: toolCall.error,
                durationMs: 0,
              })
              working.push({
                role: 'tool',
                content: `Ошибка предпросмотра: ${toolCall.error}`,
                tool_name: tool.name,
              })
              continue
            }
          }

          toolCall.status = 'pending_approval'
          store.recordToolRun(thread.id, assistantMessage.id, toolCall)
          yield event('tool_call', toolCall)
          yield event('tool_approval_required', { toolCall, timeoutMs: APPROVAL_TIMEOUT_MS })

          const decision = await approvals.request(toolCall.id, thread.id, tool.name, signal)

          if (decision !== 'approve') {
            toolCall.status = decision === 'deny' ? 'denied' : 'cancelled'
            toolCall.error =
              decision === 'deny'
                ? 'Пользователь отклонил выполнение'
                : decision === 'timeout'
                  ? 'Истекло время ожидания подтверждения'
                  : 'Выполнение прервано'

            executed.push(toolCall)
            store.recordToolRun(thread.id, assistantMessage.id, toolCall)
            yield event('tool_result', {
              toolCallId: toolCall.id,
              status: toolCall.status,
              result: null,
              error: toolCall.error,
              durationMs: 0,
            })
            working.push({ role: 'tool', content: toolCall.error, tool_name: tool.name })

            if (decision === 'cancelled') {
              store.updateMessage(assistantMessage.id, {
                content: visibleContent,
                toolCalls: executed,
              })
              yield event('done', {
                messageId: assistantMessage.id,
                stopReason: 'stopped_by_user',
                steps: step + 1,
              })
              return
            }
            continue
          }

          toolCall.status = 'running'
          store.recordToolRun(thread.id, assistantMessage.id, toolCall)
        } else {
          store.recordToolRun(thread.id, assistantMessage.id, toolCall)
          yield event('tool_call', toolCall)
        }

        const startedAt = Date.now()
        try {
          const result = await tool.execute(call.arguments, {
            workspaceRoot: workspace?.rootPath ?? null,
            enableBash: params.enableBash,
            signal,
          })

          toolCall.status = 'ok'
          toolCall.result = result.content
          toolCall.diff = result.diff ?? null
          toolCall.durationMs = Date.now() - startedAt

          working.push({ role: 'tool', content: result.content, tool_name: tool.name })
        } catch (error) {
          toolCall.status = 'error'
          toolCall.error = describeError(error)
          toolCall.durationMs = Date.now() - startedAt

          // Ошибку возвращаем модели: она должна попробовать иначе, а не встать.
          working.push({ role: 'tool', content: `Ошибка: ${toolCall.error}`, tool_name: tool.name })
        }

        executed.push(toolCall)
        store.recordToolRun(thread.id, assistantMessage.id, toolCall)
        yield event('tool_result', {
          toolCallId: toolCall.id,
          status: toolCall.status,
          result: toolCall.result,
          error: toolCall.error,
          durationMs: toolCall.durationMs ?? 0,
        })
      }

      store.updateMessage(assistantMessage.id, {
        content: visibleContent,
        thinking: thinking || null,
        toolCalls: executed,
        usage,
      })

      // Ответ модели тоже уходит в историю запроса, иначе она забудет свой же вызов.
      working.push({ role: 'assistant', content: gate.content })

      if (usage) yield event('usage', usage)
      yield event(
        'context',
        buildContextState({
          usedTokens: usage?.promptTokens ?? 0,
          allocatedTokens: thread.options.numCtx,
          usage,
          model: thread.model,
          tracker,
        }),
      )

      if (usage) expectedPrefixTokens = usage.promptTokens + usage.evalTokens
      step++
    }

    yield event('done', { messageId: '', stopReason: 'tool_limit', steps: step })
  } catch (error) {
    yield event('error', {
      code: error instanceof OllamaError ? 'ollama_unavailable' : 'internal_error',
      message: describeError(error),
      details: null,
    })
    yield event('done', { messageId: '', stopReason: 'error', steps: step })
  }
}
