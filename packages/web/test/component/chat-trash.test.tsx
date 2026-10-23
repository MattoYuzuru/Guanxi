import { QUIET_FAILURES_BEFORE_ERROR } from '../../src/lib/useAsync.ts'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatTrashItem, RestoreChatResponse } from '@guanxi/contract'
import { ChatTrashList } from '../../src/features/chat/ChatTrashList.tsx'
import { api } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const TOMBSTONED_AT = '2026-08-11T12:00:00.000Z'
const ACTIVITY_AT = '2026-08-03T12:00:00.000Z'
const ITEM: ChatTrashItem = {
  lifecycleVersion: 1,
  chatId: 'trash-chat',
  title: 'T'.repeat(120),
  projectId: 'project-a',
  state: 'trash',
  reason: 'ttl_expired',
  tombstonedAt: TOMBSTONED_AT,
  activityBasis: { at: ACTIVITY_AT, source: 'user_message' },
  source: 'server_maintenance',
  hardDeletion: 'not_implemented',
}

const RESTORED: RestoreChatResponse = {
  lifecycleVersion: 1,
  chatId: ITEM.chatId,
  projectId: ITEM.projectId,
  state: 'active',
  restored: true,
  restoredAt: TOMBSTONED_AT,
  activityBasis: { at: TOMBSTONED_AT, source: 'chat_restored' },
  source: 'user_restore',
  hardDeletion: 'not_implemented',
}
const SESSION_ITEM: ChatTrashItem = {
  lifecycleVersion: 1,
  chatId: 'session-trash-chat',
  title: 'Recoverable Session',
  projectId: null,
  state: 'trash',
  reason: 'session_left',
  tombstonedAt: TOMBSTONED_AT,
  activityBasis: { at: TOMBSTONED_AT, source: 'session_leave' },
  source: 'server_maintenance',
  hardDeletion: {
    state: 'scheduled_after_recovery',
    eligibleAt: '2026-08-12T12:00:00.000Z',
    source: 'server_maintenance',
    blobGc: 'not_applicable',
  },
  recovery: {
    deadline: '2026-08-12T12:00:00.000Z',
    state: 'available',
    source: 'server_calculated_24_hours',
  },
}

const EMPTY_DELETIONS = {
  deletionVersion: 1 as const,
  deletions: [],
  deletionsHaveMore: false,
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
})

