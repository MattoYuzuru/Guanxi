import { connectionSnapshotSchema, type CreateConnection } from '@guanxi/contract'
async function request(path: string, method: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/connections${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  })
  if (!response.ok) throw new Error('Connection request failed')
  return response.json() as Promise<unknown>
}
export const connectionApi = {
  list: async (signal?: AbortSignal) => connectionSnapshotSchema.parse(await request('', 'GET', undefined, signal)),
  create: (input: CreateConnection) => request('', 'POST', input),
  unattended: (id: string, value: boolean) => request(`/${encodeURIComponent(id)}`, 'PATCH', { unattended: value }),
  unlock: () => request('/vault/unlock', 'POST', {}),
  lock: () => request('/vault/lock', 'POST', {}),
  secret: (id: string, value: string) => request(`/${encodeURIComponent(id)}/secret`, 'PUT', { value }),
  probe: (id: string) => request(`/${encodeURIComponent(id)}/probe`, 'POST', {}),
}
