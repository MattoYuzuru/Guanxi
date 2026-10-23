import { act, fireEvent, screen, within } from '@testing-library/react'

/** A design-system Select trigger: a button with the combobox role. */
export function isSelectTrigger(element: Element): element is HTMLButtonElement {
  return element.tagName === 'BUTTON' && element.getAttribute('role') === 'combobox'
}

/** The value the legacy Select currently holds (its trigger mirrors it in `data-value`). */
export function selectedValue(trigger: HTMLElement): string | undefined {
  return trigger.dataset.value
}

async function openList(trigger: HTMLElement): Promise<HTMLElement> {
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(trigger)
    await act(async () => { await Promise.resolve() })
  }
  return screen.findByRole('listbox')
}

function press(option: HTMLElement) {
  fireEvent.pointerDown(option, { pointerType: 'mouse' })
  fireEvent.pointerUp(option, { pointerType: 'mouse' })
  fireEvent.mouseUp(option)
  fireEvent.click(option)
}

/**
 * Drives the design-system Select the way a pointer user does: open the combobox trigger, then
 * press and release the option with the given visible name. The popup is portalled, so the
 * listbox is found document-wide.
 */
export async function chooseOption(trigger: HTMLElement, name: string | RegExp): Promise<void> {
  const listbox = await openList(trigger)
  press(within(listbox).getByRole('option', { name }))
  await act(async () => { await Promise.resolve() })
}

/** Like `chooseOption`, but by the option's value (legacy Select items carry `data-value`). */
export async function chooseValue(trigger: HTMLElement, value: string): Promise<void> {
  const listbox = await openList(trigger)
  const option = within(listbox).getAllByRole('option').find(candidate => candidate.dataset.value === value)
  if (!option) throw new Error(`no option with value "${value}"`)
  press(option)
  await act(async () => { await Promise.resolve() })
}

/** The option labels a Select offers, in order; the list is closed again afterwards. */
export async function optionLabels(trigger: HTMLElement): Promise<string[]> {
  const listbox = await openList(trigger)
  const labels = within(listbox).getAllByRole('option').map(option => option.textContent ?? '')
  fireEvent.keyDown(listbox, { key: 'Escape' })
  await act(async () => { await Promise.resolve() })
  return labels
}

/** The option values a legacy Select offers, in order; the list is closed again afterwards. */
export async function optionValues(trigger: HTMLElement): Promise<string[]> {
  const listbox = await openList(trigger)
  const values = within(listbox).getAllByRole('option').map(option => option.dataset.value ?? '')
  fireEvent.keyDown(listbox, { key: 'Escape' })
  await act(async () => { await Promise.resolve() })
  return values
}

/** The labelled groups of a Select and the option labels inside each, in order. */
export async function optionGroups(trigger: HTMLElement): Promise<Array<{ label: string; options: string[] }>> {
  const listbox = await openList(trigger)
  const groups = within(listbox).getAllByRole('group').map(group => ({
    label: document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent ?? '',
    options: within(group).getAllByRole('option').map(option => option.textContent ?? ''),
  }))
  fireEvent.keyDown(listbox, { key: 'Escape' })
  await act(async () => { await Promise.resolve() })
  return groups
}
