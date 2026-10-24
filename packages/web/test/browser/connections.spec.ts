import { expect, test } from '@playwright/test'
import { installChatApiFixture } from './fixtures/chat-api.ts'

/** The connections centre reads the K3 lane contract; only the fabricated key reaches the secret route. */
test('Connections centre switches categories, adds a fabricated key and removes after confirmation', async ({ page }) => {
  await installChatApiFixture(page, 'completed')
  const createdId = '22222222-2222-4222-8222-222222222222'
  const key = 'sk-browser-fixture-not-a-real-key'

  await page.addInitScript(({ createdId }) => {
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
    let connections: Row[] = []
    const requests: { method: string; url: string; body: unknown }[] = []
    Object.assign(window, { __connectionsRequests: requests })
    window.fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/connections') {
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as Pick<Row, 'name' | 'kind' | 'provider' | 'auth'>
          requests.push({ method, url, body })
          const created: Row = {
            id: createdId, accountId: 'local', name: body.name, kind: body.kind, provider: body.provider,
            auth: body.auth, unattended: false, secretRef: null, facts: {}, balance: null,
            createdAt: '2026-10-20T00:00:00.000Z',
          }
          connections = [...connections, created]
          return Response.json(created, { status: 201 })
        }
        return Response.json({ connections, costs: [], vault: { unlocked: true, unattendedAvailable: false } })
      }
      const secret = new RegExp(`^/api/connections/([0-9a-f-]+)/secret$`, 'u').exec(url)
      if (secret && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { value: string }
        requests.push({ method, url, body })
        connections = connections.map(row => row.id === secret[1]
          ? { ...row, secretRef: `secret://test/${row.id}` } : row)
        return Response.json(connections.find(row => row.id === secret[1]))
      }
      const remove = new RegExp(`^/api/connections/([0-9a-f-]+)$`, 'u').exec(url)
      if (remove && method === 'DELETE') {
        requests.push({ method, url, body: undefined })
        connections = connections.filter(row => row.id !== remove[1])
        return Response.json({ id: remove[1] })
      }
      return fixtureFetch(input, init)
    }
  }, { createdId })

  await page.goto('/connections')
  const centre = page.getByRole('region', { name: 'Подключения', exact: true })
  await expect(centre.getByRole('heading', { level: 1, name: 'Подключения', exact: true })).toBeVisible()
  const categories = centre.getByRole('navigation', { name: 'Категории провайдеров', exact: true })
  const deepseek = centre.getByRole('article', { name: 'DeepSeek', exact: true })
  await expect(deepseek).toBeVisible()
  await expect(deepseek.getByText('Не подключено', { exact: true })).toBeVisible()

  await categories.getByRole('button', { name: /Локальные среды/u }).click()
  await expect(centre.getByRole('article', { name: 'Ollama', exact: true })).toBeVisible()
  await expect(deepseek).toHaveCount(0)
  await expect(centre.getByRole('button', { name: 'Подключить', exact: true })).toBeVisible()
  await categories.getByRole('button', { name: /API LLM/u }).click()
  await expect(deepseek).toBeVisible()

  await deepseek.getByRole('button', { name: 'Добавить ключ', exact: true }).click()
  const keyDialog = page.getByRole('dialog', { name: 'Добавить ключ DeepSeek', exact: true })
  const keyInput = keyDialog.getByLabel('Ключ API', { exact: true })
  await expect(keyInput).toHaveAttribute('type', 'password')
  await keyInput.fill(key)
  await keyDialog.getByRole('button', { name: 'Добавить ключ', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(deepseek.getByText('Подключено (1)', { exact: true })).toBeVisible()
  await expect(deepseek.getByRole('button', { name: 'Заменить ключ для DeepSeek', exact: true })).toBeVisible()
  await expect(centre.getByText(key)).toHaveCount(0)
  await expect(deepseek.getByRole('heading', { name: 'DeepSeek', exact: true })).toBeFocused()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __connectionsRequests: { method: string; url: string; body: unknown }[] }).__connectionsRequests,
  )).toEqual([
    { method: 'POST', url: '/api/connections', body: { name: 'DeepSeek', kind: 'model_api', provider: 'deepseek', auth: 'api_key' } },
    { method: 'PUT', url: `/api/connections/${createdId}/secret`, body: { value: key } },
  ])

  await deepseek.getByRole('button', { name: 'Удалить DeepSeek', exact: true }).click()
  const removeDialog = page.getByRole('dialog', { name: 'Удалить DeepSeek?', exact: true })
  await expect(removeDialog).toContainText('Сессии, роли и ведущие, привязанные к этому подключению, перестанут работать.')
  await removeDialog.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(deepseek.getByText('Подключено (1)', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __connectionsRequests: { method: string }[] }).__connectionsRequests.filter(request => request.method === 'DELETE').length,
  )).toBe(0)

  await deepseek.getByRole('button', { name: 'Удалить DeepSeek', exact: true }).click()
  await page.getByRole('dialog', { name: 'Удалить DeepSeek?', exact: true })
    .getByRole('button', { name: 'Удалить подключение', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(deepseek.getByText('Не подключено', { exact: true })).toBeVisible()
  await expect(deepseek.getByRole('heading', { name: 'DeepSeek', exact: true })).toBeFocused()
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __connectionsRequests: { method: string; url: string }[] }).__connectionsRequests
      .filter(request => request.method === 'DELETE'),
  )).toEqual([{ method: 'DELETE', url: `/api/connections/${createdId}` }])
})
