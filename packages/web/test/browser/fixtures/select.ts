import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Drives a design-system Select (a combobox trigger with a portalled listbox), the replacement for
 * `selectOption` on the retired native <select>. Legacy Select items carry `data-value`, and the
 * trigger mirrors the chosen value in `data-value`.
 *
 * `clockStepMs` is for specs that pause the page clock: the popup mounts and unmounts on timers,
 * so the helper advances the paused clock by that many milliseconds after each step.
 */
interface Options { clockStepMs?: number }

const optionFor = (listbox: Locator, value: string) =>
  listbox.locator(`[role="option"][data-value="${value.replace(/["\\]/gu, (character) => `\\${character}`)}"]`)

/** A locator that survives the label changing (choosing a language renames the control). */
async function stable(page: Page, trigger: Locator): Promise<Locator> {
  const id = await trigger.getAttribute('id')
  return id ? page.locator(`[id="${id.replace(/["\\]/gu, (character) => `\\${character}`)}"]`) : trigger
}

async function step(page: Page, options: Options) {
  if (options.clockStepMs) await page.clock.runFor(options.clockStepMs)
}

async function open(page: Page, trigger: Locator, options: Options): Promise<Locator> {
  await trigger.click()
  await step(page, options)
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  return listbox
}

async function closed(page: Page, listbox: Locator, options: Options) {
  await step(page, options)
  await expect(listbox).toHaveCount(0)
}

/** Picks the option with the given visible label. */
export async function pickOption(page: Page, trigger: Locator, option: string | RegExp, options: Options = {}): Promise<void> {
  const listbox = await open(page, trigger, options)
  await listbox.getByRole('option', { name: option, exact: typeof option === 'string' }).click()
  await closed(page, listbox, options)
}

/** Picks the option holding the given value with the pointer. */
export async function pickValue(page: Page, control: Locator, value: string, options: Options = {}): Promise<void> {
  const trigger = await stable(page, control)
  const listbox = await open(page, trigger, options)
  await optionFor(listbox, value).click()
  await closed(page, listbox, options)
  await expect(trigger).toHaveAttribute('data-value', value)
}

/**
 * Picks the option holding the given value with the keyboard only: focus the trigger, open it with
 * Enter, move the highlight with the arrow keys and commit with Enter. Focus returns to the trigger.
 */
export async function pickValueByKeyboard(page: Page, control: Locator, value: string, options: Options = {}): Promise<void> {
  const trigger = await stable(page, control)
  await trigger.focus()
  await page.keyboard.press('Enter')
  await step(page, options)
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  const values = await listbox.getByRole('option').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.value ?? ''))
  const target = values.indexOf(value)
  expect(target, `option ${value}`).toBeGreaterThanOrEqual(0)
  const highlighted = async () => listbox.locator('[role="option"][data-highlighted]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.value ?? ''))
  for (let moves = 0; moves <= values.length; moves += 1) {
    const current = (await highlighted())[0]
    if (current === value) break
    const index = current === undefined ? -1 : values.indexOf(current)
    await page.keyboard.press(index < target ? 'ArrowDown' : 'ArrowUp')
    await step(page, options)
  }
  await expect(optionFor(listbox, value)).toHaveAttribute('data-highlighted', '')
  await page.keyboard.press('Enter')
  await closed(page, listbox, options)
  await expect(trigger).toHaveAttribute('data-value', value)
  await expect(trigger).toBeFocused()
}

/** Asserts the value the Select holds. */
export async function expectValue(trigger: Locator, value: string): Promise<void> {
  await expect(trigger).toHaveAttribute('data-value', value)
}
