import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRetentionProjection } from '@alamo/contract'
import { ChatRetentionInfo } from '../../src/features/chat/ChatRetentionInfo.tsx'
import { api } from '../../src/lib/api.ts'

const ACTIVITY_AT = '2026-08-11T10:00:00.000Z'
const EXPIRES_AT = '2026-08-18T10:00:00.000Z'
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
  enforcement: 'not_implemented',
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
  vi.spyOn(api, 'getChatRetention').mockResolvedValue(TTL)
})

describe('Chat retention info', () => {
  it('shows sourced policy/expiry and truthfully separates configuration from enforcement', async () => {
    render(<ChatRetentionInfo chatId="chat-1" chatTitle={'Ч'.repeat(120)} projectId={null} />)
    const trigger = screen.getByRole('button', { name: 'Информация о чате' })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Хранение чата' })
    expect(api.getChatRetention).toHaveBeenCalledWith('chat-1', expect.any(AbortSignal))
    expect(dialog.textContent).toContain('7 дней')
    expect(dialog.textContent).toContain('основание — создание чата')
    expect(dialog.textContent).toContain('вычислено сервером')
    expect(dialog.textContent).toContain('Настроено, но ещё не применяется')
    expect(dialog.textContent).toContain('Cleanup и Корзина ещё не реализованы')
    expect(dialog.querySelector(`time[datetime="${ACTIVITY_AT}"]`)).toBeTruthy()
    expect(dialog.querySelector(`time[datetime="${EXPIRES_AT}"]`)).toBeTruthy()
    expect(dialog.textContent).toContain('Ч'.repeat(120))

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки хранения чата' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toBe(document.activeElement)
  })

  it('coalesces repeated form activation into one isolated mutation', async () => {
    const mutation = deferred<ChatRetentionProjection>()
    vi.spyOn(api, 'updateChatRetention').mockReturnValue(mutation.promise)
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Retention" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    await screen.findByRole('dialog')
    await screen.findByText('Настроено, но ещё не применяется')
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
  })

  it('focuses a safe error, retries explicitly and rejects a mismatched Project scope', async () => {
    vi.mocked(api.getChatRetention)
      .mockResolvedValueOnce({ ...TTL, projectId: 'project-b' })
      .mockResolvedValueOnce({ ...TTL, projectId: 'project-a' })
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="Scoped" projectId="project-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Информация о чате' }))
    const error = await screen.findByText('Retention относится к другому Chat scope.')
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    fireEvent.click(screen.getByRole('button', { name: 'Повторить retention' }))
    await screen.findByText('Настроено, но ещё не применяется')
    expect(api.getChatRetention).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Retention относится к другому Chat scope.')).toBeNull()
  })

  it('uses English source/fallback copy', async () => {
    document.documentElement.lang = 'en-US'
    render(<ChatRetentionInfo chatId="chat-1" chatTitle="English" projectId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Chat info' }))
    const dialog = await screen.findByRole('dialog', { name: 'Chat retention' })
    expect(dialog.textContent).toContain('Configured, not enforced yet')
    expect(dialog.textContent).toContain('calculated by the server')
  })
})
