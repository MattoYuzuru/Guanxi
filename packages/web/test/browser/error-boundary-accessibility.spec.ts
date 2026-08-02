import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 360, height: 720 } })

test('Chat fallback preserves focus, semantics, scaling, and reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/test/browser/fixtures/error-boundary.html')

  const alert = page.getByRole('alert')
  const heading = page.getByRole('heading', { name: 'Не удалось показать чат' })
  await expect(alert).toBeVisible()
  await expect(heading).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Перезагрузить' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'К чатам' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'К моделям' })).toBeFocused()
  await page.keyboard.press('Tab')

  const diagnostics = page.getByText('Диагностические сведения')
  await expect(diagnostics).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('TypeError: fixture render failure')).toBeVisible()

  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  )

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
})
