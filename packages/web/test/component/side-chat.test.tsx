import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventDetail } from '../../src/features/inspector/model.ts'
import { encodeSideChatSavedNote, type SessionEvent } from '@guanxi/contract'
import { SideChatPanel } from '../../src/features/side-chat/SideChatPanel.tsx'
import { sideChatEnglish, sideChatRussian } from '../../src/features/side-chat/messages.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

interface Call { action: 'respond' | 'save' | 'send'; body: Record<string, unknown>; signal?: AbortSignal | null }
let calls: Call[]
type Handler = (call: Call) => Response | Promise<Response>
const OBSERVED = '2026-10-23T10:00:00.000Z'
const answer = (text: string, extra: Record<string, unknown> = {}, truncated = false) => Response.json({ requestId: crypto.randomUUID(), text, truncated, context: { source: 'session.log', include: 'session', upToSeq: 12, observedAt: OBSERVED, turns: 2, excerpted: 0, bytes: 345, ...extra } })
const failure = (code: string, status = 503, details?: unknown) => Response.json({ code, ...(details ? { details } : {}) }, { status })
function install(handler: Handler = call => call.action === 'respond' ? answer('Side answer') : call.action === 'save'
  ? Response.json({ operationId: call.body.operationId, eventId: 'event-1', seq: 13, duplicate: false })
  : Response.json({ operationId: call.body.operationId, messageId: crypto.randomUUID(), delivery: 'queued', duplicate: false })) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const match = /^\/api\/agent\/([^/]+)\/side-chat\/(respond|save|send)$/u.exec(String(url))
    if (!match) throw new Error(`Unexpected request ${url}`)
    const call: Call = { action: match[2] as Call['action'], body: JSON.parse(String(init.body)), signal: init.signal }
    calls.push(call)
    return handler(call)
  }))
}
const prompt = () => screen.getByLabelText('Ask about this session') as HTMLTextAreaElement
const ask = async (text: string) => { fireEvent.change(prompt(), { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: 'Ask' })); await waitFor(() => expect(screen.getByTestId('side-chat-status').textContent).not.toBe('Waiting for the answer…')) }
const turns = () => screen.getAllByTestId('side-chat-turn')
let storageWrites: string[]
beforeEach(() => {
  setActiveLocale('en')
  storageWrites = []
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string) => { storageWrites.push(`local:${key}`) }, removeItem: () => {} })
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: (key: string) => { storageWrites.push(`session:${key}`) }, removeItem: () => {} })
  install()
})
afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru') })

