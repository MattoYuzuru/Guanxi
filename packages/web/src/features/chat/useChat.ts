/**
 * Оркестрация одного треда: загрузка истории, стрим хода, инструменты,
 * подтверждения, контекст.
 *
 * Принцип: сообщение, дописанное моделью, не собирается на клиенте из кусков
 * стрима. После `done` тред перечитывается с сервера — так в списке лежит ровно
 * то, что персистнуто, со всеми полями Message из контракта, а не наша реплика.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApiError,
  ChatStreamEvent,
  ContextState,
  Message,
  Thread,
  ToolCall,
  TurnTerminalOutcome,
  Usage,
} from '@alamo/contract'
import { api, errorMessage, streamChat } from '../../lib/api.ts'
import { translate } from '../../lib/locale.ts'
import { StreamBuffer } from './streamBuffer.ts'

/** Фаза хода — по ней рисуется индикатор ожидания. */
export type TurnPhase =
  | 'idle'
  | 'sending'
  | 'prefill'
  | 'thinking'
  | 'generating'
  | 'tools'
  | 'awaiting_approval'
  | 'finalizing'

export type PendingApproval = {
  toolCall: ToolCall
  timeoutMs: number
  /**
   * Момент истечения по часам клиента. В контракте приходит только `timeoutMs`,
   * абсолютной метки нет — при переподключении отсчёт начнётся заново.
   */
  deadline: number
}

export type ChatState = {
  thread: Thread | null
  messages: Message[]
  context: ContextState | null
  loading: boolean
  loadError: unknown
  phase: TurnPhase
  /** Инструменты текущего хода, в порядке появления. */
  liveToolCalls: ToolCall[]
  approval: PendingApproval | null
  usage: Usage | null
  streamError: ApiError | { code: 'transport'; message: string } | null
  stopReason: string | null
  turnOutcome: TurnTerminalOutcome | null
  /** Live partial remains visible if terminal history cannot be reloaded. */
  liveOutputRetained: boolean
  /** Когда начался ход — для «идёт N с». */
  turnStartedAt: number | null
  /** Когда пришёл первый токен — граница prefill и генерации. */
  firstTokenAt: number | null
  reconnecting: boolean
}

