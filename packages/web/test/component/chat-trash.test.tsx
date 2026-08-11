import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatTrashItem, RestoreChatResponse } from '@alamo/contract'
import { ChatTrashList } from '../../src/features/chat/ChatTrashList.tsx'
import { api } from '../../src/lib/api.ts'

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
  document.documentElement.lang = 'ru'
})

describe('Chat Trash list', () => {
  it('loads one exact Project scope and shows sourced reason/time with truthful hard-deletion state', async () => {
    vi.spyOn(api, 'listChatTrash').mockResolvedValue({
      lifecycleVersion: 1,
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
      scope: 'project',
      projectId: 'project-a',
      limit: 20,
    }, expect.any(AbortSignal))
    expect(region.textContent).toContain('истёк срок хранения 7 дней')
    expect(region.textContent).toContain('Безвозвратное удаление не реализовано')
    expect(region.textContent).toContain('первые 20 записей Корзины')
    expect(region.querySelectorAll(`time[datetime="${TOMBSTONED_AT}"]`)).toHaveLength(1)
    expect(region.querySelectorAll(`time[datetime="${ACTIVITY_AT}"]`)).toHaveLength(1)
    expect(region.textContent).toContain('принятое сообщение пользователя')
  })

  it('coalesces repeated Restore, refreshes active/Trash projections and returns focus safely', async () => {
    vi.spyOn(api, 'listChatTrash')
      .mockResolvedValueOnce({
        lifecycleVersion: 1, scope: 'project', projectId: 'project-a', chats: [ITEM], hasMore: false,
      })
      .mockResolvedValue({
        lifecycleVersion: 1, scope: 'project', projectId: 'project-a', chats: [], hasMore: false,
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

  it('focuses a safe Restore error and retries the same mutation without an extra list read', async () => {
    vi.spyOn(api, 'listChatTrash').mockResolvedValue({
      lifecycleVersion: 1, scope: 'projectless', projectId: null,
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
    fireEvent.click(screen.getByRole('button', { name: 'Повторить восстановление' }))
    await waitFor(() => expect(api.restoreChat).toHaveBeenCalledTimes(2))
    expect(api.restoreChat).toHaveBeenNthCalledWith(1, 'trash-chat', { lifecycleVersion: 1 })
    expect(api.restoreChat).toHaveBeenNthCalledWith(2, 'trash-chat', { lifecycleVersion: 1 })
  })

  it('rejects a mismatched Restore scope and uses curated English fallback', async () => {
    document.documentElement.lang = 'fr'
    vi.spyOn(api, 'listChatTrash').mockResolvedValue({
      lifecycleVersion: 1, scope: 'project', projectId: 'project-a', chats: [ITEM], hasMore: false,
    })
    vi.spyOn(api, 'restoreChat').mockResolvedValue({ ...RESTORED, projectId: 'project-b' })
    render(<ChatTrashList projectId="project-a" />)
    expect((await screen.findByRole('region', { name: 'Trash' })).textContent).toContain(
      'Hard deletion is not implemented',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restore Chat' }))
    expect(await screen.findByText('Restore returned a different Chat scope.')).toBeTruthy()
    expect(api.listChatTrash).toHaveBeenCalledTimes(1)
  })
})
