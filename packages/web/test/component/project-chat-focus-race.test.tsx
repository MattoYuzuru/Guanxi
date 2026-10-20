/**
 * Regression for the K1 cross-family re-review R5: the initial Project heading
 * focus is scheduled in an animation frame. When creation fails before that
 * frame runs, the frame must not take focus away from the error. Animation
 * frames are held and released explicitly, so the ordering is deterministic.
 * Adapted from the reviewer's review-focus-race.test.tsx.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Health } from '@guanxi/contract'
import { ChatPage } from '../../src/features/chat/ChatPage.tsx'
import { RuntimeProvider } from '../../src/features/health/RuntimeContext.tsx'
import { api } from '../../src/lib/api.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'

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

describe('Project Chat focus ordering', () => {
  it('keeps focus on a create failure when the initial heading focus frame runs late', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.spyOn(api, 'createProjectChat')
      .mockRejectedValueOnce(new Error('create failed safely'))
      .mockResolvedValue(CHAT)

    renderChat(null)
    const create = await screen.findByRole('button', { name: 'Создать диалог' })
    await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false))
    fireEvent.click(create)
    const error = await screen.findByText('create failed safely')
    await waitFor(() => expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement))
    await act(async () => { for (const callback of frames.splice(0)) callback(0) })
    expect(error.closest('[tabindex="-1"]')).toBe(document.activeElement)
    fireEvent.click(create)
    await waitFor(() => expect(api.createProjectChat).toHaveBeenCalledTimes(2))
    expect(window.location.pathname).toBe(`/projects/${PROJECT.id}/chats/${CHAT.id}`)
  })
})
