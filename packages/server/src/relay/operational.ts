import { join } from 'node:path'
import { LlamaServerHost, type LlamaServerBoot, type LlamaServerState } from '../runtime/llama-server/process.ts'
import type { LlamaServerRuntime } from '../runtime/llama-server/runtime.ts'
import { OwnedCheckoutAllocator } from './checkout.ts'
import type { RelayRuntimeObserver, RelayRuntimePolicy } from './runtime.ts'
import type { RelayStartHost } from './start.ts'
import { invariant, RelayError, type Reserves } from './types.ts'

/** Explicit, immutable opt-in for an operational local relay (R2-op). It is a boot option of the
 * trusted host process, never an HTTP setting. Without it the stock refusals remain:
 * `runtime_meter_unavailable` and `relay_workspace_unavailable`. */
export interface OperationalRelayOptions {
  /** The single llama-server instance that renders, counts and serves relay requests. */
  llamaServer: LlamaServerBoot
  /** ADR-0020 reserves for the served model; these are policy, not something Guanxi guesses. */
  reserves: Reserves
  /** Maximum age of a loaded-model or counter observation. Default one minute. */
  maximumAgeMs?: number
  /** Guanxi-owned allowed root for checkouts. Default `<data dir>/relay-checkouts`. */
  checkoutRoot?: string
}
export interface OperationalRelay {
  /** Absent while the binary or the model file is not present on this node. */
  readonly relay?: { runtime: RelayRuntimePolicy; reserves: Reserves; allocate: NonNullable<RelayStartHost['allocate']> }
  state(): LlamaServerState
  settled(): Promise<void>
  close(): Promise<void>
}

export function createOperationalRelay(raw: OperationalRelayOptions, dataDir: string): OperationalRelay {
  const options = structuredClone(raw)
  const maximumAgeMs = options.maximumAgeMs ?? 60_000
  invariant(Number.isSafeInteger(maximumAgeMs) && maximumAgeMs > 0, 'relay_policy_invalid')
  const host = LlamaServerHost.create(options.llamaServer)
  const allocator = new OwnedCheckoutAllocator({ root: options.checkoutRoot ?? join(dataDir, 'relay-checkouts') })
  // A spawned child picks its port asynchronously, so the runtime may not exist yet at boot. The
  // relay binds to the host, not to a runtime snapshot: until the child is served (and `ready`),
  // every observation and count refuses with the stock meter refusal.
  const served = (): LlamaServerRuntime => {
    const runtime = host.runtime
    if (!runtime) throw new RelayError('runtime_meter_unavailable')
    return runtime
  }
  const observer: RelayRuntimeObserver = Object.freeze({
    get host() { return served().host },
    get transport() { return served().transport },
    observe: (reference: string, signal: AbortSignal) => served().observe(reference, signal),
  })
  const counter: NonNullable<RelayRuntimePolicy['counter']> = (fact, signal) => served().counter(fact, signal)
  const relay = host.state().state !== 'unavailable' ? Object.freeze({ reserves: Object.freeze({ ...options.reserves }),
    runtime: Object.freeze({ maximumAgeMs, observer, counter }), allocate: allocator.allocate }) : undefined
  return { relay, state: () => host.state(), settled: () => host.settled(), close: () => host.close() }
}
