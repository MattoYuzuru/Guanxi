import type { ConnectionErrorCode } from '@guanxi/contract'

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode
  /** A fixed machine reason a trusted runtime transport gave for a refusal (never provider text). Absent for every other error. */
  readonly reason?: string
  constructor(code: ConnectionErrorCode, message: string, reason?: string) {
    super(message)
    this.name = 'ConnectionError'
    this.code = code
    if (reason !== undefined) this.reason = reason
  }
}
export const connectionErrorStatus = {
  connection_not_found: 404, connection_in_use: 409, vault_locked: 423, policy_denied: 403,
  egress_unavailable: 503, internal_error: 500, validation_failed: 400, provider_failed: 502, quota_exhausted: 429,
} as const satisfies Record<ConnectionErrorCode, number>
