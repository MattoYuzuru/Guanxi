/**
 * Canonical JSON for signed approval payloads: object keys sorted by UTF-16 code unit (the
 * JavaScript string order) at every level, no insignificant whitespace, UTF-8. Both the signer
 * (node route) and the verifier (G12, manifest) serialize through this one function; a
 * verifier in another language must sort the same way (payload keys are ASCII today).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Canonical JSON rejects non-finite numbers')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`)
}
