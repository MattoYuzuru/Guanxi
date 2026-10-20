/**
 * K1: the chat sidebar's list slot shows a plugin contribution, updates it in
 * place when the plugin is hot-replaced, and removes it when the plugin unloads.
 * The replace path is the one the Vite HMR accept handler calls.
 */
import { act, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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

function quickLinks() {
  return screen.queryByRole('navigation', { name: 'Быстрые ссылки' })
}

afterEach(async () => {
  setActiveLocale('ru')
  await replaceWebPlugin(projectsShortcut)
})

describe('plugin sidebar slot', () => {
  it('appears, hot-updates in place keeping focus, and disappears on unload', async () => {
    await webKernelReady
    render(
      <>
        <SidebarSlot />
        <a href="/chat">next control</a>
      </>,
    )

    const nav = quickLinks()
    expect(nav).not.toBeNull()
    const links = within(nav!).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0].textContent).toBe('Все проекты')
    expect(links[0].getAttribute('href')).toBe('/projects')
    const firstRevision = nav!.querySelector('li')!.getAttribute('data-plugin-revision')
    links[0].focus()

    await act(() => replaceWebPlugin(hotVersion('hot-2', '/projects?hot=2')))
    const updated = within(quickLinks()!).getAllByRole('link')
    expect(updated).toHaveLength(1)
    expect(updated[0]).toBe(links[0])
    expect(document.activeElement).toBe(links[0])
    expect(updated[0].textContent).toBe('Проекты')
    expect(updated[0].getAttribute('href')).toBe('/projects?hot=2')
    expect(quickLinks()!.querySelector('li')!.getAttribute('data-plugin-revision')).toBe('hot-2')
    expect(firstRevision).not.toBe('hot-2')
    expect(webKernel.counters().slotEntries).toBe(1)

    await act(() => unloadWebPlugin(ID))
    expect(quickLinks()).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'next control' }))
    expect(webKernel.counters().slotEntries).toBe(0)

    await act(() => replaceWebPlugin(projectsShortcut))
    expect(within(quickLinks()!).getAllByRole('link')).toHaveLength(1)
  })

  it('names the list and its entry through English locale keys', async () => {
    await webKernelReady
    setActiveLocale('en')
    render(<SidebarSlot />)
    const nav = screen.getByRole('navigation', { name: 'Quick links' })
    expect(within(nav).getByRole('link', { name: 'All Projects' })).toBeTruthy()
    expect(within(nav).getByRole('list').getAttribute('role')).toBe('list')
  })
})
