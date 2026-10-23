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


it('reselects a visible local model when quiet refresh removes a locked provider', async () => {
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ name: 'local-model', capabilities: ['completion'], contextLimit: { state: 'unknown' }, fit: { level: 'unknown' } }] } as never)
  render(<RuntimeProvider loader={async () => runtimeSnapshotFixture()}><ChatPage threadId={null} health={{} as Health} /></RuntimeProvider>)
  const option = await screen.findByRole('option', { name: 'owner-model' })
  const select = option.closest('select')!
  fireEvent.change(select, { target: { value: selection } })
  expect(select.value).toBe(selection)
  vi.mocked(api.chatModels).mockResolvedValue({ groups: [] })
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(screen.queryByRole('option', { name: 'owner-model' })).toBeNull())
  await waitFor(() => expect(select.value).toBe('local-model'))
})


it('keeps equally named connections in separate groups by connection identity', async () => {
  const first = vi.mocked(api.chatModels).getMockImplementation()!
  const snapshot = await first()
  vi.mocked(api.chatModels).mockResolvedValue({ groups: [snapshot.groups[0]!, {
    ...snapshot.groups[0]!, id: 'second-connection', models: [{ ...snapshot.groups[0]!.models[0]!, selection: 'second-selection', modelId: 'second-model' }],
  }] })
  render(<RuntimeProvider loader={async () => runtimeSnapshotFixture()}><ChatPage threadId={null} health={{} as Health} /></RuntimeProvider>)
  await screen.findByRole('option', { name: 'second-model' })
  expect(screen.getAllByRole('group', { name: 'Owner API' })).toHaveLength(2)
  expect(screen.getByRole('option', { name: 'owner-model' }).closest('optgroup')).not.toBe(screen.getByRole('option', { name: 'second-model' }).closest('optgroup'))
})

it('enables provider composer with Ollama down and dispatches without a local resource decision', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const thread = { id: 'provider-thread', title: 'Provider thread', model: selection, mode: 'chat', workspaceId: null,
    messageCount: 0, options: { numCtx: 4096, temperature: 0.7, think: 'off' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  vi.spyOn(api, 'getThread').mockResolvedValue({ thread, messages: [], contextCheckpoints: [], context: null } as never)
  const apiModule = await import('../../src/lib/api.ts')
  const send = vi.spyOn(apiModule, 'streamChat').mockImplementation((_id, _body, handlers) => {
    handlers.onAccepted?.()
    return { abort: () => {}, finished: Promise.resolve() }
  })
  const runtime = vi.fn(async () => runtimeSnapshotFixture())
  render(<RuntimeProvider loader={runtime}><ChatPage threadId={thread.id} health={{ ollama: { running: false } } as Health} /></RuntimeProvider>)
  const composer = await screen.findByRole('textbox', { name: 'Сообщение' })
  expect(composer.hasAttribute('disabled')).toBe(false)
  const reads = runtime.mock.calls.length
  fireEvent.change(composer, { target: { value: 'provider fixture' } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(runtime.mock.calls.length).toBe(reads)
  expect(screen.queryByRole('dialog')).toBeNull()
})
