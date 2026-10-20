import { describe, expect, it } from 'vitest'
import { apiPortFromEnv, portFromEnv, webPortFromEnv } from '../../dev-ports.ts'

describe('dev ports from the environment', () => {
  it('keeps the single-checkout defaults when unset or empty', () => {
    expect(webPortFromEnv({})).toBe(5173)
    expect(apiPortFromEnv({})).toBe(4310)
    expect(webPortFromEnv({ GUANXI_WEB_PORT: '' })).toBe(5173)
  })

  it('moves each port independently', () => {
    const lane = { GUANXI_WEB_PORT: '5182', GUANXI_API_PORT: '4382' }
    expect(webPortFromEnv(lane)).toBe(5182)
    expect(apiPortFromEnv(lane)).toBe(4382)
  })

  it.each([' 5199', '5199 ', '5199.0', '+5199', '0x1400', '1e4', 'abc', '0', '65536', '123456'])(
    'rejects %j with a message naming the variable',
    (raw) => {
      expect(() => portFromEnv({ GUANXI_WEB_PORT: raw }, 'GUANXI_WEB_PORT', 5173)).toThrow(
        /GUANXI_WEB_PORT must be a TCP port/,
      )
    },
  )
})
