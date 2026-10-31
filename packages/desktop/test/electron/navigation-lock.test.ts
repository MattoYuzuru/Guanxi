import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { ElectronApplication, Page } from '@playwright/test'
import { closeAllShells, freePort, killQuietly, launchShell, listenCounting, makeSandbox, readServiceManifest, waitFor } from './harness.ts'
import type { Sandbox } from './harness.ts'

type Preferences = { getLastWebPreferences(): Record<string, unknown> }

describe('navigation and external-link lock', () => {
  let sandbox: Sandbox
  let app: ElectronApplication
  let page: Page
  let port: number
  let origin: string
  let remote: Awaited<ReturnType<typeof listenCounting>>
  let remoteOrigin: string

  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

  before(async () => {
    sandbox = makeSandbox()
    port = await freePort()
    origin = `http://127.0.0.1:${port}`
    // A second loopback server stands for "the internet": it answers CORS-open, so only the shell's own
    // lock can keep a page from reaching it. Any hit in `remote.hits` is a leak.
    const remotePort = await freePort()
    remoteOrigin = `http://127.0.0.1:${remotePort}`
    remote = await listenCounting(remotePort)
    const launched = await launchShell({ sandbox, port, env: { GUANXI_FAKE_OTHER_ORIGIN: remoteOrigin } })
    app = launched.app
    page = launched.page
    await page.waitForSelector('#fake-title', { timeout: 30_000 })
  })

  beforeEach(async () => {
    // Record what would reach the system browser instead of opening it.
    await app.evaluate(({ shell }) => {
      ;(globalThis as unknown as { __opened: string[] }).__opened = []
      ;(shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
        ;(globalThis as unknown as { __opened: string[] }).__opened.push(url)
      }
    })
    remote.hits.length = 0
    // A cancelled navigation leaves Playwright waiting on it; a fresh load of the first window clears that.
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
  })

  after(async () => {
    await closeAllShells()
    await remote.close()
    await killQuietly(readServiceManifest(sandbox)?.pid)
    sandbox.cleanup()
  })

  it('a link to another origin stays out of the window and goes to the system browser', async () => {
    // noWaitAfter: the navigation is cancelled on purpose, so Playwright must not wait for it to finish.
    await page.click('#ext', { noWaitAfter: true })
    await waitFor('the external open', async () => (await opened()).length > 0 || null)
    assert.deepEqual(await opened(), ['https://example.com/ext'])
    assert.equal(page.url(), `${origin}/`)
    assert.equal(await windowCount(), 1)
  })

  it('target=_blank to another origin opens the system browser and no window', async () => {
    await page.click('#ext-blank', { noWaitAfter: true })
    await waitFor('the external open', async () => (await opened()).length > 0 || null)
    assert.deepEqual(await opened(), ['https://example.com/blank'])
    assert.equal(await windowCount(), 1)
  })

  it('a same-origin link navigates inside the window', async () => {
    await page.click('#internal')
    await page.waitForURL(`${origin}/second`)
    assert.deepEqual(await opened(), [])
  })

  // Corrected behaviour (review L1): an external open needs a recent real user gesture, so a script that navigates
  // or opens on its own is stopped and opens nothing. This test used to expect the scripted URL to reach the
  // system browser; it now asserts that it does not, and the click-driven cases below still do.
  it('a script navigating the window to another origin is stopped and opens nothing without a user gesture', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_200)) // let any earlier click's activation lapse
    await page.evaluate(() => {
      window.location.href = 'https://example.com/scripted'
    })
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(page.url(), `${origin}/`)
    assert.deepEqual(await opened(), [])
  })

  it('a server redirect to another origin is stopped and never reaches it', async () => {
    await page.evaluate(() => {
      window.location.href = '/redirect'
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(remote.hits.length, 0, `remote was contacted: ${remote.hits.join(', ')}`)
    assert.equal(new URL(page.url()).origin, origin)
    assert.deepEqual(await opened(), [], 'a redirect is not user intent: nothing opens externally')
  })

  it('window.open denies file:, javascript: and data: and opens nothing', async () => {
    for (const url of ['file:///etc/hosts', 'javascript:window.__pwned=1', 'data:text/html,<p>x</p>', 'guanxi-shell://retry']) {
      await page.evaluate((target) => void window.open(target), url)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(await windowCount(), 1)
    assert.deepEqual(await opened(), [])
    assert.equal(await page.evaluate(() => (window as { __pwned?: number }).__pwned), undefined)
  })

  it('window.open to another origin: a click opens the system browser (no window); the same call from a script does not', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    await page.evaluate(() => void window.open('https://example.com/popup'))
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await opened(), [], 'no gesture, no open')
    await page.click('#open-ext')
    await waitFor('the external open', async () => (await opened()).length > 0 || null)
    assert.deepEqual(await opened(), ['https://example.com/from-click'])
    assert.equal(await windowCount(), 1)
  })

  it('a same-origin popout opens as a hardened child window with no Node access', async () => {
    const popup = page.waitForEvent('popup')
    await page.evaluate(() => void window.open('/popout.html'))
    const child = await popup
    await child.waitForSelector('#popout')
    assert.equal(await windowCount(), 2)
    assert.equal(new URL(child.url()).origin, origin)
    assert.deepEqual(await child.evaluate(() => (window as { __probe?: unknown }).__probe), { typeofRequire: 'undefined', typeofProcess: 'undefined' })
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows()
      const p = (all[all.length - 1]!.webContents as unknown as Preferences).getLastWebPreferences()
      return { sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation }
    })
    assert.deepEqual(prefs, { sandbox: true, nodeIntegration: false, contextIsolation: true })
    await child.close()
  })

  it('remote content cannot load: fetch, image, frame and socket to another origin are cancelled', async () => {
    const outcome = await page.evaluate(async (remoteUrl) => {
      const result: Record<string, string> = {}
      result['fetch'] = await fetch(`${remoteUrl}/fetch`).then(() => 'loaded', () => 'blocked')
      result['image'] = await new Promise<string>((resolve) => {
        const img = new Image()
        img.onload = () => resolve('loaded')
        img.onerror = () => resolve('blocked')
        img.src = `${remoteUrl}/image.png`
      })
      result['socket'] = await new Promise<string>((resolve) => {
        const socket = new WebSocket(`${remoteUrl.replace('http', 'ws')}/socket`)
        socket.onopen = () => resolve('open')
        socket.onerror = () => resolve('blocked')
      })
      result['frame'] = await new Promise<string>((resolve) => {
        const frame = document.createElement('iframe')
        frame.onload = () => resolve('loaded')
        frame.src = `${remoteUrl}/frame`
        document.body.append(frame)
        setTimeout(() => resolve('timeout'), 1500)
      })
      return result
    }, remoteOrigin)
    assert.equal(outcome['fetch'], 'blocked')
    assert.equal(outcome['image'], 'blocked')
    assert.equal(outcome['socket'], 'blocked')
    // A frame the CSP (frame-src 'self') blocks still fires `load` on its element, with an error document. What
    // matters is that no frame holds the remote origin and that the remote was never contacted (checked below).
    assert.ok(page.frames().every((frame) => !frame.url().startsWith(remoteOrigin)), `a frame shows the remote origin: ${page.frames().map((frame) => frame.url()).join(', ')}`)
    assert.deepEqual(remote.hits, [], `remote was contacted: ${remote.hits.join(', ')}`)
  })

  it('the service origin itself still loads (the lock is not a blanket block)', async () => {
    const outcome = await page.evaluate(async () => (await fetch('/api/health')).status)
    assert.equal(outcome, 200)
  })

  it('denies permission requests', async () => {
    const result = await page.evaluate(async () => {
      const geo = await new Promise<string>((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), () => resolve('denied')))
      const notification = await Notification.requestPermission()
      return { geo, notification }
    })
    assert.equal(result.geo, 'denied')
    assert.notEqual(result.notification, 'granted')
  })
})
