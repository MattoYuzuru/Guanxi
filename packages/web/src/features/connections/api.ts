import { connectionSnapshotSchema, connectionErrorSchema, type ConnectionErrorCode, type CreateConnection } from '@guanxi/contract'
export class ConnectionRequestError extends Error {
  readonly code: ConnectionErrorCode
  constructor(code: ConnectionErrorCode) { super(code); this.code = code }
}
async function request(path: string, method: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/connections${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  })
  if (!response.ok) {
    const error = connectionErrorSchema.safeParse(await response.json().catch(() => null))
    throw new ConnectionRequestError(error.success ? error.data.code : 'internal_error')
  }
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
