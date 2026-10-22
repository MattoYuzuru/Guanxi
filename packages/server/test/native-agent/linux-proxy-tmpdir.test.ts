import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

test('Linux proxy startup tolerates a long parent TMPDIR and preserves command-local scratch', {
  skip: process.platform !== 'linux', timeout: 30_000,
}, async t => {
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const directory = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'linux-proxy-parent-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const parent = join(directory, 'long-private-parent-temporary-directory')
  const scratch = join(directory, 'scratch')
  await Promise.all([mkdir(parent), mkdir(scratch)])
  assert.ok(Buffer.byteLength(parent) > 60, 'old inherited proxy socket exceeds Linux pathname capacity')
  const moduleUrl = new URL('../../src/native-agent/sandbox.ts', import.meta.url).href
  const script = `
    import { sandboxCommand } from ${JSON.stringify(moduleUrl)};
    const policy = ${JSON.stringify({ mode: 'read-only', scratch, runtimeBase: directory, roots: [], attachments: [], protectedPaths: [], domains: [] })};
    const result = await sandboxCommand(policy, 'printf proxy-ok > "$TMPDIR/value"; /bin/cat "$TMPDIR/value"', undefined, 10000, true);
    process.stdout.write(JSON.stringify({ code: result.code, stdout: result.stdout, stderrBytes: Buffer.byteLength(result.stderr), truncated: result.truncated }));
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory, timeout: 20_000, maxBuffer: 16_384,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: parent, LANG: 'C.UTF-8' },
  })
  assert.deepEqual(JSON.parse(stdout), { code: 0, stdout: 'proxy-ok', stderrBytes: 0, truncated: false })
  assert.equal(await readFile(join(scratch, 'value'), 'utf8'), 'proxy-ok')
  assert.deepEqual(await readdir(parent), [], 'owned parent contains no leaked proxy directory')
  assert.deepEqual((await readdir(directory)).sort(), ['long-private-parent-temporary-directory', 'scratch'], 'worker staging is cleaned before settlement')
})
