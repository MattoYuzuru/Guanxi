/**
 * Voice glossary editor (V1 UI, LAYOUT_AND_SCREENS T1). The mock node is stateful and follows the
 * store's rules, so the flows are real round trips: create, edit, deactivate, revert, history and
 * the live preview. Counts are exact (one request per action, one alert per failure, one mark per
 * replacement); every state is scanned with axe in both themes and locales; the keyboard path,
 * 320 px with 200% text and reduced motion are asserted, and a seeded violation proves the scan.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { createGlossaryNode, glossaryFixture, seedGlossary } from './fixtures/glossary-api.ts'
import { installSessionFeaturesApi } from './fixtures/session-features-api.ts'
import type { GlossaryNode } from '../fixtures/glossary-node.ts'

const PATH = '/settings/voice/glossary'
const COPY = {
  en: { newEntry: 'New entry', canonical: 'Canonical term', variants: 'Spoken forms', form: 'New glossary entry', entries: 'Entries', save: 'Create entry', dictated: 'Dictated text' },
  ru: { newEntry: 'Новая запись', canonical: 'Канонический термин', variants: 'Произносимые формы', form: 'Новая запись глоссария', entries: 'Записи', save: 'Создать запись', dictated: 'Надиктованный текст' },
} as const

async function open(page: Page, node: GlossaryNode, options: { locale?: 'en' | 'ru'; theme?: 'light' | 'dark'; path?: string } = {}) {
  const fixture = glossaryFixture(node, { locale: options.locale ?? 'en', theme: options.theme ?? 'light' })
  await installSessionFeaturesApi(page, fixture)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(options.path ?? PATH)
  return fixture
}
const ready = async (page: Page, locale: 'en' | 'ru' = 'en') => {
  await expect(page.getByRole('heading', { level: 2, name: COPY[locale].entries, exact: true })).toBeVisible()
  await expect(page.getByTestId('glossary-skeleton')).toHaveCount(0)
}
const cardOf = (page: Page, name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { level: 4, name, exact: true }) })
const entryButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const mutations = (node: GlossaryNode) => node.requests.filter((request) => request.method !== 'GET' && request.path !== '/apply-preview')

/**
 * Scales text to `factor`. The type tokens are px values, so a root font-size change alone would
 * move only rem-based spacing: every `--font-size-*` token and the base size are scaled as well.
 */
async function scaleText(page: Page, factor: number) {
  await page.evaluate((scale) => {
    document.documentElement.style.fontSize = `${scale * 100}%`
    const names = new Set<string>()
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) for (const name of Array.from(rule.style)) { if (name.startsWith('--font-size') || name === '--font-text-size') names.add(name) }
        else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) { try { walk(sheet.cssRules) } catch { /* cross-origin sheets are not ours */ } }
    const computed = getComputedStyle(document.documentElement)
    for (const name of names) {
      const px = /^([\d.]+)px$/u.exec(computed.getPropertyValue(name).trim())
      if (px) document.documentElement.style.setProperty(name, `${Number(px[1]) * scale}px`)
    }
  }, factor)
}
const textSizes = (page: Page) => page.evaluate(() => ({
  heading: parseFloat(getComputedStyle(document.querySelector('h1') as Element).fontSize),
  hint: parseFloat(getComputedStyle(document.querySelector('article p') as Element).fontSize),
}))

