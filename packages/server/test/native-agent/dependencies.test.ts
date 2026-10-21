import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test('a degraded runtime dependency warning prevents initialization and command dispatch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'k4-dependencies-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runtime = join(dir, 'dist', 'index.mjs'), marker = join(dir, 'initialized')
  await mkdir(join(dir, 'dist'))
  const vendor = join(dir, 'vendor', 'seccomp', process.arch); await mkdir(vendor, { recursive: true })
  await writeFile(join(vendor, 'apply-seccomp'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await writeFile(runtime, `import {writeFile} from 'node:fs/promises'; export const getDefaultWritePaths=()=>[]; export const SandboxManager={isSupportedPlatform:()=>true,checkDependenciesAsync:async()=>({errors:[],warnings:['seccomp unavailable']}),initialize:async()=>writeFile(${JSON.stringify(marker)},'DISPATCHED'),reset:async()=>{}};`)
  for (const name of ['sandbox-worker.ts', 'execution-owner.ts', 'container-runner.ts', 'sandbox-protocol.ts']) {
    const source = (await readFile(new URL(`../../src/native-agent/${name}`, import.meta.url), 'utf8')).replace(/(['"])@anthropic-ai\/sandbox-runtime\1/g, JSON.stringify(pathToFileURL(runtime).href))
    await writeFile(join(dir, name), source)
  }
  const child = fork(join(dir, 'sandbox-worker.ts'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let failure: unknown
  child.on('message', message => { failure = message })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  child.send({ policy: { mode: 'read-only', scratch: dir, roots: [], attachments: [], protectedPaths: [], domains: [] }, command: 'printf SHOULD_NOT_RUN', fixed: true })
  assert.equal(await exited, 1)
  assert.deepEqual(failure, { error: 'sandbox_failed' })
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})
