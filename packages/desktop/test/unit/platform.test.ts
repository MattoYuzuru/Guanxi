import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { catalogues } from '../../src/messages.ts'
import { platformFor } from '../../src/platform/index.ts'
import type { MenuContext } from '../../src/platform/index.ts'
import { checkForUpdates, updateStatus } from '../../src/updater.ts'

const calls: string[] = []
const context = (developerTools: boolean): MenuContext => ({
  product: 'Product',
  label: (key) => catalogues.en[key],
  reconnect: () => void calls.push('reconnect'),
  stopService: () => void calls.push('stop'),
  developerTools,
})

type Item = { label?: string; role?: string; accelerator?: string; click?: () => void; submenu?: Item[] }
const flatten = (items: Item[]): Item[] => items.flatMap((item) => [item, ...(item.submenu ? flatten(item.submenu) : [])])

describe('platform adapters (D-221: macOS now, Linux in U6, no Windows)', () => {
  it('macOS stays alive without windows and reopens from the dock', () => {
    const mac = platformFor('darwin')
    assert.equal(mac.id, 'darwin')
    assert.equal(mac.quitWhenAllWindowsClosed, false)
    assert.equal(mac.reopenOnActivate, true)
  })

  it('every other platform (Linux until U6) quits the shell with its last window, and the service is unaffected', () => {
    for (const other of ['linux', 'win32', 'freebsd'] as const) {
      const adapter = platformFor(other)
      assert.equal(adapter.id, 'generic')
      assert.equal(adapter.quitWhenAllWindowsClosed, true)
      assert.equal(adapter.reopenOnActivate, false)
    }
  })

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} menu has Reconnect and Stop-service actions wired to the shell, and developer tools only when unpackaged`, () => {
      const adapter = platformFor(platform)
      const items = flatten(adapter.menuTemplate(context(false)) as Item[])
      const reconnect = items.find((item) => item.label === catalogues.en['menu.reconnect'])
      const stop = items.find((item) => item.label === catalogues.en['menu.stopService'])
      assert.equal(reconnect?.accelerator, 'CmdOrCtrl+R')
      calls.length = 0
      reconnect?.click?.()
      stop?.click?.()
      assert.deepEqual(calls, ['reconnect', 'stop'])
      assert.equal(items.some((item) => item.role === 'toggleDevTools'), false)
      assert.equal(flatten(adapter.menuTemplate(context(true)) as Item[]).some((item) => item.role === 'toggleDevTools'), true)
    })
  }
})

describe('auto-update stub', () => {
  it('is disabled and says why; it has no network side', async () => {
    assert.deepEqual(updateStatus(), { state: 'disabled', reason: 'not_implemented' })
    assert.deepEqual(await checkForUpdates(), { state: 'disabled', reason: 'not_implemented' })
  })
})