/** Serious and critical violations only, as `rule: target` lines. */
async function seriousViolations(page: Page): Promise<string[]> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'))
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`))
}

test('the main flow works end to end: reach it from Settings, create, edit, deactivate, revert, history and preview', async ({ page }) => {
  const node = seedGlossary(createGlossaryNode())
  await open(page, node, { path: '/settings' })
  await page.getByRole('link', { name: 'Open the voice glossary' }).click()
  await expect(page).toHaveURL(/\/settings\/voice\/glossary$/u)
  await ready(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1, name: 'Voice glossary' })).toBeVisible()
  await expect(page.locator('a[aria-current="page"]').filter({ hasText: 'Settings' })).toHaveCount(1) // the nested route keeps Settings current in the sidebar
  await expect(page.getByRole('article')).toHaveCount(3)
  await expect(page.getByTestId('glossary-count')).toHaveText('Entries: 3, active: 3')
  expect(node.count('GET', '/')).toBeGreaterThanOrEqual(1) // dev StrictMode may issue the first read twice; mutations below are exact

  // Create.
  await entryButton(page, 'New entry').click()
  await expect(page.getByLabel('Canonical term')).toBeFocused()
  await page.getByLabel('Canonical term').fill('Guanxi')
  await page.getByRole('textbox', { name: 'Spoken forms', exact: true }).fill('гуанси\nгуаньси')
  await page.getByRole('button', { name: 'Create entry' }).click()
  await expect(page.getByRole('form')).toHaveCount(0)
  await expect(page.getByRole('article')).toHaveCount(4)
  await expect(page.getByTestId('glossary-announcement')).toHaveText('Created “Guanxi”, revision 1.')
  await expect(page.getByRole('heading', { level: 4, name: 'Guanxi' })).toBeFocused()
  expect(mutations(node)).toHaveLength(1)
  expect(node.requests.filter((request) => request.method === 'POST' && request.path === '/')[0]?.body).toEqual({
    scope: 'account', entry: { canonical: 'Guanxi', variants: ['гуанси', 'гуаньси'], language: 'en' } })

  // Edit.
  await entryButton(page, 'Edit Guanxi').click()
  await expect(page.getByLabel('Canonical term')).toHaveValue('Guanxi')
  await page.getByLabel('Canonical term').fill('Guanxi 2')
  await page.getByRole('button', { name: 'Save entry' }).click()
  await expect(page.getByRole('form')).toHaveCount(0)
  await expect(cardOf(page, 'Guanxi 2')).toContainText('Revision 2')
  await expect(entryButton(page, 'Edit Guanxi 2')).toBeFocused()
  expect(node.requests.filter((request) => request.method === 'PUT')).toHaveLength(1)

  // Revert returns the previous revision; the history shows three revisions, newest first.
  await entryButton(page, 'Revert Guanxi 2').click()
  await expect(cardOf(page, 'Guanxi')).toContainText('Revision 3')
  await expect(page.getByTestId('glossary-announcement')).toHaveText('Reverted “Guanxi”, now revision 3.')
  await entryButton(page, 'History of Guanxi').click()
  const history = page.getByTestId('glossary-history')
  await expect(history.getByRole('listitem')).toHaveCount(3)
  expect(await history.getByRole('listitem').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-revision')))).toEqual(['3', '2', '1'])
  await expect(history.getByText('Current', { exact: true })).toHaveCount(1)
  expect(node.count('GET', '/gl_new_1/history')).toBeGreaterThanOrEqual(1)

  // Deactivate and reactivate.
  await entryButton(page, 'Deactivate Hono').click()
  await expect(cardOf(page, 'Hono')).toContainText('Inactive')
  await expect(entryButton(page, 'Edit Hono')).toBeDisabled()
  await expect(entryButton(page, 'Reactivate Hono')).toBeFocused()
  await entryButton(page, 'Reactivate Hono').click()
  await expect(cardOf(page, 'Hono')).not.toContainText('Inactive')
  expect(mutations(node).map((request) => `${request.method} ${request.path}`)).toEqual([
    'POST /', 'PUT /gl_new_1', 'POST /gl_new_1/revert', 'POST /gl_hono/deactivate', 'POST /gl_hono/reactivate',
  ])

  // Preview: highlighted replacements, the D-157 shape and the revision hash.
  await page.getByLabel('Dictated text').fill('открой пиара и хоно')
  const output = page.getByTestId('glossary-preview-output')
  await expect(output).toHaveText('открой PR-а и Hono')
  expect(await output.locator('mark').allTextContents()).toEqual(['PR-а', 'Hono'])
  await expect(page.getByTestId('glossary-preview-count')).toHaveText('Replacements: 2')
  await expect(page.getByTestId('glossary-revision')).toHaveText(/^[0-9a-f]{64}$/u)
  const hash = await page.getByTestId('glossary-revision').textContent()
  await entryButton(page, 'Deactivate PR').click()
  await expect(page.getByTestId('glossary-revision')).not.toHaveText(hash ?? '')
  await expect(output).toHaveText('открой пиара и Hono')
  expect(await output.locator('mark').allTextContents()).toEqual(['Hono'])
})

test('keyboard alone completes create, edit, deactivate and revert, with a visible focus ring on every stop', async ({ page }) => {
  const node = seedGlossary(createGlossaryNode())
  await open(page, node)
  await ready(page)
  const focused = () => page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    if (!element) return null
    const labelledBy = element.getAttribute('aria-labelledby')
    const label = element.getAttribute('aria-label') ?? (labelledBy ? document.getElementById(labelledBy)?.textContent : null) ?? (element as HTMLInputElement).labels?.[0]?.textContent ?? element.textContent
    const style = getComputedStyle(element)
    const ring = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none'
    return { label: (label ?? '').replace('✓', '').trim().replace(/\s+/gu, ' '), ring }
  })

  // Tab order of the page chrome up to the first control of the list.
  await page.getByRole('link', { name: 'Back to Settings' }).focus()
  const order: string[] = []
  for (let step = 0; step < 4; step++) {
    await page.keyboard.press('Tab')
    const state = await focused()
    expect(state?.ring, `focus ring on ${state?.label}`).toBe(true)
    order.push(state?.label ?? '')
  }
  expect(order).toEqual(['Show entries for', 'Show inactive entries', 'New entry', 'Edit Hono'])

  // Create with the keyboard: Enter opens the form with focus in the first field.
  await page.getByRole('button', { name: 'New entry' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Canonical term')).toBeFocused()
  await page.keyboard.type('Keyboard')
  const stops: string[] = []
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press('Tab')
    const state = await focused()
    expect(state?.ring, `focus ring on ${state?.label}`).toBe(true)
    stops.push(state?.label ?? '')
  }
  expect(stops).toEqual(['Spoken forms', 'Language of the term', 'Match letter case exactly', 'Add Russian endings after a hyphen (PR-а)', 'Create entry', 'Cancel'])
  await page.getByRole('textbox', { name: 'Spoken forms', exact: true }).focus()
  await page.keyboard.type('клавиатура')
  await page.keyboard.press('Shift+Tab') // back to the canonical field
  await page.keyboard.press('Enter') // implicit submission from a text field
  await expect(page.getByRole('form')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 4, name: 'Keyboard' })).toBeFocused()
  expect(mutations(node)).toHaveLength(1)

  // From the new card's heading, Tab reaches its four actions; Space/Enter operate them.
  const actions: string[] = []
  for (let step = 0; step < 4; step++) {
    await page.keyboard.press('Tab')
    actions.push((await focused())?.label ?? '')
  }
  expect(actions).toEqual(['Edit Keyboard', 'Deactivate Keyboard', 'Revert Keyboard', 'History of Keyboard'])
  await page.getByRole('button', { name: 'Deactivate Keyboard' }).focus()
  await page.keyboard.press('Enter')
  await expect(entryButton(page, 'Reactivate Keyboard')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(entryButton(page, 'Deactivate Keyboard')).toBeFocused()
  await page.keyboard.press('Tab') // Edit is Deactivate's left neighbour; Revert is next
  await expect(entryButton(page, 'Revert Keyboard')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(entryButton(page, 'Revert Keyboard')).toBeFocused()
  expect(mutations(node).map((request) => request.path)).toEqual(['/', '/gl_new_1/deactivate', '/gl_new_1/reactivate', '/gl_new_1/revert'])

  // Edit and Cancel from the keyboard return focus to the Edit button.
  await entryButton(page, 'Edit PR').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Canonical term')).toBeFocused()
  await page.getByRole('button', { name: 'Cancel' }).focus()
  await page.keyboard.press('Enter')
  await expect(entryButton(page, 'Edit PR')).toBeFocused()
  expect(mutations(node)).toHaveLength(4)

  // The history toggle announces its state.
  const toggle = entryButton(page, 'History of PR')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

test('screen-reader structure: one h1, named regions, described controls and one live status', async ({ page }) => {
  const node = seedGlossary(createGlossaryNode())
  await open(page, node)
  await ready(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  // Two persistent polite status nodes in the ready state: the outcome announcement and the preview count.
  await expect(page.locator('main').getByRole('status')).toHaveCount(2)
  await expect(page.getByTestId('glossary-announcement')).toHaveAttribute('role', 'status')
  await expect(page.getByTestId('glossary-preview-count')).toHaveAttribute('role', 'status')
  await expect(page.getByRole('region', { name: 'Account-wide' })).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Project: Alpha' })).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Try it' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Deactivate Hono' })).toHaveAccessibleDescription(/Stops replacing this term. Nothing is deleted/u)
  await expect(page.getByRole('button', { name: 'Revert Hono' })).toHaveAccessibleDescription(/first revision, so reverting deactivates the entry/u)
  await entryButton(page, 'New entry').click()
  await expect(page.getByRole('textbox', { name: 'Spoken forms', exact: true })).toHaveAccessibleDescription(/PR-а/u)
  const unnamed = await page.locator('main, body').first().locator('input, select, textarea, button, summary').evaluateAll(
    (elements) => elements.filter((element) => {
      const control = element as HTMLInputElement
      if (control.type === 'hidden' || control.getAttribute('aria-hidden') === 'true') return false
      return !(control.getAttribute('aria-label') || control.getAttribute('aria-labelledby') || control.labels?.length || control.textContent?.trim())
    }).length)
  expect(unnamed).toBe(0)
})

test('every state has no critical or serious axe finding, in both themes and both locales', async ({ page }) => {
  for (const { locale, theme } of [{ locale: 'en', theme: 'light' }, { locale: 'en', theme: 'dark' }, { locale: 'ru', theme: 'light' }, { locale: 'ru', theme: 'dark' }] as const) {
    const copy = COPY[locale]
    const label = `${locale}/${theme}`
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    const node = seedGlossary(createGlossaryNode())
    node.seed({ canonical: 'Old', variants: [] }, { id: 'gl_old', active: false })
    await open(page, node, { locale, theme })
    await ready(page, locale)
    expect(await seriousViolations(page), `${label} ready`).toEqual([])

    // Create form with validation errors, then a server refusal.
    await page.getByRole('button', { name: copy.newEntry, exact: true }).click()
    await expect(page.getByRole('form')).toBeVisible()
    expect(await seriousViolations(page), `${label} form`).toEqual([])
    await page.getByRole('button', { name: copy.save }).click()
    await expect(page.getByRole('alert')).toHaveCount(1)
    expect(await seriousViolations(page), `${label} form with errors`).toEqual([])
    await page.getByLabel(copy.canonical).fill('Bad!')
    await page.getByRole('button', { name: copy.save }).click()
    await expect(page.getByRole('alert')).toContainText('glossary_invalid')
    expect(await seriousViolations(page), `${label} form with a server refusal`).toEqual([])
    await page.getByRole('button', { name: locale === 'en' ? 'Cancel' : 'Отмена' }).click()

    // History open and a preview result with highlights.
    await page.getByRole('button', { name: locale === 'en' ? 'History of Hono' : 'История записи Hono' }).click()
    await expect(page.getByTestId('glossary-history').getByRole('listitem')).toHaveCount(1)
    await page.getByLabel(copy.dictated).fill('пиара и хоно')
    await expect(page.getByTestId('glossary-preview-output').locator('mark')).toHaveCount(2)
    expect(await seriousViolations(page), `${label} history and preview`).toEqual([])
  }
})

test('loading, empty, error and offline states are single, accessible and recoverable', async ({ page }) => {
  // Loading.
  let release!: () => void
  const held = seedGlossary(createGlossaryNode())
  held.holdList = new Promise<void>((resolve) => { release = resolve })
  await open(page, held)
  await expect(page.getByTestId('glossary-skeleton')).toHaveCount(1)
  await expect(page.getByText('Loading the glossary…', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('article')).toHaveCount(0)
  expect(await seriousViolations(page), 'loading').toEqual([])
  release()
  await ready(page)

  // Empty: one sentence and exactly one primary action.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, createGlossaryNode())
  await ready(page)
  await expect(page.locator('[data-slot="empty-state"]')).toHaveCount(1)
  await expect(page.getByText('No glossary entries yet. Add the first term you want corrected.', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'New entry' })).toHaveCount(1)
  expect(await seriousViolations(page), 'empty').toEqual([])

  // Error: a rejected list names its source and code, and recovers by itself (D-203: no Retry).
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  const broken = seedGlossary(createGlossaryNode())
  broken.fail.set('GET /', { status: 503, code: 'glossary_unavailable' }) // persistent: the dev build may read twice before the page settles
  await open(page, broken)
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText('GET /api/voice/glossary')
  await expect(page.getByRole('alert')).toContainText('glossary_unavailable')
  expect(await seriousViolations(page), 'error').toEqual([])
  await expect(page.getByRole('button', { name: /^(Retry|Reload)/u })).toHaveCount(0)
  broken.fail.delete('GET /')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await ready(page)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('article')).toHaveCount(3)

  // Offline: last known entries with their age, every network action disabled with a reason.
  broken.down = true
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('[data-state="node_unreachable"]')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText(/As of /u)
  await expect(page.getByRole('article')).toHaveCount(3)
  await expect(entryButton(page, 'New entry')).toBeDisabled()
  for (const name of ['Edit Hono', 'Deactivate Hono', 'Revert Hono']) await expect(entryButton(page, name)).toBeDisabled()
  await expect(entryButton(page, 'Edit Hono')).toHaveAccessibleDescription(/disabled until the connection returns/u)
  expect(await seriousViolations(page), 'offline').toEqual([])
  broken.down = false
  await expect(page.getByRole('button', { name: /^(Retry|Reload)/u })).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('[data-state="node_unreachable"]')).toHaveCount(0)
  await expect(entryButton(page, 'Edit Hono')).toBeEnabled()
})

test('a refused save keeps the form and the typed values, names no term and changes nothing', async ({ page }) => {
  const node = seedGlossary(createGlossaryNode())
  await open(page, node)
  await ready(page)
  await entryButton(page, 'New entry').click()
  await page.getByLabel('Canonical term').fill('Private-Term')
  await page.getByRole('textbox', { name: 'Spoken forms', exact: true }).fill('хоно')
  await page.getByRole('button', { name: 'Create entry' }).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  const text = await page.getByRole('alert').innerText()
  expect(text).toContain('The entry was not saved')
  expect(text).toContain('Nothing was changed')
  expect(text).not.toContain('Private-Term')
  expect(text).not.toContain('хоно')
  await expect(page.getByLabel('Canonical term')).toHaveValue('Private-Term')
  await expect(page.getByRole('textbox', { name: 'Spoken forms', exact: true })).toHaveValue('хоно')
  expect(await page.evaluate(() => document.activeElement?.closest('[role="alert"]') !== null || document.activeElement?.querySelector('[role="alert"]') !== null)).toBe(true)
  expect(node.entries.size).toBe(3)
  await expect(page.getByRole('article')).toHaveCount(3)
})

test('phone width (320 px) with 200% text keeps everything inside the viewport with 24 px targets, even with very long terms', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  const node = seedGlossary(createGlossaryNode())
  node.seed({ canonical: 'ExtraordinarilyLongTermWithoutAnySpacesThatKeepsGoingAndGoing', variants: ['очень-длинная-произносимая-форма-без-пробелов-которая-не-кончается', 'x'] }, { id: 'gl_long' })
  await open(page, node)
  await ready(page)
  const check = async (label: string) => {
    const overflow = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="glossary-page"]') as HTMLElement
      const visible = Array.from(root.querySelectorAll<HTMLElement>('*')).filter((element) => element.getBoundingClientRect().width > 0 && element.closest('[hidden]') === null)
      return {
        document: document.documentElement.scrollWidth - innerWidth,
        page: root.scrollWidth - root.clientWidth,
        past: visible.filter((element) => element.getBoundingClientRect().right > innerWidth + 1).map((element) => `${element.tagName} ${element.textContent?.trim().slice(0, 24)}`),
      }
    })
    expect(overflow.document, `${label} document overflow`).toBeLessThanOrEqual(0)
    expect(overflow.page, `${label} glossary page overflow`).toBeLessThanOrEqual(1)
    expect(overflow.past, `${label} elements past the right edge`).toEqual([])
    const small = await page.getByTestId('glossary-page').locator('button, select, summary, input:not([aria-hidden="true"][tabindex="-1"]), textarea, a').evaluateAll(
      (elements) => elements.filter((element) => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && (box.height < 24 || box.width < 24)
      }).map((element) => `${element.tagName} ${element.textContent?.trim().slice(0, 20)} ${Math.round(element.getBoundingClientRect().height)}`))
    expect(small, `${label} targets under 24 px`).toEqual([])
  }
  await entryButton(page, 'New entry').click()
  await page.getByLabel('Canonical term').fill('Bad!') // the node refuses it: an error state with a long machine source must fit too
  await page.getByRole('button', { name: 'Create entry' }).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await entryButton(page, 'History of ExtraordinarilyLongTermWithoutAnySpacesThatKeepsGoingAndGoing').click()
  await page.getByLabel('Dictated text').fill('хоно и пиара')
  await expect(page.getByTestId('glossary-preview-output').locator('mark')).toHaveCount(2)
  await check('phone 320')
  const before = await textSizes(page)
  await scaleText(page, 2)
  const after = await textSizes(page)
  expect(after.heading / before.heading, 'heading text really doubled').toBeCloseTo(2, 1)
  expect(after.hint / before.hint, 'body text really doubled').toBeCloseTo(2, 1)
  await check('phone 320 at 200% text')
  expect(await seriousViolations(page), 'phone at 200% text').toEqual([])
})

test('reduced motion: nothing animates on the page, and the skeleton is static', async ({ page }) => {
  let release!: () => void
  const node = seedGlossary(createGlossaryNode())
  node.holdList = new Promise<void>((resolve) => { release = resolve })
  await open(page, node)
  await expect(page.getByTestId('glossary-skeleton')).toHaveCount(1)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0)
  release()
  await ready(page)
  await entryButton(page, 'Deactivate Hono').click()
  await expect(cardOf(page, 'Hono')).toContainText('Inactive')
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0)
})

test('seeded violation: an unnamed icon button on the glossary page is reported', async ({ page }) => {
  const node = seedGlossary(createGlossaryNode())
  await open(page, node)
  await ready(page)
  await page.locator('main').evaluate((region) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-g14-seed', '')
    button.innerHTML = '<svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>'
    region.append(button)
  })
  expect((await seriousViolations(page)).some((line) => line.startsWith('button-name: ') && line.includes('data-g14-seed'))).toBe(true)
})
