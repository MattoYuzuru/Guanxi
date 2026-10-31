import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { ElectronApplication, Page } from '@playwright/test'
import { closeAllShells, freePort, killQuietly, launchShell, makeSandbox, readServiceManifest } from './harness.ts'
import type { Sandbox } from './harness.ts'

// Own shell: the limit is per application, so a test that shares one with other clicks would count their opens.
describe('external opens are rate-limited', () => {
  let sandbox: Sandbox
  let app: ElectronApplication
  let page: Page

  before(async () => {
    sandbox = makeSandbox()
    ;({ app, page } = await launchShell({ sandbox, port: await freePort() }))
    await page.waitForSelector('#fake-title', { timeout: 30_000 })
    await app.evaluate(({ shell }) => {
      ;(globalThis as unknown as { __opened: string[] }).__opened = []
      ;(shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
        ;(globalThis as unknown as { __opened: string[] }).__opened.push(url)
      }
    })
  })

  after(async () => {
    await closeAllShells()
    await killQuietly(readServiceManifest(sandbox)?.pid)
    sandbox.cleanup()
  })

  it('six real clicks reach the system browser exactly three times in ten seconds', async () => {
    for (let i = 0; i < 6; i++) await page.click('#open-ext')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const opened = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
    assert.equal(opened.length, 3)
    assert.ok(opened.every((url) => url === 'https://example.com/from-click'))
  })
})
