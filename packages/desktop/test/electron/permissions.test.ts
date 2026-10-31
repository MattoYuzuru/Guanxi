import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { ElectronApplication, Page } from '@playwright/test'
import { closeAllShells, freePort, killQuietly, launchShell, makeSandbox, readServiceManifest, waitFor } from './harness.ts'
import type { Sandbox } from './harness.ts'

type Flagged = { __copy?: string; __notify?: string }

describe('permissions: the copy buttons work, nothing else is granted', () => {
  let sandbox: Sandbox
  let app: ElectronApplication
  let page: Page

  let savedClipboard = ''

  before(async () => {
    sandbox = makeSandbox()
    const launched = await launchShell({ sandbox, port: await freePort() })
    app = launched.app
    page = launched.page
    await page.waitForSelector('#fake-title', { timeout: 30_000 })
    savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText()) // the tests below borrow the real clipboard
  })

  after(async () => {
    await app?.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard).catch(() => undefined)
    await closeAllShells()
    await killQuietly(readServiceManifest(sandbox)?.pid)
    sandbox.cleanup()
  })

  it('a click on a copy button writes plain text to the system clipboard (navigator.clipboard.writeText on a user gesture)', async () => {
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await page.click('#copy')
    assert.equal(await waitFor('the copy to settle', () => page.evaluate(() => (window as Flagged).__copy ?? null)), 'ok')
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'copied-by-the-page')
  })

  it('the page cannot read the clipboard', async () => {
    await app.evaluate(({ clipboard }) => clipboard.writeText('not readable by the page'))
    await page.click('#copy') // a user gesture is present; reading still needs a permission nobody gave
    const outcome = await page.evaluate(() => navigator.clipboard.readText().then(() => 'read', (error: Error) => error.name))
    assert.equal(outcome, 'NotAllowedError')
  })

  // Fullscreen is allowed for the service origin by `allowPermission` (unit-tested in security.test.ts). It is not
  // exercised here: a hidden test window cannot enter native fullscreen, so the request neither resolves nor
  // rejects and could not tell an allowed request from a denied one.

  it('notifications stay denied (the notification center, NC1, delivers through the shell)', async () => {
    await page.click('#notify')
    const answer = await waitFor('the permission answer', () => page.evaluate(() => (window as Flagged).__notify ?? null))
    assert.notEqual(answer, 'granted')
  })

  it('geolocation, camera and microphone stay denied', async () => {
    const result = await page.evaluate(async () => {
      const geo = await new Promise<string>((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), () => resolve('denied')))
      const media = await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (error: Error) => error.name)
      return { geo, media }
    })
    assert.equal(result.geo, 'denied')
    assert.notEqual(result.media, 'granted')
  })
})
