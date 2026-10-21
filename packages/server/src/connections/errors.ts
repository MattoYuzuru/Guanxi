import type { ConnectionErrorCode } from '@guanxi/contract'

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode
  constructor(code: ConnectionErrorCode, message: string) {
    super(message)
    this.name = 'ConnectionError'
    this.code = code
  }
}
export const connectionErrorStatus = {
  connection_not_found: 404, vault_locked: 423, policy_denied: 403,
  egress_unavailable: 503, internal_error: 500, validation_failed: 400, provider_failed: 502, quota_exhausted: 429,
} as const satisfies Record<ConnectionErrorCode, number>
