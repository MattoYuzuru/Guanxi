import type { Page } from '@playwright/test'

type FetchRead = {
  id: number
  path: string
  aborted: boolean
  state: 'pending' | 'fulfilled' | 'rejected'
}

declare global {
  interface Window {
    __guanxiFetchReads: FetchRead[]
  }
}

/** Observe effect-owned fetches before Chromium can discard an aborted request. */
export async function installFetchLifecycle(page: Page, deferNetworkStart: boolean): Promise<void> {
  await page.addInitScript((defer) => {
    const nativeFetch = window.fetch.bind(window)
    const reads: FetchRead[] = []
    window.__guanxiFetchReads = reads
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method !== 'GET' || !['/api/health', '/api/runtime', '/api/models'].includes(path)) {
        return nativeFetch(input, init)
      }
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const read: FetchRead = {
        id: reads.length + 1,
        path,
        aborted: signal?.aborted ?? false,
        state: 'pending',
      }
      reads.push(read)
      const onAbort = () => { read.aborted = true }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        // StrictMode cleanup can abort before the network stack sees the request.
        // A microtask forces that valid ordering without sleeps or fake responses.
        if (defer) await Promise.resolve()
        const response = await nativeFetch(input, init)
        read.state = 'fulfilled'
        return response
      } catch (error) {
        read.state = 'rejected'
        throw error
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }, deferNetworkStart)
}

export async function fetchReads(page: Page): Promise<FetchRead[]> {
  return page.evaluate(() => window.__guanxiFetchReads)
}
