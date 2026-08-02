/**
 * Агентный цикл: запрос к модели → вызовы инструментов → результаты обратно в модель.
 *
 * Цикл единственный и последовательный. Это не упрощение, а вывод из замера:
 * два параллельных запроса к одной модели на M2 Pro заняли 5.18 с против 4.08 с
 * у тех же двух запросов последовательно. Ускорителя один, и делить его между
 * агентами — значит только добавлять накладные расходы.
 */
import { randomUUID } from 'node:crypto'
import type {
  ChatStreamEvent,
  Message,
  Thread,
  ToolCall,
  TurnError,
  TurnStopReason,
  TurnTerminalOutcome,
  Usage,
  Workspace,
} from '@alamo/contract'
import { MAX_AGENT_STEPS, APPROVAL_TIMEOUT_MS } from '@alamo/contract'
import { buildContextState, buildUsage, type PrefillTracker } from '../context/usage.ts'
import { OllamaError, OllamaUnavailableError, type OllamaClient } from '../ollama/client.ts'
import type { OllamaChatChunk, OllamaChatMessage } from '../ollama/types.ts'
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

export const TURN_ABORT_REASON = {
  explicitStop: 'alamo:explicit-stop',
  connectionAbort: 'alamo:connection-abort',
} as const

class RuntimeProtocolError extends Error {
  constructor() {
    super('Ollama stream ended without a terminal chunk')
    this.name = 'RuntimeProtocolError'
  }
}

class TerminalPersistenceError extends Error {
  readonly reason: unknown

  constructor(reason: unknown) {
    super('Turn terminal state could not be persisted')
    this.name = 'TerminalPersistenceError'
    this.reason = reason
  }
}

function cancellationReason(signal: AbortSignal): TurnStopReason {
  return signal.reason === TURN_ABORT_REASON.connectionAbort
    ? 'connection_aborted'
    : 'stopped_by_user'
}

function safeTurnFailure(error: unknown): { error: TurnError; stopReason: TurnStopReason } {
  if (error instanceof TerminalPersistenceError) {
    return {
      error: {
        code: 'storage_error',
        message: 'The final response state could not be saved',
      },
      stopReason: 'storage_error',
    }
  }
  if (error instanceof RuntimeProtocolError) {
    return {
      error: {
        code: 'runtime_protocol',
        message: 'Ollama ended the stream without the required terminal chunk',
      },
      stopReason: 'protocol_error',
    }
  }
  if (error instanceof OllamaUnavailableError) {
    return {
      error: { code: 'ollama_unavailable', message: 'Ollama is unavailable' },
      stopReason: 'provider_error',
    }
  }
  if (error instanceof OllamaError) {
    return {
      error: { code: 'upstream_error', message: 'Ollama ended the response with an error' },
      stopReason: 'provider_error',
    }
  }
  return {
    error: { code: 'internal_error', message: 'The response could not be finalized' },
    stopReason: 'internal_error',
  }
}

function streamErrorData(
  error: TurnError,
): Extract<ChatStreamEvent, { type: 'error' }>['data'] {
  const code =
    error.code === 'runtime_protocol'
      ? 'upstream_error'
      : error.code === 'storage_error'
        ? 'internal_error'
        : error.code

  return {
    code,
    message: error.message,
    details: null,
    turnError: error,
  }
}

