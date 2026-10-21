/** Signed node channel with an injected transport. No network is opened by construction. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FEDERATION_VERSION, federationVersionSchema, replicaEntrySchema, signedConfigOperationSchema,
  type FederationAuth, type NodeIdentity, type RoutedCommand } from '@guanxi/contract/federation'
import { canonical, FederationError, requestProof, signValue } from './crypto.ts'
import type { Federation } from './service.ts'

const handshakeSchema = z.object({ version: federationVersionSchema, negotiated: federationVersionSchema, readOnly: z.boolean() }).strict()
const resultSchema = z.object({ result: z.enum(['applied','stale_version','expired','invalid_state']) }).strict()
export interface ChannelOptions {
  local: NodeIdentity
  privateKey: string
  peer: NodeIdentity
  /** Transport must provide a private authenticated link (Tailscale/Headscale or TLS).
   * The URL is logical; the host maps it to a configured, pinned peer. */
  transport: (request: Request) => Promise<Response>
  clock?: () => number
}
export class FederationChannel {
  #options: ChannelOptions
  constructor(options: ChannelOptions) { this.#options = options }
  async request(method: string, path: string, body: unknown = null): Promise<unknown> {
    const options = this.#options
    const route = `/api/federation${path}`
    const auth: FederationAuth = { nodeId: options.local.id, version: FEDERATION_VERSION,
      issuedAt: (options.clock ?? Date.now)(), nonce: randomUUID(), signature: '' }
    auth.signature = signValue(options.privateKey, requestProof(method, route, body, auth))
    const response = await options.transport(new Request(`https://federation.invalid${route}`, {
      method, headers: { 'X-Guanxi-Node': canonical(auth), 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: canonical(body) }), redirect: 'error',
    }))
    if (!response.ok) throw new FederationError('peer_refused', response.status)
    return response.json()
  }
  /** Anti-entropy pull; each peer is independent, and retries are idempotent. */
  async synchronize(local: Federation, streamIds: readonly string[] = []): Promise<{ readOnly: boolean }> {
    // Verify the host's pin before accepting any remote data.
    const peer = local.peer(this.#options.peer.id)
    if (canonical(peer) !== canonical(this.#options.peer)) throw new FederationError('identity_conflict')
    const handshake = handshakeSchema.parse(await this.request('GET','/handshake'))
    if (handshake.version.major > FEDERATION_VERSION.major) throw new FederationError('contract_incompatible',426)
    const readOnly = handshake.version.major < FEDERATION_VERSION.major || handshake.readOnly
    // An older peer is a reader: it may pull our state, but cannot author imports into us.
    if (readOnly) return { readOnly: true }
    if (peer.scopes.includes('config')) {
      const result = z.object({operations:z.array(signedConfigOperationSchema)}).strict().parse(await this.request('GET','/config'))
      if (result.operations.some((op)=>op.operation.accountId!==local.identity.accountId)) throw new FederationError('owner_mismatch',403)
      local.config.ingest(result.operations)
    }
    for (const stream of streamIds) {
      const result=z.object({entries:z.array(replicaEntrySchema)}).strict().parse(await this.request('GET',`/replicas/${encodeURIComponent(stream)}`))
      local.replicas.ingest(peer,result.entries)
    }
    return { readOnly: false }
  }
  async command(command: RoutedCommand): Promise<string> {
    if (command.homeNodeId!==this.#options.peer.id) throw new FederationError('not_home')
    return resultSchema.parse(await this.request('POST','/commands',command)).result
  }
}
