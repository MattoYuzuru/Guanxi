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
  type RefObject,
} from 'react'
import type {
  Health,
  Message,
  ThreadMode,
  TurnErrorCode,
  TurnStatus,
  TurnStopReason,
  Workspace,
} from '@alamo/contract'
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
import { translate } from '../../lib/locale.ts'
import {
  exceedsDeclaredContextLimit,
  parsePositiveSafeInteger,
} from '../../lib/contextLength.ts'
import { Link, paths, useNavigate } from '../../lib/router.tsx'
import { useAsync, useLocalStorage } from '../../lib/useAsync.ts'
import { ApprovalPrompt } from '../agent/ApprovalPrompt.tsx'
import { ToolCallCard } from '../agent/ToolCallCard.tsx'
import { WorkspaceChip, WorkspacePicker } from '../agent/WorkspacePicker.tsx'
import { ContextChip, ContextPanel } from '../context/ContextPanel.tsx'
import type { StreamBuffer } from './streamBuffer.ts'
import { useChat, type ChatSendOptions, type TurnPhase } from './useChat.ts'
import { useModelPrewarm, type ModelPrewarmState } from './useModelPrewarm.ts'
import {
  ResourceConflictDialog,
  useResourceConflictDecision,
  type ChatSendIntent,
} from './ResourceConflictDecision.tsx'

export function ChatPage({
  threadId,
  projectId = null,
  health,
}: {
  threadId: string | null
  projectId?: string | null
  health: Health
}) {
  if (!threadId) return <NewThreadPage projectId={projectId} />
  return <ThreadPage threadId={threadId} projectId={projectId} health={health} />
}

/* ───────────────────────────── Новый тред ─────────────────────────────── */

