import type { Connection, ConnectionSnapshot } from '@guanxi/contract'
import { translate } from '../../lib/locale.ts'
import { ConnectionsView } from './ConnectionsPage.tsx'

// Portable states for DS1 catalog integration; no new shared primitive or approval.
export default { title: translate('connections.title'), component: ConnectionsView }
const connection: Connection = {
  id: '11111111-1111-4111-8111-111111111111', accountId: 'example', name: 'Example connection', kind: 'model_api',
  provider: 'deepseek', auth: 'api_key', unattended: false, secretRef: null, facts: {}, balance: null, createdAt: '2026-10-20T00:00:00.000Z',
}
const empty: ConnectionSnapshot = { connections: [], costs: [], vault: { unlocked: false, unattendedAvailable: false } }
const args = { snapshot: empty, retry: () => undefined, mutate: async () => undefined }
export const Empty = { args }
export const Loading = { args: { ...args, snapshot: null, loading: true } }
export const Error = { args: { ...args, snapshot: null, error: true } }
export const Offline = { args: { ...args, snapshot: null, error: true, offline: true } }
export const Unknown = { args: { ...args, snapshot: { ...empty, connections: [connection] } } }
export const Default = { args: { ...args, snapshot: { ...empty, vault: { unlocked: true, unattendedAvailable: true }, connections: [connection] } } }
export const Disabled = { args: { ...Default.args, busy: true } }
export const Estimated = { args: { ...args, snapshot: { ...empty, connections: [{ ...connection,
  balance: { amount: 1.5, currency: 'USD', source: 'example estimate', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'medium' },
}] } } }

export const Enabled = { args: { ...Default.args, snapshot: { ...Default.args.snapshot, connections: [{ ...connection, unattended: true }] } } }

export const LockedError = { args: { ...Error.args, errorCode: 'vault_locked' } }
export const MissingError = { args: { ...Error.args, errorCode: 'connection_not_found' } }
export const PolicyError = { args: { ...Error.args, errorCode: 'policy_denied' } }
export const EgressError = { args: { ...Error.args, errorCode: 'egress_unavailable' } }
export const InternalError = { args: { ...Error.args, errorCode: 'internal_error' } }
export const ValidationError = { args: { ...Error.args, errorCode: 'validation_failed' } }
export const ProviderError = { args: { ...Error.args, errorCode: 'provider_failed' } }