function toOllamaMessages(messages: readonly Message[]): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = []

  for (const message of messages) {
    result.push({
      role: message.role,
      content: message.content,
      ...(message.role === 'assistant' && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    })

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
  let activeMessageId: string | null = null
  let activeContent = ''
  let activeThinking = ''
  let activeToolCalls: ToolCall[] = []
  let activeUsage: Usage | null = null
  let unresolvedFailure: { error: TurnError; stopReason: TurnStopReason } | null = null

  const terminalizeActive = (
    outcome: TurnTerminalOutcome,
    error: TurnError | null,
    stopReason: TurnStopReason,
  ): Message | null => {
    if (!activeMessageId) return null

    let result
    try {
      result = store.terminalizeMessage(activeMessageId, {
        outcome,
        error,
        stopReason,
        content: activeContent,
        thinking: activeThinking || null,
        toolCalls: activeToolCalls,
        usage: activeUsage,
      })
    } catch (cause) {
      throw new TerminalPersistenceError(cause)
    }

    activeMessageId = null
    return result.message
  }

  const doneData = (
    message: Message | null,
    fallback: { outcome: TurnTerminalOutcome; stopReason: TurnStopReason },
    steps: number,
  ): Extract<ChatStreamEvent, { type: 'done' }>['data'] => {
    const persistedOutcome =
      message?.turnStatus === 'completed' ||
      message?.turnStatus === 'failed' ||
      message?.turnStatus === 'cancelled'
        ? message.turnStatus
        : fallback.outcome
    const terminalStopReason = message?.stopReason ?? fallback.stopReason
    const stopReason =
      terminalStopReason === 'stop' || terminalStopReason === 'length'
        ? terminalStopReason
        : terminalStopReason === 'tool_limit'
          ? 'tool_limit'
          : persistedOutcome === 'cancelled'
            ? 'stopped_by_user'
            : 'error'

    return {
      messageId: message?.id ?? activeMessageId ?? '',
      outcome: persistedOutcome,
      stopReason,
      terminalStopReason,
      steps,
    }
  }

  try {
    while (step < MAX_AGENT_STEPS) {
      const assistantMessage = store.addMessage({
        threadId: thread.id,
        role: 'assistant',
        content: '',
      })
      activeMessageId = assistantMessage.id
      activeContent = ''
      activeThinking = ''
      activeToolCalls = []
      activeUsage = null

      yield event('start', {
        messageId: assistantMessage.id,
        model: thread.model,
        step,
        status: 'pending',
      })

      if (signal.aborted) {
        const stopReason = cancellationReason(signal)
        const terminal = terminalizeActive('cancelled', null, stopReason)
        yield event('done', doneData(terminal, { outcome: 'cancelled', stopReason }, step))
        return
      }

      const gate = new ContentGate()
      let thinking = ''
      let finalChunk: OllamaChatChunk | null = null
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
          activeThinking = thinking
          yield event('thinking', { delta: chunk.message.thinking })
        }

        if (chunk.message?.tool_calls?.length) {
          nativeToolCalls = chunk.message.tool_calls
        }

        if (chunk.message?.content) {
          const safe = gate.push(chunk.message.content)
          activeContent = gate.content
          if (safe) yield event('token', { delta: safe })
        }

        if (chunk.done) finalChunk = chunk
      }

      if (signal.aborted) {
        activeContent = gate.content
        activeThinking = thinking
        const stopReason = cancellationReason(signal)
        const terminal = terminalizeActive('cancelled', null, stopReason)
        yield event(
          'done',
          doneData(terminal, { outcome: 'cancelled', stopReason }, step + 1),
        )
        return
      }

      if (!finalChunk) throw new RuntimeProtocolError()

      const usage = buildUsage(finalChunk, tracker, thread.model, expectedPrefixTokens)

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
        activeContent = visibleContent
        activeThinking = thinking
        activeUsage = usage

        const stopReason: TurnStopReason =
          finalChunk.done_reason === 'length' ? 'length' : 'stop'
        const terminal = terminalizeActive('completed', null, stopReason)

        yield event('usage', usage)
        yield event(
          'context',
          buildContextState({
            usedTokens: usage.promptTokens,
            allocatedTokens: thread.options.numCtx,
            usage,
            model: thread.model,
            tracker,
          }),
        )
        yield event(
          'done',
          doneData(terminal, { outcome: 'completed', stopReason }, step + 1),
        )
        return
      }

      /* ── Есть вызовы инструментов ── */
      const executed: ToolCall[] = []
      activeContent = visibleContent
      activeThinking = thinking
      activeUsage = usage

      // Протокол Ollama требует строгий порядок:
      // assistant(tool_calls) → tool(result). Даже если вызов был JSON-текстом,
      // синтезируем структурное поле — иначе шаблон Qwen игнорирует результат.
      working.push({
        role: 'assistant',
        content: parsed.cleanedContent,
        tool_calls: parsed.calls.map((call) => ({
          function: { name: call.name, arguments: call.arguments },
        })),
      })

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
          activeToolCalls = executed.slice()
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
              activeToolCalls = executed.slice()
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
          // Зарегистрировать ожидание нужно до SSE-события: быстрый UI может
          // отправить решение сразу после кадра.
          const decisionPromise = approvals.request(
            toolCall.id,
            thread.id,
            tool.name,
            signal,
          )
          yield event('tool_call', toolCall)
          yield event('tool_approval_required', { toolCall, timeoutMs: APPROVAL_TIMEOUT_MS })

          const decision = await decisionPromise

          if (decision !== 'approve') {
            toolCall.status = decision === 'deny' ? 'denied' : 'cancelled'
            toolCall.error =
              decision === 'deny'
                ? 'Пользователь отклонил выполнение'
                : decision === 'timeout'
                  ? 'Истекло время ожидания подтверждения'
                  : 'Выполнение прервано'

            executed.push(toolCall)
            activeToolCalls = executed.slice()
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
              const stopReason = cancellationReason(signal)
              const terminal = terminalizeActive('cancelled', null, stopReason)
              yield event(
                'done',
                doneData(terminal, { outcome: 'cancelled', stopReason }, step + 1),
              )
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
        activeToolCalls = executed.slice()
        store.recordToolRun(thread.id, assistantMessage.id, toolCall)
        yield event('tool_result', {
          toolCallId: toolCall.id,
          status: toolCall.status,
          result: toolCall.result,
          error: toolCall.error,
          durationMs: toolCall.durationMs ?? 0,
        })
      }

      if (signal.aborted) {
        const stopReason = cancellationReason(signal)
        const terminal = terminalizeActive('cancelled', null, stopReason)
        yield event(
          'done',
          doneData(terminal, { outcome: 'cancelled', stopReason }, step + 1),
        )
        return
      }

      if (step + 1 >= MAX_AGENT_STEPS) {
        const limitError: TurnError = {
          code: 'internal_error',
          message: 'The agent turn reached its step limit',
        }
        const terminal = terminalizeActive('failed', limitError, 'tool_limit')
        yield event('error', streamErrorData(limitError))
        yield event(
          'done',
          doneData(terminal, { outcome: 'failed', stopReason: 'tool_limit' }, step + 1),
        )
        return
      }

      terminalizeActive('completed', null, 'tool_calls')

      yield event('usage', usage)
      yield event(
        'context',
        buildContextState({
          usedTokens: usage.promptTokens,
          allocatedTokens: thread.options.numCtx,
          usage,
          model: thread.model,
          tracker,
        }),
      )

      expectedPrefixTokens = usage.promptTokens + usage.evalTokens
      step++
    }

    const limitError: TurnError = {
      code: 'internal_error',
      message: 'The agent turn reached its step limit',
    }
    yield event('error', streamErrorData(limitError))
    yield event('done', {
      messageId: '',
      outcome: 'failed',
      stopReason: 'tool_limit',
      terminalStopReason: 'tool_limit',
      steps: step,
    })
  } catch (caught) {
    let terminal: Message | null = null
    let failureCause = caught

    // fetch/ReadableStream rejects reader.read() with AbortError. Classify the
    // authoritative signal reason before generic provider/error handling so
    // explicit Stop and connection abort cannot become failed/internal_error.
    if (signal.aborted && activeMessageId && !(caught instanceof TerminalPersistenceError)) {
      const stopReason = cancellationReason(signal)
      try {
        terminal = terminalizeActive('cancelled', null, stopReason)
        yield event(
          'done',
          doneData(terminal, { outcome: 'cancelled', stopReason }, step + 1),
        )
        return
      } catch (terminalError) {
        failureCause = terminalError
      }
    }

    let failure = safeTurnFailure(failureCause)
    if (activeMessageId && !(failureCause instanceof TerminalPersistenceError)) {
      try {
        terminal = terminalizeActive('failed', failure.error, failure.stopReason)
      } catch (terminalError) {
        failure = safeTurnFailure(terminalError)
      }
    }
    if (activeMessageId) unresolvedFailure = failure

    yield event('error', streamErrorData(failure.error))
    yield event(
      'done',
      doneData(
        terminal,
        { outcome: 'failed', stopReason: failure.stopReason },
        activeMessageId ? step + 1 : step,
      ),
    )
  } finally {
    if (activeMessageId) {
      const stopReason: TurnStopReason = signal.aborted
        ? cancellationReason(signal)
        : (unresolvedFailure?.stopReason ?? 'internal_error')
      const outcome: TurnTerminalOutcome = signal.aborted ? 'cancelled' : 'failed'
      const error: TurnError | null =
        outcome === 'failed'
          ? (unresolvedFailure?.error ?? {
              code: 'internal_error',
              message: 'The turn ended without a terminal event',
            })
          : null

      try {
        terminalizeActive(outcome, error, stopReason)
      } catch {
        // If the terminal write itself failed, pending is the only truthful
        // durable state available to a later reload.
      }
    }
  }
}
