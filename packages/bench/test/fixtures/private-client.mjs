#!/usr/bin/env node
/**
 * Executable fixture client. It owns only the anonymous fd 3/4 capability:
 * fd 4 writes strict completion requests to the host, fd 3 reads strict public
 * completion responses. The report is fake fixture observability under the
 * test temp directory; it never contains a credential or private completion.
 */
import { spawn } from 'node:child_process'
import { closeSync, fstatSync, readSync, readdirSync, readlinkSync, writeFileSync, writeSync } from 'node:fs'
import { PrivateFrameDecoder, encodePrivateFrame } from '../../src/private-channel.ts'

const reportPath = process.env.BENCH_FIXTURE_REPORT
if (!reportPath) process.exit(2)
const mode = process.env.BENCH_FIXTURE_MODE ?? 'two'
const decoder = new PrivateFrameDecoder(1024 * 1024)
const report = {
  pid: process.pid, mode,
  argv: process.argv.slice(0),
  env: { ...process.env },
  fd5Pipe: false, fd6Pipe: false, fd3Socket: false, fd4Socket: false,
  inheritedControlCapabilities: [],
  requests: [], responses: [], responseKeys: [], messageKeys: [],
  descendantPid: null,
  wroteStdout: false, wroteStderr: false,
  protocolError: null,
}
function writeReport() {
  try { writeFileSync(reportPath, JSON.stringify(report)) } catch { /* best effort fixture observation */ }
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function readExactly(fd, length) {
  const buffer = Buffer.alloc(length)
  let used = 0
  while (used < length) {
    try {
      const count = readSync(fd, buffer, used, length - used, null)
      if (count === 0) throw new Error('eof')
      used += count
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EAGAIN') { sleep(2); continue }
      throw error
    }
  }
  return buffer
}
function readFrame(fd) {
  const header = readExactly(fd, 4)
  const length = header.readUInt32BE()
  if (!length || length > 1024 * 1024) throw new Error('invalid frame length')
  const values = [...decoder.push(Buffer.concat([header, readExactly(fd, length)]))]
  if (values.length !== 1) throw new Error('frame count')
  return values[0]
}
function writeFrame(fd, value) {
  const frame = encodePrivateFrame(value, 1024 * 1024)
  let used = 0
  while (used < frame.length) used += writeSync(fd, frame, used, frame.length - used)
}
function request(id) {
  return { version: 1, id, operation: 'complete',
    context: { messages: [{ role: 'user', text: 'fixture task text' }], tools: [] } }
}
try { report.fd5Pipe = fstatSync(5).isFIFO() } catch { /* not passed */ }
try { report.fd6Pipe = fstatSync(6).isFIFO() } catch { /* not passed */ }
try { report.fd3Socket = fstatSync(3).isSocket() } catch { /* not passed */ }
try { report.fd4Socket = fstatSync(4).isSocket() } catch { /* not passed */ }
// Node may reuse ignored fd 5/6 for internal pipes. Check the actual parent's control
// capabilities rather than treating every internal FIFO as a leaked parent descriptor.
if (process.platform === 'linux') {
  const controls = [5, 6].map(fd => readlinkSync(`/proc/${process.ppid}/fd/${fd}`))
  report.inheritedControlCapabilities = readdirSync('/proc/self/fd').filter(fd => {
    try { return controls.includes(readlinkSync(`/proc/self/fd/${fd}`)) } catch { return false }
  })
} else {
  report.inheritedControlCapabilities = [5, 6].filter(fd => {
    try { return fstatSync(fd).isSocket() } catch { return false }
  })
}
try { writeSync(1, 'fixture ignored stdout\n'); report.wroteStdout = true } catch { /* ignored */ }
try { writeSync(2, 'fixture ignored stderr\n'); report.wroteStderr = true } catch { /* ignored */ }

try {
  if (mode === 'eof-exit-zero' || mode === 'eof-exit-seven') {
    closeSync(4)
    sleep(75)
    report.finalizationFinished = true
    writeReport()
    process.exit(mode === 'eof-exit-seven' ? 7 : 0)
  }
  if (mode === 'bad') throw new Error('fixture bad client')
  if (mode === 'malformed') {
    const header = Buffer.alloc(4); header.writeUInt32BE(3)
    writeSync(4, Buffer.concat([header, Buffer.from('{x}')]))
    writeReport()
    sleep(5_000)
    process.exit(0)
  }
  if (mode === 'selector') {
    writeFrame(4, { ...request(0), accountId: 'fixture-foreign-selector' })
    writeReport()
    readFrame(3)
    writeReport()
    process.exit(0)
  }
  if (mode === 'descendant' || mode === 'detached') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: mode === 'detached', stdio: 'ignore',
    })
    if (!child.pid) throw new Error('descendant spawn')
    report.descendantPid = child.pid
  }
  writeReport()
  const count = mode === 'two' || mode === 'two-finalization' ? 2 : 1
  for (let id = 0; id < count; id++) {
    const frame = request(id)
    report.requests.push(frame)
    writeFrame(4, frame)
    writeReport()
    const response = readFrame(3)
    report.responses.push(response)
    report.responseKeys.push(Object.keys(response).sort())
    if (response && response.status === 'ok') {
      report.messageKeys.push(Object.keys(response.message ?? {}).sort())
      if (Object.keys(response.message ?? {}).some(key => ['thinking', 'usage', 'reasoning', 'signature'].includes(key))) {
        report.protocolError = 'private field'
      }
    }
    writeReport()
    if (!response || response.status !== 'ok') break
  }
  // Keep the request capability alive through final reporting. Its EOF authorizes
  // host shutdown; a natural-exit fixture closes it only as process.exit(0) exits.
  if (mode === 'two-finalization') {
    // Widen the finalization scheduling window without changing host deadlines.
    sleep(250)
    report.finalizationFinished = true
  }
  writeReport()
  process.exit(0)
} catch (error) {
  report.protocolError = error instanceof Error ? error.message : 'fixture failure'
  writeReport()
  process.exit(1)
}
