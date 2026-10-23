/**
 * Ephemeral side chat (D-135). The mock node keeps a session log and answers the three side-chat
 * routes exactly as the real node does: `respond` never appends, `save` appends one note and
 * `send` one prompt, both idempotent per operation id. The spec queries that log through the
 * session events route before and after each action (U1 exit gate: an unsaved side chat leaves
 * no event, exact counts). The real node's zero-write property is proven by
 * packages/server/test/native-agent/side-chat.test.ts; this spec proves the UI sends nothing
 * durable except on the two explicit actions, and says so before a reload discards it.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { completedProgress, createSessionFeaturesFixture, installSessionFeaturesApi, type SessionFeaturesFixture } from './fixtures/session-features-api.ts'

interface MockLog {
  events: { seq: number; id: string; type: string; data: Record<string, unknown> }[]
  respond: number; save: number; send: number
  saved: Map<string, number>; sent: Map<string, number>
  holdRespond: Promise<void> | null
  respondAborted: number
}
function createLog(): MockLog {
  return { events: [{ seq: 1, id: 'e1', type: 'agent.policy', data: {} }, { seq: 2, id: 'e2', type: 'prompt', data: { messageId: 'p1', text: 'fixture prompt' } }, { seq: 3, id: 'e3', type: 'assistant.message', data: { text: 'fixture response' } }],
    respond: 0, save: 0, send: 0, saved: new Map(), sent: new Map(), holdRespond: null, respondAborted: 0 }
}
function withLog(log: MockLog): Partial<SessionFeaturesFixture> {
  return {
    progress: { s1: completedProgress('s1') },
    extra: async (route, url, method) => {
      const side = /^\/api\/agent\/s1\/side-chat\/(respond|save|send)$/u.exec(url.pathname)
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (url.pathname === '/api/sessions/s1/events' && method === 'GET') {
        return void await json({ sessionId: 's1', events: log.events, nextAfter: log.events.length, lastSeq: log.events.length, hasMore: false }) ?? true
      }
      if (!side) return false
      const body = route.request().postDataJSON() as { operationId?: string; text?: string; requestId?: string; messages?: { role: string; text: string }[] }
      if (side[1] === 'respond') {
        log.respond++
        if (log.holdRespond) await log.holdRespond
        const question = body.messages?.at(-1)?.text ?? ''
        await json({ requestId: body.requestId, text: `Answer to: ${question}`, truncated: false, context: { source: 'session.log', include: 'session', upToSeq: log.events.length, observedAt: '2026-10-23T10:00:00.000Z', turns: 1, excerpted: 0, bytes: 40 } })
      } else if (side[1] === 'save') {
        log.save++
        const known = log.saved.get(body.operationId!)
        if (known === undefined) {
          const seq = log.events.length + 1
          log.events.push({ seq, id: `e${seq}`, type: 'agent.note', data: { text: JSON.stringify({ sideChat: 'saved', operationId: body.operationId, messages: body.messages }) } })
          log.saved.set(body.operationId!, seq)
        }
        await json({ operationId: body.operationId, eventId: `e${log.saved.get(body.operationId!)}`, seq: log.saved.get(body.operationId!), duplicate: known !== undefined })
      } else {
        log.send++
        const known = log.sent.get(body.operationId!)
        if (known === undefined) {
          const seq = log.events.length + 1
          log.events.push({ seq, id: `e${seq}`, type: 'prompt', data: { messageId: `m-${body.operationId}`, text: body.text } })
          log.sent.set(body.operationId!, seq)
        }
        await json({ operationId: body.operationId, messageId: crypto.randomUUID(), delivery: known === undefined ? 'queued' : 'already_sent', duplicate: known !== undefined }, 202)
      }
      return true
    },
  }
}
async function open(page: Page, log: MockLog, overrides: Partial<SessionFeaturesFixture> = {}) {
  const fixture = createSessionFeaturesFixture({ ...withLog(log), ...overrides })
  await installSessionFeaturesApi(page, fixture)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/agent/s1')
  await openPanel(page, overrides.locale ?? 'en')
  return fixture
}
/** Side chat is a side panel toggled from the session header; it starts closed. */
async function openPanel(page: Page, locale: 'en' | 'ru' = 'en') {
  const toggle = page.getByRole('button', { name: locale === 'en' ? 'Side chat' : 'Боковой чат', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('side-chat-panel')).toBeVisible()
}
const sessionLog = (page: Page) => page.evaluate(async () => {
  const body = await (await fetch('/api/sessions/s1/events?after=0')).json() as { lastSeq: number; events: { type: string }[] }
  return { lastSeq: body.lastSeq, count: body.events.length, byType: body.events.reduce<Record<string, number>>((all, event) => ({ ...all, [event.type]: (all[event.type] ?? 0) + 1 }), {}) }
})
const panel = (page: Page) => page.getByTestId('side-chat-panel')
const ask = async (page: Page, text: string) => {
  await page.getByLabel('Ask about this session').fill(text)
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(panel(page).getByText(`Answer to: ${text}`, { exact: true })).toHaveCount(1)
}
async function serious(page: Page): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations.filter(item => item.impact === 'serious' || item.impact === 'critical').flatMap(item => item.nodes.map(node => `${item.id}: ${node.target.join(' ')}`))
}

