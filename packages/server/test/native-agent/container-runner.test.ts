import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { containerRunner } from '../../src/native-agent/container-runner.ts'

async function runner(held: boolean) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
  const input = new EventEmitter()
  const messages: { type: string; data?: string; truncated?: boolean }[] = []
  let exited = false, done!: () => void
  const completion = new Promise<void>(resolve => { done = resolve })
  runInNewContext(containerRunner, {
    require(name: string) {
      if (name === 'node:readline') return { createInterface: () => input }
      if (name === 'node:child_process') return { spawn: () => child }
      if (name === 'node:net') return { createServer: () => ({ listen(_port: number, _host: string, ready: () => void) { ready() }, address: () => ({ port: 12345 }) }) }
      throw new Error('unexpected module')
    },
    Buffer, setTimeout, clearTimeout,
    process: { stdin: {}, stdout: { write(line: string, callback?: () => void) { messages.push(JSON.parse(line)); callback?.() } }, exit() { exited = true; done() } },
  })
  input.emit('line', JSON.stringify({ type: 'start', auth: 'synthetic', scratch: '/fixture', uid: 501, gid: 501, command: '', limit: 65536 }))
  child.stdout.emit('data', Buffer.from('first'))
  child.emit('exit', 0)
  // Node permits pending pipe data between exit and close.
  await new Promise<void>(resolve => setImmediate(resolve))
  if (!exited) {
    child.stdout.emit('data', Buffer.from('tail'))
    child.stderr.emit('data', Buffer.from('error-tail'))
    if (!held) child.emit('close', 0)
  }
  await completion
  return messages
}
test('container runner drains stdout and stderr after exit before reporting its result', async () => {
  const messages = await runner(false)
  assert.deepEqual(messages.filter(m => m.type === 'output').map(m => Buffer.from(m.data!, 'base64').toString()), ['first', 'tail', 'error-tail'])
  assert.equal(messages.at(-1)!.type, 'result')
  assert.equal(messages.at(-1)!.truncated, false)
})
test('container runner bounds inherited-pipe drain and explicitly reports truncation', { timeout: 2000 }, async () => {
  const messages = await runner(true)
  assert.equal(messages.at(-1)!.type, 'result')
  assert.equal(messages.at(-1)!.truncated, true)
})
