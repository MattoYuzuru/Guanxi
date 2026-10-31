import { apiErrorSchema } from '@guanxi/contract'
import { describe, expect, it } from 'vitest'
import { ApiRequestError, errorMessage } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

// Wire bodies of the server's authorization hook (packages/server/src/auth/route-authz.ts).
const BODIES = {
  unauthenticated: { code: 'unauthenticated', message: 'Authentication is required', details: null },
  forbidden: { code: 'forbidden', message: 'This account may not perform that operation', details: null },
  route_unmapped: { code: 'route_unmapped', message: 'This route has no authorization policy', details: null },
  proxied_request_refused: { code: 'proxied_request_refused', message: 'A request carrying proxy headers cannot act as the local owner', details: { reason: 'forwarded_headers' } },
} as const

describe('authorization errors on the wire', () => {
  it('parse against the shared API error contract', () => {
    for (const body of Object.values(BODIES)) expect(apiErrorSchema.parse(body)).toEqual(body)
  })

  it('reach the user as localized copy, never the raw server text', () => {
    for (const locale of ['en', 'ru'] as const) {
      setActiveLocale(locale)
      const messages = Object.values(BODIES).map((body) => {
        const status = body.code === 'unauthenticated' ? 401 : 403
        return errorMessage(new ApiRequestError(status, apiErrorSchema.parse(body), body.message))
      })
      for (const [index, message] of messages.entries()) {
        expect(message.length, `${locale} message ${index}`).toBeGreaterThan(0)
        expect(message).not.toBe(Object.values(BODIES)[index]!.message)
        expect(message).not.toMatch(/^error\./u)
      }
      // A sign-in prompt and a permission refusal are different states for the user.
      expect(messages[0]).not.toBe(messages[1])
    }
    setActiveLocale('en')
  })
})
