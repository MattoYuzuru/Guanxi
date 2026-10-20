/**
 * K1: the chat sidebar's list slot shows a plugin contribution, updates it in
 * place when the plugin is hot-replaced, and removes it when the plugin unloads.
 * The replace path is the one the Vite HMR accept handler calls.
 */
import { act, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { contribute, definePlugin } from '@guanxi/kernel'
import { SidebarSlot } from '../../src/kernel/SidebarSlot.tsx'
import {
  replaceWebPlugin,
  unloadWebPlugin,
  webKernel,
  webKernelReady,
} from '../../src/kernel/runtime.ts'
import { plugin as projectsShortcut } from '../../src/kernel/plugins/projects-shortcut.ts'
import { SIDEBAR_SLOT, type SidebarEntry } from '../../src/kernel/slots.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const ID = projectsShortcut.manifest.id

function hotVersion(revision: string, href: string) {
  return definePlugin({
    manifest: projectsShortcut.manifest,
    apply(ctx) {
      contribute<SidebarEntry>(ctx, SIDEBAR_SLOT, {
        id: 'projects',
        value: { labelKey: 'projects.navigation', href, revision },
      })
    },
  })
}

function shortcuts() {
  return screen.queryByRole('navigation', { name: 'Ярлыки' })
}

describe('plugin sidebar slot', () => {
  it('appears, hot-updates in place, and disappears on unload', async () => {
    await webKernelReady
    render(<SidebarSlot />)

    const nav = shortcuts()
    expect(nav).not.toBeNull()
    const links = within(nav!).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0].textContent).toBe('Все проекты')
    expect(links[0].getAttribute('href')).toBe('/projects')
    const firstRevision = nav!.querySelector('li')!.getAttribute('data-plugin-revision')

    await act(() => replaceWebPlugin(hotVersion('hot-2', '/projects?hot=2')))
    const updated = within(shortcuts()!).getAllByRole('link')
    expect(updated).toHaveLength(1)
    expect(updated[0].textContent).toBe('Проекты')
    expect(updated[0].getAttribute('href')).toBe('/projects?hot=2')
    expect(shortcuts()!.querySelector('li')!.getAttribute('data-plugin-revision')).toBe('hot-2')
    expect(firstRevision).not.toBe('hot-2')
    expect(webKernel.counters().slotEntries).toBe(1)

    await act(() => unloadWebPlugin(ID))
    expect(shortcuts()).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(webKernel.counters().slotEntries).toBe(0)

    await act(() => replaceWebPlugin(projectsShortcut))
    expect(within(shortcuts()!).getAllByRole('link')).toHaveLength(1)
  })

  it('names the list and its entry through locale keys', async () => {
    await webKernelReady
    setActiveLocale('en')
    render(<SidebarSlot />)
    const nav = screen.getByRole('navigation', { name: 'Shortcuts' })
    expect(within(nav).getByRole('link', { name: 'All Projects' })).toBeTruthy()
  })
})