function NewThreadPage({ projectId }: { projectId: string | null }) {
  const navigate = useNavigate()
  const query = useMemo(() => new URLSearchParams(window.location.search), [])
  const settings = useAsync((signal) => api.getSettings(signal), [])
  const projectContext = useAsync(
    async (signal) => (projectId ? api.listProjectChats(projectId, signal) : null),
    [projectId],
  )

  const [mode, setMode] = useState<ThreadMode>('chat')
  const [model, setModel] = useState(query.get('model') ?? '')
  const [workspaceId, setWorkspaceId] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const creatingRef = useRef(false)
  const createErrorRef = useRef<HTMLDivElement>(null)
  const projectHeadingRef = useRef<HTMLHeadingElement>(null)
  const projectContextErrorRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (projectId && projectContext.data) {
      requestAnimationFrame(() => projectHeadingRef.current?.focus())
    } else if (projectId && projectContext.error) {
      requestAnimationFrame(() => projectContextErrorRef.current?.focus())
    }
  }, [projectId, projectContext.data, projectContext.error])

  const requestedContextText = query.get('numCtx')
  const requestedContext = parsePositiveSafeInteger(requestedContextText)
  const contextInputInvalid = requestedContextText !== null && requestedContext === null
  const defaultContext =
    mode === 'agent'
      ? settings.data?.defaultNumCtx ?? DEFAULT_NUM_CTX
      : DEFAULT_CHAT_NUM_CTX
  const numCtx =
    requestedContext !== null
      ? requestedContext
      : defaultContext
  const models = useAsync((signal) => api.listModels(numCtx, signal), [numCtx])
  const workspaces = useAsync(
    (signal) => projectId ? Promise.resolve({ workspaces: [] }) : api.listWorkspaces(signal),
    [projectId],
  )
  const availableModels = models.data?.models ?? []
  const selectedModel =
    availableModels.find(
      (item) => item.name === model && !item.capabilities.includes('embedding'),
    ) ?? null
  const contextBlocked = exceedsDeclaredContextLimit(numCtx, selectedModel?.contextLimit)
  const prewarm = useModelPrewarm({
    model: mode === 'chat' ? selectedModel : null,
    contextLength: numCtx,
    enabled: settings.data?.prewarmEnabled,
  })

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
    if (creatingRef.current || !model || contextBlocked || contextInputInvalid) return

    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    try {
      const thread = projectId
        ? await api.createProjectChat(projectId, {
            model,
            options: { numCtx, temperature: DEFAULT_TEMPERATURE, think: 'off' },
          })
        : await api.createThread({
            mode,
            model,
            workspaceId: mode === 'agent' && workspaceId ? workspaceId : null,
            options: {
              numCtx,
              temperature: mode === 'agent' ? DEFAULT_AGENT_TEMPERATURE : DEFAULT_TEMPERATURE,
              think: 'off',
            },
          })
      navigate(
        projectId ? paths.projectChat(projectId, thread.id) : paths.chat(thread.id),
        { replace: true },
      )
    } catch (error) {
      setCreateError(errorMessage(error))
      requestAnimationFrame(() => createErrorRef.current?.focus())
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  if (projectId && projectContext.loading) {
    return <div role="status" aria-label={translate('projects.chats.loading')} className="p-5"><Skeleton className="h-8 w-72" /></div>
  }

  if (projectId && (projectContext.error || !projectContext.data)) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-6" role="alert">
        <h1 ref={projectContextErrorRef} tabIndex={-1} className="text-base font-semibold outline-none">
          {translate('projects.chats.safeState')}
        </h1>
        <p className="mt-2 break-words text-xs text-[var(--fg-muted)]">
          {errorMessage(projectContext.error)}
        </p>
        <Button className="mt-3" onClick={projectContext.reload}>{translate('projects.retry')}</Button>
      </div>
    )
  }

  const project = projectContext.data?.project ?? null

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-5 px-4 py-5 sm:px-5 md:grid-cols-[240px_minmax(0,1fr)]">
      <ThreadSidebar currentId={null} projectId={projectId} />

      <section className="surface min-w-0 rounded-xl p-4">
        <h1
          ref={project ? projectHeadingRef : undefined}
          tabIndex={project ? -1 : undefined}
          className="break-words text-base font-semibold outline-none"
        >
          {project
            ? translate('projects.chats.newFor').replace('{name}', project.name)
            : 'Новый диалог'}
        </h1>
        <p className="mt-0.5 mb-4 text-xs text-[var(--fg-muted)]">
          {projectId
            ? translate('projects.chats.newDescription')
            : 'Чат отвечает на вопросы. Агент дополнительно читает и меняет файлы выбранного проекта.'}
        </p>

        {createError && (
          <div ref={createErrorRef} tabIndex={-1} className="mb-3 outline-none">
            <Callout
              tone="danger"
              title={projectId ? translate('projects.chats.createError') : 'Не удалось создать тред'}
            >
              {createError}
            </Callout>
          </div>
        )}

        <form onSubmit={create} className="w-full min-w-0 max-w-xl space-y-4">
          {!projectId && <fieldset>
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
          </fieldset>}

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
            {selectedModel && mode === 'chat' ? (
              <p className="mt-1 text-2xs text-[var(--fg-subtle)]" role="status" aria-live="polite">
                {prewarmLabel(prewarm)}
              </p>
            ) : null}
          </label>

          {contextBlocked && selectedModel?.contextLimit.state === 'declared' ? (
            <Callout tone="danger" title={translate('context.limit.exceeded')}>
              {translate('context.limit.declared')}: {' '}
              {selectedModel.contextLimit.value.toLocaleString()} · {' '}
              {selectedModel.contextLimit.source === 'ollama_api_tags'
                ? translate('context.limit.source.tags')
                : translate('context.limit.source.show')}
            </Callout>
          ) : null}

          {contextInputInvalid ? (
            <Callout tone="danger" title={translate('context.validation.positiveSafeInteger')}>
              {translate('context.custom.hint')}
            </Callout>
          ) : null}

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
            <Button
              variant="primary"
              type="submit"
              loading={creating}
              disabled={!model || contextBlocked || contextInputInvalid}
            >
              Создать диалог
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

