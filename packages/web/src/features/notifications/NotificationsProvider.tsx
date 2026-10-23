import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { notificationsApi } from './api.ts'
import { InboxStore, type InboxApi, type InboxSnapshot } from './inbox-store.ts'

/** How often the shell re-reads the inbox while it is visible. The node pushes nothing yet. */
export const NOTIFICATIONS_POLL_MS = 30_000

const InboxContext = createContext<InboxStore | null>(null)

export function NotificationsProvider({
  children,
  api = notificationsApi,
  pollMs = NOTIFICATIONS_POLL_MS,
  newKey,
}: {
  children: ReactNode
  api?: InboxApi
  pollMs?: number
  /** Test seam for the Idempotency-Key generator. */
  newKey?: () => string
}) {
  const [store] = useState(() => new InboxStore(api, { newKey }))
  useEffect(() => {
    void store.refresh()
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void store.refresh()
    }, pollMs)
    const wake = () => { void store.refresh() }
    window.addEventListener('online', wake)
    window.addEventListener('offline', wake)
    window.addEventListener('focus', wake)
    return () => {
      window.clearInterval(poll)
      window.removeEventListener('online', wake)
      window.removeEventListener('offline', wake)
      window.removeEventListener('focus', wake)
      store.dispose()
    }
  }, [store, pollMs])
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
