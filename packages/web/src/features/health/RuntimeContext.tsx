import { createContext, useContext, type ReactNode } from 'react'
import type { RuntimeSnapshot } from '@alamo/contract'
import { api } from '../../lib/api.ts'
import {
  useRuntimePolling,
  type RuntimePollingState,
} from './useRuntimePolling.ts'

const RuntimeContext = createContext<RuntimePollingState | null>(null)

/**
 * Persistent shell owner for the single sampled Runtime query loop. Feature
 * consumers may share its bounded refresh, but never create their own poller.
 */
export function RuntimeProvider({
  children,
  loader = api.runtimeSnapshot,
}: {
  children: ReactNode
  loader?: (signal: AbortSignal) => Promise<RuntimeSnapshot>
}) {
  const runtime = useRuntimePolling(loader)
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>
}

export function useRuntimeProjection(): RuntimePollingState {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error('RuntimeProvider is missing')
  return runtime
}
