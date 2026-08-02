/**
 * Экран диалога: список тредов, история/стрим и панель контекста.
 *
 * Сервер остаётся источником истины. Стрим показывает живой ответ, а после done
 * useChat перечитывает сохранённую историю целиком.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import type { Health, Message, ThreadMode, Workspace } from '@alamo/contract'
import {
  DEFAULT_AGENT_TEMPERATURE,
  DEFAULT_CHAT_NUM_CTX,
  DEFAULT_NUM_CTX,
  DEFAULT_TEMPERATURE,
} from '@alamo/contract'
import { Markdown } from '../../components/Markdown.tsx'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Select,
  Skeleton,
  Textarea,
  Toggle,
  cx,
} from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatRelativeTime, formatTime } from '../../lib/format.ts'
import { Link, paths, useNavigate } from '../../lib/router.tsx'
import { useAsync, useLocalStorage } from '../../lib/useAsync.ts'
import { ApprovalPrompt } from '../agent/ApprovalPrompt.tsx'
import { ToolCallCard } from '../agent/ToolCallCard.tsx'
import { WorkspaceChip, WorkspacePicker } from '../agent/WorkspacePicker.tsx'
import { ContextChip, ContextPanel } from '../context/ContextPanel.tsx'
import type { StreamBuffer } from './streamBuffer.ts'
import { useChat, type TurnPhase } from './useChat.ts'

export function ChatPage({
  threadId,
  health,
}: {
  threadId: string | null
  health: Health
}) {
  if (!threadId) return <NewThreadPage />
  return <ThreadPage threadId={threadId} health={health} />
}

/* ───────────────────────────── Новый тред ─────────────────────────────── */