export function useChat(threadId: string | null) {
  const [state, setState] = useState<ChatState>(initialState)

  // Буфер переживает перерисовки и не участвует в реконсиляции.
  const bufferRef = useRef<StreamBuffer>(null as unknown as StreamBuffer)
  if (bufferRef.current === null) bufferRef.current = new StreamBuffer()

  const abortRef = useRef<AbortController | null>(null)
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId

  /* ─────────────────────────── Загрузка треда ─────────────────────────── */

  const load = useCallback(async (id: string, signal: AbortSignal) => {
    setState((previous) => ({ ...previous, loading: true, loadError: null }))
    try {
      const data = await api.getThread(id, signal)
      if (signal.aborted) return
      bufferRef.current.reset()
      setState((previous) => ({
        ...previous,
        thread: data.thread,
        messages: data.messages,
        context: data.context,
        loading: false,
        loadError: null,
        liveOutputRetained: false,
      }))
    } catch (error) {
      if (signal.aborted) return
      setState((previous) => ({ ...previous, loading: false, loadError: error }))
    }
  }, [])

  useEffect(() => {
    // Смена треда обрывает незавершённый стрим предыдущего.
    abortRef.current?.abort()
    abortRef.current = null
    bufferRef.current.reset()

    if (!threadId) {
      setState(initialState())
      return
    }

    const controller = new AbortController()
    setState({ ...initialState(), loading: true })
    void load(threadId, controller.signal)
    return () => controller.abort()
  }, [threadId, load])

  useEffect(() => {
    const buffer = bufferRef.current
    return () => {
      abortRef.current?.abort()
      buffer.dispose()
    }
  }, [])

  /* ──────────────────────────── Отправка хода ─────────────────────────── */

  const send = useCallback(
    async (content: string, options?: { attachments?: string[]; autoApprove?: boolean }) => {
      const id = threadIdRef.current
      if (!id) return

      const buffer = bufferRef.current
      buffer.reset()
      abortRef.current?.abort()

      const controller = new AbortController()
      abortRef.current = controller

      setState((previous) => ({
        ...previous,
        messages: [
          ...previous.messages,
          {
            id: `optimistic-${crypto.randomUUID()}`,
            threadId: id,
            role: 'user',
            content,
            thinking: null,
            toolCalls: [],
            usage: null,
            createdAt: new Date().toISOString(),
            isCompaction: false,
            turnStatus: null,
            turnError: null,
            stopReason: null,
          },
        ],
        phase: 'sending',
        liveToolCalls: [],
        approval: null,
        usage: null,
        streamError: null,
        stopReason: null,
        turnOutcome: null,
        liveOutputRetained: false,
        turnStartedAt: Date.now(),
        firstTokenAt: null,
        reconnecting: false,
      }))

      const body = {
        content,
        ...(options?.attachments ? { attachments: options.attachments } : {}),
        ...(options?.autoApprove !== undefined ? { autoApprove: options.autoApprove } : {}),
      }

      let terminalObserved = false
      const { finished } = streamChat(id, body, {
        signal: controller.signal,
        onReconnect: () => setState((previous) => ({ ...previous, reconnecting: true })),
        onInvalidFrame: (raw) => {
          // Кадр не по контракту — стрим продолжается, но это стоит увидеть.
          console.warn('[alamo] кадр SSE не прошёл схему контракта:', raw)
        },
        onEvent: (event) => {
          if (event.type === 'done') terminalObserved = true
          handleEvent(event, buffer, setState)
        },
        onError: (error) => {
          buffer.flushNow()
          const live = buffer.peek()
          setState((previous) => ({
            ...previous,
            phase: 'idle',
            reconnecting: false,
            streamError: { code: 'transport', message: errorMessage(error) },
            liveOutputRetained:
              Boolean(live.content || live.thinking) || previous.liveToolCalls.length > 0,
          }))
        },
      })

      await finished

      // Стрим закончился (штатно, ошибкой или отменой) — синхронизируемся с базой.
      if (threadIdRef.current !== id) return
      if (!terminalObserved && !controller.signal.aborted) {
        setState((previous) => ({
          ...previous,
          streamError:
            previous.streamError ??
            {
              code: 'transport',
              message: translate('chat.turn.streamMissingTerminal'),
            },
        }))
      }
      setState((previous) => ({
        ...previous,
        phase: previous.phase === 'idle' ? 'idle' : 'finalizing',
        reconnecting: false,
      }))

      try {
        const data = await api.getThread(id)
        if (threadIdRef.current !== id) return
        buffer.reset()
        setState((previous) => ({
          ...previous,
          thread: data.thread,
          messages: data.messages,
          context: data.context,
          phase: 'idle',
          liveToolCalls: [],
          approval: null,
          liveOutputRetained: false,
        }))
      } catch {
        // Перечитать не вышло — оставляем то, что уже показано, и снимаем фазу.
        buffer.flushNow()
        const live = buffer.peek()
        setState((previous) => ({
          ...previous,
          phase: 'idle',
          liveOutputRetained:
            Boolean(live.content || live.thinking) || previous.liveToolCalls.length > 0,
        }))
      }
    },
    [],
  )

  /* ─────────────────────────────── Стоп ───────────────────────────────── */

  const stop = useCallback(async () => {
    const id = threadIdRef.current
    if (!id) return
    // Сначала просим сервер прекратить генерацию, потом рвём соединение:
    // иначе модель продолжит крутиться, просто без слушателя.
    try {
      await api.stopThread(id)
    } catch {
      // Даже если ручка не ответила, стрим всё равно оборвём.
    }
    abortRef.current?.abort()
    bufferRef.current.flushNow()
    setState((previous) => ({
      ...previous,
      phase: 'idle',
      approval: null,
      stopReason: 'stopped_by_user',
      turnOutcome: 'cancelled',
    }))
  }, [])

  /* ─────────────────────────── Подтверждения ──────────────────────────── */

  const respondToApproval = useCallback(
    async (toolCallId: string, decision: 'approve' | 'deny', rememberForThread: boolean) => {
      setState((previous) => ({ ...previous, approval: null, phase: 'tools' }))
      try {
        await api.respondToApproval(toolCallId, { decision, rememberForThread })
      } catch (error) {
        setState((previous) => ({
          ...previous,
          streamError: { code: 'transport', message: errorMessage(error) },
        }))
      }
    },
    [],
  )

  /* ─────────────────────────────── Компакция ──────────────────────────── */

  const [compacting, setCompacting] = useState(false)

  const compact = useCallback(async () => {
    const id = threadIdRef.current
    if (!id) return
    setCompacting(true)
    try {
      const result = await api.compactThread(id)
      const data = await api.getThread(id)
      if (threadIdRef.current !== id) return
      setState((previous) => ({
        ...previous,
        thread: data.thread,
        messages: data.messages,
        context: result.context,
      }))
      return result
    } finally {
      setCompacting(false)
    }
  }, [])

  const reload = useCallback(() => {
    const id = threadIdRef.current
    if (!id) return
    const controller = new AbortController()
    void load(id, controller.signal)
  }, [load])

  const isStreaming = state.phase !== 'idle'

  return useMemo(
    () => ({
      ...state,
      buffer: bufferRef.current,
      isStreaming,
      compacting,
      send,
      stop,
      respondToApproval,
      compact,
      reload,
    }),
    [state, isStreaming, compacting, send, stop, respondToApproval, compact, reload],
  )
}