describe('Chat Trash list', () => {
  it('shows exact Session recovery and truthful pending metadata deletion without blob-GC claims', async () => {
    vi.spyOn(api, 'restoreChat')
    vi.spyOn(api, 'listChatTrash').mockResolvedValue({
      lifecycleVersion: 1,
      ...EMPTY_DELETIONS,
      scope: 'projectless',
      projectId: null,
      chats: [
        SESSION_ITEM,
        {
          ...SESSION_ITEM,
          chatId: 'elapsed-session',
          title: 'Elapsed Session',
          recovery: { ...SESSION_ITEM.recovery, state: 'grace_elapsed' },
          hardDeletion: { ...SESSION_ITEM.hardDeletion, state: 'pending_maintenance' },
        },
      ],
      hasMore: false,
    })
    render(<ChatTrashList projectId={null} />)
    const available = (await screen.findByText(SESSION_ITEM.title)).closest('li')!
    const elapsed = screen.getByText('Elapsed Session').closest('li')!
    expect(available.querySelector('time[datetime="2026-08-12T12:00:00.000Z"]')).toBeTruthy()
    expect(available.textContent).toContain('восстановление доступно')
    expect(elapsed.textContent).toContain('24 часа восстановления истекли')
    expect(elapsed.textContent).toContain('удаление metadata ожидает server maintenance')
    expect(elapsed.textContent).toContain('generic blob cleanup неприменим')
    expect((elapsed.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
    expect((available.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
    expect(api.restoreChat).not.toHaveBeenCalled()
  })

  it('loads one exact Project scope and shows sourced reason/time with truthful hard-deletion state', async () => {
    vi.spyOn(api, 'listChatTrash').mockResolvedValue({
      lifecycleVersion: 1,
      ...EMPTY_DELETIONS,
      scope: 'project',
      projectId: 'project-a',
      chats: [ITEM],
      hasMore: true,
    })
    render(<ChatTrashList projectId="project-a" />)
    const region = await screen.findByRole('region', { name: 'Корзина' })
    await screen.findByText(ITEM.title)
    expect(api.listChatTrash).toHaveBeenCalledWith({
      lifecycleVersion: 1,
      deletionVersion: 1,
      scope: 'project',
      projectId: 'project-a',
      limit: 20,
    }, expect.any(AbortSignal))
    expect(region.textContent).toContain('истёк срок хранения 7 дней')
    expect(region.textContent).toContain('Удаление 7-day Trash и generic blob cleanup не реализованы')
    expect(region.textContent).toContain('первые 20 записей Корзины')
    expect(region.querySelectorAll(`time[datetime="${TOMBSTONED_AT}"]`)).toHaveLength(1)
    expect(region.querySelectorAll(`time[datetime="${ACTIVITY_AT}"]`)).toHaveLength(1)
    expect(region.textContent).toContain('принятое сообщение пользователя')
  })

  it('coalesces repeated Restore, refreshes active/Trash projections and returns focus safely', async () => {
    vi.spyOn(api, 'listChatTrash')
      .mockResolvedValueOnce({
        lifecycleVersion: 1, ...EMPTY_DELETIONS, scope: 'project', projectId: 'project-a', chats: [ITEM], hasMore: false,
      })
      .mockResolvedValue({
        lifecycleVersion: 1, ...EMPTY_DELETIONS, scope: 'project', projectId: 'project-a', chats: [], hasMore: false,
      })
    const mutation = deferred<RestoreChatResponse>()
    vi.spyOn(api, 'restoreChat').mockReturnValue(mutation.promise)
    const onRestored = vi.fn()
    render(<ChatTrashList projectId="project-a" onRestored={onRestored} />)
    const restore = await screen.findByRole('button', { name: 'Восстановить чат' })
    fireEvent.click(restore)
    fireEvent.click(restore)
    expect(api.restoreChat).toHaveBeenCalledTimes(1)
    expect(api.restoreChat).toHaveBeenCalledWith('trash-chat', { lifecycleVersion: 1 })
    await act(async () => mutation.resolve(RESTORED))
    await screen.findByText('В этой области Корзина пуста.')
    expect(api.listChatTrash).toHaveBeenCalledTimes(2)
    expect(onRestored).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Корзина' })).toBe(document.activeElement))
  })

  it('focuses a safe Restore error and repeats the same mutation from Restore without an extra list read', async () => {
    vi.spyOn(api, 'listChatTrash').mockResolvedValue({
      lifecycleVersion: 1, scope: 'projectless', projectId: null,
      ...EMPTY_DELETIONS,
      chats: [{ ...ITEM, projectId: null }], hasMore: false,
    })
    vi.spyOn(api, 'restoreChat')
      .mockRejectedValueOnce(new Error('safe restore failure'))
      .mockResolvedValueOnce({ ...RESTORED, projectId: null })
    render(<ChatTrashList projectId={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Восстановить чат' }))
    const error = await screen.findByText('safe restore failure')
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    expect(api.listChatTrash).toHaveBeenCalledTimes(1)
    expect(screen.queryAllByRole('button', { name: /^(Повторить|Обновить|Retry|Refresh)/u })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Восстановить чат' }))
    await waitFor(() => expect(api.restoreChat).toHaveBeenCalledTimes(2))
    expect(api.restoreChat).toHaveBeenNthCalledWith(1, 'trash-chat', { lifecycleVersion: 1 })
    expect(api.restoreChat).toHaveBeenNthCalledWith(2, 'trash-chat', { lifecycleVersion: 1 })
  })

  it('removes a restored stale item, focuses failed refresh, and converges by itself', async () => {
    vi.spyOn(api, 'listChatTrash')
      .mockResolvedValueOnce({
        lifecycleVersion: 1, ...EMPTY_DELETIONS, scope: 'project', projectId: 'project-a', chats: [ITEM], hasMore: false,
      })
      .mockRejectedValueOnce(new Error('post-restore refresh failed'))
      .mockResolvedValueOnce({
        lifecycleVersion: 1, ...EMPTY_DELETIONS, scope: 'project', projectId: 'project-a', chats: [], hasMore: false,
      })
    vi.spyOn(api, 'restoreChat').mockResolvedValue(RESTORED)
    const onRestored = vi.fn()
    render(<ChatTrashList projectId="project-a" onRestored={onRestored} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Восстановить чат' }))
    const refreshError = await screen.findByText(/post-restore refresh failed/u)
    await waitFor(() => expect(refreshError.closest('[tabindex="-1"]')).toBe(document.activeElement))
    expect(screen.queryByText(ITEM.title)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Восстановить чат' })).toBeNull()
    expect(onRestored).toHaveBeenCalledTimes(1)
    expect(screen.queryAllByRole('button', { name: /^(Повторить|Обновить|Retry|Refresh)/u })).toHaveLength(0)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await screen.findByText('В этой области Корзина пуста.')
    expect(api.listChatTrash).toHaveBeenCalledTimes(3)
    expect(api.restoreChat).toHaveBeenCalledTimes(1)
  })

  it('a transient background failure inserts nothing; a lasting one is announced once and never pulls focus back (P2)', async () => {
    const list = vi.spyOn(api, 'listChatTrash').mockResolvedValueOnce({
      lifecycleVersion: 1, ...EMPTY_DELETIONS, scope: 'project', projectId: 'project-a', chats: [ITEM], hasMore: false,
    })
    list.mockImplementation(async () => { throw new Error('node busy') })
    render(<ChatTrashList projectId="project-a" />)
    await screen.findByText(ITEM.title)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    for (let read = 3; read <= 1 + QUIET_FAILURES_BEFORE_ERROR; read++) {
      await act(async () => { window.dispatchEvent(new Event('focus')) })
      await waitFor(() => expect(list).toHaveBeenCalledTimes(read))
    }
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toBe(document.activeElement))
    expect(screen.getByText(ITEM.title)).toBeTruthy()
    const restore = screen.getByRole('button', { name: 'Восстановить чат' })
    restore.focus()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2 + QUIET_FAILURES_BEFORE_ERROR))
    await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))) })
    expect(document.activeElement).toBe(restore)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('focuses an initial list error and recovers by itself', async () => {
    vi.spyOn(api, 'listChatTrash')
      .mockRejectedValueOnce(new Error('initial Trash failure'))
      .mockResolvedValueOnce({
        lifecycleVersion: 1, ...EMPTY_DELETIONS, scope: 'projectless', projectId: null, chats: [], hasMore: false,
      })
    render(<ChatTrashList projectId={null} />)
    const error = await screen.findByText(/initial Trash failure/u)
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    expect(screen.queryAllByRole('button', { name: /^(Повторить|Обновить|Retry|Refresh)/u })).toHaveLength(0)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await screen.findByText('В этой области Корзина пуста.')
    expect(api.listChatTrash).toHaveBeenCalledTimes(2)
  })

  it('does not steal focus from an active control outside its region on background failure', async () => {
    const request = deferred<never>()
    vi.spyOn(api, 'listChatTrash').mockReturnValue(request.promise)
    render(
      <>
        <button type="button">External action</button>
        <ChatTrashList projectId={null} />
      </>,
    )
    const external = screen.getByRole('button', { name: 'External action' })
    external.focus()
    await act(async () => request.reject(new Error('background Trash failure')))
    await screen.findByText(/background Trash failure/u)
    await waitFor(() => expect(external).toBe(document.activeElement))
  })

  it('rejects a mismatched Restore scope and uses curated English fallback', async () => {
    setActiveLocale('en')
    vi.spyOn(api, 'listChatTrash').mockResolvedValue({
      lifecycleVersion: 1, scope: 'project', projectId: 'project-a', chats: [ITEM], hasMore: false,
      ...EMPTY_DELETIONS,
    })
    vi.spyOn(api, 'restoreChat').mockResolvedValue({ ...RESTORED, projectId: 'project-b' })
    render(<ChatTrashList projectId="project-a" />)
    expect((await screen.findByRole('region', { name: 'Trash' })).textContent).toContain(
      'Session-owned SQLite metadata is deleted after recovery',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restore Chat' }))
    expect(await screen.findByText('Restore returned a different Chat scope.')).toBeTruthy()
    expect(api.listChatTrash).toHaveBeenCalledTimes(1)
  })

  it('keeps English pending truth through failure/retry and shows one committed deletion', async () => {
    setActiveLocale('en')
    const pending = {
      ...SESSION_ITEM,
      recovery: { ...SESSION_ITEM.recovery, state: 'grace_elapsed' as const },
      hardDeletion: { ...SESSION_ITEM.hardDeletion, state: 'pending_maintenance' as const },
    }
    const committed = {
      deletionVersion: 1 as const,
      chatId: pending.chatId,
      scope: 'projectless' as const,
      projectId: null,
      state: 'deleted' as const,
      reason: 'session_recovery_elapsed' as const,
      tombstonedAt: pending.tombstonedAt,
      recoveryDeadline: pending.recovery.deadline,
      deletedAt: '2026-08-12T12:00:00.001Z',
      source: 'server_maintenance' as const,
      boundary: 'thread_owned_sqlite_metadata' as const,
      blobGc: 'not_applicable' as const,
    }
    vi.spyOn(api, 'listChatTrash')
      .mockResolvedValueOnce({
        lifecycleVersion: 1, ...EMPTY_DELETIONS, scope: 'projectless', projectId: null,
        chats: [pending], hasMore: false,
      })
      .mockRejectedValueOnce(new Error('safe English deletion failure'))
      .mockRejectedValueOnce(new Error('safe English deletion failure'))
      .mockRejectedValueOnce(new Error('safe English deletion failure'))
      .mockResolvedValueOnce({
        lifecycleVersion: 1, deletionVersion: 1, scope: 'projectless', projectId: null,
        chats: [], hasMore: false, deletions: [committed], deletionsHaveMore: false,
      })
    render(<ChatTrashList projectId={null} />)
    expect(await screen.findAllByText(pending.title)).toHaveLength(1)
    expect(screen.getAllByText(/metadata deletion is pending server maintenance/u)).toHaveLength(1)
    expect(screen.getAllByText(/generic blob cleanup is not applicable/u)).toHaveLength(1)
    expect(screen.queryAllByRole('button', { name: /^(Повторить|Обновить|Retry|Refresh)/u })).toHaveLength(0)
    // A background failure surfaces after {QUIET_FAILURES_BEFORE_ERROR} consecutive quiet reads (P2).
    for (let read = 0; read < QUIET_FAILURES_BEFORE_ERROR; read++) await act(async () => { window.dispatchEvent(new Event('focus')) })
    const failure = await screen.findByText(/safe English deletion failure/u)
    await waitFor(() => expect(failure.closest('[tabindex="-1"]')).toBe(document.activeElement))
    expect(screen.getAllByText(pending.title)).toHaveLength(1)
    expect(screen.queryAllByText(/Session Chat metadata deleted by server maintenance/u)).toHaveLength(0)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findAllByText(/Session Chat metadata deleted by server maintenance/u)).toHaveLength(1)
    expect(screen.queryAllByText(pending.title)).toHaveLength(0)
    expect(screen.getAllByText(/generic blob cleanup is not applicable/u)).toHaveLength(1)
    expect(api.listChatTrash).toHaveBeenCalledTimes(2 + QUIET_FAILURES_BEFORE_ERROR)
  })

  it('keeps elapsed metadata pending through refresh failure and removes it only after a sourced committed audit', async () => {
    const pending = {
      ...SESSION_ITEM,
      recovery: { ...SESSION_ITEM.recovery, state: 'grace_elapsed' as const },
      hardDeletion: { ...SESSION_ITEM.hardDeletion, state: 'pending_maintenance' as const },
    }
    const committed = {
      deletionVersion: 1 as const,
      chatId: pending.chatId,
      scope: 'projectless' as const,
      projectId: null,
      state: 'deleted' as const,
      reason: 'session_recovery_elapsed' as const,
      tombstonedAt: pending.tombstonedAt,
      recoveryDeadline: pending.recovery.deadline,
      deletedAt: '2026-08-12T12:00:00.001Z',
      source: 'server_maintenance' as const,
      boundary: 'thread_owned_sqlite_metadata' as const,
      blobGc: 'not_applicable' as const,
    }
    vi.spyOn(api, 'listChatTrash')
      .mockResolvedValueOnce({
        lifecycleVersion: 1,
        ...EMPTY_DELETIONS,
        scope: 'projectless',
        projectId: null,
        chats: [pending],
        hasMore: false,
      })
      .mockRejectedValueOnce(new Error('safe deletion refresh failure'))
      .mockRejectedValueOnce(new Error('safe deletion refresh failure'))
      .mockRejectedValueOnce(new Error('safe deletion refresh failure'))
      .mockResolvedValueOnce({
        lifecycleVersion: 1,
        deletionVersion: 1,
        scope: 'projectless',
        projectId: null,
        chats: [],
        hasMore: false,
        deletions: [committed],
        deletionsHaveMore: false,
      })
    render(<ChatTrashList projectId={null} />)
    expect(await screen.findAllByText(pending.title)).toHaveLength(1)
    expect(screen.queryAllByText(/Server maintenance удалил metadata чат-сессии/u)).toHaveLength(0)

    expect(screen.queryAllByRole('button', { name: /^(Повторить|Обновить|Retry|Refresh)/u })).toHaveLength(0)
    // A background failure surfaces after {QUIET_FAILURES_BEFORE_ERROR} consecutive quiet reads (P2).
    for (let read = 0; read < QUIET_FAILURES_BEFORE_ERROR; read++) await act(async () => { window.dispatchEvent(new Event('focus')) })
    const failure = await screen.findByText(/safe deletion refresh failure/u)
    await waitFor(() => expect(failure.closest('[tabindex="-1"]')).toBe(document.activeElement))
    expect(screen.getAllByText(pending.title)).toHaveLength(1)
    expect(screen.queryAllByText(/Server maintenance удалил metadata чат-сессии/u)).toHaveLength(0)

    expect(screen.queryAllByRole('button', { name: /^(Повторить|Обновить|Retry|Refresh)/u })).toHaveLength(0)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findAllByText(/Server maintenance удалил metadata чат-сессии/u)).toHaveLength(1)
    expect(screen.queryAllByText(pending.title)).toHaveLength(0)
    expect(screen.getAllByText(/generic blob cleanup неприменим/u)).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Корзина' })).toBe(document.activeElement))
    expect(api.listChatTrash).toHaveBeenCalledTimes(2 + QUIET_FAILURES_BEFORE_ERROR)
  })
})
