/**
 * Strict local Hugging Face repository identity parser.
 *
 * Pure by construction: no DNS, HTTP, Hub, Ollama or filesystem access happens here.
 * Only two shapes are accepted — a bare `owner/name` repository id and an exact HTTPS
 * `huggingface.co` model-page URL. Everything ambiguous fails closed, because a
 * lookalike host or an encoded separator must never be resolved into a request later.
 *
 * Hub repository paths are case-sensitive, so the parsed identity preserves the exact
 * owner and name the user supplied. `comparisonKey` is a case-folded local dedup key
 * only; it is never sent to the Hub and never displayed as the repository path.
 */
import type { HuggingFaceReferencePreview } from '@alamo/contract'

/**
 * Hub owner and repository names use alphanumerics plus `-`, `_` and `.`, and must
 * start and end with an alphanumeric so a bare `.`/`..` segment cannot be spelled.
 */
const COMPONENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u

/** Reserved first path segments that are Hub site routes, not repository owners. */
const RESERVED_OWNERS = new Set([
  'datasets',
  'spaces',
  'models',
  'organizations',
  'settings',
  'docs',
  'blog',
  'pricing',
  'login',
  'join',
  'search',
  'api',
  'collections',
  'papers',
  'posts',
  'tasks',
  'new',
])

export type HuggingFaceReferenceInvalidReason =
  | 'empty'
  | 'ambiguous_input'
  | 'invalid_repository_id'
  | 'invalid_model_page_url'

export class HuggingFaceReferenceError extends Error {
  readonly reason: HuggingFaceReferenceInvalidReason

  constructor(reason: HuggingFaceReferenceInvalidReason) {
    super('The Hugging Face reference is invalid')
    this.name = 'HuggingFaceReferenceError'
    this.reason = reason
  }
}

function identityOf(owner: string, name: string) {
  const repositoryId = `${owner}/${name}`
  return {
    provider: 'hugging_face' as const,
    owner,
    name,
    repositoryId,
    comparisonKey: repositoryId.toLowerCase(),
  }
}

/**
 * Accepts exactly one `owner/name` pair. A single segment, a third segment and an
 * empty segment are all refused: `owner/name` is the only grammar this slice resolves.
 */
function parseRepositoryId(
  input: string,
  reason: HuggingFaceReferenceInvalidReason,
): { owner: string; name: string } {
  const segments = input.split('/')
  if (segments.length !== 2) throw new HuggingFaceReferenceError(reason)
  const [owner, name] = segments
  if (!owner || !name) throw new HuggingFaceReferenceError(reason)
  if (!COMPONENT.test(owner) || !COMPONENT.test(name)) {
    throw new HuggingFaceReferenceError(reason)
  }
  if (RESERVED_OWNERS.has(owner.toLowerCase())) {
    throw new HuggingFaceReferenceError(reason)
  }
  return { owner, name }
}

function parseModelPageUrl(input: string): HuggingFaceReferencePreview {
  // A backslash or a percent-escape can only widen the accepted grammar here, so both
  // are refused before any parsing: `%2F` must never become a path separator.
  if (input.includes('\\') || input.includes('%')) {
    throw new HuggingFaceReferenceError('invalid_model_page_url')
  }

  // URL canonicalization erases an explicit default `:443`, so the raw authority is
  // inspected before parsing and every user-supplied port is rejected.
  const authority = /^https:\/\/([^/]+)(?:\/|$)/u.exec(input)?.[1]
  if (!authority || authority.includes(':') || authority.includes('@')) {
    throw new HuggingFaceReferenceError('invalid_model_page_url')
  }
  const rawPath = input.slice(`https://${authority}`.length).split(/[?#]/u, 1)[0] ?? ''
  if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new HuggingFaceReferenceError('invalid_model_page_url')
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new HuggingFaceReferenceError('invalid_model_page_url')
  }

  // The host must be exactly the documented Hub origin. A subdomain, a suffix
  // lookalike (`huggingface.co.evil.test`) and an IP literal are all foreign hosts.
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'huggingface.co'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new HuggingFaceReferenceError('invalid_model_page_url')
  }

  const path = url.pathname.slice(1)
  const { owner, name } = parseRepositoryId(path, 'invalid_model_page_url')
  return {
    inputKind: 'model_page_url',
    displayValue: input,
    identity: identityOf(owner, name),
  }
}

/**
 * The single entry point for turning untrusted text into a repository identity.
 * A successful parse states only that the identity is well-formed — never that the
 * repository exists, is public, contains GGUF files or can be installed.
 */
export function normalizeHuggingFaceReference(input: string): HuggingFaceReferencePreview {
  if (input.length === 0) throw new HuggingFaceReferenceError('empty')
  // Whitespace, control characters, compatibility-normalizable text and a
  // protocol-relative prefix are all ambiguous before any shape is chosen.
  if (
    input !== input.trim()
    || input.normalize('NFKC') !== input
    || /[\u0000-\u001f\u007f\s]/u.test(input)
    || input.startsWith('//')
  ) {
    throw new HuggingFaceReferenceError('ambiguous_input')
  }

  if (input.includes('://')) return parseModelPageUrl(input)
  if (input.includes('%') || input.includes('\\')) {
    throw new HuggingFaceReferenceError('invalid_repository_id')
  }

  const { owner, name } = parseRepositoryId(input, 'invalid_repository_id')
  return {
    inputKind: 'repository_id',
    displayValue: input,
    identity: identityOf(owner, name),
  }
}
