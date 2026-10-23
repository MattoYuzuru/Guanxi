import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { chatModelSelection, type Health } from '@guanxi/contract'
import { ChatPage } from '../../src/features/chat/ChatPage.tsx'
import { RuntimeProvider } from '../../src/features/health/RuntimeContext.tsx'
import { api } from '../../src/lib/api.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'
import { chooseValue, optionGroups, optionLabels, optionValues, selectedValue } from '../helpers/select.ts'

const connectionId = 'ad07f428-d220-45a2-89be-6ec819c8592c'
const selection = chatModelSelection(connectionId, 'owner-model')
const picker = () => screen.findByRole('combobox', { name: 'Модель для нового диалога' })
/** Waits until the model picker offers `value` (the list is opened and closed to read it). */
async function offered(value: string) {
  await waitFor(async () => expect(await optionValues(await picker())).toContain(value))
}
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
  await offered(selection)
  expect(await optionGroups(await picker())).toEqual([{ label: 'Owner API', options: ['owner-model'] }])
  expect((await optionLabels(await picker())).filter(label => label === 'owner-model')).toHaveLength(1)
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
  await offered('local-model')
  expect((await optionLabels(await picker())).filter(label => label === 'local-model')).toHaveLength(1)
})


it('switches from a selected provider to a visible local model before Agent creation', async () => {
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ name: 'local-model', capabilities: ['completion'], contextLimit: { state: 'unknown' }, fit: { level: 'unknown' } }] } as never)
  const create = vi.spyOn(api, 'createThread').mockResolvedValue({ id: 'created-agent' } as never)
  render(<RuntimeProvider loader={async () => runtimeSnapshotFixture()}><ChatPage threadId={null} health={{} as Health} /></RuntimeProvider>)
  await offered(selection)
  await chooseValue(await picker(), selection)
  expect(selectedValue(await picker())).toBe(selection)
  const modes = screen.getAllByRole('button', { pressed: false })
  fireEvent.click(modes[0]!)
  await waitFor(async () => expect(await optionLabels(await picker())).not.toContain('owner-model'))
  fireEvent.click(screen.getByRole('button', { name: 'Создать диалог' }))
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  expect(create.mock.calls[0]![0].model).toBe('local-model')
  expect(create.mock.calls[0]![0].mode).toBe('agent')
})


it('reselects a visible local model when quiet refresh removes a locked provider', async () => {
  vi.mocked(api.listModels).mockResolvedValue({ models: [{ name: 'local-model', capabilities: ['completion'], contextLimit: { state: 'unknown' }, fit: { level: 'unknown' } }] } as never)
  render(<RuntimeProvider loader={async () => runtimeSnapshotFixture()}><ChatPage threadId={null} health={{} as Health} /></RuntimeProvider>)
  await offered(selection)
  await chooseValue(await picker(), selection)
  expect(selectedValue(await picker())).toBe(selection)
  vi.mocked(api.chatModels).mockResolvedValue({ groups: [] })
  fireEvent(window, new Event('focus'))
  await waitFor(async () => expect(await optionLabels(await picker())).not.toContain('owner-model'))
  await waitFor(async () => expect(selectedValue(await picker())).toBe('local-model'))
})


it('keeps equally named connections in separate groups by connection identity', async () => {
  const first = vi.mocked(api.chatModels).getMockImplementation()!
  const snapshot = await first()
  vi.mocked(api.chatModels).mockResolvedValue({ groups: [snapshot.groups[0]!, {
    ...snapshot.groups[0]!, id: 'second-connection', models: [{ ...snapshot.groups[0]!.models[0]!, selection: 'second-selection', modelId: 'second-model' }],
  }] })
  render(<RuntimeProvider loader={async () => runtimeSnapshotFixture()}><ChatPage threadId={null} health={{} as Health} /></RuntimeProvider>)
  await offered('second-selection')
  // Two groups with the same visible name, one per connection identity, each with its own model.
  expect(await optionGroups(await picker())).toEqual([
    { label: 'Owner API', options: ['owner-model'] },
    { label: 'Owner API', options: ['second-model'] },
  ])
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
