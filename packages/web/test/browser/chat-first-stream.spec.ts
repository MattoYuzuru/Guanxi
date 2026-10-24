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
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await installChatApiFixture(page, 'completed')

  await page.goto('/chat')
  await page.evaluate(() => {
    document.documentElement.dataset.motion = 'full'
  })
  // The runtime facts live in the status strip's runtime popover (D-202).
  await page.getByRole('button', { name: /^Среда выполнения/u }).click()
  await expect(
    page.getByTestId('shell-runtime-popover').getByRole('listitem').filter({ hasText: 'fixture:latest' }),
  ).toContainText('fixture:latest')
  await page.keyboard.press('Escape')

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
  await expect(page.getByRole('button', { name: 'Остановить (отправка)' })).toBeVisible()
  // D-207 composer: while a turn runs, Stop replaces Send; the text area stays editable for the
  // next prompt, but nothing can be sent until the turn ends.
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toHaveCount(0)
  await expect(composer).toBeEditable()

  await advanceChatFixture(page, 'releaseHeaders')
  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('prefill', { exact: true })).toBeVisible()

  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('думает', { exact: true })).toBeVisible()
  await expect(page.getByText('Live reasoning', { exact: true })).toBeVisible()

  const liveMessage = page.locator('article').filter({ hasText: 'Live reasoning' })
  await expect(liveMessage).toBeVisible()
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    false,
  )
  expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe('full')

  await advanceChatFixture(page, 'releaseNext')
  await expect(page.getByText('генерация', { exact: true })).toBeVisible()
  await expect(page.getByText('Live stream draft', { exact: true })).toBeVisible()

  // The streaming timeline is static by requirement: the article, its pseudo-elements and
  // the caret must not animate even while motion is explicitly full. The generated
  // spinner/sheen utilities remain covered by the positive control in local-fonts.spec.ts.
  const streamingMotion = await liveMessage.evaluate((article) => {
    const caret = article.querySelector('.stream-caret')
    if (!caret) throw new Error('the live stream caret is missing')
    return {
      article: getComputedStyle(article).animationName,
      before: getComputedStyle(article, '::before').animationName,
      after: getComputedStyle(article, '::after').animationName,
      caret: getComputedStyle(caret, '::after').animationName,
      caretBackground: getComputedStyle(caret, '::after').backgroundColor,
      animations: article.getAnimations({ subtree: true }).map((animation) => {
        const cssAnimation = animation as CSSAnimation
        const cssTransition = animation as CSSTransition
        return cssAnimation.animationName ?? cssTransition.transitionProperty ?? 'unknown'
      }),
    }
  })
  expect(streamingMotion.article).toBe('none')
  expect(streamingMotion.before).toBe('none')
  expect(streamingMotion.after).toBe('none')
  expect(streamingMotion.caret).toBe('none')
  expect(streamingMotion.caretBackground).not.toBe('rgba(0, 0, 0, 0)')
  expect(streamingMotion.animations, JSON.stringify(streamingMotion)).toEqual([])

  await advanceChatFixture(page, 'releaseNext')
  await advanceChatFixture(page, 'releaseNext')

  await expect(page.getByText('Persisted canonical answer', { exact: true })).toBeVisible()
  await expect(page.getByText('Live stream draft', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/завершён, Причина остановки/)).toBeVisible()
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
  // Reload replay обязан прочитать persisted canonical output ровно один раз:
  // `toBeVisible` прошёл бы и при duplicate render, поэтому count проверяется явно.
  await expect(page.getByText('Persisted canonical answer', { exact: true })).toHaveCount(1)
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
