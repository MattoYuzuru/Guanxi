import { agentExecResultSchema, agentProgressV2Schema, type AgentExecResult } from '@guanxi/contract'

/** Both polls ask for the negotiated progress body: a pending artifact queue item has no v1 form. */
const PROGRESS = '?progressVersion=2'

/** Stable single-record stdout protocol; diagnostics never echo inputs or provider errors. */
export async function agentExec(args: string[], transport: typeof fetch = fetch, signal?: AbortSignal): Promise<AgentExecResult> {
  let sessionId: string | null = null
  let endpoint: URL | null = null
  let submitted = false
  try {
    signal?.throwIfAborted()
    const values: Record<string, string> = {}
    const allowed = new Set(['--url', '--project', '--connection', '--model', '--prompt', '--mode', '--domains', '--context-tokens'])
    for (let index = 0; index < args.length; index++) {
      const key = args[index]!
      if (key === '--json') continue
      if (!allowed.has(key) || !args[index + 1] || values[key]) throw new Error('invalid_arguments')
      values[key] = args[++index]!
    }
    const url = new URL(values['--url'] ?? `http://127.0.0.1:${process.env.GUANXI_API_PORT ?? 4310}`)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_endpoint')
    endpoint = url
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await transport(new URL(`/api/agent${path}`, url), { method,
        headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: 'error' })
      if (!response.ok) throw new Error('agent_failed')
      return response.json()
    }
    signal?.throwIfAborted()
    submitted = true
    const created = await request('', 'POST', { projectId: values['--project'], connectionId: values['--connection'], model: values['--model'],
      prompt: values['--prompt'], mode: values['--mode'] ?? 'read-only', domains: values['--domains']?.split(',').filter(Boolean) ?? [],
      ...(values['--context-tokens'] ? { contextTokens: Number(values['--context-tokens']) } : {}) }) as { sessionId: string }
    if (typeof created.sessionId !== 'string') throw new Error('invalid_result')
    sessionId = created.sessionId
    while (agentProgressV2Schema.parse(await request(`/${encodeURIComponent(sessionId)}${PROGRESS}`)).status === 'running') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve() }, 200)
        const aborted = () => { clearTimeout(timer); reject(new Error('cancelled')) }
        signal?.addEventListener('abort', aborted, { once: true })
        if (signal?.aborted) aborted()
      })
    }
    return agentExecResultSchema.parse(await request(`/${encodeURIComponent(sessionId)}/result`))
  } catch {
    if (signal?.aborted && sessionId && endpoint) {
      try {
        const stopped = await transport(new URL(`/api/agent/${encodeURIComponent(sessionId)}/stop`, endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000), redirect: 'error' })
        if (!stopped.ok) throw new Error('stop_failed')
        const deadline = AbortSignal.timeout(5000)
        for (;;) {
          const response = await transport(new URL(`/api/agent/${encodeURIComponent(sessionId)}${PROGRESS}`, endpoint), { signal: deadline, redirect: 'error' })
          if (!response.ok) throw new Error('status_failed')
          if (agentProgressV2Schema.parse(await response.json()).status !== 'running') {
            const final = await transport(new URL(`/api/agent/${encodeURIComponent(sessionId)}/result`, endpoint), { signal: deadline, redirect: 'error' })
            if (!final.ok) throw new Error('result_failed')
            return agentExecResultSchema.parse(await final.json())
          }
          await new Promise(resolve => setTimeout(resolve, 20))
          deadline.throwIfAborted()
        }
      } catch { return { version: 1, sessionId, status: 'interrupted', text: '', error: 'cancellation_unconfirmed' } }
    }
    if (signal?.aborted && submitted) return { version: 1, sessionId, status: 'interrupted', text: '', error: 'cancellation_unconfirmed' }
    return { version: 1, sessionId, status: signal?.aborted ? 'cancelled' : 'failed', text: '', error: signal?.aborted ? null : 'agent_exec_failed' }
  }
}
export const agentExecExitCode = (result: AgentExecResult) => result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1
