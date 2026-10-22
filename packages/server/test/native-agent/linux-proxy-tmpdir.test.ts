import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'

describe('Linux native proxy paths', () => {
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
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { lstatSync, realpathSync } from 'node:fs';
      import { dirname, join, sep } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const policy = ${JSON.stringify({ mode: 'read-only', scratch, runtimeBase: directory, roots: [], attachments: [], protectedPaths: [], domains: [] })};
      const originalFork = childProcess.fork;
      const launches = [];
      const missing = path => {
        try { lstatSync(path); return false; }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      };
      // Observe only this fresh child's trusted launch; delegate all arguments unchanged.
      // Never scan /tmp or print runtime paths, commands or environment values.
      childProcess.fork = function (...args) {
        const child = Reflect.apply(originalFork, this, args);
        if (args[2]?.cwd === policy.scratch) {
          const proxy = args[2].env.TMPDIR;
          const stage = dirname(fileURLToPath(args[0]));
          launches.push({ proxy, stage, mode: lstatSync(proxy).mode & 0o777,
            canonical: realpathSync(proxy) === proxy,
            tmpBase: dirname(proxy) === realpathSync('/tmp'),
            socketFits: ['claude-http-', 'claude-socks-'].every(prefix =>
              Buffer.byteLength(join(proxy, prefix + '0'.repeat(16) + '.sock')) <= 107),
            outsideScratch: proxy !== policy.scratch && !proxy.startsWith(policy.scratch + sep),
            matchingHome: args[2].env.HOME === proxy,
            ownedStage: stage.startsWith(policy.runtimeBase + sep),
          });
        }
        return child;
      };
      syncBuiltinESMExports();
      try {
        const { sandboxCommand } = await import(${JSON.stringify(moduleUrl)});
        const result = await sandboxCommand(policy, 'printf proxy-ok > "$TMPDIR/value"; /bin/cat "$TMPDIR/value"', undefined, 10000, true);
        const launch = launches[0];
        process.stdout.write(JSON.stringify({ code: result.code, stdout: result.stdout,
          stderrBytes: Buffer.byteLength(result.stderr), truncated: result.truncated,
          workerCount: launches.length, mode: launch?.mode, canonical: launch?.canonical,
          tmpBase: launch?.tmpBase, socketFits: launch?.socketFits,
          outsideScratch: launch?.outsideScratch, matchingHome: launch?.matchingHome,
          ownedStage: launch?.ownedStage,
          proxyRemoved: !!launch && missing(launch.proxy),
          stageRemoved: !!launch && missing(launch.stage),
        }));
      } finally {
        childProcess.fork = originalFork;
        syncBuiltinESMExports();
      }
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory, timeout: 20_000, maxBuffer: 16_384,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: parent, LANG: 'C.UTF-8' },
    })
    assert.deepEqual(JSON.parse(stdout), {
      code: 0, stdout: 'proxy-ok', stderrBytes: 0, truncated: false,
      workerCount: 1, mode: 0o700, canonical: true, tmpBase: true, socketFits: true,
      outsideScratch: true, matchingHome: true, ownedStage: true,
      proxyRemoved: true, stageRemoved: true,
    })
    assert.equal(await readFile(join(scratch, 'value'), 'utf8'), 'proxy-ok')
    assert.deepEqual(await readdir(parent), [], 'owned parent contains no leaked proxy directory')
    assert.deepEqual((await readdir(directory)).sort(), ['long-private-parent-temporary-directory', 'scratch'], 'worker staging is cleaned before settlement')
  })
})
