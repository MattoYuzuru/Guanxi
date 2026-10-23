import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { chatModelSelection, type Health } from '@guanxi/contract'
import { ChatPage } from '../../src/features/chat/ChatPage.tsx'
import { RuntimeProvider } from '../../src/features/health/RuntimeContext.tsx'
import { api } from '../../src/lib/api.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'

const connectionId = 'ad07f428-d220-45a2-89be-6ec819c8592c'
const selection = chatModelSelection(connectionId, 'owner-model')
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  vi.spyOn(api, 'getSettings').mockResolvedValue({ defaultModel: null, prewarmEnabled: false } as never)
  vi.spyOn(api, 'listWorkspaces').mockResolvedValue({ workspaces: [] })
  vi.spyOn(api, 'listProjectlessChats').mockResolvedValue({ chats: [] } as never)
  vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
  vi.spyOn(api, 'chatModels').mockResolvedValue({ groups: [{ id: connectionId, label: 'Owner API', kind: 'provider', models: [{
    selection, modelId: 'owner-model', source: 'api.example.invalid/models', observedAt: new Date().toISOString(), confidence: 'medium',
  }] }] })
})

it('groups provider models, creates with the opaque selection and does not prewarm providers', async () => {
  const create = vi.spyOn(api, 'createThread').mockResolvedValue({ id: 'created-provider-chat' } as never)
  const prewarm = vi.spyOn(api, 'prewarmModel')
  render(<RuntimeProvider loader={async () => runtimeSnapshotFixture()}><ChatPage threadId={null} health={{ ollama: { running: false } } as Health} /></RuntimeProvider>)
  const option = await screen.findByRole('option', { name: 'owner-model' })
  expect(option.closest('optgroup')?.label).toBe('Owner API')
  expect(screen.getAllByRole('option', { name: 'owner-model' })).toHaveLength(1)
  const button = await screen.findByRole('button', { name: 'Создать диалог' })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  expect(create.mock.calls[0]![0].model).toBe(selection)
  expect(prewarm).not.toHaveBeenCalled()
})

it('keeps local choices when provider discovery fails', async () => {
  vi.mocked(api.chatModels).mockRejectedValue(new Error('offline'))
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ name: 'local-model', capabilities: ['completion'], contextLimit: { state: 'unknown' }, fit: { level: 'unknown' } }] } as never)
  render(<RuntimeProvider loader={async () => runtimeSnapshotFixture()}><ChatPage threadId={null} health={{} as Health} /></RuntimeProvider>)
  expect(await screen.findByRole('option', { name: 'local-model' })).toBeTruthy()
  expect(screen.getAllByRole('option', { name: 'local-model' })).toHaveLength(1)
})


it('switches from a selected provider to a visible local model before Agent creation', async () => {
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ name: 'local-model', capabilities: ['completion'], contextLimit: { state: 'unknown' }, fit: { level: 'unknown' } }] } as never)
  const create = vi.spyOn(api, 'createThread').mockResolvedValue({ id: 'created-agent' } as never)
  render(<RuntimeProvider loader={async () => runtimeSnapshotFixture()}><ChatPage threadId={null} health={{} as Health} /></RuntimeProvider>)
  const option = await screen.findByRole('option', { name: 'owner-model' })
  fireEvent.change(option.closest('select')!, { target: { value: selection } })
  const modes = screen.getAllByRole('button', { pressed: false })
  fireEvent.click(modes[0]!)
  await waitFor(() => expect(screen.queryByRole('option', { name: 'owner-model' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Создать диалог' }))
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  expect(create.mock.calls[0]![0].model).toBe('local-model')
  expect(create.mock.calls[0]![0].mode).toBe('agent')
})
