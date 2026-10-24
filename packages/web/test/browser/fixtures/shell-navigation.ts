import type { Page } from '@playwright/test'

/**
 * Navigate a secondary route through the mounted shell's product palette.
 * The core four links intentionally do not include Chat, Workspace or the
 * other legacy routes, so those flows must exercise the real palette path.
 */
export async function choosePaletteCommand(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /Палитра команд|Command palette/u })
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /Палитра команд|Command palette/u }).click()
  }
  await dialog.getByRole('combobox').fill(name)
  await dialog.getByRole('option', { name, exact: true }).click()
}

const NAVIGATION_TOGGLE = /^(Open navigation|Открыть навигацию)$/u
const OVERFLOW = /^(Status and settings|Состояние и настройки)$/u

/**
 * On a phone-width shell the navigation is a drawer (visual pass, item 4): open it before using a
 * sidebar link. On a wide shell the sidebar is already there and nothing is clicked.
 */
export async function openNavigation(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: NAVIGATION_TOGGLE })
  if (await toggle.count() === 0) return
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await page.locator('[data-slot="app-shell-sidebar"][data-drawer="open"]').waitFor()
}

/**
 * On a phone-width shell the status items sit behind one overflow control: open it before using a
 * status item. On a wide shell they are in the strip and nothing is clicked.
 */
export async function openStatusOverflow(page: Page): Promise<void> {
  const more = page.getByRole('button', { name: OVERFLOW })
  if (await more.count() === 0) return
  if (await page.locator('[data-slot="app-shell-overflow"]').isVisible().catch(() => false)) return
  await more.click()
  await page.locator('[data-slot="app-shell-overflow"]').waitFor()
}

/** Closes the phone status overflow if it is open, so the page beneath is clickable again. */
export async function closeStatusOverflow(page: Page): Promise<void> {
  const overflow = page.locator('[data-slot="app-shell-overflow"]')
  for (let attempt = 0; attempt < 3 && await overflow.isVisible().catch(() => false); attempt++) await page.keyboard.press('Escape')
}

/** Closes the phone navigation drawer if it is open. */
export async function closeNavigation(page: Page): Promise<void> {
  const drawer = page.locator('[data-slot="app-shell-sidebar"][data-drawer="open"]')
  if (await drawer.count() === 0) return
  await drawer.press('Escape')
  await page.locator('[data-slot="app-shell-sidebar"][data-drawer="open"]').waitFor({ state: 'detached' }).catch(() => undefined)
}
