import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { setActiveLocale } from '../src/lib/locale.ts'

beforeEach(() => {
  setActiveLocale('ru')
})

afterEach(() => {
  cleanup()
})

Object.defineProperty(window, 'requestAnimationFrame', {
  configurable: true,
  value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
})

Object.defineProperty(window, 'cancelAnimationFrame', {
  configurable: true,
  value: (handle: number) => window.clearTimeout(handle),
})

Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  value: window.requestAnimationFrame,
})

Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  configurable: true,
  value: window.cancelAnimationFrame,
})

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
})

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  configurable: true,
  value: ObserverStub,
})

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: ObserverStub,
})

vi.stubGlobal('crypto', {
  ...globalThis.crypto,
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
})
