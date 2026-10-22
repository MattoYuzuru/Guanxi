import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { relayStartInputSchema, relayStartStatusSchema, type RelayStartStatus } from '@guanxi/contract'

const idle = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(new Error('canceled')) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, 100)
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
})
const terminal = (s: RelayStartStatus) => !['preparing', 'running'].includes(s.status)
/** Stable metadata-only stdout. Plan files contain owner choices, never a runtime attestation. */
export async function relayExec(args: string[], transport: typeof fetch = fetch, signal?: AbortSignal,
  readPlan: (path: string) => Promise<string> = path => readFile(path, 'utf8')): Promise<RelayStartStatus> {
  let key: string = randomUUID()
  let endpoint: URL | undefined, submitted = false
  const failed = (error: string, status: RelayStartStatus['status'] = 'failed'): RelayStartStatus => ({ key, runId: null, sessionId: null,
    status, error, source: 'start-owner', observedAt: new Date().toISOString(), confidence: 'observed', runtime: null, meter: null, runtimeAgeMs: null, reserves: null })
  const request = async (path: string, method: string, body?: unknown, requestSignal = signal) => {
    const response = await transport(new URL(`/api/relay${path}`, endpoint!), { method, redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal })
    if (!response.ok) {
      const value = await response.json().catch(() => null) as { code?: unknown } | null
      const known = new Set(['runtime_meter_unavailable', 'relay_workspace_unavailable', 'relay_idempotency_conflict', 'relay_local_connection_required'])
      throw new Error(typeof value?.code === 'string' && known.has(value.code) ? value.code : 'relay_exec_failed')
    }
    return relayStartStatusSchema.parse(await response.json())
  }
  try {
    const values: Record<string, string> = {}, allowed = new Set(['--url', '--request', '--key'])
    for (let index = 0; index < args.length; index++) {
      const field = args[index]!
      if (field === '--json') continue
      if (!allowed.has(field) || !args[index + 1] || values[field]) throw new Error('relay_exec_failed')
      values[field] = args[++index]!
    }
    endpoint = new URL(values['--url'] ?? `http://127.0.0.1:${process.env.GUANXI_API_PORT ?? 4310}`)
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !values['--request']) throw new Error('relay_exec_failed')
    if (values['--key']) key = values['--key']
    signal?.throwIfAborted()
    const input = relayStartInputSchema.parse({ ...JSON.parse(await readPlan(values['--request'])), key })
    signal?.throwIfAborted(); submitted = true
    let state = await request('', 'POST', input)
    while (!terminal(state)) { await idle(signal); state = await request(`/starts/${encodeURIComponent(key)}`, 'GET') }
    return state
  } catch (error) {
    if (signal?.aborted && submitted && endpoint) {
      try { return await request(`/starts/${encodeURIComponent(key)}/stop`, 'POST', {}, AbortSignal.timeout(5000)) }
      catch { return failed('cancellation_unconfirmed', 'interrupted') }
    }
    if (signal?.aborted) return failed('relay_stopped', 'canceled')
    return failed(error instanceof Error && ['runtime_meter_unavailable', 'relay_workspace_unavailable', 'relay_idempotency_conflict', 'relay_local_connection_required'].includes(error.message) ? error.message : 'relay_exec_failed')
  }
}
export const relayExecExitCode = (state: RelayStartStatus) => state.status === 'completed' ? 0 : state.status === 'canceled' ? 130 : 1
