/**
 * Экран диалога: список тредов, история/стрим и панель контекста.
 *
 * Сервер остаётся источником истины. Стрим показывает живой ответ, а после done
 * useChat перечитывает сохранённую историю целиком.
 */
import {
  createContext,
  useContext,
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
  ContextCheckpoint,
  Health,
  Message,
  ThreadMode,
  TurnErrorCode,
  TurnStatus,
  TurnStopReason,
  Workspace,
} from '@guanxi/contract'
import {
  DEFAULT_AGENT_TEMPERATURE,
  DEFAULT_CHAT_NUM_CTX,
  DEFAULT_NUM_CTX,
  DEFAULT_TEMPERATURE,
  parseChatModelSelection,
} from '@guanxi/contract'
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
import { formatInteger, formatRelativeTime, formatTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { PRODUCT_NAME } from '../../lib/brand.ts'
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
import { ChatRetentionInfo } from './ChatRetentionInfo.tsx'
import {
  ResourceConflictDialog,
  useResourceConflictDecision,
  type ChatSendIntent,
} from './ResourceConflictDecision.tsx'

const WorkspaceChatContext = createContext(false)

export function ChatPage({
  threadId,
  projectId = null,
  health,
  workspace = false,
}: {
  threadId: string | null
  projectId?: string | null
  health: Health
  workspace?: boolean
}) {
  return <WorkspaceChatContext.Provider value={workspace}>{threadId ? <ThreadPage threadId={threadId} projectId={projectId} health={health} /> : <NewThreadPage projectId={projectId} />}</WorkspaceChatContext.Provider>
}

/* ───────────────────────────── Новый тред ─────────────────────────────── */

function NewThreadPage({ projectId }: { projectId: string | null }) {
  const inWorkspace = useContext(WorkspaceChatContext)
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
  // Once creation starts or fails, a still-pending initial focus must not
  // take focus away from what the user is acting on.
  const initialFocusSuppressedRef = useRef(false)

  useEffect(() => {
    if (!createError) return
    initialFocusSuppressedRef.current = true
    createErrorRef.current?.focus()
  }, [createError])

  useEffect(() => {
    const target = projectId && projectContext.data
      ? projectHeadingRef
      : projectId && projectContext.error
        ? projectContextErrorRef
        : null
    if (!target) return
    const frame = requestAnimationFrame(() => {
      if (!initialFocusSuppressedRef.current) target.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
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
  const providerModels = useAsync(signal => api.chatModels(signal), [])
  useEffect(() => {
    const timer = setInterval(providerModels.reload, 15_000)
    const refresh = () => providerModels.reload()
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [providerModels.reload])
  const providerGroups = mode === 'chat' ? providerModels.data?.groups ?? [] : []
  const providerSelected = providerGroups.some(group => group.models.some(item => item.selection === model))
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
    const providerInvalid = parseChatModelSelection(model) && (mode === 'agent' || !providerModels.loading && !providerSelected)
    if (model && !providerInvalid) return
    if (providerInvalid) setModel('')
    if (availableModels.length === 0) {
      const first = providerGroups[0]?.models[0]?.selection
      if (first) setModel(first)
      return
    }
    const preferred = settings.data?.defaultModel
    setModel(
      (preferred && !parseChatModelSelection(preferred) && availableModels.some((item) => item.name === preferred)
        ? preferred
        : availableModels.find((item) => !item.capabilities.includes('embedding'))?.name) ??
        availableModels[0]?.name ??
        '',
    )
  }, [availableModels, providerGroups, providerModels.loading, providerSelected, model, mode, settings.data?.defaultModel])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (creatingRef.current || !model || contextBlocked || contextInputInvalid) return

    creatingRef.current = true
    initialFocusSuppressedRef.current = true
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
        inWorkspace ? paths.workspace(thread.id, projectId) : projectId ? paths.projectChat(projectId, thread.id) : paths.chat(thread.id),
        { replace: true },
      )
    } catch (error) {
      setCreateError(errorMessage(error))
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
        <p className="mt-2 break-words text-xs text-secondary">
          {errorMessage(projectContext.error)}
        </p>
        <Button className="mt-3" onClick={projectContext.reload}>{translate('projects.retry')}</Button>
      </div>
    )
  }

  const project = projectContext.data?.project ?? null

  return (
    <div className={inWorkspace ? 'workspace-chat-content' : 'mx-auto grid w-full min-w-0 max-w-6xl gap-5 px-4 py-5 sm:px-5 md:grid-cols-[240px_minmax(0,1fr)]'}>
      {!inWorkspace && <ThreadSidebar currentId={null} projectId={projectId} />}

      <section className="surface min-w-0 rounded-xl p-4">
        <h1
          ref={project ? projectHeadingRef : undefined}
          tabIndex={project ? -1 : undefined}
          className="break-words text-base font-semibold outline-none"
        >
          {project
            ? translate('projects.chats.newFor', { name: project.name })
            : translate('chat.create.title')}
        </h1>
        <p className="mt-0.5 mb-4 text-xs text-secondary">
          {projectId
            ? translate('projects.chats.newDescription')
            : translate('chat.create.description')}
        </p>

        {createError && (
          <div ref={createErrorRef} tabIndex={-1} className="mb-3 outline-none">
            <Callout
              tone="danger"
              title={projectId ? translate('projects.chats.createError') : translate('chat.create.error')}
            >
              {createError}
            </Callout>
          </div>
        )}

        {inWorkspace && <aside className="workspace-dock-lanes" aria-label={translate('workspaceLayout.dockLanes')}>{translate('workspaceLayout.lanesEmpty')}</aside>}
        <form onSubmit={create} className="w-full min-w-0 max-w-xl space-y-4">
          {!projectId && <fieldset>
            <legend className="mb-1.5 text-xs font-medium">{translate('chat.create.mode')}</legend>
            <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2">
              <ModeButton
                active={mode === 'chat'}
                title={translate('chat.create.mode.chat')}
                description={translate('chat.create.mode.chatHint')}
                onClick={() => setMode('chat')}
              />
              <ModeButton
                active={mode === 'agent'}
                title={translate('chat.create.mode.agent')}
                description={translate('chat.create.mode.agentHint')}
                onClick={() => setMode('agent')}
              />
            </div>
          </fieldset>}

          <label className="block">
            <span className="mb-1 block text-xs font-medium">{translate('chat.create.model')}</span>
            {models.loading && providerGroups.length === 0 ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <Select
                value={model}
                onChange={setModel}
                ariaLabel={translate('chat.create.modelAria')}
                options={availableModels.map((item) => ({
                  value: item.name,
                  label: item.name,
                  group: translate('chat.models.local'), groupId: 'ollama',
                  disabled: item.capabilities.includes('embedding'),
                })).concat(providerGroups.flatMap(group => group.models.map(item => ({
                  value: item.selection, label: item.modelId, group: group.label, groupId: group.id, disabled: false,
                }))))}
              />
            )}
            {models.error !== null && (
              <p className="mt-1 text-2xs text-danger">{errorMessage(models.error)}</p>
            )}
            {providerModels.error !== null && availableModels.length === 0 && !providerSelected && <p role="status" className="mt-1 text-12 text-muted">{translate('chat.models.unavailable')}</p>}
            {selectedModel && mode === 'chat' ? (
              <p className="mt-1 text-2xs text-muted" role="status" aria-live="polite">
                {prewarmLabel(prewarm)}
              </p>
            ) : null}
          </label>

          {contextBlocked && selectedModel?.contextLimit.state === 'declared' ? (
            <Callout tone="danger" title={translate('context.limit.exceeded')}>
              {translate('context.limit.declared')}: {' '}
              {formatInteger(selectedModel.contextLimit.value)} · {' '}
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
              <span className="mb-1 block text-xs font-medium">{translate('chat.create.workspace')}</span>
              <Select
                value={workspaceId}
                onChange={setWorkspaceId}
                ariaLabel={translate('chat.create.workspaceAria')}
                options={[
                  { value: '', label: translate('chat.create.workspaceNone') },
                  ...(workspaces.data?.workspaces ?? []).map((workspace) => ({
                    value: workspace.id,
                    label: workspace.exists
                      ? `${workspace.name} · ${workspace.rootPath}`
                      : translate('chat.create.workspaceMissing', { name: workspace.name }),
                    disabled: !workspace.exists,
                  })),
                ]}
              />
              <p className="mt-1 text-2xs text-muted">
                {translate('chat.create.workspaceHint')}
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
              {translate('chat.create.submit')}
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
          ? 'border-accent bg-accent/5.5'
          : 'border-divider hover:bg-inset',
      )}
    >
      <span className="block text-xs font-semibold">{title}</span>
      <span className="mt-0.5 block break-words text-2xs text-secondary">
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
  const inWorkspace = useContext(WorkspaceChatContext)
  const chat = useChat(threadId, projectId)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const loadErrorHeadingRef = useRef<HTMLHeadingElement>(null)
  const workspaces = useAsync(
    (signal) => projectId ? Promise.resolve({ workspaces: [] }) : api.listWorkspaces(signal),
    [chat.thread?.workspaceId, projectId],
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [autoApprove, setAutoApprove] = useLocalStorage('guanxi.autoApproveTurn', false)
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
  const resourceDecision = useResourceConflictDecision(dispatchChat, !parseChatModelSelection(chat.thread?.model ?? ''))

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
      <div className={inWorkspace ? 'workspace-chat-content' : 'grid h-full md:grid-cols-[240px_minmax(0,1fr)]'}>
        {!inWorkspace && <ThreadSidebar currentId={threadId} projectId={projectId} />}
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
          {projectId ? translate('projects.chats.safeState') : translate('chat.open.error')}
        </h1>
        <p className="mt-2 break-words text-xs text-secondary">
          {errorMessage(chat.loadError)}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={chat.reload}>{translate('projects.retry')}</Button>
          {projectId && <Link to={paths.projects()} className="text-xs text-accent underline">{translate('projects.chats.back')}</Link>}
        </div>
      </div>
    )
  }

  return (
    <div className={inWorkspace ? 'workspace-chat-content' : 'grid h-full min-h-0 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]'}>
      {!inWorkspace && <ThreadSidebar currentId={threadId} projectId={projectId} />}

      <section className="flex min-h-0 min-w-0 flex-col border-l border-divider">
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-divider px-3 py-1.5">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xs font-semibold">{chat.thread.title}</h1>
              <Badge tone={chat.thread.mode === 'agent' ? 'accent' : 'neutral'}>
                {chat.thread.mode === 'agent' ? translate('chat.mode.agent') : translate('chat.mode.chat')}
              </Badge>
            </div>
            {chat.project && (
              <Link
                to={paths.projects()}
                className="mt-0.5 block max-w-full truncate text-2xs text-accent underline underline-offset-2"
              >
                {translate('projects.chats.context', { name: chat.project.name })}
              </Link>
            )}
            <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted">
              <span className="truncate font-mono">{parseChatModelSelection(chat.thread.model)?.modelId ?? chat.thread.model}</span>
              <ContextChip context={chat.context} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {chat.thread.mode === 'chat' && (
              <ChatRetentionInfo
                chatId={chat.thread.id}
                chatTitle={chat.thread.title}
                projectId={projectId}
              />
            )}
            {chat.thread.mode === 'agent' && (
              <WorkspaceChip workspace={workspace} onClick={() => setPickerOpen(true)} />
            )}
            <Link
              to={paths.inspector(chat.thread.id)}
              className="flex h-6 items-center rounded-control border border-divider px-2 text-12 font-label text-secondary hover:bg-inset hover:text-foreground"
            >
              {translate('inspector.openTrace')}
            </Link>
            <Link
              to={inWorkspace ? paths.workspace(null, projectId) : projectId ? paths.projectChat(projectId) : paths.chat()}
              className="flex h-6 items-center rounded-[5px] border border-control px-2 text-2xs font-medium hover:bg-inset"
            >
              {translate('chat.new')}
            </Link>
          </div>
        </header>

        <MessageTimeline
          messages={chat.messages}
          contextCheckpoints={chat.contextCheckpoints}
          buffer={chat.buffer}
          phase={chat.phase}
          liveOutputRetained={chat.liveOutputRetained}
          liveToolCalls={chat.liveToolCalls}
          streamError={chat.streamError?.message ?? null}
        />

        <div className="border-t border-divider bg-canvas p-2.5">
          <div className="mb-2 xl:hidden">
            <details className="rounded-md border border-divider">
              <summary className="cursor-pointer px-2 py-1 text-2xs font-medium text-secondary">
                {translate('chat.contextAndSpeed')}
              </summary>
              <div className="h-80 max-h-[45vh] overflow-hidden border-t border-divider">
                <ContextPanel
                  context={chat.context}
                  usage={chat.usage}
                  compacting={chat.compacting}
                  onCompact={chat.compact}
                  disabled={chat.isStreaming}
                />
              </div>
            </details>
          </div>

          {inWorkspace && <aside className="workspace-dock-lanes" aria-label={translate('workspaceLayout.dockLanes')}>{translate('workspaceLayout.lanesEmpty')}</aside>}
          <Composer
            inputRef={composerRef}
            disabled={!health.ollama.running && !parseChatModelSelection(chat.thread?.model ?? '')}
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

      {!inWorkspace && <aside className="hidden min-h-0 border-l border-divider xl:block">
        <ContextPanel
          context={chat.context}
          usage={chat.usage}
          compacting={chat.compacting}
          onCompact={chat.compact}
          disabled={chat.isStreaming}
        />
      </aside>}

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

export function MessageTimeline({
  messages,
  contextCheckpoints,
  buffer,
  phase,
  liveOutputRetained,
  liveToolCalls,
  streamError,
}: {
  messages: Message[]
  contextCheckpoints: ContextCheckpoint[]
  buffer: StreamBuffer
  phase: TurnPhase
  liveOutputRetained: boolean
  liveToolCalls: ReturnType<typeof useChat>['liveToolCalls']
  streamError: string | null
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const latestCheckpointRef = useRef<HTMLElement>(null)
  const previousCheckpointCountRef = useRef(contextCheckpoints.length)
  const showLive = phase !== 'idle' || liveOutputRetained
  const scrollToEnd = useCallback(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [])

  useEffect(() => {
    scrollToEnd()
  }, [messages.length, contextCheckpoints.length, phase, liveToolCalls.length, scrollToEnd])

  useEffect(() => {
    if (contextCheckpoints.length > previousCheckpointCountRef.current) {
      requestAnimationFrame(() => latestCheckpointRef.current?.focus())
    }
    previousCheckpointCountRef.current = contextCheckpoints.length
  }, [contextCheckpoints.length])

  const checkpointsAfterMessage = new Map<number, ContextCheckpoint[]>()
  for (const checkpoint of contextCheckpoints) {
    const legacyPosition = messages.findIndex((message) => message.id === checkpoint.id) + 1
    const position = checkpoint.source.messageCount ?? Math.max(0, legacyPosition)
    const positioned = checkpointsAfterMessage.get(position) ?? []
    positioned.push(checkpoint)
    checkpointsAfterMessage.set(position, positioned)
  }
  const latestCheckpointId = contextCheckpoints.at(-1)?.id ?? null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
      <div className="mx-auto max-w-3xl space-y-4">
        {messages.length === 0 && !showLive && (
          <EmptyState
            title={translate('chat.empty.title')}
            description={translate('chat.empty.description')}
          />
        )}

        {(checkpointsAfterMessage.get(0) ?? []).map((checkpoint) => (
          <ContextCheckpointMarker
            key={`checkpoint:${checkpoint.id}`}
            checkpoint={checkpoint}
            ref={checkpoint.id === latestCheckpointId ? latestCheckpointRef : undefined}
          />
        ))}

        {messages.flatMap((message, index) => [
          ...(message.isCompaction ? [] : [<MessageView key={message.id} message={message} />]),
          ...(checkpointsAfterMessage.get(index + 1) ?? []).map((checkpoint) => (
            <ContextCheckpointMarker
              key={`checkpoint:${checkpoint.id}`}
              checkpoint={checkpoint}
              ref={checkpoint.id === latestCheckpointId ? latestCheckpointRef : undefined}
            />
          )),
        ])}

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
            <Callout tone="danger" title={translate('chat.generation.interrupted')}>
              {streamError}
            </Callout>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function ContextCheckpointMarker({
  checkpoint,
  ref,
}: {
  checkpoint: ContextCheckpoint
  ref?: React.Ref<HTMLElement>
}) {
  const evidence =
    checkpoint.source.state === 'source_preserved'
      ? translate('chat.checkpoint.preserved')
          .replace('{count}', String(checkpoint.source.messageCount))
          .replace('{sequence}', String(checkpoint.source.upToSeq))
      : translate('chat.checkpoint.legacy')

  return (
    <article
      ref={ref}
      tabIndex={-1}
      aria-label={translate('chat.checkpoint.title')}
      className="rounded-lg border border-[var(--color-fit-yellow)]/45 bg-[var(--color-fit-yellow)]/8 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
      data-context-checkpoint={checkpoint.id}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Badge tone="yellow">{translate('chat.checkpoint.title')}</Badge>
        <span className="text-2xs text-muted">
          {formatTime(checkpoint.createdAt)}
        </span>
      </div>
      <p className="mb-2 text-2xs text-secondary">{evidence}</p>
      <Markdown source={checkpoint.summary.content} />
    </article>
  )
}

export function MessageView({ message }: { message: Message }) {
  if (message.role === 'system') {
    return (
      <div className="rounded-lg border border-divider bg-inset px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <Badge tone={message.isCompaction ? 'yellow' : 'neutral'}>
            {message.isCompaction ? translate('chat.message.summary') : translate('chat.message.system')}
          </Badge>
          <span className="text-2xs text-secondary">{formatTime(message.createdAt)}</span>
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
            ? 'rounded-xl rounded-br-sm bg-accent/10 px-3 py-2'
            : 'w-full',
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-2xs text-secondary">
          <span>{user ? translate('chat.role.you') : message.role === 'assistant' ? PRODUCT_NAME : translate('chat.role.tool')}</span>
          <span>{formatTime(message.createdAt)}</span>
          {message.usage?.cacheHit && <Badge tone="green">{translate('chat.cache.badge')}</Badge>}
          {message.role === 'assistant' && (
            <Badge tone={turnStatusTone(message.turnStatus)}>
              {turnStatusLabel(message.turnStatus)}
            </Badge>
          )}
        </div>

        {message.thinking && (
          <details className="mb-2 rounded border border-divider bg-inset">
            <summary className="cursor-pointer px-2 py-1 text-2xs text-secondary">
              {translate('chat.reasoning.model')}
            </summary>
            <div className="border-t border-divider px-2 py-1.5 text-xs whitespace-pre-wrap text-secondary">
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
      <p className="mt-1.5 text-2xs text-muted" role="status">
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
    <article>
      <div className="mb-1 flex items-center gap-2 text-2xs text-muted">
        <span>{PRODUCT_NAME}</span>
        <span role="status" aria-live="polite" aria-atomic="true">
          <Badge tone={phase === 'awaiting_approval' ? 'yellow' : 'accent'}>
            {retainedAfterFailure
              ? translate('chat.turn.status.livePartial')
              : phaseLabel(phase)}
          </Badge>
        </span>
      </div>

      {snapshot.thinking && (
        <details open className="mb-2 rounded border border-divider bg-inset">
          <summary className="cursor-pointer px-2 py-1 text-2xs text-secondary">
            {translate('chat.reasoning.model')}
          </summary>
          <div className="border-t border-divider px-2 py-1.5 text-xs whitespace-pre-wrap text-secondary">
            {snapshot.thinking}
          </div>
        </details>
      )}

      {snapshot.content ? (
        <Markdown source={snapshot.content} className={phase === 'generating' ? 'stream-caret' : ''} />
      ) : retainedAfterFailure ? (
        <p className="text-xs text-secondary">
          {translate('chat.turn.livePartial.noContent')}
        </p>
      ) : (
        <p className="anim-pulse-soft text-xs text-secondary">
          {phase === 'prefill' ? translate('chat.stream.prefill') : translate('chat.stream.preparing')}
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
            ? translate('chat.composer.ollamaRequired')
            : agentMode
              ? translate('chat.composer.agentPlaceholder')
              : translate('chat.composer.placeholder')
        }
        aria-label={translate('chat.composer.message')}
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
              label={translate('chat.composer.autoApprove')}
              hint={translate('chat.composer.autoApproveHint')}
            />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-2xs text-muted sm:inline">
            {translate('chat.composer.shortcut')}
          </span>
          {isStreaming ? (
            <Button variant="danger" onClick={() => void onStop()}>
              {translate('chat.composer.stop', { phase: phaseLabel(phase) })}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void submit()}
              loading={sending}
              disabled={disabled || decisionOpen || !content.trim()}
            >
              {translate('chat.composer.send')}
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
  const inWorkspace = useContext(WorkspaceChatContext)
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
        <span className="text-2xs font-semibold text-secondary">
          {projectId ? translate('projects.chats.group') : translate('projects.chats.projectless')}
        </span>
        <Link
          to={inWorkspace ? paths.workspace(null, projectId) : projectId ? paths.projectChat(projectId) : paths.chat()}
          className="rounded px-1.5 py-0.5 text-2xs text-accent hover:bg-accent/10 hover:text-secondary"
        >
          {translate('chat.history.new')}
        </Link>
      </div>

      {threads.loading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : threads.error ? (
        <p className="px-1 text-2xs text-danger">{errorMessage(threads.error)}</p>
      ) : (threads.data?.threads.length ?? 0) === 0 ? (
        <p className="px-1 py-3 text-2xs text-muted">{translate('chat.history.empty')}</p>
      ) : (
        <nav aria-label={translate('chat.history.navigation')} className="space-y-0.5">
          {threads.data?.threads.map((thread) => (
            <Link
              key={thread.id}
              to={inWorkspace ? paths.workspace(thread.id, projectId) : projectId ? paths.projectChat(projectId, thread.id) : paths.chat(thread.id)}
              aria-current={thread.id === currentId ? 'page' : undefined}
              className={cx(
                'block rounded-md px-2 py-1.5',
                thread.id === currentId
                  ? 'bg-inset'
                  : 'hover:bg-inset',
              )}
            >
              <span className="block truncate text-xs font-medium">{thread.title}</span>
              <span className="mt-0.5 flex items-center justify-between gap-2 text-2xs text-secondary">
                <span className="truncate">{thread.mode === 'agent' ? translate('chat.mode.agent') : parseChatModelSelection(thread.model)?.modelId ?? thread.model}</span>
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
    idle: translate('chat.phase.idle'),
    sending: translate('chat.phase.sending'),
    prefill: translate('chat.phase.prefill'),
    thinking: translate('chat.phase.thinking'),
    generating: translate('chat.phase.generating'),
    tools: translate('chat.phase.tools'),
    awaiting_approval: translate('chat.phase.awaitingApproval'),
    finalizing: translate('chat.phase.finalizing'),
  }
  return labels[phase]
}