describe('ephemeral labelling and storage', () => {
  it('says it is ephemeral before anything is typed, exactly once, and never touches browser storage', async () => {
    render(<SideChatPanel sessionId="s1" />)
    expect(screen.getAllByTestId('side-chat-ephemeral')).toHaveLength(1)
    expect(screen.getByTestId('side-chat-ephemeral').textContent).toBe('Ephemeral')
    expect(screen.getAllByTestId('side-chat-notice')).toHaveLength(1)
    expect(screen.getByTestId('side-chat-notice').textContent).toBe('Private to this tab and outside the session log until you save it.')
    // The longer explanation is one click away, anchored to the panel's info button (D-202).
    fireEvent.click(screen.getByRole('button', { name: 'About side chat' }))
    expect((await screen.findByText(/Reloading or leaving this page discards it unless you save it/)).textContent).toContain('not part of the session log')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(calls).toHaveLength(0)
    await ask('What happened?')
    await ask('And then?')
    expect(storageWrites).toEqual([])
    expect(calls.map(call => call.action)).toEqual(['respond', 'respond'])
  })
  it('asks exactly one question per submit with the whole draft conversation and the chosen context', async () => {
    render(<SideChatPanel sessionId="s/1" />)
    await ask('First?')
    expect(turns()).toHaveLength(2)
    expect(calls[0]!.body).toMatchObject({ messages: [{ role: 'user', text: 'First?' }], context: { include: 'session' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Last turns' }))
    fireEvent.change(screen.getByLabelText('Number of last turns'), { target: { value: '2' } })
    await ask('Second?')
    expect(calls[1]!.body).toMatchObject({ messages: [{ role: 'user', text: 'First?' }, { role: 'assistant', text: 'Side answer' }, { role: 'user', text: 'Second?' }], context: { include: 'session', lastTurns: 2 } })
    fireEvent.click(screen.getByRole('radio', { name: 'No context' }))
    await ask('Third?')
    expect(calls[2]!.body.context).toEqual({ include: 'none' })
    expect(turns()).toHaveLength(6)
    expect(String((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0])).toBe('/api/agent/s%2F1/side-chat/respond')
  })
  it('shows where the answer was read from: log head, turns, bytes and time, never as a bare number', async () => {
    render(<SideChatPanel sessionId="s1" />)
    await ask('q')
    expect(screen.getByText(/Read from the session log up to event 12: 2 turns, 345 bytes, observed/)).toBeTruthy()
    install(() => answer('x', { include: 'none', turns: 0, bytes: 0, excerpted: 2 }))
    await ask('q2')
    expect(screen.getByText(/No session context was sent \(observed.*Prompts read as bounded excerpts: 2/)).toBeTruthy()
  })
  it('says so when the model stopped at its output limit', async () => {
    install(() => answer('cut', {}, true))
    render(<SideChatPanel sessionId="s1" />)
    await ask('q')
    expect(screen.getAllByText('The answer stopped at the model\'s output limit and may be cut short.')).toHaveLength(1)
    install()
    await ask('q2')
    expect(screen.getAllByText('The answer stopped at the model\'s output limit and may be cut short.')).toHaveLength(1)
  })
  it('refuses an invalid number of turns before any request', () => {
    render(<SideChatPanel sessionId="s1" />)
    fireEvent.click(screen.getByRole('radio', { name: 'Last turns' }))
    fireEvent.change(screen.getByLabelText('Number of last turns'), { target: { value: '0' } })
    fireEvent.change(prompt(), { target: { value: 'q' } })
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText('Number of last turns').getAttribute('aria-invalid')).toBe('true')
    expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(true)
    expect(calls).toHaveLength(0)
  })
  it('Enter asks once, Shift+Enter and composition do not, and an empty draft cannot ask', async () => {
    render(<SideChatPanel sessionId="s1" />)
    expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(true)
    fireEvent.change(prompt(), { target: { value: 'q' } })
    expect(fireEvent.keyDown(prompt(), { key: 'Enter', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(prompt(), { key: 'Enter', isComposing: true })).toBe(true)
    expect(calls).toHaveLength(0)
    expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(false)
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    await waitFor(() => expect(turns()).toHaveLength(2))
    expect(calls).toHaveLength(1)
  })
})

describe('failures and cancellation write nothing and keep the conversation', () => {
  it.each([
    ['egress_unavailable', 'still preparing secret protection'], ['model_failed', 'The model did not answer'], ['quota_exhausted', 'quota is exhausted'],
    ['session_unavailable', 'Trash or being removed'], ['budget_exhausted', 'budget for side chats'], ['too_many_requests', 'already answering'], ['connection_unavailable', 'model connection is unavailable'], ['something_else', 'could not complete the request'],
  ])('explains %s once, keeps the question and retries with the same messages', async (code, copy) => {
    let fail = true
    install(call => fail && call.action === 'respond' ? failure(code) : answer('Recovered'))
    render(<SideChatPanel sessionId="s1" />)
    await ask('keep me')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain(code === 'something_else' ? 'agent_unavailable' : code) // an unknown code is normalized, never shown raw
    expect(screen.getByRole('alert').textContent).toContain('POST /api/agent/…/side-chat/respond')
    expect(document.body.textContent).toContain(copy)
    expect(turns()).toHaveLength(1)
    fail = false
    expect(screen.queryAllByRole('button', { name: /retry|try again/iu })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(turns()).toHaveLength(2))
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.messages).toEqual(calls[0]!.body.messages)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(calls.filter(call => call.action !== 'respond')).toHaveLength(0)
  })
  it('names an unreachable node and explains an oversize context with its bound and no retry button', async () => {
    install(() => failure('context_too_large', 413, { bytes: 900, boundBytes: 600, windowTokens: 1000, outputTokens: 400, source: 'catalog' }))
    render(<SideChatPanel sessionId="s1" />)
    await ask('q')
    expect(document.body.textContent).toContain('900 bytes against a bound of 600 bytes (1000 tokens, 400 reserved for the answer; source: catalog)')
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull()
    expect(screen.queryAllByRole('button', { name: /retry|try again/iu })).toHaveLength(0)
    install(() => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await ask('q2')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(document.body.textContent).toContain('node_unreachable')
  })
  it('explains a refused save as too large with its explicit bound, keeps the chat and offers no blind retry', async () => {
    install(call => call.action === 'respond' ? answer('a') : failure('too_large', 413, { bytes: 300000, boundBytes: 262144 }))
    render(<SideChatPanel sessionId="s1" />)
    await ask('q')
    fireEvent.click(screen.getByRole('button', { name: 'Save to session log' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('300000 bytes against the limit of 262144 bytes')
    expect(alert.textContent).toContain('Nothing was saved or truncated')
    expect(screen.queryAllByRole('button', { name: /retry|try again|ask again/iu })).toHaveLength(0)
    expect(turns()).toHaveLength(2)
    expect(screen.getByTestId('side-chat-unsaved').textContent).toBe('Unsaved messages: 2')
  })
  it('Cancel aborts the owned request, keeps the question and reports that nothing was written', async () => {
    let seen: AbortSignal | null | undefined
    install(call => new Promise<Response>((_resolve, reject) => { seen = call.signal; call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))) }))
    render(<SideChatPanel sessionId="s1" />)
    fireEvent.change(prompt(), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByTestId('side-chat-status').textContent).toBe('Waiting for the answer…'))
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByTestId('side-chat-status').textContent).toBe('Canceled. Nothing was written to the session.'))
    expect(document.activeElement).toBe(prompt())
    expect(seen?.aborted).toBe(true)
    expect(turns()).toHaveLength(1)
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })
  it('leaving the page aborts an in-flight question', async () => {
    let seen: AbortSignal | null | undefined
    install(call => new Promise<Response>(() => { seen = call.signal }))
    const view = render(<SideChatPanel sessionId="s1" />)
    fireEvent.change(prompt(), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByTestId('side-chat-status').textContent).toBe('Waiting for the answer…'))
    view.unmount()
    expect(seen?.aborted).toBe(true)
  })
})

describe('Save to session log', () => {
  it('saves once per distinct transcript, reuses the operation for a retry, and disables when saved', async () => {
    let fail = true
    install(call => call.action === 'respond' ? answer('Side answer') : fail ? failure('session_busy', 409)
      : Response.json({ operationId: call.body.operationId, eventId: 'event-1', seq: 13, duplicate: false }))
    render(<SideChatPanel sessionId="s1" />)
    expect((screen.getByRole('button', { name: 'Save to session log' }) as HTMLButtonElement).disabled).toBe(true)
    await ask('q')
    expect(screen.getByTestId('side-chat-unsaved').textContent).toBe('Unsaved messages: 2')
    fireEvent.click(screen.getByRole('button', { name: 'Save to session log' }))
    await screen.findByRole('alert')
    expect(document.body.textContent).toContain('busy for a moment')
    fail = false
    // The failed save keeps its own button: no separate Retry, same operation id.
    expect(screen.queryAllByRole('button', { name: /retry|try again|ask again/iu })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Save to session log' }))
    await screen.findByText('Saved to the session log as event 13. Nothing was sent to the agent.')
    const saves = calls.filter(call => call.action === 'save')
    expect(saves).toHaveLength(2)
    expect(saves[1]!.body.operationId).toBe(saves[0]!.body.operationId)
    expect(saves[1]!.body.messages).toEqual([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'Side answer' }])
    expect(screen.getByTestId('side-chat-unsaved').textContent).toBe('Everything shown is saved to the session log.')
    expect((screen.getByRole('button', { name: 'Save to session log' }) as HTMLButtonElement).disabled).toBe(true)
    expect(calls.filter(call => call.action === 'send')).toHaveLength(0)
    // New turns make a new transcript, so a new operation: saving again is a distinct explicit action.
    await ask('more')
    expect(screen.getByTestId('side-chat-unsaved').textContent).toBe('Unsaved messages: 2')
    fireEvent.click(screen.getByRole('button', { name: 'Save to session log' }))
    await waitFor(() => expect(calls.filter(call => call.action === 'save')).toHaveLength(3))
    expect(calls.filter(call => call.action === 'save')[2]!.body.operationId).not.toBe(saves[0]!.body.operationId)
  })
  it('does not double-save on a rapid second click and reports a duplicate receipt truthfully', async () => {
    install(call => call.action === 'respond' ? answer('a') : Response.json({ operationId: call.body.operationId, eventId: 'event-1', seq: 9, duplicate: true }))
    render(<SideChatPanel sessionId="s1" />)
    await ask('q')
    const button = screen.getByRole('button', { name: 'Save to session log' })
    fireEvent.click(button); fireEvent.click(button)
    await screen.findByText('Already saved as event 9. Nothing new was written.')
    expect(calls.filter(call => call.action === 'save')).toHaveLength(1)
  })
})

describe('Send to main', () => {
  it('posts exactly once per message, with one operation id each, and never saves', async () => {
    render(<SideChatPanel sessionId="s1" />)
    await ask('q')
    const first = screen.getByRole('button', { name: 'Send to main, message 1' })
    fireEvent.click(first); fireEvent.click(first)
    await screen.findByText('Sent to main once: queued behind the running turn.')
    expect(screen.getAllByTestId('side-chat-sent')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Send to main, message 2' }))
    await waitFor(() => expect(screen.getAllByTestId('side-chat-sent')).toHaveLength(2))
    // One persistent live region carries the announcement; the per-message marks are not live.
    expect(screen.getAllByTestId('side-chat-status')).toHaveLength(1)
    expect(screen.getByTestId('side-chat-status').getAttribute('role')).toBe('status')
    expect(screen.getByTestId('side-chat-status').textContent).toBe('Sent to main once: queued behind the running turn.')
    expect(screen.getAllByTestId('side-chat-sent').every(mark => mark.closest('[role="status"], [aria-live]') === null)).toBe(true)
    const sends = calls.filter(call => call.action === 'send')
    expect(sends).toHaveLength(2)
    expect(sends.map(call => call.body.text)).toEqual(['q', 'Side answer'])
    expect(new Set(sends.map(call => call.body.operationId)).size).toBe(2)
    expect((screen.getByRole('button', { name: 'Send to main, message 1' }) as HTMLButtonElement).disabled).toBe(true)
    expect(calls.filter(call => call.action === 'save')).toHaveLength(0)
  })
  it('tells its host once per successful send, and not for a failed one', async () => {
    let fail = true
    install(call => call.action === 'respond' ? answer('a') : fail ? failure('agent_unavailable') : Response.json({ operationId: call.body.operationId, messageId: crypto.randomUUID(), delivery: 'started', duplicate: false }))
    const onSent = vi.fn()
    render(<SideChatPanel sessionId="s1" onSent={onSent} />)
    await ask('q')
    fireEvent.click(screen.getByRole('button', { name: 'Send to main, message 1' }))
    await screen.findByRole('alert')
    expect(onSent).not.toHaveBeenCalled()
    fail = false
    expect(screen.queryAllByRole('button', { name: /retry|try again|ask again/iu })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Send to main, message 1' }))
    await screen.findByText('Sent to main once: started a new turn.')
    expect(onSent).toHaveBeenCalledTimes(1)
  })
  it('reuses the operation id when a failed send is retried', async () => {
    let fail = true
    install(call => call.action === 'respond' ? answer('a') : fail ? failure('agent_unavailable') : Response.json({ operationId: call.body.operationId, messageId: crypto.randomUUID(), delivery: 'already_sent', duplicate: true }))
    render(<SideChatPanel sessionId="s1" />)
    await ask('q')
    fireEvent.click(screen.getByRole('button', { name: 'Send to main, message 2' }))
    await screen.findByRole('alert')
    expect((screen.getByRole('button', { name: 'Send to main, message 2' }) as HTMLButtonElement).disabled).toBe(false)
    fail = false
    expect(screen.queryAllByRole('button', { name: /retry|try again|ask again/iu })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Send to main, message 2' }))
    await screen.findByText('Already sent to main earlier. Nothing new was posted.')
    const sends = calls.filter(call => call.action === 'send')
    expect(sends).toHaveLength(2)
    expect(sends[1]!.body.operationId).toBe(sends[0]!.body.operationId)
  })
})

describe('discarding and reload warning', () => {
  it('asks before discarding unsaved messages, keeps on Keep, clears everything on Discard, and discards a saved chat at once', async () => {
    render(<SideChatPanel sessionId="s1" />)
    await ask('q')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const group = screen.getByRole('group', { name: 'Discard' })
    expect(within(group).getByText('Discard 2 unsaved messages? They cannot be recovered.')).toBeTruthy()
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Keep' }))
    expect(group.getAttribute('aria-describedby')).toBe(within(group).getByText('Discard 2 unsaved messages? They cannot be recovered.').id)
    fireEvent.keyDown(group, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard' })))
    expect(screen.queryByRole('group', { name: 'Discard' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Discard' })).getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard' })))
    expect(turns()).toHaveLength(2)
    expect(screen.queryByRole('group', { name: 'Discard' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved messages' }))
    expect(screen.queryAllByTestId('side-chat-turn')).toHaveLength(0)
    expect(screen.getByText('Nothing yet. Ask a question about this session.')).toBeTruthy()
    expect(document.activeElement).toBe(prompt())
    await ask('again')
    fireEvent.click(screen.getByRole('button', { name: 'Save to session log' }))
    await screen.findByText(/Saved to the session log as event 13/)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('group', { name: 'Discard' })).toBeNull()
    expect(screen.queryAllByTestId('side-chat-turn')).toHaveLength(0)
  })
  it('warns before a reload only while something unsaved exists', async () => {
    const blocked = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }
    render(<SideChatPanel sessionId="s1" />)
    expect(blocked()).toBe(false)
    await ask('q')
    expect(blocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save to session log' }))
    await screen.findByText(/Saved to the session log as event 13/)
    expect(blocked()).toBe(false)
  })
})

describe('locale', () => {
  it('keeps placeholders identical in English and Russian', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const key of Object.keys(sideChatEnglish) as (keyof typeof sideChatEnglish)[]) {
      expect(sideChatRussian[key].trim().length, key).toBeGreaterThan(0)
      expect(placeholders(sideChatRussian[key]), key).toEqual(placeholders(sideChatEnglish[key]))
    }
  })
  it('renders the label and notice in Russian without leaking keys', async () => {
    setActiveLocale('ru')
    render(<SideChatPanel sessionId="s1" />)
    expect(screen.getByTestId('side-chat-ephemeral').textContent).toBe('Временный')
    expect(screen.getByTestId('side-chat-notice').textContent).toContain('вне журнала сессии')
    expect(document.body.textContent).not.toMatch(/sideChat\.|translation variables mismatch|missing translation/)
    await act(async () => { fireEvent.change(screen.getByLabelText('Спросите об этой сессии'), { target: { value: 'вопрос' } }) })
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))
    await screen.findByText('Side answer')
    expect(document.body.textContent).not.toMatch(/sideChat\.|translation variables mismatch|missing translation/)
  })
})

describe('inspector rendering of a saved side chat', () => {
  const note = (text: string) => ({ id: 'e', seq: 4, version: 1, type: 'agent.note', class: 'standard', data: { text }, createdAt: OBSERVED, spanId: null, parentSpanId: null, jobId: null, jobSequence: null, writerEpoch: 1, redactions: 0 }) as unknown as SessionEvent
  it('renders the saved transcript for people and leaves every other note as it was', () => {
    setActiveLocale('en')
    const saved = eventDetail(note(encodeSideChatSavedNote('11111111-1111-4111-8111-111111111111', [{ role: 'user', text: 'Q?' }, { role: 'assistant', text: 'A.' }])))
    expect(saved).toBe('Saved side chat: 2 messages, history only, never sent to the agent\nYou: Q?\nSide chat: A.')
    expect(eventDetail(note('{"relay":"cap"}'))).toBe('{"relay":"cap"}')
    expect(eventDetail(note('plain'))).toBe('plain')
  })
})
