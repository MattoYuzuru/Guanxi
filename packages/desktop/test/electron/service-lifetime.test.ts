import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ElectronApplication, Page } from '@playwright/test'
import { alive, closeAllShells, freePort, processGroup, killQuietly, launchShell, makeSandbox, readServiceManifest, waitFor } from './harness.ts'
import type { Sandbox } from './harness.ts'

interface RunState {
  running: boolean
  ticks: number
  pid: number
}

describe('service lifetime (exit gate: closing the window during a run does not stop the run)', () => {
  let sandbox: Sandbox
  let port: number
  let origin: string
  let servicePid = 0

  const runState = async (): Promise<RunState> => (await fetch(`${origin}/api/test/run`)).json() as Promise<RunState>
  const tickLines = (): number => {
    try {
      return readFileSync(join(sandbox.dataDir, 'run-ticks.log'), 'utf8').split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }
  /** The run advances: more ticks than before, within the wait. */
  const advancesBeyond = async (before: number): Promise<number> =>
    waitFor('the run to advance', () => (tickLines() > before + 3 ? tickLines() : null), 5_000)

  before(async () => {
    sandbox = makeSandbox()
    port = await freePort()
    origin = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await closeAllShells()
    await killQuietly(servicePid)
    sandbox.cleanup()
  })

  it('starts the service as a detached process the shell does not own, and a run keeps going when the window closes and when the app quits', async () => {
    let app: ElectronApplication
    let page: Page
    ;({ app, page } = await launchShell({ sandbox, port }))
    await page.waitForSelector('#fake-title', { timeout: 30_000 })

    const manifest = await waitFor('the service manifest', () => readServiceManifest(sandbox))
    servicePid = manifest.pid
    assert.equal(manifest.port, port)
    assert.ok(alive(servicePid))

    // Detachment, not just survival: the service leads a process group of its own, so a signal sent to the shell's
    // group (a terminal Ctrl-C, a launcher killing the app tree) cannot reach it.
    const shellPid = await app.evaluate(() => process.pid)
    assert.notEqual(processGroup(servicePid), processGroup(shellPid), 'the service shares the shell’s process group')
    assert.equal(processGroup(servicePid), String(servicePid), 'the service leads its own process group')

    // The child got the node's own settings, loopback host and no Electron or Node-option inheritance.
    const startup = JSON.parse(readFileSync(join(sandbox.dataDir, 'fake-service-args.json'), 'utf8')) as { args: string[]; electronVersion: string | null; leakedKeys: string[]; toolLeakedKeys: string[] }
    assert.deepEqual(startup.args, ['--port', String(port), '--host', '127.0.0.1', '--data-dir', sandbox.dataDir, '--no-open'])
    // The service runs on a real Node, not on the Electron binary, and neither it nor a tool it starts (the node's
    // bash tool passes `...process.env`) sees any Electron, NODE_OPTIONS, HOST or shell-setting variable.
    assert.equal(startup.electronVersion, null, 'the service is not running on Electron')
    assert.deepEqual(startup.leakedKeys, [])
    assert.deepEqual(startup.toolLeakedKeys, [])

    // Start the "run" and watch it advance.
    const started = await fetch(`${origin}/api/test/run`, { method: 'POST' })
    assert.equal(started.status, 200)
    assert.equal(((await started.json()) as RunState).pid, servicePid)
    let ticks = await advancesBeyond(0)

    // 1. Close the window. The app (macOS) stays, the service and the run are untouched.
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close()
    })
    await waitFor('the window to be gone', async () => {
      try {
        return (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0
      } catch {
        return true // the app is already gone: outside macOS the last window closing quits the shell
      }
    })
    assert.ok(alive(servicePid), 'service survived the window close')
    ticks = await advancesBeyond(ticks)
    assert.equal((await runState()).running, true)

    // 2. Quit the application. The service and the run are still untouched.
    await app.close().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.ok(alive(servicePid), 'service survived the app quit')
    ticks = await advancesBeyond(ticks)
    const afterQuit = await runState()
    assert.equal(afterQuit.running, true)
    assert.equal(afterQuit.pid, servicePid)
  })

  it('attaches to the still-running service on the next launch instead of starting a second one', async () => {
    assert.ok(alive(servicePid))
    const before = tickLines()
    const { app, page } = await launchShell({ sandbox, port })
    try {
      await page.waitForSelector('#fake-title', { timeout: 30_000 })
      assert.equal(readServiceManifest(sandbox)?.pid, servicePid, 'the manifest still names the first service')
      assert.equal((await runState()).pid, servicePid)
      assert.ok(tickLines() > before, 'the run kept advancing while no app was open')
    } finally {
      await app.close().catch(() => undefined)
    }
    assert.ok(alive(servicePid))
  })

  it('an explicit stop (the menu action) ends the service the shell started; nothing else did', async () => {
    // Direct check of the policy: quitting twice above never signalled the process; an explicit stop does.
    const { stopService } = await import('../../src/service/stop.ts')
    const { servicePaths, isProcessAlive } = await import('../../src/service/launcher.ts')
    const { lookupListeners, processInfo } = await import('../../src/service/owner.ts')
    const { probeService } = await import('../../src/service/probe.ts')
    const result = await stopService({
      paths: servicePaths(sandbox.dataDir),
      probe: (p) => probeService(`http://127.0.0.1:${p}`, { timeoutMs: 2000 }),
      kill: (pid, signal) => process.kill(pid, signal),
      alive: isProcessAlive,
      processInfo,
      listeners: lookupListeners,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      timeoutMs: 5000,
    })
    assert.deepEqual(result, { ok: true, pid: servicePid })
    assert.equal(alive(servicePid), false)
    assert.equal(readServiceManifest(sandbox), null)
  })
})
