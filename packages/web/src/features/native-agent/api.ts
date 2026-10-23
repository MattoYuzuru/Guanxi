import { nativeRetentionSchema, deleteNativeSessionResponseSchema, agentProgressSchema, type NativeAgentInput } from '@guanxi/contract'
/** Carries the node's content-free error code so screens can explain the failure. */
export class AgentRequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) { super('agent_unavailable'); this.status = status; this.code = code }
}
export async function agentRequest(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/agent${path}`, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
  if (!response.ok) {
    const parsed: unknown = await response.json().catch(() => null)
    const code = parsed && typeof parsed === 'object' && 'code' in parsed && typeof parsed.code === 'string' ? parsed.code : 'agent_unavailable'
    throw new AgentRequestError(response.status, code)
  }
  return response.json()
}
export const nativeApi = {
  leaveSession: async (id: string) => nativeRetentionSchema.parse(await agentRequest(`/${encodeURIComponent(id)}/leave`, 'POST', {})),
  setRetention: async (id: string, mode: 'keep' | 'ttl' | 'session') => nativeRetentionSchema.parse(await agentRequest(`/${encodeURIComponent(id)}/retention`, 'PATCH', { mode })),
  deleteSession: async (id: string) => deleteNativeSessionResponseSchema.parse(await agentRequest(`/${encodeURIComponent(id)}`, 'DELETE')),
  create: (input: NativeAgentInput) => agentRequest('', 'POST', input) as Promise<{ sessionId: string }>,
  progress: async (id: string, signal?: AbortSignal) => agentProgressSchema.parse(await agentRequest(`/${encodeURIComponent(id)}`, 'GET', undefined, signal)),
  prompt: (id: string, text: string) => agentRequest(`/${encodeURIComponent(id)}/prompts`, 'POST', { text }),
  stop: (id: string) => agentRequest(`/${encodeURIComponent(id)}/stop`, 'POST', {}),
  remove: (id: string, item: string) => agentRequest(`/${encodeURIComponent(id)}/queue/${encodeURIComponent(item)}`, 'DELETE'),
}
