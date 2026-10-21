/** The only Dockview boundary. Public APIs expose Guanxi documents and pane hosts. */
import { useEffect, useMemo, useRef, type Ref } from 'react'
import { DockviewReact, type IDockviewPanelProps } from 'dockview-react'
import { Orientation, type DockviewApi, type DockviewGroupPanel, type SerializedDockview } from 'dockview-core'
import { layoutDocumentSchema, type LayoutDocument, type LayoutGeometry, type LayoutTree, type WorkspaceZone } from '@guanxi/contract'
import 'dockview-core/dist/styles/dockview.css'
import './workspace-layout.css'

export interface WorkspaceLayoutHandle {
  move: (id: string, zone: WorkspaceZone) => Promise<boolean>
  hide: (id: string) => void
  show: (id: string, zone: WorkspaceZone) => void
  snapshot: () => { engineState: LayoutDocument['engineState']; hidden: string[]; geometry: LayoutGeometry }
  focus: (id: string) => void
  cycleZone: (backward: boolean) => void
  activeBlock: () => string | undefined
  diagnostics: () => { groups: { id: string; zone: WorkspaceZone; locked: boolean }[]; blocks: number }
}
export interface WorkspaceLayoutProps {
  document: LayoutDocument
  geometry: LayoutGeometry
  hosts: ReadonlyMap<string, HTMLElement>
  title: (id: string) => string
  handleRef: Ref<WorkspaceLayoutHandle>
  onChange: () => void
  onMove: (id: string, zone: WorkspaceZone) => void
  onReady?: (elapsed: number) => void
}
function toTree(node: SerializedDockview['grid']['root']): LayoutTree {
  return node.type === 'leaf' ? { group: (node.data as { id: string }).id, size: node.size ?? 1 } : { children: (node.data as SerializedDockview['grid']['root'][]).map(toTree), size: node.size ?? 1 }
}
function fromTree(tree: LayoutTree, doc: LayoutDocument): SerializedDockview['grid']['root'] {
  if ('children' in tree) return { type: 'branch', data: tree.children.map(child => fromTree(child, doc)), size: tree.size }
  const group = doc.engineState.groups.find(g => g.id === tree.group)!
  return { type: 'leaf', data: { id: group.id, views: group.blocks, activeView: group.active, locked: group.zone !== 'center' }, size: tree.size }
}
function assignRef<T>(ref: Ref<T>, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

export function WorkspaceLayout(props: WorkspaceLayoutProps) {
  const latest = useRef(props)
  latest.current = props
  const apiRef = useRef<DockviewApi | null>(null)
  const subscriptions = useRef<{ dispose: () => void }[]>([])
  const zones = useRef(new Map<string, WorkspaceZone>())
  const muted = useRef(false)
  const components = useMemo(() => ({ host: function PaneHost({ api }: IDockviewPanelProps) {
    return <div className="workspace-pane-host" ref={element => {
      const host = latest.current.hosts.get(api.id)
      if (element && host) element.append(host)
    }} />
  } }), [])

  useEffect(() => () => {
    subscriptions.current.forEach(item => item.dispose())
    assignRef(latest.current.handleRef, null)
  }, [])

  function ready(api: DockviewApi) {
    const start = performance.now()
    apiRef.current = api
    const doc = layoutDocumentSchema.parse(latest.current.document)
    const groupZones = zones.current
    doc.engineState.groups.forEach(g => groupZones.set(g.id, g.zone))
    const zoneOf = (group: DockviewGroupPanel): WorkspaceZone => {
      const type = group.api.location.type
      return type === 'floating' || type === 'popout' ? type : groupZones.get(group.id) ?? 'center'
    }
    const ensureGroup = (zone: WorkspaceZone): DockviewGroupPanel => {
      const existing = api.groups.find(g => zoneOf(g) === zone && g.api.location.type === 'grid')
      if (existing) return existing
      const direction = zone === 'left' ? 'left' : zone === 'right' ? 'right' : zone === 'top' ? 'above' : zone === 'bottom' ? 'below' : 'right'
      const group = api.addGroup({ direction, locked: zone !== 'center' && zone !== 'floating' && zone !== 'popout' })
      groupZones.set(group.id, zone)
      return group
    }
    const add = (id: string, group: DockviewGroupPanel) => api.addPanel({ id, component: 'host', title: latest.current.title(id), renderer: 'always', position: { referenceGroup: group, direction: 'within' } })
    const dockGroups = doc.engineState.groups.filter(g => g.zone !== 'floating' && g.zone !== 'popout')
    if (doc.engineState.grid) {
      const grid = doc.engineState.grid
      api.fromJSON({ grid: { ...grid, root: fromTree(grid.root, doc), orientation: grid.orientation === 'HORIZONTAL' ? Orientation.HORIZONTAL : Orientation.VERTICAL }, panels: Object.fromEntries(dockGroups.flatMap(group => group.blocks.map(id => [id, { id, contentComponent: 'host', title: latest.current.title(id), renderer: 'always' }])) ) })
    } else {
      for (const group of dockGroups) {
        const target = ensureGroup(group.zone)
        for (const id of group.blocks) add(id, target)
        if (group.active) api.getPanel(group.active)?.api.setActive()
      }
    }
    for (const saved of doc.engineState.groups.filter(g => g.zone === 'floating' || g.zone === 'popout')) {
      // Browsers require a user gesture to open windows: restored popouts stay docked
      // until explicitly reopened. Never launch windows from untrusted layout JSON.
      const group = api.addGroup({ direction: 'right' })
      groupZones.set(group.id, saved.zone === 'popout' ? 'center' : 'floating')
      saved.blocks.forEach(id => add(id, group))
      if (saved.zone === 'floating') {
        const box = latest.current.geometry[saved.id]
        api.addFloatingGroup(group, box ? { x: box.left, y: box.top, width: box.width, height: box.height } : {})
      }
    }
    const snapshot: WorkspaceLayoutHandle['snapshot'] = () => {
      const raw = api.toJSON()
      const groups = api.groups.filter(group => group.panels.length).map(group => ({ id: group.id, zone: zoneOf(group), blocks: group.panels.map(panel => panel.id), active: group.activePanel?.id }))
      const geometry: LayoutGeometry = {}
      for (const group of [...(raw.floatingGroups ?? []), ...(raw.popoutGroups ?? [])]) {
        const box = group.position
        if (group.data && box && 'left' in box && 'top' in box && typeof box.left === 'number' && typeof box.top === 'number') geometry[group.data.id] = { left: box.left, top: box.top, width: box.width, height: box.height }
      }
      const visible = new Set(groups.flatMap(group => group.blocks))
      return {
        engineState: { engine: 'dockview', major: 8, groups, ...(raw.grid.root && groups.some(g => !['floating', 'popout'].includes(g.zone)) ? { grid: { ...raw.grid, root: toTree(raw.grid.root) } } : {}) },
        hidden: Object.keys(latest.current.document.blocks).filter(id => !visible.has(id)), geometry,
      }
    }
    const handle: WorkspaceLayoutHandle = {
      async move(id, zone) {
        const panel = api.getPanel(id)
        if (!panel) return false
        muted.current = true
        let success = true
        try {
          if (zone === 'floating') api.addFloatingGroup(panel)
          else if (zone === 'popout') success = await api.addPopoutGroup(panel, { popoutUrl: new URL('/workspace-popout.html', window.location.origin).href })
          else panel.api.moveTo({ group: ensureGroup(zone), position: 'center' })
        } finally { muted.current = false }
        if (success) {
          latest.current.onMove(id, zone)
          latest.current.onChange()
          panel.api.setActive()
          requestAnimationFrame(() => latest.current.hosts.get(id)?.querySelector<HTMLElement>('[data-block]')?.focus())
        }
        return success
      },
      hide(id) { api.getPanel(id)?.api.close(); latest.current.onChange() },
      show(id, zone) { if (!api.getPanel(id)) add(id, ensureGroup(zone)); latest.current.onChange() },
      snapshot,
      focus(id) { api.getPanel(id)?.api.setActive(); latest.current.hosts.get(id)?.querySelector<HTMLElement>('[data-block]')?.focus() },
      activeBlock: () => api.activePanel?.id,
      cycleZone(backward) {
        const ordered: WorkspaceZone[] = ['left', 'top', 'center', 'right', 'bottom', 'floating', 'popout']
        const active = api.activePanel ? zoneOf(api.activePanel.group) : undefined
        const available = ordered.filter(zone => api.groups.some(g => zoneOf(g) === zone && g.panels.length))
        const index = active ? available.indexOf(active) : -1
        const next = available[(index + (backward ? -1 : 1) + available.length) % available.length]
        const group = api.groups.find(g => zoneOf(g) === next)
        if (group?.activePanel) handle.focus(group.activePanel.id)
      },
      diagnostics: () => ({ groups: api.groups.map(g => ({ id: g.id, zone: zoneOf(g), locked: g.api.locked === true })), blocks: api.panels.length }),
    }
    assignRef(latest.current.handleRef, handle)
    subscriptions.current.push(api.onDidMovePanel(event => {
      if (!groupZones.has(event.to.id)) groupZones.set(event.to.id, groupZones.get(event.from.id) ?? 'center')
      const zone = zoneOf(event.to)
      event.to.api.locked = zone !== 'center' && zone !== 'floating' && zone !== 'popout'
      if (!muted.current) latest.current.onMove(event.panel.id, zone)
    }), api.onDidLayoutChange(() => { if (!muted.current) latest.current.onChange() }))
    latest.current.onReady?.(performance.now() - start)
  }
  return <div className="workspace-layout"><DockviewReact components={components} theme={{ name: 'guanxi', className: 'gx-dockview' }} onReady={event => ready(event.api)} popoutUrl="/workspace-popout.html" /></div>
}
