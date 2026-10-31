/**
 * What the shell can learn about a loopback port without owning it.
 *
 * The identity test is shape-based, not authenticated: the node has no local authentication
 * (packages/server/src/app.ts), so a hostile local process could imitate the health document.
 * Real authentication arrives with U3; see docs/plans/lanes/U2-macos.plan.md, Decision 3.
 */
export type ProbeResult =
  /** Guanxi answers its health document and serves the UI document. */
  | { kind: 'ready'; version: string }
  /** Guanxi API answers but the node was started without a built UI. */
  | { kind: 'ui_missing'; version: string }
  /** Nothing listens (connection refused). */
  | { kind: 'closed' }
  /** Something answers, but not as Guanxi (other HTTP server, or a non-HTTP listener). */
  | { kind: 'foreign' }
  /** The port accepts connections but nothing answers inside the probe timeout. */
  | { kind: 'hung' }

export type FetchLike = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

const MAX_BODY = 256 * 1024
/** Marker of the node's own "no UI build" page (packages/server/src/index.ts, mountWeb). */
const API_ONLY_MARKER = 'Сборка фронта не найдена'

type Outcome<T> = { tag: 'value'; value: T } | { tag: 'closed' } | { tag: 'hung' } | { tag: 'error' }

async function attempt<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<Outcome<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return { tag: 'value', value: await run(controller.signal) }
  } catch (error) {
    if (controller.signal.aborted) return { tag: 'hung' }
    const code = (error as { cause?: { code?: string }; code?: string } | null)
    if (code?.cause?.code === 'ECONNREFUSED' || code?.code === 'ECONNREFUSED') return { tag: 'closed' }
    return { tag: 'error' }
  } finally {
    clearTimeout(timer)
  }
}

function isHealthDocument(value: unknown): value is { appVersion: string } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const application = record['application']
  return (
    record['ok'] === true &&
    typeof record['appVersion'] === 'string' &&
    typeof application === 'object' &&
    application !== null &&
    (application as Record<string, unknown>)['source'] === 'application_http'
  )
}

async function readText(response: { text(): Promise<string> }): Promise<string> {
  return (await response.text()).slice(0, MAX_BODY)
}

export async function probeService(
  origin: string,
  options: { timeoutMs: number; fetchImpl?: FetchLike },
): Promise<ProbeResult> {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))

  const health = await attempt(async (signal) => {
    const response = await doFetch(`${origin}/api/health`, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return null
    try {
      const parsed: unknown = JSON.parse(await readText(response))
      return isHealthDocument(parsed) ? parsed.appVersion : null
    } catch {
      return null
    }
  }, options.timeoutMs)

  if (health.tag === 'closed') return { kind: 'closed' }
  if (health.tag === 'hung') return { kind: 'hung' }
  if (health.tag === 'error' || health.value === null) return { kind: 'foreign' }
  const version = health.value

  const page = await attempt(async (signal) => {
    const response = await doFetch(`${origin}/`, { signal, headers: { accept: 'text/html' } })
    return response.ok ? await readText(response) : ''
  }, options.timeoutMs)
  if (page.tag === 'closed') return { kind: 'closed' }
  if (page.tag === 'hung') return { kind: 'hung' }
  if (page.tag === 'value' && /<div\s+id=["']root["']/.test(page.value) && !page.value.includes(API_ONLY_MARKER)) {
    return { kind: 'ready', version }
  }
  return { kind: 'ui_missing', version }
}
