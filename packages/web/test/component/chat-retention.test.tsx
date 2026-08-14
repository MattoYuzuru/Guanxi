import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRetentionProjection, ListReasoningArtifactsResponse } from '@alamo/contract'
import { ChatRetentionInfo } from '../../src/features/chat/ChatRetentionInfo.tsx'
import { api } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const ACTIVITY_AT = '2026-08-11T10:00:00.000Z'
const EXPIRES_AT = '2026-08-18T10:00:00.000Z'
const ARTIFACT_EXPIRES_AT = '2026-08-20T10:00:00.000Z'
const TTL: ChatRetentionProjection = {
  retentionVersion: 1,
  chatId: 'chat-1',
  projectId: null,
  policy: { mode: 'ttl', expiresAfterDays: 7 },
  policySource: 'default',
  policyUpdatedAt: ACTIVITY_AT,
  lastUserActivity: { at: ACTIVITY_AT, source: 'chat_created' },
  expiresAt: EXPIRES_AT,
  expirySource: 'server_calculated',
  enforcement: 'rolling_ttl_trash',
}
const SESSION: ChatRetentionProjection = {
  ...TTL,
  policy: { mode: 'session' },
  policySource: 'user',
  expiresAt: null,
  expirySource: 'policy_without_time_expiry',
}
const REASONING: ListReasoningArtifactsResponse = {
  artifactVersion: 1,
  enforcementVersion: 1,
  enforcement: {
    state: 'active',
    owner: 'server_maintenance',
    boundary: 'reasoning_artifacts_only',
    inclusiveDueBoundary: true,
  },
  chatId: 'chat-1',
  scope: 'projectless',
  projectId: null,
  generatedAnswers: [{
    messageId: 'message-1',
    jobId: '11111111-1111-4111-8111-111111111111',
    createdAt: ACTIVITY_AT,
    byteSize: 12,
  }],
  artifacts: [{
    artifactVersion: 1,
    id: '22222222-2222-4222-8222-222222222222',
    type: 'reasoning',
    mediaType: 'text/markdown; charset=utf-8',
    storageKind: 'sqlite_text',
    byteSize: 15,
    checksum: `sha256:${'a'.repeat(64)}`,
    createdAt: ACTIVITY_AT,
    source: {
      chatId: 'chat-1',
      messageId: 'message-1',
      jobId: '11111111-1111-4111-8111-111111111111',
    },
    ownership: { scope: 'projectless', projectId: null },
    retention: {
      basis: 'diagnostic_7_days',
      expiresAfterDays: 7,
      artifactExpiresAt: ARTIFACT_EXPIRES_AT,
      parentMode: 'ttl',
      parentExpiresAt: EXPIRES_AT,
      effectiveExpiresAt: EXPIRES_AT,
      relationship: 'shorter_parent_retention_wins',
      automaticDeletion: 'server_maintenance_active',
    },
  }],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  setActiveLocale('ru')
  vi.spyOn(api, 'getChatRetention').mockResolvedValue(TTL)
  vi.spyOn(api, 'listReasoningArtifacts').mockResolvedValue(REASONING)
})

