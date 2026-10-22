import { SESSION_ROUTES } from '@guanxi/contract'
import { expect, test, type Page, type Route } from '@playwright/test'
import { activeRuntimeBrowserSnapshot, browserSettings } from './fixtures/runtime-snapshot.ts'
import { choosePaletteCommand } from './fixtures/shell-navigation.ts'

type OwnerMode = 'job' | 'operation' | 'unknown'

type FixtureControl = {
  owner: OwnerMode
  cancelFails: boolean
  runtimeCalls: number
  cancelCalls: number
  messageCalls: number
  messageBodies: unknown[]
}

const observedAt = '2026-08-02T12:00:00.000Z'
const threadId = 'thread-resource-conflict'
const activeJobId = 'job-browser-active'
const queuedJobId = '33333333-3333-4333-8333-333333333333'

async function installFixture(
  page: Page,
  owner: OwnerMode = 'job',
  cancelFails = false,
): Promise<FixtureControl> {
  const control: FixtureControl = {
    owner,
    cancelFails,
    runtimeCalls: 0,
    cancelCalls: 0,
    messageCalls: 0,
    messageBodies: [],
  }
  let activeJobReads = 0

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    if (url.pathname === '/api/health') return fulfillJson(route, health())
    if (url.pathname === SESSION_ROUTES.page()) {
      return fulfillJson(route, { sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } })
    }
    if (url.pathname === '/api/runtime') {
      control.runtimeCalls += 1
      return fulfillJson(route, runtimeSnapshot(control))
    }
    if (url.pathname === '/api/models') return fulfillJson(route, { models: [] })
    if (url.pathname === '/api/workspaces') return fulfillJson(route, { workspaces: [] })
    if (url.pathname === '/api/settings') return fulfillJson(route, settings())
    if (url.pathname === '/api/threads' && method === 'GET') {
      return fulfillJson(route, {
        ownershipVersion: 1,
        scope: 'projectless',
        chats: [{
          ...thread(control.messageCalls > 0 ? 2 : 0),
          ownershipVersion: 1,
          projectId: null,
        }],
      })
    }
    if (url.pathname === `/api/threads/${threadId}` && method === 'GET') {
      return fulfillJson(route, {
        thread: thread(control.messageCalls > 0 ? 2 : 0),
        messages: control.messageCalls > 0 ? pendingMessages() : [],
        context: context(),
      })
    }
    if (url.pathname === `/api/threads/${threadId}/messages` && method === 'POST') {
      control.messageCalls += 1
      control.messageBodies.push(request.postDataJSON())
      const start = {
        type: 'start',
        seq: 0,
        data: {
          messageId: 'assistant-resource-conflict',
          model: 'requested:latest',
          step: 0,
          status: 'pending',
          jobId: queuedJobId,
        },
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify(start)}\n\n`,
      })
    }
    if (url.pathname === `/api/jobs/${activeJobId}` && method === 'GET') {
      activeJobReads += 1
      const cancelAccepted = control.cancelFails
        ? control.cancelCalls > 1
        : control.cancelCalls > 0
      return fulfillJson(
        route,
        { job: job(activeJobReads > 1 && cancelAccepted ? 'cancelled' : 'generating') },
      )
    }
    if (url.pathname === `/api/jobs/${activeJobId}/cancel` && method === 'POST') {
      control.cancelCalls += 1
      if (control.cancelFails && control.cancelCalls === 1) {
        return fulfillJson(
          route,
          {
            code: 'internal_error',
            message: 'raw provider body /private/path token=secret',
            details: null,
          },
          500,
        )
      }
      return fulfillJson(route, { job: job('cancelling') })
    }
    if (url.pathname === `/api/jobs/${queuedJobId}` && method === 'GET') {
      return fulfillJson(route, { job: queuedJob() })
    }
    if (url.pathname === `/api/jobs/${queuedJobId}/events` && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    }

    return fulfillJson(
      route,
      { code: 'internal_error', message: `Unhandled fixture route ${method} ${url.pathname}`, details: null },
      500,
    )
  })

  return control
}

test('literal Queue flow is one command and remains keyboard/responsive safe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const control = await installFixture(page)
  await page.goto(`/chat/${threadId}`)

  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.fill('Queue this exact prompt')
  await composer.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Конфликт ресурсов перед отправкой' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('browser-active:latest')
  await expect(dialog).toContainText('Позиция 1')
  await expect(dialog).toContainText('Позиция 2')
  await expect(dialog).toContainText('16k')
  await expect(dialog).not.toContainText('Parallel')
  await expect(page.locator('#root')).toHaveAttribute('inert', '')
  const queue = dialog.getByRole('button', { name: 'Поставить после текущей' })
  await expect(queue).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Закрыть выбор действия с ресурсами' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(composer).toBeFocused()
  expect(control.messageCalls).toBe(0)
  expect(control.cancelCalls).toBe(0)

  await composer.press('Enter')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Поставить после текущей' }).dblclick()
  await expect(dialog).toBeHidden()
  await expect.poll(() => control.messageCalls).toBe(1)
  expect(control.cancelCalls).toBe(0)
  expect(control.messageBodies).toHaveLength(1)
  expect(control.messageBodies[0]).toMatchObject({
    content: 'Queue this exact prompt',
    idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
  })

  const runtime = page.getByRole('region', { name: 'Runtime и ресурсы' })
  await runtime.getByRole('button', { name: 'Повторить runtime-проверку' }).click()
  await runtime.getByText('Показать сведения о runtime').click()
  await expect(runtime).toContainText('Position 3'.replace('Position', 'Позиция'))

  await page.getByRole('link', { name: 'Настройки' }).click()
  await expect(page).toHaveURL(/\/settings$/u)
  await choosePaletteCommand(page, 'Чат')
  await expect(page).toHaveURL(/\/chat$/u)
  expect(control.cancelCalls).toBe(0)

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }))
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.reducedMotion).toBe(true)
})

test('exact Job Stop waits for terminal acknowledgement and dispatches once', async ({ page }) => {
  const control = await installFixture(page)
  await page.goto(`/chat/${threadId}`)
  await page.getByRole('textbox', { name: 'Сообщение' }).fill('Switch after exact cancel')
  await page.getByRole('button', { name: 'Отправить' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Остановить текущую и переключиться' }).click()
  await expect(dialog.getByText(/Ждём terminal-подтверждение/u)).toBeVisible()
  await expect(dialog).toBeHidden()
  await expect.poll(() => control.cancelCalls).toBe(1)
  await expect.poll(() => control.messageCalls).toBe(1)
})

test('operation and unknown owners never expose a guessed Stop action', async ({ page }) => {
  const control = await installFixture(page, 'operation')
  await page.goto(`/chat/${threadId}`)
  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.fill('Keep operation owner safe')
  await composer.press('Enter')
  const dialog = page.getByRole('dialog')
  const stop = dialog.getByRole('button', { name: 'Остановить текущую и переключиться' })
  await expect(stop).toBeDisabled()
  await expect(dialog).toContainText('process-local runtime operation')
  await page.keyboard.press('Escape')

  control.owner = 'unknown'
  await composer.press('Enter')
  await expect(dialog).toBeVisible()
  await expect(stop).toBeDisabled()
  await expect(dialog).toContainText('точный владелец active public Job неизвестен')
  expect(control.cancelCalls).toBe(0)
  expect(control.messageCalls).toBe(0)
})

test('cancel failure is redacted and retries only after a second activation', async ({ page }) => {
  const control = await installFixture(page, 'job', true)
  await page.goto(`/chat/${threadId}`)
  await page.getByRole('textbox', { name: 'Сообщение' }).fill('Retry explicit cancel')
  await page.getByRole('button', { name: 'Отправить' }).click()
  const dialog = page.getByRole('dialog')
  const stop = dialog.getByRole('button', { name: 'Остановить текущую и переключиться' })
  await stop.click()
  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('снова явно активируйте Stop')
  await expect(alert).not.toContainText('provider body')
  expect(control.cancelCalls).toBe(1)
  expect(control.messageCalls).toBe(0)

  await stop.click()
  await expect(dialog).toBeHidden()
  expect(control.cancelCalls).toBe(2)
  expect(control.messageCalls).toBe(1)
})

function runtimeSnapshot(control: FixtureControl) {
  const snapshot = activeRuntimeBrowserSnapshot()
  if (control.owner === 'operation' && snapshot.governor.activeLease) {
    snapshot.governor.activeLease.owner = {
      kind: 'operation',
      operationId: 'operation-browser-owner',
    }
  }
  if (control.owner === 'unknown') snapshot.governor.activeLease = null
  if (control.messageCalls > 0) {
    snapshot.governor.queued.push({
      ticketId: 'ticket-browser-chat-b',
      owner: { kind: 'job', jobId: queuedJobId },
      operation: 'chat',
      model: { provider: 'ollama', name: 'requested:latest' },
      requestedContext: 8_192,
      priority: 'normal',
      enqueuedAt: observedAt,
      reason: 'fifo_predecessor',
    })
  }
  return snapshot
}

function health() {
  return {
    ok: true,
    appVersion: 'test',
    application: { state: 'reachable', source: 'application_http', observedAt },
    ollama: {
      installed: true,
      installSource: 'runtime_response',
      running: true,
      state: 'reachable',
      source: 'ollama_api_version',
      observedAt,
      version: 'test',
      host: 'http://127.0.0.1:11434',
      installHint: null,
    },
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
      totalMemoryBytes: 16_000_000_000, usableMemoryBytes: 12_000_000_000,
      accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true,
      freeDiskBytes: 100_000_000_000,
    },
    network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
  }
}

function settings() {
  return browserSettings({
    ollamaHost: 'http://127.0.0.1:11434', defaultModel: null, defaultNumCtx: 8_192,
    autoApproveTools: false, enableBash: false,
  })
}

function thread(messageCount: number) {
  return {
    id: threadId, title: 'Resource conflict Chat B', mode: 'chat', model: 'requested:latest',
    workspaceId: null, options: { numCtx: 8_192, temperature: 0.7, think: 'off' },
    createdAt: observedAt, updatedAt: observedAt, messageCount,
  }
}

function context() {
  return {
    usedTokens: 0, allocatedTokens: 8_192, percent: 0, cacheHit: false,
    cachedTokens: 0, compactable: false, estimatedRepefillMs: 0,
  }
}

function pendingMessages() {
  return [
    {
      id: 'user-resource-conflict', threadId, jobId: queuedJobId, role: 'user',
      content: 'queued prompt', thinking: null, toolCalls: [], usage: null,
      createdAt: observedAt, isCompaction: false, turnStatus: null, turnError: null,
      stopReason: null,
    },
    {
      id: 'assistant-resource-conflict', threadId, jobId: queuedJobId, role: 'assistant',
      content: '', thinking: null, toolCalls: [], usage: null, createdAt: observedAt,
      isCompaction: false, turnStatus: 'pending', turnError: null, stopReason: null,
    },
  ]
}

function job(status: 'generating' | 'cancelling' | 'cancelled') {
  return {
    id: activeJobId, kind: 'inference', operation: 'chat', status,
    phase: status === 'cancelled' ? null : status,
    idempotencyScope: 'chat:thread-a:send:v1',
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: observedAt, startedAt: observedAt,
    finishedAt: status === 'cancelled' ? '2026-08-02T12:00:01.000Z' : null,
    error: null, outcome: null, stopReason: status === 'cancelled' ? 'user_requested' : null,
    lastEventSequence: status === 'cancelled' ? 3 : 2,
  }
}

function queuedJob() {
  return {
    id: queuedJobId, kind: 'inference', operation: 'chat', status: 'queued', phase: null,
    idempotencyScope: `chat:${threadId}:send:v1`,
    idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    createdAt: observedAt, startedAt: null, finishedAt: null,
    error: null, outcome: null, stopReason: null, lastEventSequence: 1,
  }
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}
