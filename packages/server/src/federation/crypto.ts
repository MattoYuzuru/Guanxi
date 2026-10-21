import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

/** Canonical JSON, including recursively sorted object keys. Arrays retain their order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
export const signValue = (key: string, value: unknown): string => sign(null, Buffer.from(canonical(value)), createPrivateKey(key)).toString('base64url')
export function validSignature(key: string, value: unknown, signature: string): boolean {
  try { return verify(null, Buffer.from(canonical(value)), publicKey(key), Buffer.from(signature, 'base64url')) } catch { return false }
}
export function publicKey(key: string) {
  const parsed = createPublicKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'spki' })
  if (parsed.asymmetricKeyType !== 'ed25519') throw new FederationError('invalid_key')
  return parsed
}
export class FederationError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status = 409) { super(code); this.name = 'FederationError'; this.code = code; this.status = status }
}
export function requestProof(method: string, path: string, body: unknown, auth: { nodeId: string; audience: string; version: unknown; issuedAt: number; nonce: string }) {
  return { domain: 'guanxi.federation.request.v1', method, path, bodyHash: hash(body), nodeId: auth.nodeId, audience: auth.audience,
    version: auth.version, issuedAt: auth.issuedAt, nonce: auth.nonce }
}