function NewThreadPage() {
  const navigate = useNavigate()
  const query = useMemo(() => new URLSearchParams(window.location.search), [])
  const models = useAsync((signal) => api.listModels(undefined, signal), [])
  const workspaces = useAsync((signal) => api.listWorkspaces(signal), [])
  const settings = useAsync((signal) => api.getSettings(signal), [])

  const [mode, setMode] = useState<ThreadMode>('chat')
  const [model, setModel] = useState(query.get('model') ?? '')
  const [workspaceId, setWorkspaceId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const availableModels = models.data?.models ?? []

  useEffect(() => {
    if (model || availableModels.length === 0) return
    const preferred = settings.data?.defaultModel
    setModel(
      (preferred && availableModels.some((item) => item.name === preferred)
        ? preferred
        : availableModels.find((item) => !item.capabilities.includes('embedding'))?.name) ??
        availableModels[0]?.name ??
        '',
    )
  }, [availableModels, model, settings.data?.defaultModel])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!model) return

    setCreating(true)
    setCreateError(null)
    try {
      const requestedContext = Number(query.get('numCtx'))
      const defaultContext =
        mode === 'agent'
          ? settings.data?.defaultNumCtx ?? DEFAULT_NUM_CTX
          : DEFAULT_CHAT_NUM_CTX
      const numCtx =
        Number.isFinite(requestedContext) && requestedContext >= 512
          ? requestedContext
          : defaultContext

      const thread = await api.createThread({
        mode,
        model,
        workspaceId: mode === 'agent' && workspaceId ? workspaceId : null,
        options: {
          numCtx,
          temperature: mode === 'agent' ? DEFAULT_AGENT_TEMPERATURE : DEFAULT_TEMPERATURE,
          think: 'off',
        },
      })
      navigate(paths.chat(thread.id), { replace: true })
    } catch (error) {
      setCreateError(errorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-5 px-4 py-5 sm:px-5 md:grid-cols-[240px_minmax(0,1fr)]">
      <ThreadSidebar currentId={null} />

      <section className="surface min-w-0 rounded-xl p-4">
        <h1 className="text-base font-semibold">Новый диалог</h1>
        <p className="mt-0.5 mb-4 text-xs text-[var(--fg-muted)]">
          Чат отвечает на вопросы. Агент дополнительно читает и меняет файлы выбранного проекта.
        </p>

        {createError && (
          <div className="mb-3">
            <Callout tone="danger" title="Не удалось создать тред">
              {createError}
            </Callout>
          </div>
        )}

        <form onSubmit={create} className="w-full min-w-0 max-w-xl space-y-4">
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium">Режим</legend>
            <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2">
              <ModeButton
                active={mode === 'chat'}
                title="Чат"
                description="Диалог без доступа к файлам"
                onClick={() => setMode('chat')}
              />
              <ModeButton
                active={mode === 'agent'}
                title="Агент"
                description="Инструменты и рабочая директория"
                onClick={() => setMode('agent')}
              />
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-1 block text-xs font-medium">Модель</span>
            {models.loading ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <Select
                value={model}
                onChange={setModel}
                ariaLabel="Модель для нового диалога"
                options={availableModels.map((item) => ({
                  value: item.name,
                  label: `${item.name}${item.capabilities.includes('tools') ? ' · tools' : ''}`,
                  disabled: item.capabilities.includes('embedding'),
                }))}
              />
            )}
            {models.error !== null && (
              <p className="mt-1 text-2xs text-[var(--danger)]">{errorMessage(models.error)}</p>
            )}
          </label>

          {mode === 'agent' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium">Рабочая директория</span>
              <Select
                value={workspaceId}
                onChange={setWorkspaceId}
                ariaLabel="Рабочая директория агента"
                options={[
                  { value: '', label: 'Без директории — инструменты недоступны' },
                  ...(workspaces.data?.workspaces ?? []).map((workspace) => ({
                    value: workspace.id,
                    label: workspace.exists
                      ? `${workspace.name} · ${workspace.rootPath}`
                      : `${workspace.name} · нет на диске`,
                    disabled: !workspace.exists,
                  })),
                ]}
              />
              <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
                Новую директорию можно добавить уже в шапке треда.
              </p>
            </label>
          )}

          <div className="flex justify-end">
            <Button variant="primary" type="submit" loading={creating} disabled={!model}>
              Создать диалог
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

function ModeButton({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'min-w-0 rounded-lg border px-3 py-2 text-left',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-subtle)]/55'
          : 'border-[var(--border)] hover:bg-[var(--bg-subtle)]',
      )}
    >
      <span className="block text-xs font-semibold">{title}</span>
      <span className="mt-0.5 block break-words text-2xs text-[var(--fg-muted)]">
        {description}
      </span>
    </button>
  )
}

/* ─────────────────────────────── Тред ─────────────────────────────────── */

