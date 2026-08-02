import { expect, test } from '@playwright/test'
import {
  advanceChatFixture,
  installChatApiFixture,
  readChatFixture,
} from './fixtures/chat-api.ts'

test('create, redirect, stream, done, and hard reload use the persisted outcome', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installChatApiFixture(page, 'completed')

  await page.goto('/chat')
  await expect(
    page.getByRole('listitem').filter({ hasText: 'ollama_api_ps' }),
  ).toContainText('fixture:latest')

  const createButton = page.getByRole('button', { name: 'Создать диалог' })
  await createButton.focus()
  await expect(createButton).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(/\/chat\/thread-p0-e-full$/)
  const currentThread = page.locator(
    'nav[aria-label="История диалогов"] a[aria-current="page"]',
  )
  await expect(currentThread).toContainText('P0-E release gate')

  const composer = page.getByRole('textbox', { name: 'Сообщение' })
  await composer.fill('Run the P0-E release flow')
  await composer.press('Enter')

  await expect(
    page.getByRole('status').filter({ hasText: 'отправка' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Остановить · отправка' })).toBeVisible()
  await expect(composer).toBeDisabled()

  await advanceChatFixture(page, 'releaseHeaders')
  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('prefill', { exact: true })).toBeVisible()

  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('думает', { exact: true })).toBeVisible()
  await expect(page.getByText('Live reasoning', { exact: true })).toBeVisible()

  const liveMessage = page.locator('article.anim-fade-up')
  await expect(liveMessage).toBeVisible()
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  )
  const animationDurationMs = await liveMessage.evaluate((element) => {
    const duration = getComputedStyle(element).animationDuration
    return duration.endsWith('ms') ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1000
  })
  expect(animationDurationMs).toBeLessThanOrEqual(0.011)

  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('генерация', { exact: true })).toBeVisible()
  await expect(page.getByText('Live stream draft', { exact: true })).toBeVisible()

  await advanceChatFixture(page, 'releaseNext')
  await advanceChatFixture(page, 'releaseNext')

  await expect(page.getByText('Persisted canonical answer', { exact: true })).toBeVisible()
  await expect(page.getByText('Live stream draft', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/завершён · Причина остановки/)).toBeVisible()
  await expect(composer).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Отправить' })).toBeVisible()

  const beforeReload = await readChatFixture(page)
  expect(beforeReload.state).toBe('terminal')
  expect(beforeReload.detailReads).toBeGreaterThanOrEqual(2)
  expect(beforeReload.createBody).toMatchObject({
    mode: 'chat',
    model: 'fixture:latest',
  })
  expect(beforeReload.messageBody).toMatchObject({
    content: 'Run the P0-E release flow',
  })

  await page.reload()
  await expect(page).toHaveURL(/\/chat\/thread-p0-e-full$/)
  await expect(page.getByText('Persisted canonical answer', { exact: true })).toBeVisible()
  await expect(page.getByText('Live stream draft', { exact: true })).toHaveCount(0)
  await expect(
    page.locator('nav[aria-label="История диалогов"] a[aria-current="page"]'),
  ).toContainText('P0-E release gate')
  expect((await readChatFixture(page)).detailReads).toBeGreaterThan(beforeReload.detailReads)

  await composer.focus()
  await expect(composer).toBeFocused()
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)

  await page.screenshot({
    path: testInfo.outputPath('p0-e-full-flow.png'),
    fullPage: true,
  })
  await expect(page.getByRole('heading', { name: 'Не удалось показать чат' })).toHaveCount(0)
  expect(pageErrors.filter((message) => /is not a function|destroy/i.test(message))).toEqual([])
})
