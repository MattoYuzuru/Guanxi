import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { installChatApiFixture } from './fixtures/chat-api.ts'

const webRoot = fileURLToPath(new URL('../..', import.meta.url))
let directory: string
let origin: string
let server: Server

test.beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'guanxi-ds1a-built-fonts-'))
  execFileSync(process.execPath, [resolve(webRoot, '../../node_modules/vite/bin/vite.js'), 'build', '--outDir', directory, '--emptyOutDir'], { cwd: webRoot, stdio: 'pipe' })
  const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.html': 'text/html', '.svg': 'image/svg+xml' }
  server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const path = resolve(directory, '.' + pathname)
    if (path !== directory && !path.startsWith(directory + sep)) { response.writeHead(403).end(); return }
    try {
      const target = path === directory || !extname(path) ? resolve(directory, 'index.html') : path
      const contents = await readFile(target)
      response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream' }).end(contents)
    } catch { response.writeHead(404).end() }
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener')
  origin = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('M1: every one of the 32 font faces loads from the built app origin', async ({ page }) => {
  const fonts: string[] = []
  const failedFonts: string[] = []
  page.on('request', request => { if (request.resourceType() === 'font') fonts.push(request.url()) })
  page.on('requestfailed', request => { if (request.resourceType() === 'font') failedFonts.push(request.url()) })
  await installChatApiFixture(page, 'completed')
  await page.goto(origin)
  const loaded = await page.evaluate(async () => {
    const faces = [...document.fonts]
    await Promise.all(faces.map(face => face.load()))
    await document.fonts.ready
    return { count: faces.length, loaded: faces.filter(face => face.status === 'loaded').length, warning: getComputedStyle(document.documentElement).getPropertyValue('--warning').trim(), focus: getComputedStyle(document.documentElement).getPropertyValue('--focus').trim() }
  })
  expect(loaded.count).toBe(32)
  expect(loaded.loaded).toBe(32)
  expect(loaded.warning).not.toBe('')
  expect(loaded.focus).not.toBe('')
  expect(new Set(fonts).size).toBe(32)
  expect(fonts.filter(url => new URL(url).origin !== origin)).toHaveLength(0)
  expect(failedFonts).toHaveLength(0)
})

test('font network observation catches an injected non-local font request', async ({ page }) => {
  const violations: string[] = []
  page.on('request', request => {
    if (request.resourceType() === 'font' && new URL(request.url()).origin !== origin) violations.push(request.url())
  })
  await page.route('https://font-gate.invalid/**', route => route.abort())
  await installChatApiFixture(page, 'completed')
  await page.goto(origin)
  await page.addStyleTag({ content: '@font-face { font-family: GateSeed; src: url("https://font-gate.invalid/seed.woff2") format("woff2"); }' })
  await page.evaluate(() => document.fonts.load('13px GateSeed', 'Seed').catch(() => []))
  expect(violations).toEqual(['https://font-gate.invalid/seed.woff2'])
})

test('generated theme, density and motion modifiers remain independent of OS media', async ({ page }) => {
  await installChatApiFixture(page, 'completed')
  await page.goto(origin)
  for (const colorScheme of ['light', 'dark'] as const) for (const contrast of ['no-preference', 'more'] as const) {
    await page.emulateMedia({ colorScheme, contrast, reducedMotion: 'reduce' })
    for (const theme of ['light', 'dark', 'light-hc', 'dark-hc', 'system']) for (const density of ['compact', 'comfortable']) for (const motion of ['full', 'reduced']) {
      const actual = await page.evaluate(({ theme, density, motion }) => {
        const root = document.documentElement
        root.dataset.theme = theme
        root.dataset.density = density
        root.dataset.motion = motion
        const css = getComputedStyle(root)
        return Object.fromEntries(['--font-text-size', '--control-height', '--row-height', '--panel-padding', '--pane-gap', '--grid-unit', '--motion-duration-medium'].map(name => {
          const value = css.getPropertyValue(name).trim()
          // Production CSS minification can normalize 200ms to .2s.
          return [name, name === '--motion-duration-medium' ? `${Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000)}ms` : value]
        }))
      }, { theme, density, motion })
      expect(actual, `${colorScheme}/${contrast}/${theme}/${density}/${motion}`).toEqual({
        '--font-text-size': density === 'compact' ? '13px' : '14px',
        '--control-height': density === 'compact' ? '28px' : '32px',
        '--row-height': density === 'compact' ? '26px' : '32px',
        '--panel-padding': density === 'compact' ? '8px' : '12px',
        '--pane-gap': density === 'compact' ? '8px' : '12px',
        '--grid-unit': '4px',
        '--motion-duration-medium': motion === 'full' ? '200ms' : '0ms',
      })
    }
  }
})

