import { definePlugin } from '@guanxi/kernel'
import type { OllamaAdapter } from '../ollama/plugin.ts'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'
import { ConnectionStore } from './store.ts'
import { Vault, type VaultPolicy } from '../vault/vault.ts'
import { osKeychain, type VaultKeychain } from '../vault/keychain.ts'
import { BalanceProbes } from '../probes/balances.ts'
import { EGRESS_SERVICE, type EgressScrubber } from './egress.ts'
import { Connections } from './service.ts'
import type { PiTransport } from './pi.ts'

export const CONNECTIONS_SERVICE = 'connections.registry'
export const CONNECTIONS_EGRESS_READINESS = 'connections.egress-readiness'
export interface ConnectionsEgressReadiness { readonly ready: boolean; assertReady(): void }
export interface ConnectionsConfig {
  databasePath: string; localHost: () => string
  policy?: VaultPolicy
  keychain?: () => Promise<VaultKeychain>
  transport?: typeof fetch; pi?: PiTransport
}
export const connectionsPlugin = definePlugin<ConnectionsConfig>({
  manifest: { id: 'guanxi.connections', engines: { guanxi: '^0.1.0' },
    provides: [CONNECTIONS_SERVICE, CONNECTIONS_EGRESS_READINESS], requires: [EGRESS_SERVICE, 'ollama', 'governor'], trust: 'T0' },
  async apply(ctx, config) {
    const scrubber = ctx.service<EgressScrubber>(EGRESS_SERVICE)
    const store = new ConnectionStore(config.databasePath, scrubber)
    const vault = new Vault(store, config.keychain ?? (() => osKeychain(config.databasePath)), scrubber,
      config.policy ?? { ownerDevice: true, nodeKeyOptIn: false })
    const probes = new BalanceProbes(store, vault, config.transport)
    const connections = new Connections(store, vault, probes, scrubber, ctx.signal,
      ctx.service<OllamaAdapter>('ollama'), ctx.service<ResourceGovernor>('governor'), config.localHost, config.pi, config.transport)
    ctx.effect(() => async () => { vault.close(); await connections.close(); store.close() }, 'connections.close')
    // A locked keychain leaves the source visibly unready, with all K3 egress closed.
    // K2's startup/write barrier must consume this source after integration.
    await vault.registerForScrubbing().catch(() => undefined)
    ctx.provide(CONNECTIONS_EGRESS_READINESS, {
      get ready() { return vault.scrubbingReady },
      assertReady() { vault.assertScrubbingReady('') },
    } satisfies ConnectionsEgressReadiness)
    ctx.provide(CONNECTIONS_SERVICE, connections)
  },
})
