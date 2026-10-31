import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { alive, desktopDir, freePort, killQuietly, makeSandbox, processGroup, readServiceManifest, shellEnvironment, waitFor } from './harness.ts'
import type { Sandbox } from './harness.ts'
import { createRequire } from 'node:module'

const electronPath = createRequire(import.meta.url)('electron') as string

// The shell here is a plain process in a group of its own (no automation in between), so the whole group can be
// killed the way a terminal, a launcher or a crash reporter might. A service that merely survives a polite
// quit but shares the group dies with it; this test is the one that tells the two designs apart.
describe('the service survives the death of the shell’s whole process group', () => {
  let sandbox: Sandbox
  let port: number
  let shellPid = 0
  let servicePid = 0

  before(async () => {
    sandbox = makeSandbox()
    port = await freePort()
  })

  after(async () => {
    if (shellPid > 1) {
      try {
        process.kill(-shellPid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    await killQuietly(servicePid)
    sandbox.cleanup()
  })

  it('SIGKILL to the shell’s group leaves the service alive, in its own group, still answering', async () => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${sandbox.userDataDir}`], {
      detached: true,
      stdio: 'ignore',
      env: shellEnvironment({ sandbox, port }),
    })
    child.unref()
    assert.ok(child.pid !== undefined)
    shellPid = child.pid
    assert.equal(processGroup(shellPid), String(shellPid), 'the shell leads its own group in this test')

    const manifest = await waitFor('the service manifest', () => readServiceManifest(sandbox), 30_000)
    servicePid = manifest.pid
    await waitFor('the service to answer', async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.ok || null)
    assert.notEqual(processGroup(servicePid), String(shellPid), 'the service is not in the shell’s group')

    process.kill(-shellPid, 'SIGKILL')
    await waitFor('the shell to be gone', () => !alive(shellPid), 10_000)
    await new Promise((resolve) => setTimeout(resolve, 500))

    assert.ok(alive(servicePid), 'the service survived the death of the shell’s group')
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200)
  })
})
