import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { Page } from '@playwright/test'
import { alive, closeAllShells, fakeServiceEntry, freePort, killQuietly, launchShell, listenCounting, listenSilent, makeSandbox, readServiceManifest } from './harness.ts'
import type { LaunchOptions, Sandbox } from './harness.ts'

interface Screen {
  state: string
  severity: string
  title: string
  text: string
  lang: string
  bridge: unknown
}

async function readScreen(page: Page): Promise<Screen> {
  await page.waitForSelector('main[data-state]:not([data-state="checking"]):not([data-state="starting"])', { timeout: 30_000 })
  return page.evaluate(async () => {
    const main = document.querySelector('main')!
    const bridge = (window as unknown as { guanxiDesktop: { info(): Promise<unknown> } }).guanxiDesktop
    return {
      state: main.dataset['state'] ?? '',
      severity: main.dataset['severity'] ?? '',
      title: main.querySelector('h1')?.textContent ?? '',
      text: main.textContent ?? '',
      lang: document.documentElement.lang,
      bridge: await bridge.info(),
    }
  })
}

describe('handshake failure states are visible and localized', () => {
  let sandbox: Sandbox
  let port: number
  const cleanups: Array<() => Promise<void>> = []

  beforeEach(async () => {
    sandbox = makeSandbox()
    port = await freePort()
  })

  afterEach(async () => {
    await closeAllShells()
    await killQuietly(readServiceManifest(sandbox)?.pid)
    for (const cleanup of cleanups.splice(0)) await cleanup()
    sandbox.cleanup()
  })

  const show = async (options: Partial<LaunchOptions> = {}) => {
    const { page } = await launchShell({ sandbox, port, ...options })
    return { page, screen: await readScreen(page) }
  }

  it('port_busy: another program answers on the port; it is left alone', async () => {
    const foreign = await listenCounting(port)
    cleanups.push(foreign.close)
    const { screen } = await show()
    assert.equal(screen.state, 'port_busy')
    assert.equal(screen.severity, 'error')
    assert.match(screen.title, new RegExp(`Port ${port} is in use`))
    assert.match(screen.text, /GUANXI_API_PORT/)
    assert.equal(readServiceManifest(sandbox), null, 'nothing was started')
    assert.ok(foreign.hits.length > 0 && foreign.hits.every((hit) => hit.startsWith('GET ')), 'only probed with GET')
    assert.equal(screen.bridge, null, 'the status page gets nothing from the bridge')
  })

  it('service_missing: the entry does not exist', async () => {
    const entry = join(sandbox.dir, 'nowhere', 'bin.js')
    const { screen } = await show({ service: entry })
    assert.equal(screen.state, 'service_missing')
    assert.match(screen.title, /service is missing/)
    assert.ok(screen.text.includes(entry), 'the expected path is shown')
    assert.equal(readServiceManifest(sandbox), null)
  })

  it('health_timeout: a started service never listens; it is stopped and no manifest is left', async () => {
    const { screen } = await show({ env: { GUANXI_FAKE_MODE: 'never-listen', GUANXI_DESKTOP_HEALTH_TIMEOUT_MS: '1500' } })
    assert.equal(screen.state, 'health_timeout')
    assert.match(screen.text, /did not answer on port/)
    assert.match(screen.text, /It was stopped/)
    assert.equal(readServiceManifest(sandbox), null)
    const log = readFileSync(join(sandbox.dataDir, 'desktop', 'service.log'), 'utf8')
    assert.match(log, /alive but never listens/)
  })

  it('health_timeout: a listener that accepts and never answers is reported and not touched', async () => {
    const silent = await listenSilent(port)
    cleanups.push(silent.close)
    const { screen } = await show({ env: { GUANXI_DESKTOP_PROBE_TIMEOUT_MS: '600' } })
    assert.equal(screen.state, 'health_timeout')
    assert.match(screen.text, /did not touch it/)
    assert.equal(readServiceManifest(sandbox), null, 'no second process was started beside it')
  })

  it('service_exited: the service ends while starting; exit code and log path are shown', async () => {
    const { screen } = await show({ env: { GUANXI_FAKE_MODE: 'exit-early' } })
    assert.equal(screen.state, 'service_exited')
    const log = join(sandbox.dataDir, 'desktop', 'service.log')
    assert.match(screen.text, /exit code 3/)
    assert.ok(screen.text.includes(log))
    assert.ok(existsSync(log))
    assert.match(readFileSync(log, 'utf8'), /refusing to start/)
  })

  it('ui_missing: the node answers without a UI build', async () => {
    const { screen } = await show({ env: { GUANXI_FAKE_MODE: 'no-ui' } })
    assert.equal(screen.state, 'ui_missing')
    assert.match(screen.title, /has no interface/)
  })

  it('config_invalid: a bad port is named, and nothing is started', async () => {
    const { screen } = await show({ env: { GUANXI_API_PORT: 'abc' } })
    assert.equal(screen.state, 'config_invalid')
    assert.match(screen.text, /GUANXI_API_PORT/)
    assert.match(screen.text, /"abc"/)
    assert.equal(readServiceManifest(sandbox), null)
  })

  it('shows the same screens in Russian when the system language is Russian', async () => {
    const foreign = await listenCounting(port)
    cleanups.push(foreign.close)
    const { screen } = await show({ lang: 'ru' })
    assert.equal(screen.state, 'port_busy')
    assert.equal(screen.lang, 'ru')
    assert.match(screen.title, new RegExp(`Порт ${port} занят`))
    assert.match(screen.text, /вместо службы Guanxi отвечает другая программа/)
    assert.doesNotMatch(screen.text, /is in use/)
  })

  it('recovers by itself when a Guanxi appears on the port (no Retry button)', async () => {
    const foreign = await listenCounting(port)
    const { page } = await launchShell({ sandbox, port })
    const screen = await readScreen(page)
    assert.equal(screen.state, 'port_busy')
    assert.equal(await page.locator('button, a[href]').count(), 0, 'the status page has no controls')

    // The owner frees the port and a node comes up (started by hand, as the CLI would).
    await foreign.close()
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [fakeServiceEntry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', sandbox.dataDir], { stdio: 'ignore', detached: true })
    child.unref()
    cleanups.push(async () => killQuietly(child.pid))
    await page.waitForSelector('#fake-title', { timeout: 20_000 })
    assert.equal(new URL(page.url()).origin, `http://127.0.0.1:${port}`)
    assert.ok(child.pid !== undefined && alive(child.pid))
    assert.equal(readServiceManifest(sandbox), null, 'attaching does not claim ownership of a service the shell did not start')
  })
})
