import { act } from '@testing-library/react'
import { vi } from 'vitest'

/** Hold frames until the test has observed the DOM/effects that must precede them. */
export function holdAnimationFrames() {
  const frames = new Map<number, FrameRequestCallback>()
  let nextHandle = 0
  // Spies are restored by restoreMocks; unlike stubGlobal they cannot leak to another test.
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextHandle, callback)
    return nextHandle
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((handle) => {
    frames.delete(handle)
  })

  return {
    pending: () => frames.size,
    async flush() {
      const batch = [...frames.entries()]
      await act(async () => {
        for (const [handle, callback] of batch) {
          if (!frames.delete(handle)) continue
          callback(performance.now())
        }
      })
    },
  }
}
