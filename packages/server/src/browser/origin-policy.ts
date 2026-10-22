/**
 * Pure per-run origin policy for the agent browser (ADR-0035 decisions 5–7).
 *
 * The policy is deterministic: it reads only its arguments, never mutates them and never
 * consults a clock, storage, the network or the process environment. A clean link can propose
 * one new readable origin; it can never add a writable origin, and only the caller may apply
 * the returned `addReadable` to the run policy.
 *
 * ## Normalization
 *
 * `normalizeOrigin` accepts any absolute http(s) URL (a bare origin is a URL with `/`). It
 * lowercases the host, converts IDN labels to punycode through the WHATWG URL parser, removes
 * all trailing dots from the host, drops default ports (`:80` for http, `:443` for https) and
 * returns `scheme://host[:port]`. Userinfo, path, query and fragment do not become part of the
 * origin. Any other scheme, a relative reference or an unparseable value throws `TypeError`.
 *
 * ## Clean-link heuristic (adds one readable origin)
 *
 * A URL is clean only when all of these hold:
 *
 * - it is http(s), with no username and no password;
 * - it has no query string or fragment, including an empty `?` or `#`;
 * - its percent-decoded pathname, including the leading `/`, is at most 200 characters;
 * - every percent-decoded path segment is at most 32 characters, or is not composed solely of
 *   base64/hex-like characters `[A-Za-z0-9_+=-]`.
 *
 * The last rule is deliberately conservative: any path segment longer than 32 characters drawn
 * from that alphabet is treated as data-carrying, even if it happens to be a long English word.
 * Percent escapes are decoded before measuring; malformed escapes are treated as literal text.
 *
 * ## Model-URL data heuristic (refuses data on an already-readable origin)
 *
 * A navigate action sent `via: 'model'` is refused as data-carrying when any of these hold:
 *
 * - it carries userinfo;
 * - it has a non-empty fragment;
 * - its percent-decoded pathname plus percent-decoded query is longer than 200 characters;
 * - it has more than 8 query parameters;
 * - any query parameter name or value is longer than 64 characters;
 * - any query parameter name or value is longer than 32 characters and composed solely of the
 *   base64/hex alphabet above;
 * - any percent-decoded path segment is longer than 64 characters;
 * - any percent-decoded path segment is longer than 32 characters and composed solely of that
 *   alphabet, or any part of it split on `.`, `-` or `_` is.
 *
 * Query values are split on `&` and the first `=`; `+` is treated literally rather than as a
 * space, because it is a base64 character. The decoded path and query share one 200-character
 * budget so data cannot be spread across many short segments or parameters. Splitting a path
 * segment on `.`, `-` and `_` keeps a separator from hiding one long data run inside a segment
 * that is otherwise not composed solely of the alphabet.
 */
import type {
  BrowserAction,
  BrowserDecision,
  BrowserDecisionCode,
  RunBrowserPolicy,
} from './types.ts'

export type { BrowserAction, BrowserDecision, BrowserDecisionCode, BrowserMode, RunBrowserPolicy } from './types.ts'

const HTTP_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:'])
const BASE64_HEX = /^[A-Za-z0-9_+=-]+$/
const CLEAN_PATH_LIMIT = 200
const MODEL_TOTAL_LIMIT = 200
const MODEL_QUERY_PARAMETER_LIMIT = 8
const SEGMENT_ENTROPY_LIMIT = 32
const VALUE_DATA_LIMIT = 64

/**
 * Return the canonical origin of an absolute http(s) URL. Throws `TypeError` for every other
 * scheme, relative references and unparseable values.
 */
export function normalizeOrigin(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError('normalizeOrigin expects an absolute http(s) URL')
  }
  if (!HTTP_SCHEMES.has(parsed.protocol)) {
    throw new TypeError('normalizeOrigin expects an absolute http(s) URL')
  }
  if (parsed.hostname === '') throw new TypeError('normalizeOrigin expects a non-empty host')
  return canonicalOrigin(parsed)
}

/** Authorize one action against an immutable run policy. */
export function decide(policy: RunBrowserPolicy, action: BrowserAction): BrowserDecision {
  return action.kind === 'navigate' ? decideNavigate(policy, action) : decideInteraction(policy, action)
}

