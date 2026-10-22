import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  AppShellChrome,
  Button,
  type AppShellChromeProps,
  type AppShellSide,
  type AppShellVisibility,
} from '../src/index.ts'

const labels: AppShellChromeProps['labels'] = {
  show: 'Show sidebar',
  collapse: 'Collapse to rail',
  expand: 'Expand sidebar',
  hide: 'Hide sidebar',
  moveLeft: 'Move sidebar left',
  moveRight: 'Move sidebar right',
  palette: 'Command palette',
}

const workspace = 'Workspace navigation'

function StatefulChild({ name }: { name: string }) {
  const [count, setCount] = useState(0)
  return (
    <div>
      <Button onClick={() => setCount((value) => value + 1)}>{`Increment ${name}`}</Button>
      <span>{`${name} count ${count}`}</span>
    </div>
  )
}

function Harness({
  initialSide = 'left',
  initialVisibility = 'expanded',
  onSide = () => {},
  onVisibility = () => {},
  onOpenPalette = () => {},
}: {
  initialSide?: AppShellSide
  initialVisibility?: AppShellVisibility
  onSide?: (side: AppShellSide) => void
  onVisibility?: (visibility: AppShellVisibility) => void
  onOpenPalette?: () => void
}) {
  const [side, setSide] = useState<AppShellSide>(initialSide)
  const [visibility, setVisibility] = useState<AppShellVisibility>(initialVisibility)
  const props: AppShellChromeProps = {
    side,
    visibility,
    sidebar: <StatefulChild name="Sidebar" />,
    status: <span>Node connected</span>,
    sidebarLabel: workspace,
    labels,
    onSide: (next) => {
      onSide(next)
      setSide(next)
    },
    onVisibility: (next) => {
      onVisibility(next)
      setVisibility(next)
    },
    onOpenPalette,
    children: <StatefulChild name="Main" />,
  }
  return <AppShellChrome {...props} />
}

function sidebar() {
  const element = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar"]')
  if (!element) throw new Error('sidebar is not mounted')
  return element
}

async function choose(label: string) {
  const trigger = screen.getByRole('button', { name: workspace, hidden: true })
  fireEvent.click(trigger)
  const menu = await screen.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: label }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

describe('AppShellChrome', () => {
  it('keeps status, Show and Palette available while the sidebar is hidden', async () => {
    const onVisibility = vi.fn()
    const onOpenPalette = vi.fn()
    render(<Harness initialVisibility="hidden" onVisibility={onVisibility} onOpenPalette={onOpenPalette} />)

    const aside = sidebar()
    expect(aside.hidden).toBe(true)
    expect(aside.hasAttribute('inert')).toBe(true)
    expect(screen.getByText('Node connected')).toBeTruthy()

    const show = screen.getByRole('button', { name: labels.show })
    expect(show.getAttribute('aria-controls')).toBe(sidebar().id)
    fireEvent.click(show)
    expect(onVisibility).toHaveBeenCalledWith('expanded')
    await waitFor(() => expect(sidebar().hidden).toBe(false))
    expect(screen.getByRole('complementary', { name: workspace })).toBe(sidebar())
    expect(screen.queryByRole('button', { name: labels.show })).toBeNull()
    await waitFor(() => expect(sidebar().contains(document.activeElement)).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: labels.palette }))
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('reports exact move, collapse, expand and hide values from the sidebar menu', async () => {
    const onSide = vi.fn()
    const onVisibility = vi.fn()
    render(<Harness onSide={onSide} onVisibility={onVisibility} />)

    await choose(labels.moveRight)
    expect(onSide).toHaveBeenLastCalledWith('right')

    await choose(labels.collapse)
    expect(onVisibility).toHaveBeenLastCalledWith('rail')

    await choose(labels.expand)
    expect(onVisibility).toHaveBeenLastCalledWith('expanded')

    await choose(labels.moveLeft)
    expect(onSide).toHaveBeenLastCalledWith('left')

    await choose(labels.hide)
    expect(onVisibility).toHaveBeenLastCalledWith('hidden')
  })

  it('places sidebar and main in side-dependent DOM order without remounting them', async () => {
    render(<Harness />)
    expect(
      sidebar().compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    fireEvent.click(screen.getByRole('button', { name: 'Increment Sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increment Main' }))
    expect(screen.getByText('Sidebar count 1')).toBeTruthy()
    expect(screen.getByText('Main count 1')).toBeTruthy()

    await choose(labels.moveRight)
    expect(
      screen.getByRole('main').compareDocumentPosition(sidebar()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getByText('Sidebar count 1')).toBeTruthy()
    expect(screen.getByText('Main count 1')).toBeTruthy()
  })

  it('keeps sidebar and main children mounted through collapse and hiding', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Increment Sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increment Main' }))

    await choose(labels.collapse)
    expect(sidebar().getAttribute('data-visibility')).toBe('rail')
    expect(screen.getByText('Sidebar count 1')).toBeTruthy()
    expect(screen.getByText('Main count 1')).toBeTruthy()

    await choose(labels.hide)
    expect(sidebar().hidden).toBe(true)
    expect(within(sidebar()).getByText('Sidebar count 1')).toBeTruthy()
    expect(screen.getByText('Main count 1')).toBeTruthy()
  })

  it('returns focus to the persistent Show control after hiding the sidebar', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: workspace })
    trigger.focus()
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: labels.hide }))

    const show = await screen.findByRole('button', { name: labels.show })
    await waitFor(() => expect(document.activeElement).toBe(show))
    expect(sidebar().contains(document.activeElement)).toBe(false)
  })

  it('opens and activates the sidebar menu from the keyboard', async () => {
    const onSide = vi.fn()
    render(<Harness onSide={onSide} />)
    const trigger = screen.getByRole('button', { name: workspace })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu')
    const move = within(menu).getByRole('menuitem', { name: labels.moveRight })
    await waitFor(() => expect(document.activeElement).toBe(move))
    fireEvent.keyDown(move, { key: 'Enter' })
    await waitFor(() => expect(onSide).toHaveBeenCalledWith('right'))
  })
})
