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

test('linux sandbox does not reintroduce absent optional system-library paths', () => {
  const root = '/fixture/repo'
  // Mirrors an arm64 runtime's validated sources: /lib exists, /lib64 does not.
  const existing = ['/usr', '/bin', '/sbin', '/lib', '/etc', root, '/fixture/data/runtime']
  const spec = linuxSandboxSpawn(existing, root, 21, '/fixture/data/knowledge-index', root, '/usr/bin/node', '/fixture/data/runtime/worker.js')
  const mounted = spec.args.flatMap((value, index) => value === '--ro-bind' || value === '--ro-bind-fd'
    ? [spec.args[index + 2]!]
    : [])
  assert.deepEqual(mounted, [...existing].sort((a, b) => a.length - b.length))
  assert.equal(spec.args.includes('/lib64'), false)
  assert.equal(spec.args.includes('/lib'), true)
  assert.equal(spec.stdio[4], 21, 'root containment still uses its inherited pinned descriptor')
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

test('sandbox denies actual ignore-file reads after an ancestor swap; unsandboxed control reads the bytes', { timeout: 20_000 }, async () => {
  const { readFile, rename, symlink } = await import('node:fs/promises')
  const { spawn } = await import('node:child_process')
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'guanxi-x1-read-race-')))
  const root = join(directory, 'repo'), data = join(directory, 'data'), outside = join(directory, 'outside'), runtime = join(data, 'runtime')
  await mkdir(join(root, 'nested'), { recursive: true }); await mkdir(runtime, { recursive: true }); await mkdir(outside)
  const marker = 'SYNTHETIC_OUTSIDE_READ_SENTINEL\n'
  await writeFile(join(root, 'allowed'), 'inside')
  await writeFile(join(root, 'nested', '.gitignore'), 'allowed-pattern\n')
  await writeFile(join(outside, '.gitignore'), marker)
  // Run the production reader inside exactly the scanner's OS profile. Only
  // the fixture callback coordinates the swap after its first containment check.
  const reader = (await readFile(new URL('../../src/indexing/snapshot.ts', import.meta.url), 'utf8'))
    .replace("from 'ignore'", `from ${JSON.stringify(import.meta.resolve('ignore'))}`)
  await writeFile(join(runtime, 'snapshot.ts'), reader)
  const entry = join(runtime, 'probe.mjs')
  await writeFile(entry, `import {createRequire,syncBuiltinESMExports} from 'node:module';
    const fs=createRequire(import.meta.url)('node:fs/promises');const original=fs.open;let bytes=0;
    fs.open=async(...args)=>{const h=await original(...args);if(args[0]===${JSON.stringify(join(root, 'nested', '.gitignore'))}){const read=h.read.bind(h);h.read=async(...a)=>{const r=await read(...a);bytes+=r.bytesRead;return r}}return h};
    syncBuiltinESMExports();const {readProjectFile}=await import('./snapshot.ts');
    process.once('message',async()=>{try{
      const inside=await readProjectFile(${JSON.stringify(root)},'allowed',1024);let content=null,code=null;
      try{content=await readProjectFile(${JSON.stringify(root)},'nested/.gitignore',1024,()=>new Promise(resolve=>{process.once('message',resolve);process.send({kind:'swap'})}))}catch(e){code=e.code}
      process.send({kind:'result',inside,content,bytes,code});
    }catch(e){process.send({kind:'failure',code:e.code})}finally{process.disconnect()}})`)
  type Result = { kind: string; inside: string; content: string | null; bytes: number; code: string | null }
  const run = async (sandbox: boolean): Promise<Result> => {
    const child = sandbox ? await indexProcess(entry, root, data, 'inherit') : spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    try {
      return await new Promise<Result>((resolve, reject) => {
        child.on('message', message => {
          const result = message as Result
          if (result.kind === 'swap') {
            void (async () => {
              await rename(join(root, 'nested'), join(root, 'original'))
              await symlink(outside, join(root, 'nested'))
              child.send({ swapped: true })
            })().catch(reject)
          } else if (result.kind === 'result') resolve(result)
          else reject(new Error(`fixture_reader_failed:${result.code}`))
        })
        child.once('error', reject)
        child.once('close', () => reject(new Error('fixture_reader_closed')))
        child.send({ start: true })
      })
    } finally { await stopIndexProcess(child) }
  }
  try {
    const control = await run(false)
    assert.equal(control.inside, 'inside')
    assert.equal(control.bytes, Buffer.byteLength(marker), 'control observes the real outside FileHandle.read')
    await rm(join(root, 'nested')); await rename(join(root, 'original'), join(root, 'nested'))
    const protectedRead = await run(true)
    assert.equal(protectedRead.inside, 'inside', 'sandbox still permits an ordinary in-root read')
    assert.equal(protectedRead.bytes, 0, 'outside bytes must never be read, even when discarded later')
    assert.equal(protectedRead.content, null)
    assert.ok(['EPERM', 'EACCES', 'ENOENT'].includes(protectedRead.code ?? ''), `actual OS read denial: ${protectedRead.code}`)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
