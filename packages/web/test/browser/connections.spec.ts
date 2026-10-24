import { expect, test } from '@playwright/test'
import { installChatApiFixture } from './fixtures/chat-api.ts'

interface BrowserConnection {
  id: string
  accountId: string
  name: string
  kind: string
  provider: string
  auth: string
  unattended: boolean
  secretRef: string | null
  facts: Record<string, unknown>
  balance: null
  createdAt: string
}

/** The connections centre reads the K3 lane contract; only the fabricated key reaches the secret route. */
test('Connections centre switches categories, adds a fabricated key and removes after confirmation', async ({ page }) => {
  await installChatApiFixture(page, 'completed')
  const initial: BrowserConnection[] = [{
    id: '11111111-1111-4111-8111-111111111111', accountId: 'local', name: 'DeepSeek', kind: 'model_api',
    provider: 'deepseek', auth: 'api_key', unattended: false, secretRef: null,
    facts: { origin: { value: 'provider_key_import', source: 'connection_import', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'high' } },
    balance: null, createdAt: '2026-10-20T00:00:00.000Z',
  }]
  const key = 'sk-browser-fixture-not-a-real-key'

  await page.addInitScript(({ seed }) => {
    type Row = {
      id: string
      accountId: string
      name: string
      kind: string
      provider: string
      auth: string
      unattended: boolean
      secretRef: string | null
      facts: Record<string, unknown>
      balance: null
      createdAt: string
    }
    const fixtureFetch = window.fetch.bind(window)
    let connections: Row[] = seed
    const requests: { method: string; url: string; body: unknown }[] = []
    Object.assign(window, { __connectionsRequests: requests })
    window.fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/connections') {
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as Partial<Row>
          requests.push({ method, url, body })
          const created: Row = {
            ...seed[0]!, ...body, id: '22222222-2222-4222-8222-222222222222',
            name: body.name ?? seed[0]!.name, secretRef: null, facts: {}, balance: null,
          }
          connections = [...connections, created]
          return Response.json(created, { status: 201 })
        }
        return Response.json({ connections, costs: [], vault: { unlocked: true, unattendedAvailable: false } })
      }
      const secret = /^\/api\/connections\/([0-9a-f-]+)\/secret$/u.exec(url)
      if (secret && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { value: string }
        requests.push({ method, url, body })
        connections = connections.map(row => row.id === secret[1]
          ? { ...row, secretRef: `secret://test/${row.id}` } : row)
        return Response.json(connections.find(row => row.id === secret[1]))
      }
      const remove = /^\/api\/connections\/([0-9a-f-]+)$/u.exec(url)
      if (remove && method === 'DELETE') {
        requests.push({ method, url, body: undefined })
        connections = connections.filter(row => row.id !== remove[1])
        return Response.json({ id: remove[1] })
      }
      return fixtureFetch(input, init)
    }
  }, { seed: initial })

  await page.goto('/connections')
  const centre = page.getByRole('region', { name: 'Подключения', exact: true })
  await expect(centre.getByRole('heading', { level: 1, name: 'Подключения' })).toBeVisible()
  const categories = centre.getByRole('navigation', { name: 'Категории провайдеров' })
  const deepseek = centre.getByRole('article', { name: 'DeepSeek' })
  await expect(deepseek).toBeVisible()

  await categories.getByRole('button', { name: /Локальные среды/u }).click()
  await expect(centre.getByRole('article', { name: 'Ollama' })).toBeVisible()
  await expect(deepseek).toHaveCount(0)
  await expect(centre.getByRole('button', { name: 'Подключить', exact: true })).toBeVisible()
  await categories.getByRole('button', { name: /API LLM/u }).click()
  await expect(deepseek).toBeVisible()

  await deepseek.getByRole('button', { name: 'Добавить ключ' }).click()
  const keyDialog = page.getByRole('dialog', { name: 'Добавить ключ DeepSeek' })
  const keyInput = keyDialog.getByLabel('Ключ API')
  await expect(keyInput).toHaveAttribute('type', 'password')
  await keyInput.fill(key)
  await keyDialog.getByRole('button', { name: 'Добавить ключ' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(deepseek.getByText('Подключено (1)')).toBeVisible()
  await expect(centre.getByText(key)).toHaveCount(0)
  await expect(deepseek.getByRole('heading', { name: 'DeepSeek' })).toBeFocused()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __connectionsRequests: { method: string; url: string; body: unknown }[] }).__connectionsRequests,
  )).toEqual([
    { method: 'POST', url: '/api/connections', body: { name: 'DeepSeek', kind: 'model_api', provider: 'deepseek', auth: 'api_key' } },
    { method: 'PUT', url: '/api/connections/11111111-1111-4111-8111-111111111111/secret', body: { value: key } },
  ])

  await deepseek.getByRole('button', { name: 'Удалить DeepSeek' }).click()
  const removeDialog = page.getByRole('dialog', { name: 'Удалить DeepSeek?' })
  await expect(removeDialog).toContainText('Сессии, роли и ведущие, привязанные к этому подключению, перестанут работать.')
  await removeDialog.getByRole('button', { name: 'Отмена' }).click()
  await expect(deepseek.getByText('Подключено (1)')).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __connectionsRequests: { method: string }[] }).__connectionsRequests.filter(request => request.method === 'DELETE').length,
  )).toBe(0)

  await deepseek.getByRole('button', { name: 'Удалить DeepSeek' }).click()
  await page.getByRole('dialog', { name: 'Удалить DeepSeek?' }).getByRole('button', { name: 'Удалить подключение' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(deepseek.getByText('Не подключено')).toBeVisible()
  await expect(deepseek.getByRole('heading', { name: 'DeepSeek' })).toBeFocused()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __connectionsRequests: { method: string }[] }).__connectionsRequests.filter(request => request.method === 'DELETE').length,
  )).toBe(1)
})
