import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { notificationsApi } from './api.ts'
import { InboxStore, type InboxApi, type InboxSnapshot } from './inbox-store.ts'

/** How often the shell re-reads the inbox while it is visible and the node answers. The node pushes nothing yet. */
export const NOTIFICATIONS_POLL_MS = 30_000
/** The longest wait between reads while the node keeps failing (the interval doubles up to this). */
export const NOTIFICATIONS_POLL_MAX_MS = 300_000

/** Wait before the next read after `failures` consecutive failed reads: base, then doubling up to the cap. */
export function pollDelay(baseMs: number, failures: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures, 30))
}

const InboxContext = createContext<InboxStore | null>(null)

export function NotificationsProvider({
  children,
  api = notificationsApi,
  pollMs = NOTIFICATIONS_POLL_MS,
  maxPollMs = NOTIFICATIONS_POLL_MAX_MS,
  newKey,
}: {
  children: ReactNode
  api?: InboxApi
  pollMs?: number
  maxPollMs?: number
  /** Test seam for the Idempotency-Key generator. */
  newKey?: () => string
}) {
  const [store] = useState(() => new InboxStore(api, { newKey }))
  useEffect(() => {
    store.resume()
    let stopped = false
    let failures = 0
    let timer: number | undefined
    const schedule = () => {
      window.clearTimeout(timer) // one timer at most, however the reads overlap
      if (!stopped) timer = window.setTimeout(() => { void tick() }, pollDelay(pollMs, failures, maxPollMs))
    }
    const read = async () => {
      await store.refresh()
      if (stopped) return
      failures = store.getSnapshot().lists.unread.failure === null ? 0 : failures + 1
    }
    // A tick while the document is hidden reads nothing; becoming visible reads at once.
    const tick = async () => {
      if (document.visibilityState !== 'hidden') await read()
      schedule()
    }
    const wake = () => { if (!stopped) void read().then(schedule) }
    const visible = () => { if (document.visibilityState !== 'hidden') wake() }
    wake()
    window.addEventListener('online', wake)
    window.addEventListener('offline', wake)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.removeEventListener('online', wake)
      window.removeEventListener('offline', wake)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', visible)
      store.dispose()
    }
  }, [store, pollMs, maxPollMs])
  return <InboxContext.Provider value={store}>{children}</InboxContext.Provider>
}

/** The inbox store, or `null` when no provider is mounted (the status strip then shows unknown). */
export function useOptionalInboxStore(): InboxStore | null {
  return useContext(InboxContext)
}

export function useInboxStore(): InboxStore {
  const store = useContext(InboxContext)
  if (store === null) throw new Error('useInboxStore needs a NotificationsProvider')
  return store
}

export function useInboxSnapshot(store: InboxStore): InboxSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