function prewarmLabel(state: ModelPrewarmState): string {
  if (state.phase === 'idle') return translate('chat.prewarm.idle')
  if (state.phase === 'pending') return translate('chat.prewarm.pending')
  if (state.phase === 'warming') return translate('chat.prewarm.warming')
  if (state.phase === 'warmed') return translate('chat.prewarm.warmed')
  if (state.phase === 'reused') return translate('chat.prewarm.reused')
  if (state.reason === 'disabled') return translate('chat.prewarm.skipped.disabled')
  if (state.reason === 'fit_unknown') return translate('chat.prewarm.skipped.fitUnknown')
  if (state.reason === 'fit_unavailable') return translate('chat.prewarm.skipped.fitUnavailable')
  if (state.reason === 'document_hidden') return translate('chat.prewarm.cancelled.hidden')
  if (state.reason === 'normal_work_present' || state.reason === 'normal_work_started') {
    return translate('chat.prewarm.cancelled.normalWork')
  }
  if (state.reason === 'already_resident_exact') return translate('chat.prewarm.reused')
  if (state.reason === 'resident_identity_ambiguous') {
    return translate('chat.prewarm.skipped.identityAmbiguous')
  }
  if (state.reason === 'request_timeout') return translate('chat.prewarm.skipped.timeout')
  if (state.reason === 'selection_changed') {
    return translate('chat.prewarm.skipped.selectionChanged')
  }
  if (state.reason === 'model_not_installed') {
    return translate('chat.prewarm.skipped.selectionChanged')
  }
  if (state.reason === 'request_cancelled') return translate('chat.prewarm.cancelled.cleanup')
  return translate('chat.prewarm.skipped.runtimeUnavailable')
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

function ThreadPage({
  threadId,
  projectId,
  health,
}: {
  threadId: string
  projectId: string | null
  health: Health
}) {
  const chat = useChat(threadId, projectId)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const loadErrorHeadingRef = useRef<HTMLHeadingElement>(null)
  const workspaces = useAsync(
    (signal) => projectId ? Promise.resolve({ workspaces: [] }) : api.listWorkspaces(signal),
    [chat.thread?.workspaceId, projectId],
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [autoApprove, setAutoApprove] = useLocalStorage('alamo.autoApproveTurn', false)
  const dispatchChat = useCallback(
    (
      intent: ChatSendIntent,
      callbacks: { onAccepted: () => void; onCommandError: () => void },
    ) => {
      const options: ChatSendOptions = {
        autoApprove,
        idempotencyKey: intent.idempotencyKey,
        onCommandAccepted: callbacks.onAccepted,
        onCommandError: callbacks.onCommandError,
      }
      void chat.send(intent.content, options).catch(callbacks.onCommandError)
    },
    [autoApprove, chat.send],
  )
  const resourceDecision = useResourceConflictDecision(dispatchChat)

  const workspace =
    workspaces.data?.workspaces.find((item) => item.id === chat.thread?.workspaceId) ?? null

  useEffect(() => {
    if (chat.loadError) loadErrorHeadingRef.current?.focus()
  }, [chat.loadError])

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
      <div className="grid h-full md:grid-cols-[240px_minmax(0,1fr)]">
        <ThreadSidebar currentId={threadId} projectId={projectId} />
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
      <div className="mx-auto max-w-3xl px-5 py-6" role="alert">
        <h1 ref={loadErrorHeadingRef} tabIndex={-1} className="text-base font-semibold outline-none">
          {projectId ? translate('projects.chats.safeState') : 'Не удалось открыть тред'}
        </h1>
        <p className="mt-2 break-words text-xs text-[var(--fg-muted)]">
          {errorMessage(chat.loadError)}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={chat.reload}>{translate('projects.retry')}</Button>
          {projectId && <Link to={paths.projects()} className="text-xs text-[var(--accent)] underline">{translate('projects.chats.back')}</Link>}
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]">
      <ThreadSidebar currentId={threadId} projectId={projectId} />

      <section className="flex min-h-0 min-w-0 flex-col border-l border-[var(--border)]">
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-1.5">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xs font-semibold">{chat.thread.title}</h1>
              <Badge tone={chat.thread.mode === 'agent' ? 'accent' : 'neutral'}>
                {chat.thread.mode === 'agent' ? 'агент' : 'чат'}
              </Badge>
            </div>
            {chat.project && (
              <Link
                to={paths.projects()}
                className="mt-0.5 block max-w-full truncate text-2xs text-[var(--accent)] underline underline-offset-2"
              >
                {translate('projects.chats.context').replace('{name}', chat.project.name)}
              </Link>
            )}
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
              to={projectId ? paths.projectChat(projectId) : paths.chat()}
              className="flex h-6 items-center rounded-[5px] border border-[var(--border-strong)] px-2 text-2xs font-medium hover:bg-[var(--bg-subtle)]"
            >
              Новый
            </Link>
          </div>
        </header>

        <MessageTimeline
          messages={chat.messages}
          buffer={chat.buffer}
          phase={chat.phase}
          liveOutputRetained={chat.liveOutputRetained}
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
            inputRef={composerRef}
            disabled={!health.ollama.running}
            decisionOpen={resourceDecision.decision !== null}
            phase={chat.phase}
            isStreaming={chat.isStreaming}
            agentMode={chat.thread.mode === 'agent'}
            autoApprove={autoApprove}
            onAutoApprove={setAutoApprove}
            onSend={resourceDecision.request}
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

      {resourceDecision.decision && (
        <ResourceConflictDialog
          decision={resourceDecision.decision}
          onQueue={resourceDecision.queue}
          onStopAndSwitch={() => void resourceDecision.stopAndSwitch()}
          onClose={resourceDecision.close}
          returnFocusRef={composerRef}
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
  liveOutputRetained,
  liveToolCalls,
  streamError,
}: {
  messages: Message[]
  buffer: StreamBuffer
  phase: TurnPhase
  liveOutputRetained: boolean
  liveToolCalls: ReturnType<typeof useChat>['liveToolCalls']
  streamError: string | null
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const showLive = phase !== 'idle' || liveOutputRetained
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
            retainedAfterFailure={liveOutputRetained}
            toolCalls={liveToolCalls}
            onChange={scrollToEnd}
          />
        )}

        {streamError && (
          <div role="alert">
            <Callout tone="danger" title="Генерация прервалась">
              {streamError}
            </Callout>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

export function MessageView({ message }: { message: Message }) {
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
          {message.role === 'assistant' && (
            <Badge tone={turnStatusTone(message.turnStatus)}>
              {turnStatusLabel(message.turnStatus)}
            </Badge>
          )}
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

        {message.role === 'assistant' && <TurnOutcomeView message={message} />}
      </div>
    </article>
  )
}

function TurnOutcomeView({ message }: { message: Message }) {
  const hasVisibleOutput =
    message.content.length > 0 || Boolean(message.thinking) || message.toolCalls.length > 0
  const reason = message.stopReason ? turnStopReasonLabel(message.stopReason) : null

  if (message.turnStatus === 'completed') {
    if (!hasVisibleOutput) {
      return (
        <div className="mt-2" role="status" aria-live="polite">
          <Callout tone="info" title={translate('chat.turn.completedEmpty.title')}>
            {translate('chat.turn.completedEmpty.summary')}
            {reason && (
              <span className="mt-1 block">
                {translate('chat.turn.reason')}: {reason}
              </span>
            )}
          </Callout>
        </div>
      )
    }

    return (
      <p className="mt-1.5 text-2xs text-[var(--fg-subtle)]" role="status">
        {translate('chat.turn.status.completed')}
        {reason ? ` · ${translate('chat.turn.reason')}: ${reason}` : ''}
      </p>
    )
  }

  if (message.turnStatus === 'failed') {
    return (
      <div className="mt-2" role="alert">
        <Callout tone="danger" title={translate('chat.turn.failed.title')}>
          {message.turnError
            ? turnErrorLabel(message.turnError.code)
            : translate('chat.turn.error.internal_error')}
          {reason && (
            <span className="mt-1 block">
              {translate('chat.turn.reason')}: {reason}
            </span>
          )}
        </Callout>
      </div>
    )
  }

  if (message.turnStatus === 'cancelled') {
    return (
      <div className="mt-2" role="status" aria-live="polite">
        <Callout tone="warning" title={translate('chat.turn.cancelled.title')}>
          {reason && (
            <span>
              {translate('chat.turn.reason')}: {reason}
            </span>
          )}
        </Callout>
      </div>
    )
  }

  if (message.turnStatus === 'pending') {
    return (
      <div className="mt-2" role="status" aria-live="polite">
        <Callout tone="warning" title={translate('chat.turn.pending.title')}>
          {translate('chat.turn.pending.summary')}
        </Callout>
      </div>
    )
  }

  return (
    <div className="mt-2" role="status">
      <Callout tone="neutral" title={translate('chat.turn.legacy.title')}>
        {translate('chat.turn.legacy.summary')}
      </Callout>
    </div>
  )
}

function turnStatusTone(
  status: TurnStatus | null,
): 'green' | 'yellow' | 'red' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'green'
    case 'pending':
    case 'cancelled':
      return 'yellow'
    case 'failed':
      return 'red'
    default:
      return 'neutral'
  }
}

function turnStatusLabel(status: TurnStatus | null): string {
  switch (status) {
    case 'pending':
      return translate('chat.turn.status.pending')
    case 'completed':
      return translate('chat.turn.status.completed')
    case 'failed':
      return translate('chat.turn.status.failed')
    case 'cancelled':
      return translate('chat.turn.status.cancelled')
    default:
      return translate('chat.turn.status.legacy')
  }
}

function turnErrorLabel(code: TurnErrorCode): string {
  switch (code) {
    case 'ollama_unavailable':
      return translate('chat.turn.error.ollama_unavailable')
    case 'ollama_connect_timeout':
      return translate('chat.turn.error.ollama_connect_timeout')
    case 'ollama_load_timeout':
      return translate('chat.turn.error.ollama_load_timeout')
    case 'ollama_stream_idle_timeout':
      return translate('chat.turn.error.ollama_stream_idle_timeout')
    case 'upstream_error':
      return translate('chat.turn.error.upstream_error')
    case 'runtime_protocol':
      return translate('chat.turn.error.runtime_protocol')
    case 'storage_error':
      return translate('chat.turn.error.storage_error')
    case 'internal_error':
      return translate('chat.turn.error.internal_error')
  }
}

function turnStopReasonLabel(reason: TurnStopReason): string {
  switch (reason) {
    case 'stop':
      return translate('chat.turn.reason.stop')
    case 'length':
      return translate('chat.turn.reason.length')
    case 'tool_calls':
      return translate('chat.turn.reason.tool_calls')
    case 'tool_limit':
      return translate('chat.turn.reason.tool_limit')
    case 'stopped_by_user':
      return translate('chat.turn.reason.stopped_by_user')
    case 'connection_aborted':
      return translate('chat.turn.reason.connection_aborted')
    case 'provider_error':
      return translate('chat.turn.reason.provider_error')
    case 'protocol_error':
      return translate('chat.turn.reason.protocol_error')
    case 'storage_error':
      return translate('chat.turn.reason.storage_error')
    case 'internal_error':
      return translate('chat.turn.reason.internal_error')
    case 'legacy_terminal_chunk':
      return translate('chat.turn.reason.legacy_terminal_chunk')
    case 'error':
      return translate('chat.turn.reason.error')
  }
}

export function StreamingMessage({
  buffer,
  phase,
  retainedAfterFailure,
  toolCalls,
  onChange,
}: {
  buffer: StreamBuffer
  phase: TurnPhase
  retainedAfterFailure: boolean
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
        <span role="status" aria-live="polite" aria-atomic="true">
          <Badge tone={phase === 'awaiting_approval' ? 'yellow' : 'accent'}>
            {retainedAfterFailure
              ? translate('chat.turn.status.livePartial')
              : phaseLabel(phase)}
          </Badge>
        </span>
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
      ) : retainedAfterFailure ? (
        <p className="text-xs text-[var(--fg-muted)]">
          {translate('chat.turn.livePartial.noContent')}
        </p>
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
  inputRef,
  disabled,
  decisionOpen,
  phase,
  isStreaming,
  agentMode,
  autoApprove,
  onAutoApprove,
  onSend,
  onStop,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
  decisionOpen: boolean
  phase: TurnPhase
  isStreaming: boolean
  agentMode: boolean
  autoApprove: boolean
  onAutoApprove: (next: boolean) => void
  onSend: (
    intent: ChatSendIntent,
  ) => Promise<'conflict' | 'dispatched' | 'ignored'>
  onStop: () => Promise<void>
}) {
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)

  const submit = async () => {
    const trimmed = content.trim()
    if (!trimmed || isStreaming || disabled || decisionOpen || sending) return
    setSending(true)
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      setSending(false)
    }
    const result = await onSend({
      content: trimmed,
      idempotencyKey: crypto.randomUUID(),
      onAccepted: () => {
        setContent('')
        finish()
      },
      onRejected: finish,
    })
    if (result === 'conflict' || result === 'ignored') {
      setSending(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Textarea
        ref={inputRef}
        value={content}
        rows={3}
        disabled={disabled || isStreaming || decisionOpen}
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
              disabled={disabled || decisionOpen || !content.trim()}
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

function ThreadSidebar({
  currentId,
  projectId,
}: {
  currentId: string | null
  projectId: string | null
}) {
  const threads = useAsync(
    async (signal) => {
      const result = projectId
        ? await api.listProjectChats(projectId, signal)
        : await api.listProjectlessChats(signal)
      return { threads: result.chats }
    },
    [currentId, projectId],
  )

  return (
    <aside className="hidden min-h-0 overflow-y-auto p-2 md:block">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="text-2xs font-semibold text-[var(--fg-muted)]">
          {projectId ? translate('projects.chats.group') : translate('projects.chats.projectless')}
        </span>
        <Link
          to={projectId ? paths.projectChat(projectId) : paths.chat()}
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
              to={projectId ? paths.projectChat(projectId, thread.id) : paths.chat(thread.id)}
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
