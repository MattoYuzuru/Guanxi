import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readShellPreferences, writeShellPreferences, SHELL_PREFERENCES_KEY } from '../../src/features/shell/preferences.ts'

beforeEach(() => {
  // Node 26 reserves localStorage; use the same isolated storage fixture as other browser-state unit tests.
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
})
afterEach(() => vi.unstubAllGlobals())
describe('shell presentation preferences', () => {
  it('restores side, rail/hidden visibility and opaque pins without storing session content', () => {
    const value = { side: 'right', visibility: 'hidden', pinned: Array.from({ length: 220 }, (_, index) => `session-${index}`) } as const
    writeShellPreferences({ ...value, pinned: [...value.pinned] })
    expect(readShellPreferences()).toEqual(value)
    expect(Object.keys(JSON.parse(window.localStorage.getItem(SHELL_PREFERENCES_KEY)!))).toEqual(['side', 'visibility', 'pinned'])
  })
  it('normalizes corrupted storage, invalid enums and duplicate/non-string pin references', () => {
    window.localStorage.setItem(SHELL_PREFERENCES_KEY, '{broken')
    expect(readShellPreferences()).toEqual({ side: 'left', visibility: 'expanded', pinned: [] })
    window.localStorage.setItem(SHELL_PREFERENCES_KEY, JSON.stringify({ side: 'elsewhere', visibility: 'gone', pinned: ['a', '', 'a', 3, 'b'] }))
    expect(readShellPreferences()).toEqual({ side: 'left', visibility: 'expanded', pinned: ['a', 'b'] })
  })
  it('remains usable when browser storage is blocked', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readShellPreferences()).toEqual({ side: 'left', visibility: 'expanded', pinned: [] })
    expect(() => writeShellPreferences({ side: 'left', visibility: 'rail', pinned: [] })).not.toThrow()
  })
})
