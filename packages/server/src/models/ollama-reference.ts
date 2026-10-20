import type { OllamaReferencePreview } from '@guanxi/contract'

const COMPONENT = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?'
const MODEL_NAME = new RegExp(
  `^(?:${COMPONENT}/)?${COMPONENT}(?::${COMPONENT})?$`,
)

export type OllamaReferenceInvalidReason =
  | 'empty'
  | 'ambiguous_input'
  | 'invalid_model_name'
  | 'invalid_official_url'

export class OllamaReferenceError extends Error {
  readonly reason: OllamaReferenceInvalidReason

  constructor(reason: OllamaReferenceInvalidReason) {
    super('The Ollama reference is invalid')
    this.name = 'OllamaReferenceError'
    this.reason = reason
  }
}

function normalizeModelName(input: string): string | null {
  if (!MODEL_NAME.test(input)) return null
  const normalized = input.toLowerCase()
  const lastSlash = normalized.lastIndexOf('/')
  return normalized.lastIndexOf(':') > lastSlash
    ? normalized
    : `${normalized}:latest`
}

/** Shared strict name-only boundary for server-derived catalog pull targets. */
export function normalizeOllamaModelName(input: string): string {
  const normalized = normalizeModelName(input)
  if (!normalized) throw new OllamaReferenceError('invalid_model_name')
  return normalized
}

function normalizeOfficialPageUrl(input: string): OllamaReferencePreview {
  if (input.includes('\\') || input.includes('%')) {
    throw new OllamaReferenceError('invalid_official_url')
  }

  // URL canonicalization erases an explicit default `:443`, so inspect the
  // raw authority before parsing and reject every user-supplied port.
  const authority = /^https:\/\/([^/]+)(?:\/|$)/u.exec(input)?.[1]
  if (!authority || authority.includes(':')) {
    throw new OllamaReferenceError('invalid_official_url')
  }
  const rawPath = input.slice(`https://${authority}`.length).split(/[?#]/u, 1)[0] ?? ''
  if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new OllamaReferenceError('invalid_official_url')
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new OllamaReferenceError('invalid_official_url')
  }

  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'ollama.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new OllamaReferenceError('invalid_official_url')
  }

  const segments = url.pathname.split('/').slice(1)
  let candidate: string | null = null
  if (segments.length === 2 && segments[0]?.toLowerCase() === 'library') {
    candidate = segments[1] ?? null
  } else if (
    segments.length === 2
    && segments[0]?.toLowerCase() !== 'library'
  ) {
    candidate = `${segments[0]}/${segments[1]}`
  }

  const normalizedModelName = candidate ? normalizeModelName(candidate) : null
  if (!normalizedModelName) {
    throw new OllamaReferenceError('invalid_official_url')
  }

  return {
    inputKind: 'official_page_url',
    displayValue: input,
    normalizedModelName,
  }
}

/** Pure local parser. It performs no DNS, HTTP, Ollama, or filesystem access. */
export function normalizeOllamaReference(input: string): OllamaReferencePreview {
  if (input.length === 0) throw new OllamaReferenceError('empty')
  if (
    input !== input.trim()
    || input.normalize('NFKC') !== input
    || /[\u0000-\u001f\u007f\s]/u.test(input)
    || input.startsWith('//')
  ) {
    throw new OllamaReferenceError('ambiguous_input')
  }

  if (input.includes('://')) return normalizeOfficialPageUrl(input)

  const normalizedModelName = normalizeOllamaModelName(input)
  return {
    inputKind: 'model_name',
    displayValue: input,
    normalizedModelName,
  }
}