function decideNavigate(
  policy: RunBrowserPolicy,
  action: Extract<BrowserAction, { kind: 'navigate' }>,
): BrowserDecision {
  const parsed = parseHttpUrl(action.url)
  if ('code' in parsed) return deny(parsed.code)
  const origin = canonicalOrigin(parsed.url)
  const readable = policy.readable.includes(origin)

  // The untyped HTTP/tool boundary can omit `via`; fail closed instead of falling through to
  // clean-link handling. Typed callers cannot express an unknown value.
  switch (action.via) {
    case 'model':
      // Rule 3 is stricter than rule 1: a model URL on a readable origin still may not carry data.
      if (!readable) return deny('origin_not_allowed')
      return hasModelData(parsed.url) ? deny('data_url_refused') : allow()
    case 'policy':
      return readable ? allow() : deny('origin_not_allowed')
    case 'clean_link': {
      if (readable) return allow()
      // Only a readable page may introduce one new readable origin.
      const fromOrigin = action.fromOrigin === undefined ? null : tryNormalizeOrigin(action.fromOrigin)
      if (fromOrigin === null || !policy.readable.includes(fromOrigin)) {
        return deny('origin_not_allowed')
      }
      if (!isCleanLink(parsed.url, action.url)) return deny('data_url_refused')
      return { allowed: true, code: 'allowed', addReadable: origin }
    }
    default:
      return deny('invalid_action')
  }
}

function decideInteraction(
  policy: RunBrowserPolicy,
  action: Exclude<BrowserAction, { kind: 'navigate' }>,
): BrowserDecision {
  const parsed = parseHttpUrl(action.origin)
  if ('code' in parsed) return deny(parsed.code)
  const origin = canonicalOrigin(parsed.url)
  const readable = policy.readable.includes(origin)

  if (action.kind === 'click') {
    return readable ? allow() : deny('origin_not_allowed')
  }
  // Only the exact `full` mode may write; an absent/unknown mode fails closed as read-only.
  if (policy.mode !== 'full') return deny('read_only')
  return policy.writable.includes(origin) ? allow() : deny('write_not_allowed')
}

function allow(): BrowserDecision {
  return { allowed: true, code: 'allowed' }
}

function deny(code: Exclude<BrowserDecisionCode, 'allowed'>): BrowserDecision {
  return { allowed: false, code }
}

function parseHttpUrl(raw: string): { url: URL } | { code: 'scheme_refused' | 'invalid_url' } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw)?.[1]?.toLowerCase()
    return { code: scheme !== undefined && !HTTP_SCHEMES.has(`${scheme}:`) ? 'scheme_refused' : 'invalid_url' }
  }
  if (!HTTP_SCHEMES.has(parsed.protocol)) return { code: 'scheme_refused' }
  if (parsed.hostname === '') return { code: 'invalid_url' }
  return { url: parsed }
}

function canonicalOrigin(url: URL): string {
  const host = stripTrailingDots(url.hostname.toLowerCase())
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${host}${port}`
}

function tryNormalizeOrigin(raw: string): string | null {
  try {
    return normalizeOrigin(raw)
  } catch {
    return null
  }
}

function stripTrailingDots(host: string): string {
  // IPv6 hostnames are bracketed and never end in a dot.
  return host.startsWith('[') ? host : host.replace(/\.+$/, '')
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isHighEntropy(value: string): boolean {
  return value.length > SEGMENT_ENTROPY_LIMIT && BASE64_HEX.test(value)
}

function isDataValue(value: string): boolean {
  return value.length > VALUE_DATA_LIMIT || isHighEntropy(value)
}

function isDataSegment(segment: string): boolean {
  if (isDataValue(segment)) return true
  return segment.split(/[._-]/).some(part => isDataValue(part))
}

function decodedQuery(search: string): string {
  return decodeComponent(search.startsWith('?') ? search.slice(1) : search)
}

function isCleanLink(url: URL, raw: string): boolean {
  if (url.username !== '' || url.password !== '') return false
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) return false
  const decodedPath = decodeComponent(url.pathname)
  if (decodedPath.length > CLEAN_PATH_LIMIT) return false
  for (const segment of decodedPath.split('/')) {
    if (isHighEntropy(segment)) return false
  }
  return true
}

function hasModelData(url: URL): boolean {
  if (url.username !== '' || url.password !== '') return true
  if (url.hash !== '') return true
  if (decodeComponent(url.pathname).length + decodedQuery(url.search).length > MODEL_TOTAL_LIMIT) return true
  const query = rawQueryPairs(url.search)
  if (query.length > MODEL_QUERY_PARAMETER_LIMIT) return true
  for (const [name, value] of query) {
    if (isDataValue(decodeComponent(name)) || isDataValue(decodeComponent(value))) return true
  }
  // Decode before splitting so an encoded separator cannot hide one long data segment.
  for (const segment of decodeComponent(url.pathname).split('/')) {
    if (isDataSegment(segment)) return true
  }
  return false
}

/** Split a query without URL-form decoding, keeping `+` as the base64 character it is. */
function rawQueryPairs(search: string): Array<[string, string]> {
  const query = search.startsWith('?') ? search.slice(1) : search
  if (query === '') return []
  return query.split('&').map((part) => {
    const separator = part.indexOf('=')
    return separator === -1 ? [part, ''] : [part.slice(0, separator), part.slice(separator + 1)]
  })
}
