import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backgroundPriority, indexProcess, stopIndexProcess, linuxSandboxSpawn } from '../../src/indexing/process.ts'

test('linux sandbox passes the pinned root as inherited descriptor 4', () => {
  const root = '/fixture/repo'
  const paths = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/fixture/repo', '/fixture/data/knowledge-index', '/opt/runtime/node']
  const spawn = linuxSandboxSpawn(paths, root, 21, '/fixture/data/knowledge-index', root, '/opt/runtime/node/bin/node', '/fixture/data/runtime/index-worker.js')
  assert.equal(spawn.command, '/usr/bin/bwrap')
  assert.deepEqual(spawn.args.slice(-2), ['/opt/runtime/node/bin/node', '/fixture/data/runtime/index-worker.js'])
  // The root is mounted only through the inherited descriptor. Reading another
  // process's /proc/<pid>/fd is denied in an unprivileged bwrap namespace.
  const mounts = spawn.args.flatMap((value, index) => value === '--ro-bind' || value === '--ro-bind-fd'
    ? [spawn.args.slice(index, index + 3).join(' ')]
    : [])
  assert.deepEqual(mounts.filter(mount => mount.endsWith(` ${root}`)), [`--ro-bind-fd 4 ${root}`])
  assert.equal(spawn.args[spawn.args.indexOf('--chdir') + 1], root)
  assert.equal(spawn.args.some(value => /\/proc\/\d+/.test(value)), false)
  const sorted = [...new Set(['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', ...paths])].sort((a, b) => a.length - b.length)
  const bound = spawn.args.flatMap((value, index) => value === '--ro-bind' || value === '--ro-bind-fd'
    ? [spawn.args[index + 2]!]
    : [])
  assert.deepEqual(bound, sorted)
  assert.equal(spawn.stdio[3], 'ipc')
  assert.equal(spawn.stdio[4], 21)
  assert.deepEqual(spawn.stdio.slice(0, 3), ['ignore', 'ignore', 'ignore'])
})

test('background priority wraps the sandbox and keeps its argument order', () => {
  const sandbox = ['-p', '(version 1)', '/usr/bin/node', '/runtime/worker.js']
  assert.deepEqual(backgroundPriority('/usr/bin/sandbox-exec', sandbox, 'darwin', false), {
    command: '/usr/sbin/taskpolicy', args: ['-b', '/usr/bin/sandbox-exec', ...sandbox],
  })
  assert.deepEqual(backgroundPriority('/usr/bin/bwrap', sandbox, 'linux', true), {
    command: '/usr/bin/nice', args: ['-n', '19', '/usr/bin/ionice', '-c3', '/usr/bin/bwrap', ...sandbox],
  })
  assert.deepEqual(backgroundPriority('/usr/bin/bwrap', sandbox, 'linux', false), {
    command: '/usr/bin/nice', args: ['-n', '19', '/usr/bin/bwrap', ...sandbox],
  })
  // The wrapper runs the sandbox; the sandbox still runs the worker.
  const wrapped = backgroundPriority('/usr/bin/bwrap', ['--die-with-parent', '/usr/bin/node', '/runtime/worker.js'], 'linux', false)
  assert.ok(wrapped.args.indexOf('/usr/bin/bwrap') < wrapped.args.indexOf('/usr/bin/node'))
})

test('Linux sandbox worker runs at nice 19 and idle IO priority', { skip: process.platform !== 'linux', timeout: 15_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'guanxi-x1-priority-')))
  const root = join(directory, 'repo'), data = join(directory, 'data'), runtime = join(data, 'runtime')
  await mkdir(root); await mkdir(runtime, { recursive: true })
  const entry = join(runtime, 'probe.mjs')
  const hasIonice = existsSync('/usr/bin/ionice')
  await writeFile(entry, `import {getPriority} from 'node:os';import {execFileSync} from 'node:child_process';
    process.once('message',()=>{process.send({nice:getPriority(0),io:${hasIonice ? "execFileSync('/usr/bin/ionice',['-p',String(process.pid)],{encoding:'utf8'}).trim()" : 'null'}});process.disconnect()})`)
  const child = await indexProcess(entry, root, data)
  try {
    const result = await new Promise<{ nice: number; io: string | null }>((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
      child.once('close', () => reject(new Error('priority_probe_closed')))
      child.send({ start: true })
    })
    assert.equal(result.nice, 19, 'observed in the sandbox worker, after all wrappers')
    assert.equal(result.io, hasIonice ? 'idle' : null)
  } finally { await stopIndexProcess(child); await rm(directory, { recursive: true, force: true }) }
})
