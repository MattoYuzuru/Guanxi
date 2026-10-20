import type { Page } from '@playwright/test'

/**
 * Runs top-level requestAnimationFrame callbacks in a microtask, before React's
 * scheduler task commits an update made in an async handler. A browser may render a
 * frame before that task, so focus code that schedules a frame from an async handler
 * and expects the new UI to be committed only fails intermittently under load. Here it
 * fails every time. Nested frames (animation loops) keep native timing, and
 * cancelAnimationFrame still cancels.
 */
export async function runFramesBeforePendingCommits(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeRequest = window.requestAnimationFrame.bind(window)
    const nativeCancel = window.cancelAnimationFrame.bind(window)
    const cancelled = new Set<number>()
    let nextHandle = -1
    let depth = 0
    const tracked = (callback: FrameRequestCallback): FrameRequestCallback => (time) => {
      depth += 1
      try {
        callback(time)
      } finally {
        depth -= 1
      }
    }
    window.requestAnimationFrame = (callback) => {
      if (depth > 0) return nativeRequest(tracked(callback))
      // Negative handles never collide with native ones.
      const handle = nextHandle
      nextHandle -= 1
      queueMicrotask(() => {
        if (!cancelled.delete(handle)) tracked(callback)(performance.now())
      })
      return handle
    }
    window.cancelAnimationFrame = (handle) => {
      if (handle < 0) cancelled.add(handle)
      else nativeCancel(handle)
    }
  })
}
