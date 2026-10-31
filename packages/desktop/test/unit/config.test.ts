import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, DEFAULT_API_PORT, resolveConfig } from '../../src/config.ts'

describe('resolveConfig', () => {
  it('defaults to the node defaults: port 4310 on loopback and ~/.guanxi', () => {
    const config = resolveConfig({}, '/home/me')
    assert.equal(config.port, DEFAULT_API_PORT)
    assert.equal(config.origin, 'http://127.0.0.1:4310')
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.dataDir, '/home/me/.guanxi')
  })

  it('uses the lane variables the node itself reads', () => {
    const config = resolveConfig({ GUANXI_API_PORT: '4441', GUANXI_DATA_DIR: '/tmp/lane' }, '/home/me')
    assert.equal(config.origin, 'http://127.0.0.1:4441')
    assert.equal(config.dataDir, '/tmp/lane')
  })

  it('treats empty values as unset', () => {
    const config = resolveConfig({ GUANXI_API_PORT: '', GUANXI_DATA_DIR: '' }, '/home/me')
    assert.equal(config.port, 4310)
    assert.equal(config.dataDir, '/home/me/.guanxi')
  })

  for (const bad of ['abc', '0', '65536', '-1', '4441.5', ' 4441', '4441abc', '1e3', '123456']) {
    it(`rejects the port ${JSON.stringify(bad)} and names the variable`, () => {
      assert.throws(
        () => resolveConfig({ GUANXI_API_PORT: bad }, '/h'),
        (error: unknown) => error instanceof ConfigError && error.variable === 'GUANXI_API_PORT' && error.value === bad,
      )
    })
  }

  it('rejects an invalid timeout instead of silently using the default', () => {
    assert.throws(() => resolveConfig({ GUANXI_DESKTOP_HEALTH_TIMEOUT_MS: '-5' }, '/h'), ConfigError)
    assert.equal(resolveConfig({ GUANXI_DESKTOP_HEALTH_TIMEOUT_MS: '1500' }, '/h').healthTimeoutMs, 1500)
  })

  it('never produces a non-loopback origin, whatever HOST says', () => {
    assert.equal(resolveConfig({ HOST: '0.0.0.0', PORT: '9999' }, '/h').origin, 'http://127.0.0.1:4310')
  })
})
