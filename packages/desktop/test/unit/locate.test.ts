import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ServiceMissingError, locateService, resolveOnPath, serviceEnvironment } from '../../src/service/locate.ts'
import type { LocateInput } from '../../src/service/locate.ts'

const base: LocateInput = {
  packaged: false,
  resourcesPath: '/Applications/App.app/Contents/Resources',
  repoRoot: '/work/guanxi',
  env: { PATH: '/opt/bin:/usr/bin', HOME: '/Users/me' },
  port: 4441,
  dataDir: '/data/lane',
  exists: () => true,
  isExecutable: (path) => path === '/usr/bin/node' || path.endsWith('/node/bin/node'),
}

describe('locateService', () => {
  it('packaged: runs the staged CLI bundle on the staged Node.js, never on the Electron binary', () => {
    const command = locateService({ ...base, packaged: true })
    assert.equal(command.command, '/Applications/App.app/Contents/Resources/service/node/bin/node')
    assert.equal(command.entry, '/Applications/App.app/Contents/Resources/service/bin.js')
    assert.deepEqual(command.args, [command.entry, '--port', '4441', '--host', '127.0.0.1', '--data-dir', '/data/lane', '--no-open'])
    assert.ok(!('ELECTRON_RUN_AS_NODE' in command.env))
  })

  it('checkout: the node on PATH runs the CLI source entry of the repository', () => {
    const command = locateService(base)
    assert.equal(command.command, '/usr/bin/node')
    assert.equal(command.entry, '/work/guanxi/packages/cli/src/bin.ts')
  })

  it('an unpackaged app may be pointed at another entry and Node; an installed app may not', () => {
    const env = { ...base.env, GUANXI_DESKTOP_SERVICE_ENTRY: '/tmp/fake.mjs', GUANXI_DESKTOP_NODE: '/tmp/node' }
    const loose = locateService({ ...base, env, isExecutable: () => true })
    assert.equal(loose.entry, '/tmp/fake.mjs')
    assert.equal(loose.command, '/tmp/node')
    const installed = locateService({ ...base, env, packaged: true })
    assert.equal(installed.entry, '/Applications/App.app/Contents/Resources/service/bin.js')
    assert.equal(installed.command, '/Applications/App.app/Contents/Resources/service/node/bin/node')
  })

  it('throws ServiceMissingError naming the entry, or the Node, that is absent', () => {
    assert.throws(
      () => locateService({ ...base, packaged: true, exists: () => false }),
      (error: unknown) => error instanceof ServiceMissingError && error.entry === '/Applications/App.app/Contents/Resources/service/bin.js',
    )
    assert.throws(
      () => locateService({ ...base, packaged: true, isExecutable: () => false }),
      (error: unknown) => error instanceof ServiceMissingError && error.entry.endsWith('/service/node/bin/node'),
    )
    assert.throws(
      () => locateService({ ...base, isExecutable: () => false }),
      (error: unknown) => error instanceof ServiceMissingError && error.entry === 'node (not on PATH)',
    )
  })
})

describe('resolveOnPath', () => {
  it('takes the first executable in PATH order and ignores empty entries', () => {
    assert.equal(resolveOnPath('node', ':/a:/b', (p) => p === '/b/node' || p === '/a/node'), '/a/node')
    assert.equal(resolveOnPath('node', '/a', () => false), null)
    assert.equal(resolveOnPath('node', undefined, () => true), null)
  })
})

describe('serviceEnvironment', () => {
  it('moves nothing the node does not own, and hands tools no Electron or shell variable (they inherit this environment)', () => {
    const env = serviceEnvironment(
      { PATH: '/usr/bin', HOME: '/h', HOST: '0.0.0.0', PORT: '9', NODE_OPTIONS: '--require /evil.js', NODE_ENV: 'x', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', GUANXI_DESKTOP_LOCALE: 'ru', GUANXI_FAKE_MODE: 'keep', GUANXI_API_PORT: '1', GUANXI_DATA_DIR: '/other', LANG: 'en_US.UTF-8' },
      4441,
      '/data/lane',
    )
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/h', LANG: 'en_US.UTF-8', GUANXI_FAKE_MODE: 'keep', GUANXI_API_PORT: '4441', GUANXI_DATA_DIR: '/data/lane' })
  })
})
