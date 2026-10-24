import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { RuntimeSnapshot } from '@guanxi/contract'
import { api } from '../../lib/api.ts'
import {
  useRuntimePolling,
  type RuntimePollingState,
} from './useRuntimePolling.ts'

/**
 * The shared runtime sample as an external store. The node rebuilds every snapshot (a new
 * observation time and memory sample), so the sample's identity changes on every poll; consumers
 * therefore subscribe to the slice they show (P2, D-203). A consumer whose slice is unchanged does
 * not re-render, and the context value itself never changes.
 */
interface RuntimeStore {
  getState: () => RuntimePollingState
  subscribe: (listener: () => void) => () => void
}

const RuntimeContext = createContext<RuntimeStore | null>(null)

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
  const polling = useRuntimePolling(loader)
  const { data, error, loading, refreshing, retry, refresh } = polling
  // One state object per real change; retry and refresh are stable.
  const state = useMemo<RuntimePollingState>(
    () => ({ data, error, loading, refreshing, retry, refresh }),
    [data, error, loading, refreshing, retry, refresh],
  )
  const current = useRef(state)
  const listeners = useRef(new Set<() => void>())
  const store = useMemo<RuntimeStore>(() => ({
    getState: () => current.current,
    subscribe: (listener) => { listeners.current.add(listener); return () => { listeners.current.delete(listener) } },
  }), [])
  useLayoutEffect(() => {
    if (current.current === state) return
    current.current = state
    for (const listener of listeners.current) listener()
  }, [state])
  return <RuntimeContext.Provider value={store}>{children}</RuntimeContext.Provider>
}

/**
 * Subscribes to one slice of the runtime state. The component re-renders only when `isEqual`
 * says the slice changed (by default identity, which structural sharing keeps for unchanged
 * subtrees such as the governor).
 */
export function useRuntimeSelector<T>(
  select: (state: RuntimePollingState) => T,
  isEqual: (previous: T, next: T) => boolean = Object.is,
): T {
  const store = useContext(RuntimeContext)
  if (!store) throw new Error('RuntimeProvider is missing')
  return useStoreSelector(store, select, isEqual)
}

/** The whole runtime state: for views that show the sample itself (the status items, details). */
export function useRuntimeProjection(): RuntimePollingState {
  return useRuntimeSelector(identity)
}

export function useOptionalRuntimeProjection(): RuntimePollingState | null {
  const store = useContext(RuntimeContext)
  return useStoreSelector(store, identity, Object.is)
}

const identity = (state: RuntimePollingState) => state
const noStore: RuntimeStore = { getState: () => null as unknown as RuntimePollingState, subscribe: () => () => {} }

function useStoreSelector<T>(
  store: RuntimeStore | null,
  select: (state: RuntimePollingState) => T,
  isEqual: (previous: T, next: T) => boolean,
): T {
  const target = store ?? noStore
  const selection = useRef<{ state: RuntimePollingState; value: T } | null>(null)
  const getSnapshot = () => {
    const state = target.getState()
    const last = selection.current
    if (last && last.state === state) return last.value
    const value = select(state)
    if (last && isEqual(last.value, value)) {
      selection.current = { state, value: last.value }
      return last.value
    }
    selection.current = { state, value }
    return value
  }
  return useSyncExternalStore(target.subscribe, getSnapshot, getSnapshot)
}
