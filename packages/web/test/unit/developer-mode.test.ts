import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDeveloperMode, writeDeveloperMode } from '../../src/features/catalog/developer-mode.ts'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

function deniedStorage(): Storage {
  const deny = () => {
    throw new DOMException('denied', 'SecurityError')
  }
  return { length: 0, clear: deny, getItem: deny, key: deny, removeItem: deny, setItem: deny }
}

describe('Developer mode preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists through localStorage when it is available', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    writeDeveloperMode(true)
    expect(storage.getItem('guanxi.developerMode')).toBe('on')
    expect(readDeveloperMode()).toBe(true)
    writeDeveloperMode(false)
    expect(readDeveloperMode()).toBe(false)
  })

  it('keeps a page-local value when storage throws on read and write (GPT L1)', () => {
    vi.stubGlobal('localStorage', deniedStorage())
    expect(readDeveloperMode()).toBe(false)
    writeDeveloperMode(true)
    expect(readDeveloperMode()).toBe(true)
    writeDeveloperMode(false)
    expect(readDeveloperMode()).toBe(false)
  })
})
