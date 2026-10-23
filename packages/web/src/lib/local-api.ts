/**
 * Transport for the local-owner REST surfaces (notifications, voice glossary, work ledger).
 *
 * Their errors are `{ code }` only. Every response is parsed with a contract schema; a body that
 * does not match is a contract bug (`LocalApiShapeError`), not a user error. No message text is
 * ever read from the server or shown from here: the UI maps `code` to its own locale keys.
 */
import type { output, ZodTypeAny } from 'zod'

export class LocalApiError<Code extends string = string> extends Error {
  constructor(readonly status: number, readonly code: Code | 'unexpected_response') {
    super(code)
    this.name = 'LocalApiError'
  }
}

export class LocalApiShapeError extends Error {
  constructor(readonly path: string, readonly issues: unknown) {
    super('API response shape mismatch')
    this.name = 'LocalApiShapeError'
  }
}

export interface LocalRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
  signal?: AbortSignal
}

function withQuery(path: string, query: LocalRequestInit['query']): string {
  if (query === undefined) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const text = params.toString()
  return text === '' ? path : `${path}?${text}`
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

export async function localRequest<Schema extends ZodTypeAny, ErrorSchema extends ZodTypeAny>(
  path: string,
  schema: Schema,
  errorSchema: ErrorSchema,
  init: LocalRequestInit = {},
): Promise<output<Schema>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(withQuery(path, init.query), {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  const json = parseJson(await response.text())
  if (!response.ok) {
    const error = errorSchema.safeParse(json)
    throw new LocalApiError<string>(response.status, error.success ? (error.data as { code: string }).code : 'unexpected_response')
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new LocalApiShapeError(path, parsed.error.issues)
  return parsed.data
}
