import { expect, test, type Page } from '@playwright/test'
import {
  advanceChatFixture,
  chatFixtureThreadId,
  installChatApiFixture,
  readChatFixture,
  type ChatFixtureScenario,
} from './fixtures/chat-api.ts'

test.use({ viewport: { width: 360, height: 720 } })

async function openAndSend(
  page: Page,
  scenario: Exclude<ChatFixtureScenario, 'completed'>,
  prompt: string,
) {
  await installChatApiFixture(page, scenario)
  await page.goto(`/chat/${chatFixtureThreadId(scenario)}`)
  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.fill(prompt)
  await composer.press('Enter')
  await advanceChatFixture(page, 'releaseHeaders')
  return composer
}

async function assertNoEmptySuccess(page: Page) {
  await expect(page.getByText('Завершено без видимого содержимого')).toHaveCount(0)
  await expect(page.getByText('Ответ завершён', { exact: true })).toHaveCount(0)
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
}

test('connect timeout before content reloads as failed, not empty success', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openAndSend(page, 'connect_timeout', 'Trigger connect timeout')

  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('prefill', { exact: true })).toBeVisible()
  await advanceChatFixture(page, 'releaseNext')
  await advanceChatFixture(page, 'releaseNext')

  await expect(page.getByText('Генерация завершилась ошибкой')).toBeVisible()
  await expect(page.getByText(/connect deadline/)).toBeVisible()
  await expect(page.getByText(/ошибка provider/)).toBeVisible()
  await assertNoEmptySuccess(page)

  await page.reload()
  await expect(page.getByText('Генерация завершилась ошибкой')).toBeVisible()
  await expect(page.getByText(/connect deadline/)).toBeVisible()
  await expect(page.getByText(/ошибка provider/)).toBeVisible()
  await assertNoEmptySuccess(page)
  await assertNoHorizontalOverflow(page)
  expect((await readChatFixture(page)).state).toBe('terminal')
  expect(pageErrors).toEqual([])
})

test('provider EOF reloads the failed partial as runtime_protocol', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openAndSend(page, 'runtime_protocol', 'Trigger missing terminal')

  await advanceChatFixture(page, 'releaseNext')
  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('Live partial before EOF', { exact: true })).toBeVisible()
  await advanceChatFixture(page, 'releaseNext')
  await advanceChatFixture(page, 'releaseNext')

  await expect(page.getByText('Persisted partial after EOF', { exact: true })).toBeVisible()
  await expect(page.getByText(/обязательного terminal chunk/)).toBeVisible()
  await expect(page.getByText(/ошибка протокола provider/)).toBeVisible()
  await assertNoEmptySuccess(page)

  await page.reload()
  await expect(page.getByText('Persisted partial after EOF', { exact: true })).toBeVisible()
  await expect(page.getByText(/обязательного terminal chunk/)).toBeVisible()
  await expect(page.getByText(/ошибка протокола provider/)).toBeVisible()
  await assertNoEmptySuccess(page)
  await assertNoHorizontalOverflow(page)
  expect(pageErrors).toEqual([])
})

test('navigation abort reloads as connection-owned cancellation, not provider failure', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openAndSend(page, 'navigation_abort', 'Navigate away during generation')

  await advanceChatFixture(page, 'releaseNext')
  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('Live partial before navigation', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Настройки' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect.poll(async () => (await readChatFixture(page)).state).toBe('terminal')

  await page.goBack()
  await expect(page).toHaveURL(/\/chat\/thread-p0-e-navigation-abort$/)
  await expect(
    page.getByText('Persisted partial before navigation', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Генерация отменена')).toBeVisible()
  await expect(page.getByText(/соединение закрыто/)).toBeVisible()
  await expect(page.getByText(/ошибка provider/)).toHaveCount(0)
  await assertNoEmptySuccess(page)

  await page.reload()
  await expect(
    page.getByText('Persisted partial before navigation', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/соединение закрыто/)).toBeVisible()
  await expect(page.getByText(/ошибка provider/)).toHaveCount(0)
  await assertNoEmptySuccess(page)
  await assertNoHorizontalOverflow(page)
  expect(pageErrors).toEqual([])
})
