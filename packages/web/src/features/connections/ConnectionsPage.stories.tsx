import type { Connection, ConnectionSnapshot } from '@guanxi/contract'
import { translate } from '../../lib/locale.ts'
import { ConnectionsView } from './ConnectionsPage.tsx'

// Portable states for DS1 catalog integration; no new shared primitive or approval.
export default { title: translate('connections.title'), component: ConnectionsView }
const connection: Connection = {
  id: '11111111-1111-4111-8111-111111111111', accountId: 'example', name: 'DeepSeek', kind: 'model_api',
  provider: 'deepseek', auth: 'api_key', unattended: false, secretRef: 'secret://example/11111111-1111-4111-8111-111111111111',
  facts: { origin: { value: 'provider_key_import', source: 'connection_import', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'high' } },
  balance: null, createdAt: '2026-10-20T00:00:00.000Z',
}
const local: Connection = {
  id: '22222222-2222-4222-8222-222222222222', accountId: 'example', name: 'Ollama', kind: 'local_runtime',
  provider: 'ollama', auth: 'none', unattended: false, secretRef: null, facts: {}, balance: null,
  createdAt: '2026-10-20T00:00:00.000Z',
}
const empty: ConnectionSnapshot = { connections: [], costs: [], vault: { unlocked: false, unattendedAvailable: false } }
const args = { snapshot: empty, mutate: async () => ({ ok: true as const }) }
export const Empty = { args }
export const Loading = { args: { ...args, snapshot: null, loading: true } }
export const Error = { args: { ...args, snapshot: null, error: true } }
export const Offline = { args: { ...args, snapshot: null, error: true, offline: true } }
export const Default = { args: { ...args, snapshot: { ...empty, vault: { unlocked: true, unattendedAvailable: true }, connections: [connection] } } }
export const LocalRuntime = { args: { ...args, snapshot: { ...empty, vault: { unlocked: true, unattendedAvailable: true }, connections: [local] } } }
export const Disabled = { args: { ...Default.args, busy: true } }
export const LockedError = { args: { ...Error.args, errorCode: 'vault_locked' } }
export const InUseError = { args: { ...Error.args, errorCode: 'connection_in_use' } }
export const ProviderError = { args: { ...Error.args, errorCode: 'provider_failed' } }
