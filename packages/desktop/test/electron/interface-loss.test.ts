import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import type { ElectronApplication } from '@playwright/test'
import { alive, closeAllShells, fakeServiceEntry, freePort, killQuietly, launchShell, makeSandbox, readServiceManifest, waitFor } from './harness.ts'
import type { Sandbox } from './harness.ts'

// The interface can be lost after a good handshake: the service dies and the window is reloaded, or the
// renderer process crashes. The window must say so (no blank or Chromium error page) and recover by itself.
describe('the window recovers when the interface is lost', () => {
  let sandbox: Sandbox
  let port: number
  let app: ElectronApplication
  const pids: Array<number | undefined> = []

  /** State of the first window read from the main process, so it works while the renderer is gone or replaced. */
  const screen = () =>
    app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      if (!contents || contents.isDestroyed() || contents.isCrashed()) return 'crashed'
      const url = contents.getURL()
      if (url.startsWith('data:')) return String(await contents.executeJavaScript("document.querySelector('main')?.dataset.state ?? 'none'"))
      return url.startsWith('http://127.0.0.1') ? String(await contents.executeJavaScript("document.getElementById('fake-title') ? 'ui' : 'blank'")) : url
    })

  before(async () => {
    sandbox = makeSandbox()
    port = await freePort()
    const launched = await launchShell({ sandbox, port })
    app = launched.app
    // Not through the driver's page handle: the test crashes the renderer, and the handle would report it as a failure.
    await waitFor('the interface', async () => (await screen()) === 'ui' || null, 30_000)
    pids.push(readServiceManifest(sandbox)?.pid)
  })

  after(async () => {
    await closeAllShells()
    for (const pid of pids) await killQuietly(pid)
    sandbox.cleanup()
  })

  it('render-process-gone: a crashed renderer shows the status screen, then the interface returns on its own', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer())
    await waitFor('the status screen', async () => (await screen()) === 'load_failed' || null, 20_000)
    await waitFor('the interface to come back', async () => (await screen()) === 'ui' || null, 20_000)
  })

  it('did-fail-load: the service dies, a reload fails, the status screen says so, and a service started by hand is picked up', async () => {
    const dead = readServiceManifest(sandbox)!.pid
    process.kill(dead, 'SIGKILL')
    await waitFor('the service to be gone', () => !alive(dead), 5_000)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload())
    await waitFor('the status screen', async () => (await screen()) === 'load_failed' || null, 20_000)

    // Someone starts a node on that port (here the fixture, as the CLI would be). The window finds it.
    const child = spawn(process.execPath, [fakeServiceEntry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', sandbox.dataDir], { stdio: 'ignore', detached: true })
    child.unref()
    pids.push(child.pid)
    await waitFor('the interface to come back', async () => (await screen()) === 'ui' || null, 20_000)
    assert.equal(readServiceManifest(sandbox), null, 'the dead service no longer stands in the manifest (its pid can be reused)')
  })
})
