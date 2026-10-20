import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  apiPortFromEnv,
  dataDirFromEnv,
  devOriginsFromEnv,
  portFromEnv,
} from '../src/config/listen-env.ts'

describe('listen settings from the environment', () => {
  it('keeps the single-checkout defaults', () => {
    assert.equal(apiPortFromEnv({}, 4310), 4310)
    assert.equal(dataDirFromEnv({ HOME: '/home/owner' }), '/home/owner/.guanxi')
    assert.deepEqual(devOriginsFromEnv({}), ['http://localhost:5173', 'http://127.0.0.1:5173'])
  })

  it('prefers GUANXI_API_PORT over the legacy PORT', () => {
    assert.equal(apiPortFromEnv({ PORT: '4999', GUANXI_API_PORT: '4383' }, 4310), 4383)
    assert.equal(apiPortFromEnv({ PORT: '4999' }, 4310), 4999)
    assert.equal(apiPortFromEnv({ PORT: 'junk' }, 4310), 4310)
  })

  it('moves the data directory away from ~/.guanxi', () => {
    assert.equal(
      dataDirFromEnv({ HOME: '/home/owner', GUANXI_DATA_DIR: '/tmp/lane/.lane-data' }),
      '/tmp/lane/.lane-data',
    )
    assert.equal(dataDirFromEnv({ HOME: '/home/owner', GUANXI_DATA_DIR: '' }), '/home/owner/.guanxi')
  })

  it('derives dev origins from GUANXI_WEB_PORT', () => {
    assert.deepEqual(devOriginsFromEnv({ GUANXI_WEB_PORT: '5183' }), [
      'http://localhost:5183',
      'http://127.0.0.1:5183',
    ])
  })

  for (const raw of [' 4383', '4383.0', '+4383', '0x1400', '1e4', 'abc', '0', '65536']) {
    it(`rejects ${JSON.stringify(raw)} instead of guessing`, () => {
      assert.throws(
        () => portFromEnv({ GUANXI_API_PORT: raw }, 'GUANXI_API_PORT', 4310),
        /GUANXI_API_PORT must be a TCP port/,
      )
    })
  }
})
