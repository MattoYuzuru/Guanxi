import { expect, test } from '@playwright/test'
import { installChatApiFixture } from './fixtures/chat-api.ts'
test('native session keyboard creation and progress replay have exact counts on desktop/mobile with reduced motion', async ({ page }) => {
  await installChatApiFixture(page, 'completed')
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    const id = '11111111-1111-4111-8111-111111111111'
    const progress = { sessionId: id, projectId: 'p', connectionId: id, model: 'fixture', mode: 'read-only', status: 'completed',
      plan: [{ text: 'Fixture item', status: 'verification_requested' }], queue: [], summary: 'Fixture response', error: null,
      source: 'session.log', confidence: 'high', observedAt: '2026-10-21T00:00:00.000Z' }
    window.fetch = async (input, init) => {
      const path = String(input)
      if (path === '/api/agent/projects') return Response.json({ projects: [{ id: 'p', name: 'Fixture project', filesystemBindings: [] }] })
      if (path === '/api/connections') return Response.json({ connections: [{ id, accountId: 'local', name: 'Fixture model', kind: 'model_api', provider: 'deepseek', auth: 'api_key',
        unattended: false, secretRef: null, facts: {}, balance: null, createdAt: '2026-10-21T00:00:00.000Z' }], costs: [], vault: { unlocked: false, unattendedAvailable: false } })
      if (path === '/api/agent' && init?.method === 'POST') {
        const values = JSON.parse(String(init.body))
        if (values.mode !== 'read-only' || values.projectId !== 'p') return Response.json({ code: 'invalid' }, { status: 400 })
        return Response.json({ sessionId: id }, { status: 202 })
      }
      if (path === `/api/agent/${id}`) return Response.json(progress)
      return original(input, init)
    }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/agent')
  await page.getByLabel('Проект', { exact: true }).selectOption('p')
  await page.getByLabel('Подключение', { exact: true }).selectOption('11111111-1111-4111-8111-111111111111')
  await page.getByLabel('ID модели', { exact: true }).fill('fixture')
  await page.getByLabel('Что должен сделать агент?', { exact: true }).fill('Inspect')
  await expect(page.getByText('Без папок · запись только в scratch', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Начать сессию', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/agent\/11111111/)
  await expect(page.getByText('Fixture response', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('listitem').filter({ hasText: 'Fixture item' })).toHaveCount(1)
  await page.reload()
  await expect(page.getByText('Fixture response', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('listitem').filter({ hasText: 'Fixture item' })).toHaveCount(1)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
