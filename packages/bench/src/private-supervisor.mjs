#!/usr/bin/env node
/**
 * Trusted lifetime supervisor for one private trial process group.
 *
 * The record is intentionally never removed here: only the live parent or the
 * next reaper may unlink it, after the process group is observably gone. This
 * supervisor sends signals to its own process group, so it cannot verify ESRCH
 * after the final SIGKILL.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, createReadStream, openSync, writeSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const launcherPath = fileURLToPath(new URL('./private-client-launcher.mjs', import.meta.url))

const [clientScript, recordPath, killGraceRaw, bindingTag, nonceHash] = process.argv.slice(2)
const killGrace = Number(killGraceRaw)
const pgid = process.pid
// Fresh, non-identifying generation for this one client spawn. Only its hash is
// durable; the token is visible in the client argv, grants nothing and is never
// written to the record or a log.
const clientToken = randomBytes(32).toString('base64url')
const clientTokenHash = createHash('sha256').update(clientToken).digest('hex')
let shutting = false
let record = {
  version: 2, bindingTag, nonceHash, supervisorPid: pgid, pgid,
  clientPid: null, clientExitCode: null, clientTokenHash, clientScript, startedAt: Date.now(),
}

function writeRecord() {
  writeFileSync(recordPath, JSON.stringify(record))
}
function control(value) {
  try { writeSync(6, `${JSON.stringify(value)}\n`) } catch { /* parent may already be gone */ }
}
function groupSignal(signal) {
  try { process.kill(-pgid, signal); return true } catch { return false }
}
function shutdown() {
  if (shutting) return
  shutting = true
  groupSignal('SIGTERM')
  const timer = setTimeout(() => {
    groupSignal('SIGKILL')
    // If the group signal failed, there is nothing safe left to do; the parent
    // keeps the record and reports cleanup_unconfirmed.
    setTimeout(() => process.exit(1), 50).unref()
  }, killGrace)
  timer.ref()
}
// SIGTERM from our own group signal must not end the grace window early.
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})

try {
  const fd = openSync(recordPath, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(record)) } finally { closeSync(fd) }
} catch {
  control({ status: 'start_error', code: 'record_exists' })
  process.exit(1)
}

let child
try {
  child = spawn(process.execPath, [launcherPath, clientScript, clientToken], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'ignore', 3, 4, 'ignore', 'ignore'],
  })
} catch {
  control({ status: 'start_error', code: 'client_spawn_failed' })
  process.exit(1)
}
child.on('error', () => {
  control({ status: 'start_error', code: 'client_spawn_failed' })
  process.exit(1)
})
child.on('exit', code => {
  record = { ...record, clientExitCode: code }
  try { writeRecord() } catch { /* parent/reaper retains the record */ }
})
if (!child.pid) {
  control({ status: 'start_error', code: 'client_spawn_failed' })
  process.exit(1)
}
record = { ...record, clientPid: child.pid }
try { writeRecord() } catch {
  shutdown()
  control({ status: 'start_error', code: 'record_write_failed' })
}
// The client must be the only holder of fds 3/4, or the host would never see
// the request write end close and could not observe EOF.
try { closeSync(3) } catch { /* already closed */ }
try { closeSync(4) } catch { /* already closed */ }
control({ status: 'ready', supervisorPid: pgid, pgid, clientPid: child.pid, clientTokenHash })

try {
  const lifetime = createReadStream(null, { fd: 5, autoClose: false })
  lifetime.on('data', () => {})
  lifetime.on('end', shutdown)
  lifetime.on('close', shutdown)
  lifetime.on('error', shutdown)
} catch {
  shutdown()
}
