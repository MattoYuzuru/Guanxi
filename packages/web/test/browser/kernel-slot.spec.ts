/**
 * K1 exit gate: a plugin's sidebar slot entry appears, updates on a real Vite
 * HMR of the plugin module without a page reload, and disappears on unload.
 * The HMR step touches the module's mtime only; its content never changes.
 */
import { utimes } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { installChatApiFixture } from './fixtures/chat-api.ts'

const PLUGIN_ID = 'guanxi.web-projects-shortcut'
const pluginModule = fileURLToPath(new URL('../../src/kernel/plugins/projects-shortcut.ts', import.meta.url))

type KernelHandle = {
  ready: Promise<void>
  unload(id: string): Promise<void>
  reload(id: string): Promise<void>
  counters(): { slotEntries: number }
}

test('a plugin sidebar entry appears, hot-updates in place and disappears on unload', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await installChatApiFixture(page, 'completed')
  await page.goto('/chat')
  await page.evaluate(() => (globalThis as unknown as { __GUANXI_KERNEL__: KernelHandle }).__GUANXI_KERNEL__.ready)

  const shortcuts = page.getByRole('navigation', { name: 'Быстрые ссылки' })
  const entries = shortcuts.getByRole('listitem')
  await expect(entries).toHaveCount(1)
  const link = shortcuts.getByRole('link', { name: 'Все проекты' })
  await expect(link).toHaveAttribute('href', '/projects')
  await link.focus()
  await expect(link).toBeFocused()
  await expect(page.getByRole('link', { name: '+ Новый' })).toBeVisible()

  const firstRevision = await entries.first().getAttribute('data-plugin-revision')
  expect(firstRevision).toBeTruthy()
  await page.evaluate(() => {
    ;(globalThis as unknown as { __k1NoReload: boolean }).__k1NoReload = true
  })
  await link.evaluate((element) => {
    element.dataset['k1Node'] = 'original'
  })
  const now = new Date()
  await utimes(pluginModule, now, now)
  await expect(entries.first()).not.toHaveAttribute('data-plugin-revision', firstRevision!, { timeout: 15_000 })
  await expect(entries).toHaveCount(1)
  expect(
    await page.evaluate(() => (globalThis as unknown as { __k1NoReload?: boolean }).__k1NoReload),
  ).toBe(true)
  // Updated in place: the same DOM node, still focused.
  await expect(link).toHaveAttribute('data-k1-node', 'original')
  await expect(link).toBeFocused()

  await page.evaluate((id) => (globalThis as unknown as { __GUANXI_KERNEL__: KernelHandle }).__GUANXI_KERNEL__.unload(id), PLUGIN_ID)
  await expect(shortcuts).toHaveCount(0)
  // The focused link is gone; focus moved to the next control, not the page body.
  await expect(page.getByRole('link', { name: '+ Новый' })).toBeFocused()
  expect(
    await page.evaluate(() => (globalThis as unknown as { __GUANXI_KERNEL__: KernelHandle }).__GUANXI_KERNEL__.counters().slotEntries),
  ).toBe(0)
  await expect(page.getByRole('link', { name: '+ Новый' })).toBeVisible()

  await page.evaluate((id) => (globalThis as unknown as { __GUANXI_KERNEL__: KernelHandle }).__GUANXI_KERNEL__.reload(id), PLUGIN_ID)
  await expect(entries).toHaveCount(1)
  expect(pageErrors).toEqual([])
})
