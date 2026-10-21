import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health } from '@guanxi/contract'
import { ChatPage } from '../../src/features/chat/ChatPage.tsx'
import { RuntimeProvider } from '../../src/features/health/RuntimeContext.tsx'
import { api } from '../../src/lib/api.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'
import { holdAnimationFrames } from '../helpers/animation-frames.ts'

const PROJECT = {
  id: 'project-1',
  name: 'A Project With A Truthfully Long Name',
  createdAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  filesystemBindings: [],
}

const CHAT = {
  id: 'chat-1',
  title: 'Project Chat',
  mode: 'chat' as const,
  model: 'fixture:latest',
  workspaceId: null,
  options: { numCtx: 8192, temperature: 0.7, think: 'off' as const },
  createdAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  messageCount: 0,
  ownershipVersion: 1 as const,
  projectId: PROJECT.id,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderChat(threadId: string | null) {
  return render(
    <RuntimeProvider loader={async () => runtimeSnapshotFixture()}>
      <ChatPage threadId={threadId} projectId={PROJECT.id} health={{} as Health} />
    </RuntimeProvider>,
  )
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  vi.spyOn(api, 'listProjectChats').mockResolvedValue({
    ownershipVersion: 1,
    project: PROJECT,
    chats: [],
  })
  vi.spyOn(api, 'getSettings').mockResolvedValue({
    ollamaHost: 'http://127.0.0.1:11434',
    defaultModel: 'fixture:latest',
    defaultNumCtx: 8192,
    autoApproveTools: false,
    enableBash: false,
    prewarmEnabled: false,
    webSearch: { provider: 'none', baseUrl: null, apiKey: null },
  })
  vi.spyOn(api, 'listModels').mockResolvedValue({
    models: [{
      name: 'fixture:latest',
      digest: 'sha256:fixture',
      capabilities: ['completion'],
      contextLimit: { state: 'known', value: 8192, source: 'provider', observedAt: null },
      fit: { level: 'green', basis: 'estimate' },
    }],
  } as never)
  vi.spyOn(api, 'listWorkspaces').mockResolvedValue({ workspaces: [] })
  vi.spyOn(api, 'listProjectlessChats').mockResolvedValue({
    ownershipVersion: 1,
    scope: 'projectless',
    chats: [],
  })
})

describe('Project Chat Web boundary', () => {
  it('creates once under repeated keyboard/form activation and keeps the exact Project route', async () => {
    const frames = holdAnimationFrames()
    const creation = deferred<typeof CHAT>()
    vi.spyOn(api, 'createProjectChat').mockReturnValue(creation.promise)
    vi.spyOn(api, 'createThread')

    renderChat(null)
    const heading = await screen.findByRole('heading', {
      name: `Новый чат в проекте «${PROJECT.name}»`,
    })
    await waitFor(() => expect(frames.pending()).toBe(1))
    await frames.flush()
    expect(heading).toBe(document.activeElement)
    await frames.flush()
    expect(heading).toBe(document.activeElement)
    const create = await screen.findByRole('button', { name: 'Создать диалог' })
    await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false))
    const form = create.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(api.createProjectChat).toHaveBeenCalledTimes(1)
    expect(api.createProjectChat).toHaveBeenCalledWith(PROJECT.id, {
      model: 'fixture:latest',
      options: { numCtx: 8192, temperature: 0.7, think: 'off' },
    })
    await act(async () => creation.resolve(CHAT))
    expect(window.location.pathname).toBe(`/projects/${PROJECT.id}/chats/${CHAT.id}`)
    expect(api.createThread).not.toHaveBeenCalled()
  })

  it('focuses create failure and allows one explicit retry', async () => {
    const frames = holdAnimationFrames()
    vi.spyOn(api, 'createProjectChat')
      .mockRejectedValueOnce(new Error('create failed safely'))
      .mockResolvedValue(CHAT)

    renderChat(null)
    // Ordinary order: the initial heading frame has run before creation fails.
    // The late-frame order is covered by project-chat-focus-race.test.tsx.
    const heading = await screen.findByRole('heading', { name: `Новый чат в проекте «${PROJECT.name}»` })
    await waitFor(() => expect(frames.pending()).toBe(1))
    await frames.flush()
    expect(heading).toBe(document.activeElement)
    const create = await screen.findByRole('button', { name: 'Создать диалог' })
    await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false))
    fireEvent.click(create)
    const error = await screen.findByText('create failed safely')
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    await frames.flush()
    expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement)
    fireEvent.click(create)
    await waitFor(() => expect(api.createProjectChat).toHaveBeenCalledTimes(2))
    expect(window.location.pathname).toBe(`/projects/${PROJECT.id}/chats/${CHAT.id}`)
  })

  it('hard-loads through sourced ownership and contains stale or mismatched references', async () => {
    const frames = holdAnimationFrames()
    vi.spyOn(api, 'getProjectChat').mockRejectedValue(new Error('project_chat_mismatch'))
    vi.spyOn(api, 'getThread')

    renderChat(CHAT.id)
    const heading = await screen.findByRole('heading', {
      name: 'Не удалось безопасно открыть чат проекта',
    })
    // Finding the DOM does not imply that ThreadPage's passive focus effect ran.
    await waitFor(() => expect(heading).toBe(document.activeElement))
    await frames.flush()
    expect(heading).toBe(document.activeElement)
    expect(screen.getByRole('alert').textContent).toContain('project_chat_mismatch')
    expect(api.getProjectChat).toHaveBeenCalledWith(PROJECT.id, CHAT.id, expect.any(AbortSignal))
    expect(api.getThread).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(api.getProjectChat).toHaveBeenCalledTimes(2))
    const retryHeading = await screen.findByRole('heading', {
      name: 'Не удалось безопасно открыть чат проекта',
    })
    await waitFor(() => expect(retryHeading).toBe(document.activeElement))
    await frames.flush()
    expect(retryHeading).toBe(document.activeElement)
  })
})
