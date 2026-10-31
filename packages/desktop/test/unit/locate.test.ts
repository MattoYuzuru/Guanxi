import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ServiceMissingError, locateService, serviceEnvironment } from '../../src/service/locate.ts'
import type { LocateInput } from '../../src/service/locate.ts'

const base: LocateInput = {
  packaged: false,
  resourcesPath: '/Applications/App.app/Contents/Resources',
  execPath: '/Applications/App.app/Contents/MacOS/App',
  repoRoot: '/work/guanxi',
  env: { PATH: '/usr/bin', HOME: '/Users/me' },
  port: 4441,
  dataDir: '/data/lane',
  exists: () => true,
}

describe('locateService', () => {
  it('packaged: runs the staged CLI bundle with the app binary as Node', () => {
    const command = locateService({ ...base, packaged: true })
    assert.equal(command.command, base.execPath)
    assert.equal(command.entry, '/Applications/App.app/Contents/Resources/service/bin.js')
    assert.deepEqual(command.args, [command.entry, '--port', '4441', '--host', '127.0.0.1', '--data-dir', '/data/lane', '--no-open'])
    assert.equal(command.env['ELECTRON_RUN_AS_NODE'], '1')
  })

  it('checkout: runs the CLI source entry of the repository', () => {
    assert.equal(locateService(base).entry, '/work/guanxi/packages/cli/src/bin.ts')
  })

  it('an unpackaged app may be pointed at another entry; an installed app may not', () => {
    const env = { ...base.env, GUANXI_DESKTOP_SERVICE_ENTRY: '/tmp/fake.mjs' }
    assert.equal(locateService({ ...base, env }).entry, '/tmp/fake.mjs')
    assert.equal(locateService({ ...base, env, packaged: true }).entry, '/Applications/App.app/Contents/Resources/service/bin.js')
  })

  it('throws ServiceMissingError naming the path when the entry is absent', () => {
    assert.throws(
      () => locateService({ ...base, packaged: true, exists: () => false }),
      (error: unknown) => error instanceof ServiceMissingError && error.entry === '/Applications/App.app/Contents/Resources/service/bin.js',
    )
  })
})

describe('serviceEnvironment', () => {
  it('moves nothing the node does not own: no HOST, PORT, NODE_OPTIONS, Electron or shell-test variables', () => {
    const env = serviceEnvironment(
      { PATH: '/usr/bin', HOME: '/h', HOST: '0.0.0.0', PORT: '9', NODE_OPTIONS: '--require /evil.js', NODE_ENV: 'x', ELECTRON_ENABLE_LOGGING: '1', GUANXI_DESKTOP_LOCALE: 'ru', GUANXI_FAKE_MODE: 'keep', GUANXI_API_PORT: '1', GUANXI_DATA_DIR: '/other', LANG: 'en_US.UTF-8' },
      4441,
      '/data/lane',
    )
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/h', LANG: 'en_US.UTF-8', GUANXI_FAKE_MODE: 'keep', ELECTRON_RUN_AS_NODE: '1', GUANXI_API_PORT: '4441', GUANXI_DATA_DIR: '/data/lane' })
  })
})