function ThreadPage({ threadId, health }: { threadId: string; health: Health }) {
  const chat = useChat(threadId)
  const workspaces = useAsync((signal) => api.listWorkspaces(signal), [chat.thread?.workspaceId])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [autoApprove, setAutoApprove] = useLocalStorage('alamo.autoApproveTurn', false)

  const workspace =
    workspaces.data?.workspaces.find((item) => item.id === chat.thread?.workspaceId) ?? null

  const pickWorkspace = async (next: Workspace | null) => {
    setPickerOpen(false)
    if (!chat.thread) return
    try {
      await api.updateThread(chat.thread.id, { workspaceId: next?.id ?? null })
      chat.reload()
      workspaces.reload()
    } catch {
      // Перезагрузка оставит прежнее значение; отдельной модалке ошибка не нужна.
    }
  }

  if (chat.loading) {
    return (
      <div className="grid h-[calc(100dvh-44px)] md:grid-cols-[240px_minmax(0,1fr)]">
        <ThreadSidebar currentId={threadId} />
        <div className="space-y-3 p-5">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-24 w-3/4" />
          <Skeleton className="ml-auto h-20 w-2/3" />
        </div>
      </div>
    )
  }

  if (chat.loadError || !chat.thread) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-6">
        <Callout
          tone="danger"
          title="Не удалось открыть тред"
          action={
            <Button size="sm" onClick={chat.reload}>
              Повторить
            </Button>
          }
        >
          {errorMessage(chat.loadError)}
        </Callout>
      </div>
    )
  }

  return (
    <div className="grid h-[calc(100dvh-44px)] min-h-0 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]">
      <ThreadSidebar currentId={threadId} />

      <section className="flex min-h-0 min-w-0 flex-col border-l border-[var(--border)]">
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-1.5">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xs font-semibold">{chat.thread.title}</h1>
              <Badge tone={chat.thread.mode === 'agent' ? 'accent' : 'neutral'}>
                {chat.thread.mode === 'agent' ? 'агент' : 'чат'}
              </Badge>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-2xs text-[var(--fg-subtle)]">
              <span className="truncate font-mono">{chat.thread.model}</span>
              <ContextChip context={chat.context} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {chat.thread.mode === 'agent' && (
              <WorkspaceChip workspace={workspace} onClick={() => setPickerOpen(true)} />
            )}
            <Link
              to={paths.chat()}
              className="flex h-6 items-center rounded-[5px] border border-[var(--border-strong)] px-2 text-2xs font-medium hover:bg-[var(--bg-subtle)]"
            >
              Новый
            </Link>
          </div>
        </header>

        {!health.ollama.running && (
          <Callout tone="warning" title="Ollama не запущена">
            Историю можно читать, но новый ответ не сгенерируется, пока сервис недоступен.
          </Callout>
        )}

        <MessageTimeline
          messages={chat.messages}
          buffer={chat.buffer}
          phase={chat.phase}
          liveToolCalls={chat.liveToolCalls}
          streamError={chat.streamError?.message ?? null}
        />

        <div className="border-t border-[var(--border)] bg-[var(--bg)] p-2.5">
          <div className="mb-2 xl:hidden">
            <details className="rounded-md border border-[var(--border)]">
              <summary className="cursor-pointer px-2 py-1 text-2xs font-medium text-[var(--fg-muted)]">
                Контекст и скорость
              </summary>
              <div className="max-h-80 border-t border-[var(--border)]">
                <ContextPanel
                  context={chat.context}
                  usage={chat.usage}
                  compacting={chat.compacting}
                  onCompact={() => void chat.compact()}
                  disabled={chat.isStreaming}
                />
              </div>
            </details>
          </div>

          <Composer
            disabled={!health.ollama.running}
            phase={chat.phase}
            isStreaming={chat.isStreaming}
            agentMode={chat.thread.mode === 'agent'}
            autoApprove={autoApprove}
            onAutoApprove={setAutoApprove}
            onSend={(content) => chat.send(content, { autoApprove })}
            onStop={chat.stop}
          />
        </div>
      </section>

      <aside className="hidden min-h-0 border-l border-[var(--border)] xl:block">
        <ContextPanel
          context={chat.context}
          usage={chat.usage}
          compacting={chat.compacting}
          onCompact={() => void chat.compact()}
          disabled={chat.isStreaming}
        />
      </aside>

      {chat.thread.mode === 'agent' && (
        <WorkspacePicker
          open={pickerOpen}
          currentId={chat.thread.workspaceId}
          onClose={() => setPickerOpen(false)}
          onPick={(next) => void pickWorkspace(next)}
        />
      )}

      {chat.approval && (
        <ApprovalPrompt
          approval={chat.approval}
          onDecide={(decision, remember) =>
            void chat.respondToApproval(chat.approval!.toolCall.id, decision, remember)
          }
        />
      )}
    </div>
  )
}

/* ─────────────────────────── История и стрим ──────────────────────────── */

