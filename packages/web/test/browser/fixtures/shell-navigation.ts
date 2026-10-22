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
