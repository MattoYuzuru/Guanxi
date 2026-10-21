/**
 * DS1-b exit gate in the real app: Settings → Developer → Components is hidden and not loaded
 * without Developer mode, renders every declared state of every component in every regime,
 * recolours a T2 iframe plugin through MCP Apps variables, and drives the review API.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page, type Route } from '@playwright/test'
import { mcpAppsVariables } from '../../../ui/generated/mcp-apps-variables.ts'
import { browserSettings, runtimeBrowserSnapshot } from './fixtures/runtime-snapshot.ts'

interface ManifestComponent {
  id: string
  level: 'primitive' | 'pattern'
  states: string[]
  sourceHash: string
  snapshotHashes: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../../../ui/catalog/manifest.json', import.meta.url), 'utf8'),
) as { components: ManifestComponent[] }
const expectedKeys = manifest.components.flatMap((component) => component.states.map((state) => `${component.id}--${state}`))

const observedAt = '2026-10-20T12:00:00.000Z'
const health = {
  ok: true,
  appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt },
  ollama: {
    installed: true,
    installSource: 'runtime_response',
    running: true,
    state: 'reachable',
    source: 'ollama_api_version',
    observedAt,
    version: 'test',
    host: 'http://127.0.0.1:11434',
    installHint: null,
  },
  hardware: {
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'fixture',
    cpuCores: 8,
    totalMemoryBytes: 16_000_000_000,
    usableMemoryBytes: 12_000_000_000,
    accelerator: 'metal',
    acceleratorName: 'fixture',
    unifiedMemory: true,
    freeDiskBytes: null,
  },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

type ReviewMock = {
  capability: unknown
  submits: Array<Record<string, unknown>>
}

async function mockApi(page: Page, review: Partial<ReviewMock> = {}): Promise<ReviewMock> {
  const state: ReviewMock = {
    capability: review.capability ?? { writable: false, reason: 'not_source_checkout', keyId: null, observedAt },
    submits: [],
  }
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/health') return route.fulfill(json(health))
    if (url.pathname === '/api/settings') return route.fulfill(json(browserSettings({ locale: 'en', theme: 'light' })))
    if (url.pathname === '/api/runtime') return route.fulfill(json(runtimeBrowserSnapshot()))
    if (url.pathname === '/api/models') return route.fulfill(json({ models: [] }))
    if (url.pathname === '/api/ui-catalog/review-capability') return route.fulfill(json(state.capability))
    const match = /^\/api\/ui-catalog\/components\/([a-z-]+)\/review$/.exec(url.pathname)
    if (match) {
      const component = manifest.components.find((item) => item.id === match[1])!
      const record = { id: component.id, status: 'draft', approval: null, requests: [] }
      const current = { sourceHash: component.sourceHash, snapshotHashes: component.snapshotHashes }
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>
        state.submits.push(body)
        return route.fulfill(
          json({
            id: component.id,
            record: {
              ...record,
              status: 'approved',
              approval: { at: observedAt, ...current, comment: body['comment'], keyId: 'ed25519:test', previous: null, signature: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==' },
            },
            current,
            signature: 'valid',
            signatureReason: null,
            status: 'approved',
            observedAt,
          }),
        )
      }
      return route.fulfill(json({ id: component.id, record, current, signature: 'absent', signatureReason: null, status: 'draft', observedAt }))
    }
    return route.fulfill(json({ code: 'internal_error', message: url.pathname, details: null }, 500))
  })
  return state
}

async function enableDeveloperMode(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('guanxi.developerMode', 'on'))
}

// Product primitives load independently of Developer mode; catalog payloads remain lazy.
const catalogModule = /CatalogRoute\.tsx|\/packages\/ui\/catalog\/|\/packages\/ui\/src\/story-kit\/|\/packages\/ui\/src\/components\/[^/]+\/[^/]+\.(?:stories\.tsx|docs\.md|review\.json)/

test('the catalog is hidden and never requested until Developer mode is on', async ({ page }) => {
  for (const path of [
    '/src/features/catalog/CatalogRoute.tsx', '/packages/ui/catalog/index.ts',
    '/packages/ui/src/story-kit/index.tsx', '/packages/ui/src/components/button/button.stories.tsx',
    '/packages/ui/src/components/button/button.docs.md?raw', '/packages/ui/src/components/button/button.review.json?import',
  ]) expect(catalogModule.test(path), path).toBe(true)
  for (const path of ['/packages/ui/src/index.ts', '/packages/ui/src/components/button/button.tsx']) {
    expect(catalogModule.test(path), path).toBe(false)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockApi(page)
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))

  await page.goto('/settings/developer/components')
  await expect(page.getByText('Developer mode is off')).toBeVisible()
  await expect(page.locator('[data-story]')).toHaveCount(0)
  await page.goto('/settings')
  const toggle = page.getByRole('switch', { name: 'Developer mode' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('link', { name: 'Open the component catalog' })).toHaveCount(0)
  expect(requested.filter((url) => catalogModule.test(url))).toEqual([])

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(requested.filter((url) => catalogModule.test(url))).toEqual([])
  await page.getByRole('link', { name: 'Open the component catalog' }).click()
  await expect(page).toHaveURL(/\/settings\/developer\/components$/)
  await expect(page.locator('[data-story]')).toHaveCount(expectedKeys.length)
  expect(requested.some((url) => /CatalogRoute\.tsx/.test(url))).toBe(true)

  // Turning it off again hides the catalog on the next visit.
  await page.goto('/settings')
  await page.getByRole('switch', { name: 'Developer mode' }).click()
  await page.goto('/settings/developer/components')
  await expect(page.getByText('Developer mode is off')).toBeVisible()
})

// Each theme's canvas and secondary text as DS1-a generates them (FOUNDATIONS §1.1, §1.4).
const themeValues = (theme: keyof typeof mcpAppsVariables) => ({
  canvas: mcpAppsVariables[theme]['--color-background-primary'],
  secondaryText: mcpAppsVariables[theme]['--color-text-secondary'],
})
const THEMES = {
  light: themeValues('light'),
  dark: themeValues('dark'),
  'light-hc': themeValues('light-hc'),
  'dark-hc': themeValues('dark-hc'),
} as const
const DENSITIES = { compact: '28px', comfortable: '32px' } as const
// FOUNDATIONS §4 tables as DS1-a generates them: backdrop, and the fill opacity of normal and
// strong (elevation 3, dialogs) glass per theme family. High-contrast themes always use Solid.
const GLASS = {
  glass: {
    blur: 'blur(20px) saturate(1.15)',
    strongBlur: 'blur(24px) saturate(1.15)',
    opacity: { light: '0.72', dark: '0.7' },
    strongOpacity: { light: '0.9', dark: '0.88' },
  },
  tinted: {
    blur: 'blur(12px) saturate(1.15)',
    strongBlur: 'blur(12px) saturate(1.15)',
    opacity: { light: '0.9', dark: '0.9' },
    strongOpacity: { light: '0.96', dark: '0.96' },
  },
  // Solid keeps the recipe with zero blur; only forced Solid (HC, reduced transparency) is 'none'.
  solid: {
    blur: 'blur(0px) saturate(1)',
    strongBlur: 'blur(0px) saturate(1)',
    opacity: { light: '1', dark: '1' },
    strongOpacity: { light: '1', dark: '1' },
  },
} as const
const fillOf = (opacity: string) => new RegExp(`calc\\(\\s*${opacity.replace('.', '\\.')}\\s*\\*\\s*100%\\s*\\)`)

test('every component shows every declared state in all 24 theme, density and glass regimes', async ({ page }) => {
  test.setTimeout(240_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await enableDeveloperMode(page)
  await mockApi(page)
  for (const theme of Object.keys(THEMES) as Array<keyof typeof THEMES>) {
    for (const density of Object.keys(DENSITIES) as Array<keyof typeof DENSITIES>) {
      for (const glass of Object.keys(GLASS) as Array<keyof typeof GLASS>) {
        await page.goto(`/settings/developer/components?theme=${theme}&density=${density}&glass=${glass}`)
        await expect(page.locator('[data-story]')).toHaveCount(expectedKeys.length)
        const cells = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-story]')].map((cell) => {
            const stage = cell.querySelector<HTMLElement>('[data-gx-regime]')!
            const style = getComputedStyle(stage)
            const glassLayer = cell.querySelector<HTMLElement>('.gx-glass:not([data-elevation="3"])')
            const strongLayer = cell.querySelector<HTMLElement>('.gx-glass[data-elevation="3"]')
            return {
              key: cell.dataset['story'],
              theme: stage.dataset['theme'],
              density: stage.dataset['density'],
              glass: stage.dataset['material'],
              canvas: style.getPropertyValue('--color-background-primary').trim(),
              secondaryText: style.getPropertyValue('--color-text-secondary').trim(),
              controlHeight: style.getPropertyValue('--control-height').trim(),
              glassFill: glassLayer ? getComputedStyle(glassLayer).getPropertyValue('--material-background').trim() : null,
              strongFill: strongLayer ? getComputedStyle(strongLayer).getPropertyValue('--material-background').trim() : null,
              glassBackdrop: glassLayer ? getComputedStyle(glassLayer).backdropFilter : null,
              strongBackdrop: strongLayer ? getComputedStyle(strongLayer).backdropFilter : null,
              failed: cell.querySelector('[data-story-error]') !== null,
              // Toasts and other portalled layers render into the frame's portal container.
              rendered:
                (cell.querySelector('.gx-story-root')?.childElementCount ?? 0) +
                  (cell.querySelector('.gx-catalog-portal')?.childElementCount ?? 0) >
                0,
            }
          }),
        )
        const label = `${theme}/${density}/${glass}`
        // Exactly the declared states, each once (the catalog orders primitives before patterns).
        expect(cells.map((cell) => cell.key).sort(), label).toEqual([...expectedKeys].sort())
        const hc = theme.endsWith('-hc')
        for (const cell of cells) {
          expect(cell, `${label} ${cell.key}`).toMatchObject({
            theme,
            density,
            glass,
            canvas: THEMES[theme].canvas,
            secondaryText: THEMES[theme].secondaryText,
            controlHeight: DENSITIES[density],
            failed: false,
            rendered: true,
          })
          const family = theme.startsWith('dark') ? 'dark' : 'light'
          // High contrast forces the opaque solid fill (no color-mix at all) and no backdrop.
          if (cell.glassFill !== null) {
            if (hc) expect(cell.glassFill, `${label} ${cell.key}`).not.toContain('color-mix')
            else expect(cell.glassFill, `${label} ${cell.key}`).toMatch(fillOf(GLASS[glass].opacity[family]))
            expect(cell.glassBackdrop, `${label} ${cell.key}`).toBe(hc ? 'none' : GLASS[glass].blur)
          }
          if (cell.strongFill !== null) {
            if (hc) expect(cell.strongFill, `${label} ${cell.key}`).not.toContain('color-mix')
            else expect(cell.strongFill, `${label} ${cell.key}`).toMatch(fillOf(GLASS[glass].strongOpacity[family]))
            expect(cell.strongBackdrop, `${label} ${cell.key}`).toBe(hc ? 'none' : GLASS[glass].strongBlur)
          }
        }
        // Glass layers exist in this regime (popover, menu, select, toast stories; dialogs strong).
        expect(cells.filter((cell) => cell.glassBackdrop !== null).length, label).toBeGreaterThanOrEqual(5)
        expect(cells.filter((cell) => cell.strongBackdrop !== null).length, label).toBeGreaterThanOrEqual(2)
      }
    }
  }
})

test('the toolbar switches theme, density and material for every story without a reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await enableDeveloperMode(page)
  await mockApi(page)
  await page.goto('/settings/developer/components')
  await expect(page.locator('[data-story]')).toHaveCount(expectedKeys.length)
  const choose = async (control: string, option: string) => {
    await page.locator(`[data-catalog-control="${control}"]`).click()
    await page.getByRole('option', { name: option, exact: true }).click()
  }
  await choose('theme', 'Dark, high contrast')
  await choose('density', 'Comfortable')
  await choose('glass', 'Solid')
  await expect(page).toHaveURL(/theme=dark-hc/)
  const regimes = await page.locator('[data-story] [data-gx-regime]').evaluateAll((stages) =>
    [...new Set(stages.map((stage) => `${stage.getAttribute('data-theme')}/${stage.getAttribute('data-density')}/${stage.getAttribute('data-material')}`))],
  )
  expect(regimes).toEqual(['dark-hc/comfortable/solid'])
})

test('switching the theme recolours a sandboxed T2 plugin through MCP Apps variables only', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await enableDeveloperMode(page)
  await mockApi(page)
  await page.goto('/settings/developer/components?view=t2')
  const iframe = page.locator('iframe.gx-catalog-t2-frame')
  await expect(iframe).toHaveAttribute('data-plugin-initialized', '')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  const document = await iframe.getAttribute('srcdoc')
  const plugin = page.frameLocator('iframe.gx-catalog-t2-frame')
  const colours = () =>
    plugin.locator('body').evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      card: getComputedStyle(document.querySelector('[data-plugin-card]')!).backgroundColor,
      secondary: getComputedStyle(document.querySelector('[data-plugin-theme]')!).color,
      theme: document.querySelector('[data-plugin-theme]')!.textContent,
    }))
  // What the host itself paints with the same semantic tokens in that theme.
  const host = (theme: string, pluginTheme: string) =>
    page.evaluate(
      ([value, label]) => {
        const probe = document.createElement('div')
        probe.setAttribute('data-theme', value)
        document.body.append(probe)
        const paint = (name: string, property: 'backgroundColor' | 'color') => {
          const element = document.createElement('span')
          element.style[property] = `var(${name})`
          probe.append(element)
          return getComputedStyle(element)[property]
        }
        const result = {
          background: paint('--color-background-primary', 'backgroundColor'),
          card: paint('--color-background-secondary', 'backgroundColor'),
          secondary: paint('--color-text-secondary', 'color'),
          theme: label,
        }
        probe.remove()
        return result
      },
      [theme, pluginTheme],
    )
  const light = await host('light', 'light')
  expect(light.background).not.toBe(light.card)
  await expect.poll(colours).toEqual(light)

  await page.locator('[data-catalog-control="theme"]').click()
  await page.getByRole('option', { name: 'Dark', exact: true }).click()
  const dark = await host('dark', 'dark')
  expect(dark.background).not.toBe(light.background)
  await expect.poll(colours).toEqual(dark)

  await page.locator('[data-catalog-control="theme"]').click()
  await page.getByRole('option', { name: 'Light, high contrast', exact: true }).click()
  const lightHc = await host('light-hc', 'light')
  await expect.poll(colours).toEqual(lightHc)

  // The plugin document never changed; only host variables did.
  expect(await iframe.getAttribute('srcdoc')).toBe(document)
  await expect(page.locator('iframe.gx-catalog-t2-frame')).toHaveCount(1)
})

test('approving sends the hashes the node showed; a read-only node offers no review actions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await enableDeveloperMode(page)
  const review = await mockApi(page, { capability: { writable: true, reason: null, keyId: 'ed25519:test', observedAt } })
  await page.goto('/settings/developer/components?component=button')
  await page.getByRole('tab', { name: 'Review' }).click()
  await page.getByLabel('Comment').fill('Reads well in every theme.')
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Approved and signed.' })).toBeVisible()
  const button = manifest.components.find((component) => component.id === 'button')!
  expect(review.submits).toEqual([
    {
      decision: 'approve',
      comment: 'Reads well in every theme.',
      expectedSourceHash: button.sourceHash,
      expectedSnapshotHashes: button.snapshotHashes,
    },
  ])
  await expect(page.locator('.gx-catalog-review [data-status="approved"]')).toBeVisible()

  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await mockApi(page, { capability: { writable: false, reason: 'release_build', keyId: null, observedAt } })
  await page.goto('/settings/developer/components?component=button')
  await page.getByRole('tab', { name: 'Review' }).click()
  await expect(page.getByText('Release builds never write approvals.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Request changes' })).toHaveCount(0)
})

test('motion, transparency and language apply to every story; motion follows the OS by default', async ({ page }) => {
  await enableDeveloperMode(page)
  await mockApi(page)
  await page.goto('/settings/developer/components')
  await expect(page.locator('[data-story]')).toHaveCount(expectedKeys.length)
  // Default: no data-motion, so the OS setting decides (FOUNDATIONS §5).
  expect(await page.locator('[data-story] [data-gx-regime][data-motion]').count()).toBe(0)

  await page.goto('/settings/developer/components?motion=reduced&transparency=reduced&locale=ru&glass=glass')
  await expect(page.locator('[data-story]')).toHaveCount(expectedKeys.length)
  const stages = await page.locator('[data-story] [data-gx-regime]').evaluateAll((elements) =>
    elements.map((stage) => ({
      motion: stage.getAttribute('data-motion'),
      reduceTransparency: stage.hasAttribute('data-reduce-transparency'),
      lang: stage.getAttribute('lang'),
      fill: getComputedStyle(stage).getPropertyValue('--material-background').trim(),
      fast: getComputedStyle(stage).getPropertyValue('--motion-duration-slow').trim(),
      fade: getComputedStyle(stage).getPropertyValue('--motion-fade-slow').trim(),
      distance: getComputedStyle(stage).getPropertyValue('--motion-distance-md').trim(),
    })),
  )
  for (const stage of stages) {
    // Reduced transparency forces the opaque solid fill; reduced motion removes distance and
    // spatial duration (DS1-a: 0 ms) while fades keep a short duration.
    expect(stage).toMatchObject({ motion: 'reduced', reduceTransparency: true, lang: 'ru', fast: '0ms', distance: '0px' })
    expect(stage.fill).not.toContain('color-mix')
    expect(stage.fade).toBe('100ms')
  }
  await expect(page.locator('[data-story="button--default"]')).toContainText('Сохранить изменения')
  await expect(page.locator('[data-story="status-pill--running"]')).toContainText('Выполняется')
})

test('the catalog can be driven from the keyboard', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await enableDeveloperMode(page)
  await mockApi(page)
  await page.goto('/settings/developer/components')
  await expect(page.locator('[data-story]')).toHaveCount(expectedKeys.length)

  await page.getByRole('link', { name: 'Skip to the preview' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#gx-catalog-preview')).toBeFocused()

  await page.getByLabel('Search components').fill('dialog')
  await expect(page.locator('[data-catalog-results]')).toHaveText('1 components shown')
  const dialog = page.getByRole('button', { name: /^Dialog/ })
  await dialog.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 2, name: 'Dialog' })).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-current', 'page')

  const states = page.getByRole('tab', { name: 'States' })
  await states.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Usage' })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true')
})
