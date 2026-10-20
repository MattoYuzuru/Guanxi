import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    const path = resolve(directory, '.' + decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname))
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

test('built web app requests only self-hosted fonts, including non-Latin slices', async ({ page }) => {
  const fonts: string[] = []
  const failedFonts: string[] = []
  page.on('request', request => { if (request.resourceType() === 'font') fonts.push(request.url()) })
  page.on('requestfailed', request => { if (request.resourceType() === 'font') failedFonts.push(request.url()) })
  await installChatApiFixture(page, 'completed')
  await page.goto(origin)
  const loaded = await page.evaluate(async () => {
    const text = 'Guanxi Привет Ελληνικά'
    const sans = await document.fonts.load('400 13px "IBM Plex Sans"', text)
    const mono = await document.fonts.load('400 13px "IBM Plex Mono"', 'Guanxi Привет 123')
    await document.fonts.ready
    return { sans: sans.length, mono: mono.length, warning: getComputedStyle(document.documentElement).getPropertyValue('--warning').trim(), focus: getComputedStyle(document.documentElement).getPropertyValue('--focus').trim() }
  })
  expect(loaded.sans).toBeGreaterThanOrEqual(3)
  expect(loaded.mono).toBeGreaterThanOrEqual(2)
  expect(loaded.warning).not.toBe('')
  expect(loaded.focus).not.toBe('')
  expect(fonts.length).toBeGreaterThanOrEqual(5)
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