test('H2: built app applies IBM Plex typography, density type size and spacing', async ({ page }) => {
  await installChatApiFixture(page, 'completed')
  await page.goto(origin)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const density of ['compact', 'comfortable'] as const) {
      const actual = await page.evaluate(({ theme, density }) => {
        const root = document.documentElement
        root.dataset.theme = theme
        root.classList.toggle('dark', theme === 'dark')
        root.dataset.density = density
        const sample = document.createElement('div')
        sample.className = 'font-mono p-2 gap-3'
        // Compare resolved lengths: the generated grid token is 4px, Tailwind's is .25rem.
        sample.style.marginTop = 'var(--spacing)'
        document.body.append(sample)
        const bodyCss = getComputedStyle(document.body)
        const css = getComputedStyle(sample)
        const result = { bodyFont: bodyCss.fontFamily, bodySize: bodyCss.fontSize, bodyLineHeight: bodyCss.lineHeight, mono: css.fontFamily, padding: css.padding, gap: css.gap, spacing: css.marginTop }
        sample.remove()
        return result
      }, { theme, density })
      const label = `${theme}/${density}`
      expect(actual.bodyFont, label).toContain('IBM Plex Sans')
      expect(actual.bodyFont, label).not.toContain('Inter')
      expect(actual.mono, label).toContain('IBM Plex Mono')
      expect(actual.mono, label).not.toContain('SF Mono')
      expect(actual.bodySize, label).toBe(density === 'compact' ? '13px' : '14px')
      // Computed line-height is the 1.5 ratio resolved against the density body size.
      expect(actual.bodyLineHeight, label).toBe(density === 'compact' ? '19.5px' : '21px')
      expect(actual.padding, label).toBe('8px')
      expect(actual.gap, label).toBe('12px')
      expect(actual.spacing, label).toBe('4px')
    }
  }
})

test('automatic Solid overrides strong and locally selected glass recipes', async ({ page }) => {
  await installChatApiFixture(page, 'completed')
  await page.goto(origin)
  const inspect = async (trigger: string, level: string) => page.evaluate(({ trigger, level }) => {
    const root = document.documentElement
    for (const name of ['data-reduce-transparency', 'data-battery-saver', 'data-gpu-compositing', 'data-theme']) root.removeAttribute(name)
    root.dataset.theme = 'light'
    root.dataset.material = level
    if (trigger === 'hc') root.dataset.theme = 'light-hc'
    else if (trigger === 'gpu') root.dataset.gpuCompositing = 'off'
    else if (trigger !== 'media') root.setAttribute(trigger, '')
    const child = document.createElement('div')
    child.dataset.elevation = '3'
    child.dataset.material = level
    root.append(child)
    const styles = [root, child].map(element => {
      const css = getComputedStyle(element)
      const probe = document.createElement('div')
      const reference = document.createElement('div')
      probe.style.backgroundColor = 'var(--material-background)'
      probe.style.borderColor = 'var(--material-border)'
      reference.style.backgroundColor = 'var(--material-solid-fill)'
      reference.style.borderColor = 'var(--material-solid-border)'
      element.append(probe, reference)
      const actual = getComputedStyle(probe), solid = getComputedStyle(reference)
      const values = { backdrop: css.getPropertyValue('--material-backdrop').trim(), grain: css.getPropertyValue('--material-grain').trim(), background: actual.backgroundColor, solidBackground: solid.backgroundColor, border: actual.borderTopColor, solidBorder: solid.borderTopColor }
      probe.remove()
      reference.remove()
      return values
    })
    child.remove()
    return styles
  }, { trigger, level })
  const assertSolid = (styles: Awaited<ReturnType<typeof inspect>>) => {
    expect(styles).toHaveLength(2)
    for (const css of styles) {
      expect(css.backdrop).toBe('none')
      expect(css.grain).toBe('0')
      expect(css.background).toBe(css.solidBackground)
      expect(css.border).toBe(css.solidBorder)
      expect(css.background).not.toMatch(/\/\s*0(?:\.|\))/)
    }
  }
  for (const level of ['glass', 'tinted', 'solid']) for (const trigger of ['hc', 'gpu', 'data-reduce-transparency', 'data-battery-saver']) assertSolid(await inspect(trigger, level))
  await page.emulateMedia({ contrast: 'more' })
  assertSolid(await inspect('media', 'glass'))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
  assertSolid(await inspect('media', 'tinted'))
  await cdp.detach()
})

test('compiled Tailwind theme resolves font, spacing and percentage radius tokens', async ({ page }) => {
  const requireUI = createRequire(new URL('../../../ui/package.json', import.meta.url))
  const { compile } = requireUI('tailwindcss') as typeof import('tailwindcss')
  const source = await readFile(fileURLToPath(new URL('../../../ui/generated/theme.css', import.meta.url)), 'utf8')
  const compiled = (await compile(source + '\n@tailwind utilities;')).build(['font-sans', 'font-mono', 'gap-2', 'rounded-app-tile-ratio'])
  await installChatApiFixture(page, 'completed')
  await page.goto(origin)
  await page.addStyleTag({ content: compiled })
  const actual = await page.evaluate(() => {
    const item = document.createElement('div')
    item.className = 'font-sans gap-2 rounded-app-tile-ratio'
    document.body.append(item)
    const css = getComputedStyle(item)
    const result = { font: css.fontFamily, gap: css.gap, radius: css.borderRadius }
    item.remove()
    return result
  })
  expect(actual.font).toContain('IBM Plex Sans')
  expect(actual.gap).toBe('8px')
  expect(actual.radius).toBe('21.9%')
})

test('legacy Light and Dark semantic warning and focus follow the class, independently of OS', async ({ page }) => {
  await installChatApiFixture(page, 'completed')
  await page.goto(origin)
  const seen: Record<string, string[]> = {}
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, contrast: 'no-preference' })
    for (const dark of [false, true]) seen[`${colorScheme}/${dark}`] = await page.evaluate(dark => {
      const root = document.documentElement
      root.removeAttribute('data-theme')
      root.classList.toggle('dark', dark)
      const css = getComputedStyle(root)
      return ['--warning', '--focus'].map(name => css.getPropertyValue(name).trim())
    }, dark)
  }
  expect(seen['light/false']).toEqual(seen['dark/false'])
  expect(seen['light/true']).toEqual(seen['dark/true'])
  expect(seen['light/false']).not.toEqual(seen['light/true'])
})