function MessageTimeline({
  messages,
  buffer,
  phase,
  liveToolCalls,
  streamError,
}: {
  messages: Message[]
  buffer: StreamBuffer
  phase: TurnPhase
  liveToolCalls: ReturnType<typeof useChat>['liveToolCalls']
  streamError: string | null
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const showLive = phase !== 'idle'
  const scrollToEnd = useCallback(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [])

  useEffect(() => {
    scrollToEnd()
  }, [messages.length, phase, liveToolCalls.length, scrollToEnd])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
      <div className="mx-auto max-w-3xl space-y-4">
        {messages.length === 0 && !showLive && (
          <EmptyState
            title="Начните диалог"
            description="Ответ появится здесь потоково, а затем сохранится в локальной SQLite-базе."
          />
        )}

        {messages.map((message) => (
          <MessageView key={message.id} message={message} />
        ))}

        {showLive && (
          <StreamingMessage
            buffer={buffer}
            phase={phase}
            toolCalls={liveToolCalls}
            onChange={scrollToEnd}
          />
        )}

        {streamError && (
          <Callout tone="danger" title="Генерация прервалась">
            {streamError}
          </Callout>
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function MessageView({ message }: { message: Message }) {
  if (message.role === 'system') {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <Badge tone={message.isCompaction ? 'yellow' : 'neutral'}>
            {message.isCompaction ? 'сводка' : 'система'}
          </Badge>
          <span className="text-2xs text-[var(--fg-subtle)]">{formatTime(message.createdAt)}</span>
        </div>
        <Markdown source={message.content} />
      </div>
    )
  }

  const user = message.role === 'user'

  return (
    <article className={cx('flex', user ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'min-w-0 max-w-[92%]',
          user
            ? 'rounded-xl rounded-br-sm bg-[var(--accent-subtle)] px-3 py-2'
            : 'w-full',
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-2xs text-[var(--fg-subtle)]">
          <span>{user ? 'Вы' : message.role === 'assistant' ? 'Alamo' : 'Инструмент'}</span>
          <span>{formatTime(message.createdAt)}</span>
          {message.usage?.cacheHit && <Badge tone="green">KV-кэш</Badge>}
        </div>

        {message.thinking && (
          <details className="mb-2 rounded border border-[var(--border)] bg-[var(--bg-subtle)]">
            <summary className="cursor-pointer px-2 py-1 text-2xs text-[var(--fg-muted)]">
              Рассуждение модели
            </summary>
            <div className="border-t border-[var(--border)] px-2 py-1.5 text-xs whitespace-pre-wrap text-[var(--fg-muted)]">
              {message.thinking}
            </div>
          </details>
        )}

        {message.content && <Markdown source={message.content} />}

        {message.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {message.toolCalls.map((call) => (
              <ToolCallCard key={call.id} call={call} />
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export function StreamingMessage({
  buffer,
  phase,
  toolCalls,
  onChange,
}: {
  buffer: StreamBuffer
  phase: TurnPhase
  toolCalls: ReturnType<typeof useChat>['liveToolCalls']
  onChange: () => void
}) {
  const snapshot = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot, buffer.getSnapshot)

  useEffect(() => {
    onChange()
  }, [snapshot.version, toolCalls.length, onChange])

  return (
    <article className="anim-fade-up">
      <div className="mb-1 flex items-center gap-2 text-2xs text-[var(--fg-subtle)]">
        <span>Alamo</span>
        <Badge tone={phase === 'awaiting_approval' ? 'yellow' : 'accent'}>
          {phaseLabel(phase)}
        </Badge>
      </div>

      {snapshot.thinking && (
        <details open className="mb-2 rounded border border-[var(--border)] bg-[var(--bg-subtle)]">
          <summary className="cursor-pointer px-2 py-1 text-2xs text-[var(--fg-muted)]">
            Рассуждение модели
          </summary>
          <div className="border-t border-[var(--border)] px-2 py-1.5 text-xs whitespace-pre-wrap text-[var(--fg-muted)]">
            {snapshot.thinking}
          </div>
        </details>
      )}

      {snapshot.content ? (
        <Markdown source={snapshot.content} className={phase === 'generating' ? 'stream-caret' : ''} />
      ) : (
        <p className="anim-pulse-soft text-xs text-[var(--fg-muted)]">
          {phase === 'prefill' ? 'Обрабатывает контекст…' : 'Готовит ответ…'}
        </p>
      )}

      {toolCalls.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {toolCalls.map((call) => (
            <ToolCallCard key={call.id} call={call} defaultOpen={call.status !== 'ok'} />
          ))}
        </div>
      )}
    </article>
  )
}

/* ───────────────────────────── Композер ───────────────────────────────── */

function Composer({
  disabled,
  phase,
  isStreaming,
  agentMode,
  autoApprove,
  onAutoApprove,
  onSend,
  onStop,
}: {
  disabled: boolean
  phase: TurnPhase
  isStreaming: boolean
  agentMode: boolean
  autoApprove: boolean
  onAutoApprove: (next: boolean) => void
  onSend: (content: string) => Promise<void>
  onStop: () => Promise<void>
}) {
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)

  const submit = async () => {
    const trimmed = content.trim()
    if (!trimmed || isStreaming || disabled) return
    setContent('')
    setSending(true)
    try {
      await onSend(trimmed)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Textarea
        value={content}
        rows={3}
        disabled={disabled || isStreaming}
        placeholder={
          disabled
            ? 'Запустите Ollama, чтобы продолжить'
            : agentMode
              ? 'Опишите задачу над проектом…'
              : 'Сообщение…'
        }
        aria-label="Сообщение"
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
        className="min-h-20"
      />

      <div className="mt-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {agentMode && (
            <Toggle
              checked={autoApprove}
              onChange={onAutoApprove}
              disabled={isStreaming}
              label="Автоподтверждение"
              hint="Записи и bash выполнятся без паузы в этом ходе."
            />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-2xs text-[var(--fg-subtle)] sm:inline">
            Enter — отправить · Shift+Enter — строка
          </span>
          {isStreaming ? (
            <Button variant="danger" onClick={() => void onStop()}>
              Остановить · {phaseLabel(phase)}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void submit()}
              loading={sending}
              disabled={disabled || !content.trim()}
            >
              Отправить
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────────── Список тредов ──────────────────────────── */

function ThreadSidebar({ currentId }: { currentId: string | null }) {
  const threads = useAsync((signal) => api.listThreads(signal), [currentId])

  return (
    <aside className="hidden min-h-0 overflow-y-auto p-2 md:block">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="text-2xs font-semibold text-[var(--fg-muted)]">Диалоги</span>
        <Link
          to={paths.chat()}
          className="rounded px-1.5 py-0.5 text-2xs text-[var(--accent)] hover:bg-[var(--accent-subtle)]"
        >
          + Новый
        </Link>
      </div>

      {threads.loading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : threads.error ? (
        <p className="px-1 text-2xs text-[var(--danger)]">{errorMessage(threads.error)}</p>
      ) : (threads.data?.threads.length ?? 0) === 0 ? (
        <p className="px-1 py-3 text-2xs text-[var(--fg-subtle)]">История пока пуста.</p>
      ) : (
        <nav aria-label="История диалогов" className="space-y-0.5">
          {threads.data?.threads.map((thread) => (
            <Link
              key={thread.id}
              to={paths.chat(thread.id)}
              aria-current={thread.id === currentId ? 'page' : undefined}
              className={cx(
                'block rounded-md px-2 py-1.5',
                thread.id === currentId
                  ? 'bg-[var(--bg-inset)]'
                  : 'hover:bg-[var(--bg-subtle)]',
              )}
            >
              <span className="block truncate text-xs font-medium">{thread.title}</span>
              <span className="mt-0.5 flex items-center justify-between gap-2 text-2xs text-[var(--fg-subtle)]">
                <span className="truncate">{thread.mode === 'agent' ? 'агент' : thread.model}</span>
                <span className="shrink-0">{formatRelativeTime(thread.updatedAt)}</span>
              </span>
            </Link>
          ))}
        </nav>
      )}
    </aside>
  )
}

function phaseLabel(phase: TurnPhase): string {
  const labels: Record<TurnPhase, string> = {
    idle: 'готов',
    sending: 'отправка',
    prefill: 'prefill',
    thinking: 'думает',
    generating: 'генерация',
    tools: 'инструменты',
    awaiting_approval: 'ждёт решения',
    finalizing: 'сохраняет',
  }
  return labels[phase]
}