test('an unsaved side chat leaves the session log untouched (exact counts), says it is ephemeral first, and reload discards it', async ({ page }) => {
  const log = createLog()
  await open(page, log)
  await expect(page.getByTestId('side-chat-ephemeral')).toHaveText('Ephemeral')
  await expect(page.getByTestId('side-chat-notice')).toHaveText('Private to this tab and outside the session log until you save it.')
  await panel(page).getByRole('button', { name: 'About side chat', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Side chat' })).toContainText('Reloading or leaving this page discards it unless you save it')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  const before = await sessionLog(page)
  expect(before).toEqual({ lastSeq: 3, count: 3, byType: { 'agent.policy': 1, prompt: 1, 'assistant.message': 1 } })

  await ask(page, 'Why did it finish early?')
  await ask(page, 'What did it change?')
  await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(4)
  expect({ respond: log.respond, save: log.save, send: log.send }).toEqual({ respond: 2, save: 0, send: 0 })
  expect(await sessionLog(page)).toEqual(before)
  await expect(page.getByTestId('side-chat-unsaved')).toHaveText('Unsaved messages: 4')

  // Nothing is kept in the browser either.
  const storage = await page.evaluate(async () => ({
    local: Object.entries(localStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
    session: Object.entries(sessionStorage).map(([key, value]) => `${key}=${value}`).join('\n'),
    databases: (await indexedDB.databases()).map(database => database.name),
  }))
  expect(storage.local + storage.session).not.toContain('Why did it finish early')
  expect(storage.local + storage.session).not.toContain('Answer to')
  expect(storage.databases).toEqual([])

  // The page warns before an unsaved chat is lost, and only then.
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(true)
  await page.reload()
  await openPanel(page)
  await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(0)
  await expect(panel(page).getByText('Nothing yet. Ask a question about this session.', { exact: true })).toHaveCount(1)
  expect(await sessionLog(page)).toEqual(before)
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(false)
})

test('Save appends exactly one note, once; Send posts exactly one prompt, once; neither does the other', async ({ page }) => {
  const log = createLog()
  await open(page, log)
  await ask(page, 'Summarize the plan')
  const before = await sessionLog(page)

  const save = panel(page).getByRole('button', { name: 'Save to session log', exact: true })
  await save.click()
  await expect(page.getByTestId('side-chat-status')).toHaveText('Saved to the session log as event 4. Nothing was sent to the agent.')
  await expect(save).toBeDisabled()
  await expect(page.getByTestId('side-chat-status')).toBeFocused() // focus moved off the control the save disabled
  expect(await sessionLog(page)).toEqual({ lastSeq: 4, count: 4, byType: { ...before.byType, 'agent.note': 1 } })
  expect({ save: log.save, send: log.send }).toEqual({ save: 1, send: 0 })
  await expect(page.getByTestId('side-chat-unsaved')).toHaveText('Everything shown is saved to the session log.')

  const send = panel(page).getByRole('button', { name: 'Send to main, message 2' })
  await send.dblclick()
  await expect(page.getByTestId('side-chat-status')).toHaveText('Sent to main once: queued behind the running turn.')
  await expect(panel(page).getByTestId('side-chat-sent')).toHaveCount(1)
  await expect(send).toBeDisabled()
  expect(await sessionLog(page)).toEqual({ lastSeq: 5, count: 5, byType: { ...before.byType, 'agent.note': 1, prompt: 2 } })
  expect({ save: log.save, send: log.send, notes: log.events.filter(event => event.type === 'agent.note').length }).toEqual({ save: 1, send: 1, notes: 1 })
  expect(log.events.at(-1)?.data.text).toBe('Answer to: Summarize the plan')

  // Another turn is a new transcript: saving it again is a new explicit action with a new operation.
  await ask(page, 'And the risks?')
  await expect(page.getByTestId('side-chat-unsaved')).toHaveText('Unsaved messages: 2')
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByTestId('side-chat-status')).toHaveText('Saved to the session log as event 6. Nothing was sent to the agent.')
  expect((await sessionLog(page)).byType['agent.note']).toBe(2)
  expect(log.saved.size).toBe(2)
  // Saved chats are discarded without a warning; the log keeps them across reload.
  await page.reload()
  await openPanel(page)
  await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(0)
  expect((await sessionLog(page)).count).toBe(6)
})

test('a failed Save keeps the chat and its retry reuses the operation: one note after any number of attempts', async ({ page }) => {
  const log = createLog()
  let failNext = 2
  const fixture = await open(page, log)
  const inner = fixture.extra!
  fixture.extra = async (route, url, method) => {
    if (url.pathname === '/api/agent/s1/side-chat/save' && failNext > 0) {
      failNext--
      log.save++
      // The first failure is a lost response: the note IS appended but the client never learns.
      if (failNext === 1) {
        const body = route.request().postDataJSON() as { operationId: string; messages: unknown }
        const seq = log.events.length + 1
        log.events.push({ seq, id: `e${seq}`, type: 'agent.note', data: { text: JSON.stringify({ sideChat: 'saved', operationId: body.operationId, messages: body.messages }) } })
        log.saved.set(body.operationId, seq)
      }
      await route.abort('connectionreset')
      return true
    }
    return inner(route, url, method)
  }
  await ask(page, 'Question')
  await panel(page).getByRole('button', { name: 'Save to session log', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText('node_unreachable')
  await expect(page.getByRole('alert')).toContainText('saving or sending it again cannot duplicate it')
  await expect(panel(page).getByRole('button', { name: /retry|try again/iu })).toHaveCount(0)
  await panel(page).getByRole('button', { name: 'Save to session log', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await panel(page).getByRole('button', { name: 'Save to session log', exact: true }).click()
  await expect(page.getByTestId('side-chat-status')).toHaveText('Already saved as event 4. Nothing new was written.')
  expect(log.save).toBe(3)
  expect((await sessionLog(page)).byType['agent.note']).toBe(1)
  await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(2)
})

test('Cancel aborts the question, keeps it, and the session log is untouched', async ({ page }) => {
  const log = createLog()
  let release!: () => void
  log.holdRespond = new Promise<void>(resolve => { release = resolve })
  await open(page, log)
  const before = await sessionLog(page)
  await page.getByLabel('Ask about this session').fill('Slow one')
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(page.getByTestId('side-chat-status')).toHaveText('Waiting for the answer…')
  await expect(panel(page).getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1)
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByTestId('side-chat-status')).toHaveText('Canceled. Nothing was written to the session.')
  await expect(page.getByLabel('Ask about this session')).toBeFocused()
  await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  release()
  expect(await sessionLog(page)).toEqual(before)
  expect({ save: log.save, send: log.send }).toEqual({ save: 0, send: 0 })
})

test('keyboard: ask with Enter, reach every action by Tab, and the discard confirmation takes focus', async ({ page }) => {
  const log = createLog()
  await open(page, log)
  const prompt = page.getByLabel('Ask about this session')
  await prompt.focus()
  await page.keyboard.type('Keyboard question')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second line')
  await page.keyboard.press('Enter')
  await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(2)
  expect(log.respond).toBe(1)
  expect(await prompt.inputValue()).toBe('')
  const names: string[] = []
  await panel(page).getByRole('button', { name: 'Send to main, message 1' }).focus()
  for (let step = 0; step < 5; step++) {
    names.push(await page.evaluate(() => {
      const element = document.activeElement as HTMLInputElement | null
      return (element?.getAttribute('aria-label') ?? element?.labels?.[0]?.textContent ?? element?.textContent ?? '').trim()
    }))
    await page.keyboard.press('Tab')
  }
  // The disabled Ask button (empty draft) is skipped; Save and Discard follow the composer.
  expect(names).toEqual(['Send to main, message 1', 'Send to main, message 2', 'Ask about this session', 'Save to session log', 'Discard'])
  await panel(page).getByRole('button', { name: 'Discard', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(panel(page).getByRole('button', { name: 'Keep' })).toBeFocused()
  await expect(panel(page).getByRole('group', { name: 'Discard' })).toHaveAccessibleDescription('Discard 2 unsaved messages? They cannot be recovered.')
  await page.keyboard.press('Escape')
  await expect(panel(page).getByRole('button', { name: 'Discard', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter') // Keep
  await expect(panel(page).getByRole('button', { name: 'Discard', exact: true })).toBeFocused()
  await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(2)
  await panel(page).getByRole('button', { name: 'Discard', exact: true }).click()
  await panel(page).getByRole('button', { name: 'Discard unsaved messages' }).click()
  await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(0)
  await expect(prompt).toBeFocused()
})

test('every state has no critical or serious axe finding, in both themes and locales', async ({ page }) => {
  for (const { locale, theme } of [{ locale: 'en', theme: 'light' }, { locale: 'en', theme: 'dark' }, { locale: 'ru', theme: 'light' }, { locale: 'ru', theme: 'dark' }] as const) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    const log = createLog()
    await open(page, log, { locale, theme })
    expect(await serious(page), `${locale}/${theme} empty`).toEqual([])
    const ask_ = locale === 'en' ? 'Ask about this session' : 'Спросите об этой сессии'
    await page.getByLabel(ask_).fill('Question')
    await page.getByRole('button', { name: locale === 'en' ? 'Ask' : 'Спросить', exact: true }).click()
    await expect(panel(page).getByTestId('side-chat-turn')).toHaveCount(2)
    await panel(page).getByRole('button', { name: locale === 'en' ? 'Send to main, message 2' : 'Отправить в основной чат, сообщение 2' }).click()
    await expect(page.getByTestId('side-chat-status')).not.toHaveText('')
    expect(await serious(page), `${locale}/${theme} turns and receipt`).toEqual([])
    await panel(page).getByRole('button', { name: locale === 'en' ? 'Discard' : 'Сбросить', exact: true }).click()
    await expect(panel(page).getByRole('group')).toHaveCount(1)
    expect(await serious(page), `${locale}/${theme} discard confirmation`).toEqual([])
  }
})

test('errors are single and accessible; phone width and large text do not overflow', async ({ page }) => {
  const log = createLog()
  const fixture = await open(page, log)
  const inner = fixture.extra!
  fixture.extra = async (route, url, method) => {
    if (url.pathname === '/api/agent/s1/side-chat/respond') {
      await route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ code: 'context_too_large', details: { bytes: 700000, boundBytes: 616000, windowTokens: 1000000, outputTokens: 384000, source: '@earendil-works/pi-ai catalog' } }) })
      return true
    }
    return inner(route, url, method)
  }
  await page.setViewportSize({ width: 320, height: 800 })
  await page.getByLabel('Ask about this session').fill('Too much '.repeat(40))
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText('context_too_large')
  await expect(panel(page)).toContainText('700000 bytes against a bound of 616000 bytes')
  await expect(panel(page).getByRole('button', { name: /retry|try again|ask again/iu })).toHaveCount(0)
  expect(await serious(page), 'error').toEqual([])
  const fits = async (label: string) => {
    const measured = await page.evaluate(() => {
      const host = document.querySelector('[data-slot="shell-route-host"]')
      const box = document.querySelector('[data-testid="side-chat-panel"]')!.getBoundingClientRect()
      return { document: document.documentElement.scrollWidth - innerWidth, host: host ? host.scrollWidth - host.clientWidth : 0, panelRight: box.right - innerWidth }
    })
    expect(measured.document, `${label} document`).toBeLessThanOrEqual(0)
    expect(measured.host, `${label} route host`).toBeLessThanOrEqual(1)
    expect(measured.panelRight, `${label} panel`).toBeLessThanOrEqual(1)
    // Radio segments carry a visually hidden, aria-hidden native input for forms; it is not a target.
    const small = await panel(page).locator('button, select, input, textarea').evaluateAll(elements => elements.filter(element => { const box = element.getBoundingClientRect(); return element.getAttribute('aria-hidden') !== 'true' && box.width > 0 && (box.height < 24 || box.width < 24) }).length)
    expect(small, `${label} targets under 24 px`).toBe(0)
  }
  await fits('phone 320')
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await fits('phone at 200% text')
  expect(await serious(page), 'phone at 200% text').toEqual([])
})
