import { vi } from 'vitest'
import type { FakeNode, Reply } from '../fixtures/notifications-server.ts'

/** Routes `/api/notifications*` to the fake node; anything else goes to `other` or answers 500. */
export function installNodeFetch(node: FakeNode, other?: (path: string, method: string) => Reply | null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, window.location.origin)
    const method = init?.method ?? 'GET'
    const signal = init?.signal
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    let reply: Reply | null
    if (url.pathname.startsWith('/api/notifications')) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null
      reply = await node.handle(method, url.pathname, Object.fromEntries(url.searchParams), headers, body)
    } else {
      reply = other?.(url.pathname, method) ?? { status: 500, body: { code: 'internal_error', message: url.pathname, details: null } }
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Deterministic Idempotency-Key generator: `key-000001`, `key-000002`, … */
export function counterKeys(): () => string {
  let n = 0
  return () => `key-${String(++n).padStart(6, '0')}`
}
