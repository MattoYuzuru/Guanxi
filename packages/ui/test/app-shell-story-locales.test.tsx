/**
 * The app-shell-chrome story is the catalog's localized preview. Its seven control labels must
 * resolve through the real story path in every locale: the English source wording is exact, the
 * curated Russian differs, the pseudo-locale expands by at least 40%, and the rendered visible
 * and accessible names use those translations. This is a story-contract test, not a second
 * component-behavior test.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StoryView } from '../catalog/StoryView.tsx'
import type {
  AppShellChromeProps,
  AppShellLabels,
} from '../src/components/app-shell-chrome/app-shell-chrome.tsx'
import * as stories from '../src/components/app-shell-chrome/app-shell-chrome.stories.tsx'
import { translateUi, UiLocaleProvider, type UiLocale } from '../src/i18n/context.tsx'
import { resolveMessages, type Story } from '../src/story-kit/index.tsx'

const meta = stories.default

const EN_LABELS: AppShellLabels = {
  show: 'Show sidebar',
  collapse: 'Collapse to rail',
  expand: 'Expand sidebar',
  hide: 'Hide sidebar',
  moveLeft: 'Move sidebar left',
  moveRight: 'Move sidebar right',
  palette: 'Command palette',
}

const LABEL_FIELDS: ReadonlyArray<keyof AppShellLabels> = [
  'show',
  'collapse',
  'expand',
  'hide',
  'moveLeft',
  'moveRight',
  'palette',
]

type StoryArgs = Partial<AppShellChromeProps>

function resolvedArgs(locale: UiLocale, story: { args?: StoryArgs }) {
  return resolveMessages(
    { ...(meta.args ?? {}), ...(story.args ?? {}) },
    (key, vars) => translateUi(locale, key, vars),
  )
}

function labelsFor(locale: UiLocale, story: { args?: StoryArgs }): AppShellLabels {
  const labels = resolvedArgs(locale, story).labels
  if (!labels) throw new Error('the story has no labels')
  return labels
}

function sidebarLabelFor(locale: UiLocale, story: { args?: StoryArgs }): string {
  const label = resolvedArgs(locale, story).sidebarLabel
  if (!label) throw new Error('the story has no sidebar label')
  return label
}

function renderStory(locale: UiLocale, story: Story<AppShellChromeProps>) {
  return render(
    <UiLocaleProvider locale={locale}>
      <StoryView meta={meta} story={story} />
    </UiLocaleProvider>,
  )
}

/** Raw English must not survive in a Russian or pseudo story, in text or accessible names. */
function expectNoEnglish(labels: AppShellLabels) {
  for (const field of LABEL_FIELDS) {
    expect(screen.queryAllByText(EN_LABELS[field], { exact: true }), `${field} text`).toHaveLength(0)
    expect(
      screen.queryByRole('button', { name: EN_LABELS[field], hidden: true }),
      `${field} button name`,
    ).toBeNull()
    expect(
      screen.queryByRole('menuitem', { name: EN_LABELS[field], hidden: true }),
      `${field} menu name`,
    ).toBeNull()
  }
  // Prove the check itself is live: the translated labels are present in the same tree.
  expect(screen.getAllByRole('button', { name: labels.palette, hidden: true }).length).toBeGreaterThan(0)
}

describe('AppShellChrome story localization', () => {
  it('keeps the exact English control wording across all seven story labels', () => {
    expect(labelsFor('en', stories.Default)).toEqual(EN_LABELS)
  })

  it('resolves curated Russian and at least +40% pseudo labels for all seven controls', () => {
    const en = labelsFor('en', stories.Default)
    const ru = labelsFor('ru', stories.Default)
    const pseudo = labelsFor('pseudo', stories.Default)

    for (const field of LABEL_FIELDS) {
      expect(ru[field], `${field} Russian differs from English`).not.toBe(en[field])
      expect(ru[field], `${field} Russian is not empty`).not.toBe('')
      expect(
        pseudo[field].length,
        `${field} pseudo expands by at least 40%`,
      ).toBeGreaterThanOrEqual(Math.ceil(en[field].length * 1.4))
      expect(pseudo[field], `${field} is the pseudo-locale`).toContain('⟦')
    }
  })

  const menuVariants = [
    { name: 'default', story: stories.Default, items: ['moveRight', 'collapse', 'hide'] },
    { name: 'rail', story: stories.Rail, items: ['moveRight', 'expand', 'hide'] },
    { name: 'right', story: stories.Right, items: ['moveLeft', 'collapse', 'hide'] },
  ] as const satisfies ReadonlyArray<{
    name: string
    story: Story<AppShellChromeProps>
    items: ReadonlyArray<keyof AppShellLabels>
  }>

  for (const locale of ['ru', 'pseudo'] as const) {
    for (const variant of menuVariants) {
      it(`renders the ${variant.name} story controls and keyboard menu names in ${locale}`, async () => {
        const view = renderStory(locale, variant.story)
        const labels = labelsFor(locale, variant.story)
        const sidebarLabel = sidebarLabelFor(locale, variant.story)

        expect(screen.getByRole('button', { name: labels.palette })).toBeTruthy()
        const trigger = screen.getByRole('button', { name: sidebarLabel })
        expect(trigger).toBeTruthy()

        trigger.focus()
        fireEvent.keyDown(trigger, { key: 'ArrowDown' })
        const menu = await screen.findByRole('menu')

        const firstItem = within(menu).getByRole('menuitem', { name: labels[variant.items[0]] })
        await waitFor(() => expect(document.activeElement).toBe(firstItem))
        expect(within(menu).getAllByRole('menuitem')).toHaveLength(variant.items.length)
        for (const field of variant.items) {
          expect(
            within(menu).getByRole('menuitem', { name: labels[field] }),
            `${field} menu item name`,
          ).toBeTruthy()
        }

        expectNoEnglish(labels)
        view.unmount()
      })
    }

    it(`renders the hidden story Show and Palette controls in ${locale}`, () => {
      const view = renderStory(locale, stories.Hidden)
      const labels = labelsFor(locale, stories.Hidden)
      const sidebar = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar"]')

      expect(sidebar?.hidden, 'the sidebar stays hidden').toBe(true)
      expect(screen.getByRole('button', { name: labels.show })).toBeTruthy()
      expect(screen.getByRole('button', { name: labels.palette })).toBeTruthy()
      // There is no menu to open while the sidebar is hidden.
      expect(screen.queryByRole('button', { name: sidebarLabelFor(locale, stories.Hidden) })).toBeNull()

      expectNoEnglish(labels)
      view.unmount()
    })
  }
})