/* ──────────────────────────── Обработка событий ─────────────────────────── */

function handleEvent(
  event: ChatStreamEvent,
  buffer: StreamBuffer,
  setState: React.Dispatch<React.SetStateAction<ChatState>>,
): void {
  switch (event.type) {
    case 'start':
      // Токенов ещё нет: модель обрабатывает промпт. На большом контексте это
      // десятки секунд, и это надо показать явно.
      setState((previous) => ({ ...previous, phase: 'prefill', reconnecting: false }))
      break

    case 'thinking':
      buffer.appendThinking(event.data.delta)
      setState((previous) =>
        previous.phase === 'thinking'
          ? previous
          : {
              ...previous,
              phase: 'thinking',
              firstTokenAt: previous.firstTokenAt ?? Date.now(),
            },
      )
      break

    case 'token':
      buffer.appendToken(event.data.delta)
      setState((previous) =>
        previous.phase === 'generating'
          ? previous
          : {
              ...previous,
              phase: 'generating',
              firstTokenAt: previous.firstTokenAt ?? Date.now(),
            },
      )
      break

    case 'tool_call':
      setState((previous) => ({
        ...previous,
        phase: 'tools',
        liveToolCalls: upsertToolCall(previous.liveToolCalls, event.data),
      }))
      break

    case 'tool_approval_required':
      setState((previous) => ({
        ...previous,
        phase: 'awaiting_approval',
        liveToolCalls: upsertToolCall(previous.liveToolCalls, event.data.toolCall),
        approval: {
          toolCall: event.data.toolCall,
          timeoutMs: event.data.timeoutMs,
          deadline: Date.now() + event.data.timeoutMs,
        },
      }))
      break

    case 'tool_result':
      setState((previous) => ({
        ...previous,
        phase: 'tools',
        approval:
          previous.approval?.toolCall.id === event.data.toolCallId ? null : previous.approval,
        liveToolCalls: previous.liveToolCalls.map((call) =>
          call.id === event.data.toolCallId
            ? {
                ...call,
                status: event.data.status,
                result: event.data.result,
                error: event.data.error,
                durationMs: event.data.durationMs,
              }
            : call,
        ),
      }))
      break

    case 'usage':
      setState((previous) => ({ ...previous, usage: event.data }))
      break

    case 'context':
      setState((previous) => ({ ...previous, context: event.data }))
      break

    case 'done':
      buffer.flushNow()
      setState((previous) => ({
        ...previous,
        phase: 'finalizing',
        stopReason: event.data.terminalStopReason ?? event.data.stopReason,
        turnOutcome: event.data.outcome ?? null,
        approval: null,
      }))
      break

    case 'error': {
      buffer.flushNow()
      const live = buffer.peek()
      setState((previous) => ({
        ...previous,
        phase: 'idle',
        streamError: event.data,
        turnOutcome: 'failed',
        approval: null,
        liveOutputRetained:
          Boolean(live.content || live.thinking) || previous.liveToolCalls.length > 0,
      }))
      break
    }

    default:
      break
  }
}

function upsertToolCall(calls: ToolCall[], next: ToolCall): ToolCall[] {
  const index = calls.findIndex((call) => call.id === next.id)
  if (index === -1) return [...calls, next]
  const copy = calls.slice()
  copy[index] = { ...copy[index], ...next } as ToolCall
  return copy
}

function initialState(): ChatState {
  return {
    thread: null,
    messages: [],
    context: null,
    loading: false,
    loadError: null,
    phase: 'idle',
    liveToolCalls: [],
    approval: null,
    usage: null,
    streamError: null,
    stopReason: null,
    turnOutcome: null,
    liveOutputRetained: false,
    turnStartedAt: null,
    firstTokenAt: null,
    reconnecting: false,
  }
}