describe('Chat retention info', () => {
  it('offers explicit Session leave only for saved Session policy and restores focus on cancel/Escape', async () => {
    vi.mocked(api.getChatRetention).mockResolvedValue(SESSION)
    vi.spyOn(api, 'leaveSessionChat')
    vi.spyOn(api, 'updateChatRetention').mockResolvedValue(TTL)
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Session" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    const leave = await screen.findByRole('button', { name: 'Завершить сессию' })
    fireEvent.click(leave)
    const confirm = screen.getByRole('button', { name: 'Подтвердить выход' })
    await waitFor(() => expect(confirm).toBe(document.activeElement))
    expect(screen.getByText(/Перезагрузка, переподключение и закрытие вкладки этого не делают/u)).toBeTruthy()
    expect((screen.getByRole('radio', { name: '7 дней' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Сохранить retention' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(confirm, { key: 'Escape' })
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Завершить сессию' }),
    ).toBe(document.activeElement))
    expect(screen.queryByRole('button', { name: 'Подтвердить выход' })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: '7 дней' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить retention' }))
    await waitFor(() => expect(api.updateChatRetention).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Завершить сессию' })).toBeNull()
    expect(api.leaveSessionChat).not.toHaveBeenCalled()
  })

  it('coalesces exact scoped leave, shows blocked state and retries the same command after failure', async () => {
    const mutation = deferred<Awaited<ReturnType<typeof api.leaveSessionChat>>>()
    vi.mocked(api.getChatRetention).mockResolvedValue({ ...SESSION, projectId: 'project-a' })
    vi.spyOn(api, 'leaveSessionChat')
      .mockReturnValueOnce(mutation.promise)
      .mockRejectedValueOnce(new Error('safe leave failure'))
      .mockResolvedValueOnce({
        leaveVersion: 1,
        chatId: 'chat-1',
        projectId: 'project-a',
        state: 'blocked_active_job',
        leaveBasis: { at: ACTIVITY_AT, source: 'explicit_user_action' },
        activeJobCount: 1,
        recoveryDeadline: null,
        hardDeletion: 'session_metadata_after_recovery',
      })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Project Session" projectId="project-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Завершить сессию' }))
    const confirm = screen.getByRole('button', { name: 'Подтвердить выход' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(api.leaveSessionChat).toHaveBeenCalledTimes(1)
    expect(api.leaveSessionChat).toHaveBeenCalledWith('chat-1', {
      leaveVersion: 1,
      chatId: 'chat-1',
      scope: 'project',
      projectId: 'project-a',
    })
    await act(async () => mutation.reject(new Error('safe leave failure')))
    expect(await screen.findByText('safe leave failure')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить retention' }))
    expect(await screen.findByText('safe leave failure')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить retention' }))
    const result = (await screen.findByText(
      'Выход зафиксирован; активная работа должна завершиться',
    )).closest('[role="status"]')!
    await waitFor(() => expect(result).toBe(document.activeElement))
    expect(api.leaveSessionChat).toHaveBeenCalledTimes(3)
    for (const call of vi.mocked(api.leaveSessionChat).mock.calls) {
      expect(call).toEqual(['chat-1', {
        leaveVersion: 1,
        chatId: 'chat-1',
        scope: 'project',
        projectId: 'project-a',
      }])
    }
  })

  it('shows exact recovery deadline and scheduled Session metadata deletion after leave', async () => {
    vi.mocked(api.getChatRetention).mockResolvedValue(SESSION)
    vi.spyOn(api, 'leaveSessionChat').mockResolvedValue({
      leaveVersion: 1,
      chatId: 'chat-1',
      projectId: null,
      state: 'trash',
      leaveBasis: { at: ACTIVITY_AT, source: 'explicit_user_action' },
      activeJobCount: 0,
      recoveryDeadline: EXPIRES_AT,
      hardDeletion: 'session_metadata_after_recovery',
    })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Session" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Завершить сессию' }))
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить выход' }))
    const result = (await screen.findByText(
      'Чат-сессия перемещён в Корзину',
    )).closest('[role="status"]')!
    await waitFor(() => expect(result).toBe(document.activeElement))
    expect(document.querySelector(`time[datetime="${EXPIRES_AT}"]`)).toBeTruthy()
    expect(screen.getAllByText(/Metadata сессии удаляется после 24-часового срока восстановления/u)).toHaveLength(1)
    expect(screen.getAllByText(/Удаление metadata сессии запланировано после 24-часового срока восстановления/u)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Завершить сессию' })).toBeNull()
  })

  it('reloads durable pending leave with English fallback and no duplicate leave affordance', async () => {
    setActiveLocale('en')
    vi.mocked(api.getChatRetention).mockResolvedValue({
      ...SESSION,
      sessionLeave: {
        at: ACTIVITY_AT,
        source: 'explicit_user_action',
        state: 'pending_maintenance',
        activeJobCount: 0,
      },
    })
    vi.spyOn(api, 'leaveSessionChat')
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Pending Session" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
    expect(await screen.findByText('Leave recorded; waiting for Maintenance')).toBeTruthy()
    expect(document.querySelector(`time[datetime="${ACTIVITY_AT}"]`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Leave session' })).toBeNull()
    expect(api.leaveSessionChat).not.toHaveBeenCalled()
  })

  it('shows sourced policy/expiry and truthfully separates configuration from enforcement', async () => {
    const reasoningLoad = deferred<ListReasoningArtifactsResponse>()
    vi.mocked(api.listReasoningArtifacts).mockReturnValue(reasoningLoad.promise)
    render(<ChatRetentionInfo chatId="chat-1" chatTitle={'Ч'.repeat(120)} projectId={null} />)
    const trigger = screen.getByRole('button', { name: 'Информация о чате' })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Хранение чата' })
    expect(api.getChatRetention).toHaveBeenCalledWith('chat-1', expect.any(AbortSignal))
    expect(dialog.textContent).toContain('7 дней')
    expect(dialog.textContent).toContain('основание — создание чата')
    expect(dialog.textContent).toContain('вычислено сервером')
    expect(dialog.textContent).toContain('Восстанавливаемое истечение применяется')
    expect(dialog.textContent).toContain('Metadata сессии удаляется после 24-часового срока восстановления')
    expect(dialog.querySelector(`time[datetime="${ACTIVITY_AT}"]`)).toBeTruthy()
    expect(dialog.querySelector(`time[datetime="${EXPIRES_AT}"]`)).toBeTruthy()
    expect(dialog.textContent).toContain('Ч'.repeat(120))
    expect(dialog.textContent).not.toContain('Автоматическое удаление применяется')
    await act(async () => reasoningLoad.resolve(REASONING))
    await screen.findByText('Результаты с рассуждениями')
    expect(dialog.textContent).toContain('Сгенерированные ответы')
    expect(dialog.textContent).toContain('Результаты с рассуждениями')
    expect(screen.getAllByText(/Автоматическое удаление применяется/u)).toHaveLength(1)
    expect(api.listReasoningArtifacts).toHaveBeenCalledWith(
      'chat-1',
      { artifactVersion: 1, enforcementVersion: 1, scope: 'projectless' },
      expect.any(AbortSignal),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки хранения чата' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toBe(document.activeElement)
  })

  it('coalesces repeated form activation into one isolated mutation', async () => {
    const mutation = deferred<ChatRetentionProjection>()
    vi.spyOn(api, 'updateChatRetention').mockReturnValue(mutation.promise)
    vi.mocked(api.listReasoningArtifacts)
      .mockResolvedValueOnce(REASONING)
      .mockResolvedValueOnce({
        ...REASONING,
        artifacts: REASONING.artifacts.map((artifact) => ({
          ...artifact,
          retention: {
            ...artifact.retention,
            parentMode: 'keep' as const,
            parentExpiresAt: null,
            effectiveExpiresAt: ARTIFACT_EXPIRES_AT,
          },
        })),
      })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Retention" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    await screen.findByRole('dialog')
    await screen.findByText('Восстанавливаемое истечение применяется')
    fireEvent.click(screen.getByRole('radio', { name: 'Хранить' }))
    const save = screen.getByRole('button', { name: 'Сохранить retention' })
    const form = save.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(api.updateChatRetention).toHaveBeenCalledTimes(1)
    expect(api.updateChatRetention).toHaveBeenCalledWith('chat-1', {
      retentionVersion: 1,
      policy: { mode: 'keep' },
    })

    await act(async () => mutation.resolve({
      ...TTL,
      policy: { mode: 'keep' },
      policySource: 'user',
      expiresAt: null,
      expirySource: 'policy_without_time_expiry',
    }))
    expect(screen.getByText((_, element) =>
      element?.tagName === 'DD' && element.textContent?.startsWith('Нет временного истечения') === true,
    )).toBeTruthy()
    expect(api.getChatRetention).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.listReasoningArtifacts).toHaveBeenCalledTimes(2))
    expect(document.querySelector(`time[datetime="${ARTIFACT_EXPIRES_AT}"]`)).toBeTruthy()
    expect(document.querySelector(`li time[datetime="${EXPIRES_AT}"]`)).toBeNull()
  })

  it('focuses a safe error, retries GET and rejects a mismatched Chat identity', async () => {
    vi.mocked(api.getChatRetention)
      .mockResolvedValueOnce({ ...TTL, chatId: 'chat-other', projectId: 'project-a' })
      .mockResolvedValueOnce({ ...TTL, projectId: 'project-a' })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Scoped" projectId="project-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    const error = await screen.findByText('Retention относится к другому Chat scope.')
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    fireEvent.click(screen.getByRole('button', { name: 'Повторить retention' }))
    await screen.findByText('Восстанавливаемое истечение применяется')
    expect(api.getChatRetention).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Retention относится к другому Chat scope.')).toBeNull()
  })

  it('retries a failed Save as the same PATCH without an extra GET', async () => {
    vi.spyOn(api, 'updateChatRetention')
      .mockRejectedValueOnce(new Error('safe write failure'))
      .mockResolvedValueOnce({
        ...TTL,
        policy: { mode: 'keep' },
        policySource: 'user',
        expiresAt: null,
        expirySource: 'policy_without_time_expiry',
      })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Retry" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    await screen.findByRole('dialog')
    fireEvent.click(await screen.findByRole('radio', { name: 'Хранить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить retention' }))
    const error = await screen.findByText('safe write failure')
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    fireEvent.click(screen.getByRole('button', { name: 'Повторить retention' }))
    await waitFor(() => expect(api.updateChatRetention).toHaveBeenCalledTimes(2))
    expect(api.updateChatRetention).toHaveBeenNthCalledWith(1, 'chat-1', {
      retentionVersion: 1,
      policy: { mode: 'keep' },
    })
    expect(api.updateChatRetention).toHaveBeenNthCalledWith(2, 'chat-1', {
      retentionVersion: 1,
      policy: { mode: 'keep' },
    })
    expect(api.getChatRetention).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched PATCH identity and recovers with GET without another mutation', async () => {
    vi.spyOn(api, 'updateChatRetention').mockResolvedValue({
      ...TTL,
      chatId: 'chat-other',
      policy: { mode: 'keep' },
      policySource: 'user',
      expiresAt: null,
      expirySource: 'policy_without_time_expiry',
    })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Scoped save" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    await screen.findByRole('dialog')
    fireEvent.click(await screen.findByRole('radio', { name: 'Хранить' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить retention' }))
    await screen.findByText('Retention относится к другому Chat scope.')
    expect(screen.queryByRole('button', { name: 'Сохранить retention' })).toBeNull()
    expect(document.querySelector(`form time[datetime="${EXPIRES_AT}"]`)).toBeNull()
    expect(api.updateChatRetention).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Повторить retention' }))
    await screen.findByText('Восстанавливаемое истечение применяется')
    expect(api.getChatRetention).toHaveBeenCalledTimes(2)
    expect(api.updateChatRetention).toHaveBeenCalledTimes(1)
  })

  it('uses English source/fallback copy', async () => {
    setActiveLocale('en')
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="English" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
    const dialog = await screen.findByRole('dialog', { name: 'Chat retention' })
    expect(dialog.textContent).toContain('Recoverable expiry is active')
    expect(dialog.textContent).toContain('calculated by the server')
    expect(dialog.textContent).toContain('Automatic deletion is active')
  })

  it('copies only exact scoped Artifact text and does not expose answer/prompt/tool data', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.spyOn(api, 'getReasoningArtifact').mockResolvedValue({
      ...REASONING.artifacts[0]!,
      content: 'private diagnostic',
    })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Copy" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    const copy = await screen.findByRole('button', { name: 'Копировать рассуждение' })
    fireEvent.click(copy)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('private diagnostic'))
    expect(api.getReasoningArtifact).toHaveBeenCalledWith(
      'chat-1',
      REASONING.artifacts[0]!.id,
      { artifactVersion: 1, enforcementVersion: 1, scope: 'projectless' },
    )
    expect(document.body.textContent).not.toContain('final answer secret')
    expect(document.body.textContent).not.toContain('prompt secret')
    expect(document.body.textContent).not.toContain('tool credential')
  })

  it('exports only exact scoped Artifact text and focuses a safe action failure', async () => {
    let clickedDownload: { download: string; href: string } | null = null
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reasoning-export')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      clickedDownload = { download: this.download, href: this.href }
    })
    vi.spyOn(api, 'getReasoningArtifact')
      .mockResolvedValueOnce({
        ...REASONING.artifacts[0]!,
        content: 'exported diagnostic only',
      })
      .mockRejectedValueOnce(new Error('safe Artifact action failure'))
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Export" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Экспортировать рассуждение' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
    const exportedBlob = createObjectURL.mock.calls[0]?.[0]
    expect(exportedBlob).toBeInstanceOf(Blob)
    const exportedText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(String(reader.result)))
      reader.addEventListener('error', () => reject(reader.error))
      reader.readAsText(exportedBlob!)
    })
    expect(exportedText).toBe('exported diagnostic only')
    expect(clickedDownload).toEqual({
      download: `rassuzhdenie-${REASONING.artifacts[0]!.id}.md`,
      href: 'blob:reasoning-export',
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:reasoning-export')
    expect(api.getReasoningArtifact).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      REASONING.artifacts[0]!.id,
      { artifactVersion: 1, enforcementVersion: 1, scope: 'projectless' },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Копировать рассуждение' }))
    const error = await screen.findByText('safe Artifact action failure')
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    expect(api.getReasoningArtifact).toHaveBeenCalledTimes(2)
  })

  it('shows distinct empty answer and reasoning states without actions', async () => {
    vi.mocked(api.listReasoningArtifacts).mockResolvedValue({
      ...REASONING,
      generatedAnswers: [],
      artifacts: [],
    })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Empty" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    expect(await screen.findByText('Сгенерированных ответов пока нет.')).toBeTruthy()
    expect(screen.getByText('В этом Chat нет сохранённых рассуждений.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Копировать рассуждение' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Экспортировать рассуждение' })).toBeNull()
  })

  it('refreshes after server cleanup to a separate empty reasoning state and keeps the answer', async () => {
    vi.mocked(api.listReasoningArtifacts)
      .mockResolvedValueOnce(REASONING)
      .mockResolvedValueOnce({ ...REASONING, artifacts: [] })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Cleanup" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    expect(await screen.findAllByRole('button', { name: 'Копировать рассуждение' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Обновить рассуждения' }))
    expect(await screen.findByText('В этом Chat нет сохранённых рассуждений.')).toBeTruthy()
    expect(screen.getByText('Сгенерированные ответы')).toBeTruthy()
    expect(screen.getByText((_, element) =>
      element?.tagName === 'LI' && element.textContent?.includes('12') === true,
    )).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Копировать рассуждение' })).toBeNull()
    expect(api.listReasoningArtifacts).toHaveBeenCalledTimes(2)
  })

  it('focuses reasoning load errors and retries with exact Project scope', async () => {
    vi.mocked(api.getChatRetention).mockResolvedValue({ ...TTL, projectId: 'project-a' })
    vi.mocked(api.listReasoningArtifacts)
      .mockRejectedValueOnce(new Error('safe Artifact load failure'))
      .mockResolvedValueOnce({
        ...REASONING,
        scope: 'project',
        projectId: 'project-a',
        artifacts: REASONING.artifacts.map((artifact) => ({
          ...artifact,
          ownership: { scope: 'project', projectId: 'project-a' },
        })),
      })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Artifacts" projectId="project-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    const error = await screen.findByText('safe Artifact load failure')
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    expect(screen.queryByText(/Автоматическое удаление применяется/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку рассуждений' }))
    await screen.findByRole('button', { name: 'Копировать рассуждение' })
    expect(screen.getByText(/Автоматическое удаление применяется/u)).toBeTruthy()
    expect(api.listReasoningArtifacts).toHaveBeenLastCalledWith(
      'chat-1',
      { artifactVersion: 1, enforcementVersion: 1, scope: 'project', projectId: 'project-a' },
      undefined,
    )
    expect(api.listReasoningArtifacts).toHaveBeenCalledTimes(2)
  })
})
