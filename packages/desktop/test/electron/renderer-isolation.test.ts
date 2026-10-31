import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { ElectronApplication, Page } from '@playwright/test'
import { closeAllShells, freePort, killQuietly, launchShell, makeSandbox, readServiceManifest } from './harness.ts'
import type { Sandbox } from './harness.ts'

type Preferences = { getLastWebPreferences(): Record<string, unknown> }

describe('renderer isolation (exit gate: the renderer has no Node access)', () => {
  let sandbox: Sandbox
  let app: ElectronApplication
  let page: Page
  let port: number

  before(async () => {
    sandbox = makeSandbox()
    port = await freePort()
    const launched = await launchShell({ sandbox, port })
    app = launched.app
    page = launched.page
    await page.waitForSelector('#fake-title', { timeout: 30_000 })
  })

  after(async () => {
    await closeAllShells()
    await killQuietly(readServiceManifest(sandbox)?.pid)
    sandbox?.cleanup()
  })

  it('loads the service origin and nothing else', () => {
    assert.equal(new URL(page.url()).origin, `http://127.0.0.1:${port}`)
  })

  it('has none of the Node globals in the page', async () => {
    const probe = await page.evaluate(() => ({
      require: typeof require,
      process: typeof process,
      module: typeof module,
      buffer: typeof Buffer,
      filename: typeof __filename,
      dirname: typeof __dirname,
      globalRef: typeof (globalThis as { global?: unknown }).global,
      electron: typeof (window as { electron?: unknown }).electron,
      ipcRenderer: typeof (window as { ipcRenderer?: unknown }).ipcRenderer,
      pageProbe: (window as { __probe?: unknown }).__probe,
    }))
    assert.deepEqual(probe, {
      require: 'undefined', process: 'undefined', module: 'undefined', buffer: 'undefined',
      filename: 'undefined', dirname: 'undefined', globalRef: 'undefined', electron: 'undefined', ipcRenderer: 'undefined',
      pageProbe: { typeofRequire: 'undefined', typeofProcess: 'undefined', typeofModule: 'undefined', typeofBuffer: 'undefined', typeofFilename: 'undefined', typeofGlobal: 'undefined' },
    })
  })

  // Review L6: with contextIsolation on, the page's main world has no Node even if nodeIntegration were on; the
  // preload's isolated world is where that setting would show. Probe that world (Electron's preload world id is 999).
  it('has no Node globals in the preload’s isolated world either (nodeIntegration and sandbox are really off)', async () => {
    const probe = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScriptInIsolatedWorld(999, [
        { code: 'JSON.stringify({ require: typeof require, module: typeof module, Buffer: typeof Buffer, global: typeof global, __dirname: typeof __dirname })' },
      ]),
    )
    assert.deepEqual(JSON.parse(String(probe)), { require: 'undefined', module: 'undefined', Buffer: 'undefined', global: 'undefined', __dirname: 'undefined' })
  })

  it('cannot import a Node built-in', async () => {
    const outcome = await page.evaluate(async () => {
      try {
        await import('node:fs' as string)
        return 'imported'
      } catch {
        return 'refused'
      }
    })
    assert.equal(outcome, 'refused')
  })

  it('has none of the Node globals in a worker', async () => {
    const inWorker = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const source = 'postMessage([typeof require, typeof process, typeof importScripts].join())'
          const worker = new Worker(URL.createObjectURL(new Blob([source])))
          worker.onmessage = (event) => resolve(String(event.data))
          worker.onerror = () => resolve('worker-error')
        }),
    )
    assert.equal(inWorker, 'undefined,undefined,function')
  })

  it('exposes exactly one bridge function and no IPC handle', async () => {
    const bridge = await page.evaluate(async () => {
      const exposed = (window as unknown as { guanxiDesktop?: Record<string, unknown> }).guanxiDesktop
      return {
        keys: Object.keys(exposed ?? {}),
        types: Object.values(exposed ?? {}).map((value) => typeof value),
        info: await (exposed?.['info'] as () => Promise<unknown>)(),
      }
    })
    assert.deepEqual(bridge.keys, ['info'])
    assert.deepEqual(bridge.types, ['function'])
    assert.deepEqual(Object.keys(bridge.info as object).sort(), ['platform', 'shell', 'shellVersion'])
    assert.equal((bridge.info as { shell: string }).shell, 'electron')
  })

  it('creates the window with sandbox, context isolation and no Node integration', async () => {
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const prefs = (BrowserWindow.getAllWindows()[0]!.webContents as unknown as Preferences).getLastWebPreferences()
      return {
        contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox,
        webSecurity: prefs.webSecurity, webviewTag: prefs.webviewTag,
        nodeIntegrationInWorker: prefs.nodeIntegrationInWorker, nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
        allowRunningInsecureContent: prefs.allowRunningInsecureContent,
      }
    })
    assert.deepEqual(preferences, {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, allowRunningInsecureContent: false,
    })
  })
})
