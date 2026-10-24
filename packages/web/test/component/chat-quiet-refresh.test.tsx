/**
 * P2 (D-203): the chat page keeps its provider model list current by quiet revalidation. A re-read
 * that returns the same list commits nothing: no `refreshing` flag flips and no view re-renders.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { Profiler } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { chatModelSelection, type Health } from '@guanxi/contract'
import { ChatPage } from '../../src/features/chat/ChatPage.tsx'
import { RuntimeProvider } from '../../src/features/health/RuntimeContext.tsx'
import { api } from '../../src/lib/api.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'

const connectionId = 'ad07f428-d220-45a2-89be-6ec819c8592c'
const observedAt = '2026-10-23T12:00:00.000Z'
const runtime = runtimeSnapshotFixture()
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  vi.spyOn(api, 'getSettings').mockResolvedValue({ defaultModel: null, prewarmEnabled: false } as never)
  vi.spyOn(api, 'listWorkspaces').mockResolvedValue({ workspaces: [] })
  vi.spyOn(api, 'listProjectlessChats').mockResolvedValue({ chats: [] } as never)
  vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
  vi.spyOn(api, 'chatModels').mockImplementation(async () => ({ groups: [{ id: connectionId, label: 'Owner API', kind: 'provider', models: [{
    selection: chatModelSelection(connectionId, 'owner-model'), modelId: 'owner-model', source: 'api.example.invalid/models', observedAt, confidence: 'medium',
  }] }] }))
})

it('an equal provider-model re-read on focus commits nothing (P2)', async () => {
  const commits: string[] = []
  render(<RuntimeProvider loader={async () => runtime}>
    <Profiler id="chat" onRender={(_id, phase) => { commits.push(phase) }}>
      <ChatPage threadId={null} health={{ ollama: { running: false } } as Health} />
    </Profiler>
  </RuntimeProvider>)
  await screen.findAllByText('owner-model')
  await waitFor(() => expect(api.chatModels).toHaveBeenCalledTimes(1))
  // Let the first reads settle.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  const settled = commits.length
  const reads = vi.mocked(api.chatModels).mock.calls.length
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => expect(vi.mocked(api.chatModels).mock.calls.length).toBeGreaterThan(reads))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(commits.slice(settled)).toEqual([])
})
