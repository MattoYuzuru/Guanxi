import { expect, test } from '@playwright/test'
import { installChatApiFixture } from './fixtures/chat-api.ts'

test('Connections handles timestamp-free balances, keyboard creation, reload and mobile Russian layout', async ({ page }) => {
  await installChatApiFixture(page, 'completed')
  const rows = [{ id: '11111111-1111-4111-8111-111111111111', accountId: 'local', name: 'Fixture connection', kind: 'model_api', provider: 'deepseek', auth: 'api_key', unattended: false,
    secretRef: null, facts: {}, createdAt: '2026-10-20T00:00:00.000Z', balance: { amount: 99999, currency: 'USD', source: 'fixture', confidence: 'high' } }]
  const inputs: Record<string, unknown>[] = []
  // The legacy fixture intercepts fetch in the page; intercept K3 before its fallback.
  await page.addInitScript(({ initial }) => {
    const fixtureFetch = window.fetch.bind(window)
    const connections = initial
    const inputs: Record<string, unknown>[] = []
    Object.assign(window, { __k3Inputs: inputs })
    window.fetch = async (input, init) => {
      if (String(input) === '/api/connections') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)); inputs.push(body)
          connections.push({ ...connections[0], ...body, id: '22222222-2222-4222-8222-222222222222', unattended: false, balance: null })
          return Response.json(connections.at(-1), { status: 201 })
        }
        return Response.json({ connections, costs: [], vault: { unlocked: false, unattendedAvailable: false } })
      }
      return fixtureFetch(input, init)
    }
  }, { initial: rows })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Подключения', exact: true }).click()
  const section = page.getByRole('region', { name: 'Подключения', exact: true })
  await expect(section.getByTestId('connection-balance')).toHaveText('Неизвестно')
  await expect(section.getByText(/99999/)).toHaveCount(0)
  await expect(section.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await expect(section.getByRole('switch')).toBeDisabled()
  await section.getByLabel('Название подключения').fill('Keyboard connection')
  await section.getByRole('button', { name: 'Добавить подключение' }).focus()
  await page.keyboard.press('Enter')
  await expect(section.getByRole('heading', { name: 'Keyboard connection' })).toHaveCount(1)
  inputs.push(...await page.evaluate(() => (window as unknown as { __k3Inputs: Record<string, unknown>[] }).__k3Inputs))
  expect(inputs).toHaveLength(1)
  expect(inputs[0]).not.toHaveProperty('unattended')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(section).toBeInViewport()
  expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.reload()
  await page.getByRole('button', { name: 'Подключения', exact: true }).click()
  await expect(section.getByRole('heading', { name: 'Fixture connection' })).toHaveCount(1)
  await expect(section.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
})
