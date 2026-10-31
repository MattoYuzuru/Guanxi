import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Page } from '@playwright/test'
import { closeAllShells, freePort, killQuietly, launchShell, makeSandbox, readServiceManifest } from './harness.ts'
import type { Sandbox } from './harness.ts'

describe('content security policy on the service origin', () => {
  let sandbox: Sandbox
  let page: Page
  let origin: string

  before(async () => {
    sandbox = makeSandbox()
    const port = await freePort()
    origin = `http://127.0.0.1:${port}`
    ;({ page } = await launchShell({ sandbox, port }))
    await page.waitForSelector('#fake-title', { timeout: 30_000 })
  })

  after(async () => {
    await closeAllShells()
    await killQuietly(readServiceManifest(sandbox)?.pid)
    sandbox.cleanup()
  })

  it('every response of the node carries the shell’s policy', async () => {
    const policies = await page.evaluate(async () => {
      const read = async (path: string) => (await fetch(path)).headers.get('content-security-policy')
      return { page: await read('/'), api: await read('/api/health') }
    })
    for (const policy of [policies.page, policies.api]) {
      assert.ok(policy, 'a Content-Security-Policy header is present')
      assert.match(policy, /default-src 'self'/)
      assert.match(policy, new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${new URL(origin).port}`))
    }
  })

  it('the policy is enforced: eval and remote script are refused, inline script and blob workers still work', async () => {
    const outcome = await page.evaluate(async () => {
      const result: Record<string, string> = {}
      // The page's own inline script tried `new Function` while loading (code the driver evaluates is exempt).
      result['eval'] = (window as { __evalAtLoad?: string }).__evalAtLoad ?? 'missing'
      result['remoteScript'] = await new Promise<string>((resolve) => {
        const script = document.createElement('script')
        script.src = 'https://example.com/x.js'
        script.onload = () => resolve('loaded')
        script.onerror = () => resolve('blocked')
        document.head.append(script)
      })
      result['inlineScript'] = await new Promise<string>((resolve) => {
        const script = document.createElement('script')
        script.textContent = 'window.__inline = "ran"'
        document.head.append(script)
        resolve((window as { __inline?: string }).__inline ?? 'blocked')
      })
      result['blobWorker'] = await new Promise<string>((resolve) => {
        const worker = new Worker(URL.createObjectURL(new Blob(['postMessage("worker-ok")'])))
        worker.onmessage = (event) => resolve(String(event.data))
        worker.onerror = () => resolve('blocked')
      })
      return result
    })
    assert.equal(outcome['eval'], 'EvalError')
    assert.equal(outcome['remoteScript'], 'blocked')
    assert.equal(outcome['inlineScript'], 'ran')
    assert.equal(outcome['blobWorker'], 'worker-ok')
  })
})
