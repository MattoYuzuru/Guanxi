import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ElectronApplication, Page } from '@playwright/test'
import { alive, closeAllShells, freePort, killQuietly, launchShell, makeSandbox, readServiceManifest, repoRoot, waitFor } from './harness.ts'
import type { Sandbox } from './harness.ts'

// The same exit gate with the real node: the CLI entry of this checkout (packages/cli/src/bin.ts), run by the
// Node.js that runs these tests (never the Electron binary), serving the built web UI. No model is involved, so what is proved is process
// lifetime and the health document of the real service, not a model run.
describe('the real node service under the shell', () => {
  let sandbox: Sandbox
  let port: number
  let app: ElectronApplication
  let page: Page
  let pid = 0

  before(async () => {
    const dist = join(repoRoot, 'packages/web/dist/index.html')
    if (!existsSync(dist)) {
      const built = spawnSync('npm', ['run', 'build', '--workspace', '@guanxi/web'], { cwd: repoRoot, stdio: 'inherit' })
      assert.equal(built.status, 0, 'the web UI must build before the shell can show it')
    }
    sandbox = makeSandbox()
    port = await freePort()
    ;({ app, page } = await launchShell({ sandbox, port, service: 'real', env: { GUANXI_DESKTOP_HEALTH_TIMEOUT_MS: '60000', GUANXI_DESKTOP_PROBE_TIMEOUT_MS: '10000' } }))
  })

  after(async () => {
    await closeAllShells()
    await killQuietly(pid)
    sandbox?.cleanup()
  })

  it('starts the CLI entry, shows its UI, and the service answers its health document', async () => {
    await page.waitForSelector('#root > *', { timeout: 90_000 })
    assert.equal(new URL(page.url()).origin, `http://127.0.0.1:${port}`)
    const manifest = await waitFor('the manifest', () => readServiceManifest(sandbox))
    pid = manifest.pid
    assert.match(manifest.port.toString(), new RegExp(`^${port}$`))
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean; application: { source: string } }
    assert.equal(health.ok, true)
    assert.equal(health.application.source, 'application_http')
  })

  it('the real UI loads under the shell’s CSP and request filter: no refused resource, no CSP violation, the app mounts', async () => {
    const refused: string[] = []
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to|violates the following/i.test(message.text())) refused.push(message.text())
    })
    page.on('requestfailed', (request) => refused.push(`request failed: ${request.url()}`))
    await page.reload()
    await page.waitForSelector('#root > *', { timeout: 60_000 })
    // Give lazy chunks, fonts and workers a moment to be requested before judging.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    assert.deepEqual(refused, [])
  })

  it('the service survives closing the window and quitting the app', async () => {
    assert.ok(alive(pid))
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close()
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.ok(alive(pid), 'survived the window close')
    await app.close().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.ok(alive(pid), 'survived the app quit')
    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.equal(health.status, 200)
  })
})
