import { agentProgressSchema, type NativeAgentInput } from '@guanxi/contract'
export async function agentRequest(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/agent${path}`, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
  if (!response.ok) throw new Error('agent_unavailable')
  return response.json()
}
export const nativeApi = {
  create: (input: NativeAgentInput) => agentRequest('', 'POST', input) as Promise<{ sessionId: string }>,
  progress: async (id: string, signal?: AbortSignal) => agentProgressSchema.parse(await agentRequest(`/${encodeURIComponent(id)}`, 'GET', undefined, signal)),
  prompt: (id: string, text: string) => agentRequest(`/${encodeURIComponent(id)}/prompts`, 'POST', { text }),
  stop: (id: string) => agentRequest(`/${encodeURIComponent(id)}/stop`, 'POST', {}),
  remove: (id: string, item: string) => agentRequest(`/${encodeURIComponent(id)}/queue/${encodeURIComponent(item)}`, 'DELETE'),
}
