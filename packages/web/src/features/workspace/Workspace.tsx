import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PortalContainerProvider, UiLocaleProvider, WorkspaceChrome } from '@guanxi/ui'
import { WORKSPACE_BLOCK_SLOT, type BlockContribution } from '@guanxi/kernel'
import { layoutClock, layoutScopeKey, resolveLayout, layoutDocumentSchema, type ExperienceMode, type LayoutDocument, type LayoutGeometry, type LayoutList, type LayoutQuery, type WorkspaceZone } from '@guanxi/contract'
import { webKernel, webKernelReady } from '../../kernel/runtime.ts'
import { api } from '../../lib/api.ts'
import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { useTheme } from '../../lib/theme.tsx'
import { builtInLayout } from './defaults.ts'
import { paneRegistry } from './renderers.ts'
import { blockNames, type BuiltInBlock } from './blocks.ts'
import { WorkspaceLayout, type WorkspaceLayoutHandle } from './WorkspaceLayout/index.tsx'
import './workspace.css'

const zoneOrder: WorkspaceZone[] = ['left', 'right', 'top', 'bottom', 'center', 'floating', 'popout']
function deviceId(): string {
  const key = `${PRODUCT_FILE_PREFIX}.layout-device`
  try {
    const previous = localStorage.getItem(key)
    if (previous && /^[\w-]+$/.test(previous)) return previous
    const next = crypto.randomUUID()
    localStorage.setItem(key, next)
    return next
  } catch { return crypto.randomUUID() }
}
function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 639px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)')
    const update = () => setPhone(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}
export interface WorkspaceProps {
  children: ReactNode
  account?: string
  project?: string
  safeMode?: boolean
}

/** Node-owned documents; browser memory owns pane lifetimes, never credentials or processes. */
export function Workspace({ children, account = 'local', project, safeMode = false }: WorkspaceProps) {
  const { locale } = useLocale()
  const { resolved: theme } = useTheme()
  const phone = usePhone()
  const [device] = useState(deviceId)
  const [deviceClass] = useState<LayoutQuery['deviceClass']>(() => phone ? 'phone' : 'desktop')
  const [mode, setMode] = useState<ExperienceMode>('developer')
  const [documents, setDocuments] = useState<Partial<Record<ExperienceMode, LayoutDocument>>>({})
  const [list, setList] = useState<LayoutList>({ documents: [], active: [] })
  const [geometry, setGeometry] = useState<LayoutGeometry>({})
  const [generation, setGeneration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [name, setName] = useState('')
  const [selected, setSelected] = useState('guanxi.core/chat')
  const [moving, setMoving] = useState<string | null>(null)
  const [destination, setDestination] = useState<WorkspaceZone>('right')
  const engine = useRef<WorkspaceLayoutHandle | null>(null)
  const restoreTime = useRef(0)
  const paneHosts = useRef(new Map<string, HTMLDivElement>())
  const latestDocument = useRef<LayoutDocument | undefined>(undefined)
  const phoneSnapshot = useRef<ReturnType<WorkspaceLayoutHandle['snapshot']> | undefined>(undefined)
  useSyncExternalStore(paneRegistry.subscribe, paneRegistry.snapshot)
  const contributions = useSyncExternalStore(
    useCallback(callback => webKernel.slots.subscribe(callback), []),
    useCallback(() => webKernel.slots.list<BlockContribution>(WORKSPACE_BLOCK_SLOT), []),
  )
  const query = useCallback((nextMode: ExperienceMode): LayoutQuery => ({ account, ...(project ? { project } : {}), device, deviceClass, mode: nextMode }), [account, project, device, deviceClass])
  const doc = documents[mode]
  latestDocument.current = doc
  const contributionFor = (id: string) => contributions.find(entry => entry.key === doc?.blocks[id]?.contribution && entry.value.id === entry.key)?.value
  const title = (id: string) => {
    const contribution = contributionFor(id)
    return contribution ? translate(contribution.title as LocaleKey) : id
  }
  const announceMove = (id: string, zone: WorkspaceZone) => setAnnouncement(translate('workspace.moved', { block: title(id), zone: translate(`workspace.zone.${zone}`) }))

  const load = useCallback(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(false)
    void webKernelReady.then(async () => {
      const lists = await Promise.all((['developer', 'visual'] as const).map(next => api.layouts(query(next), controller.signal)))
      const nextDocuments: Partial<Record<ExperienceMode, LayoutDocument>> = {}
      for (let i = 0; i < 2; i++) {
        const nextMode = i === 0 ? 'developer' : 'visual'
        nextDocuments[nextMode] = resolveLayout(lists[i]!, query(nextMode), builtInLayout(query(nextMode)))
      }
      const current = nextDocuments[mode]!
      const local = await api.layoutGeometry(account, device, current.id, controller.signal)
      if (controller.signal.aborted) return
      setList({ documents: lists.flatMap(row => row.documents), active: lists.flatMap(row => row.active) })
      setDocuments(nextDocuments)
      setGeometry(local.geometry)
      setName(current.name)
      setGeneration(value => value + 1)
      setLoading(false)
    }).catch(() => { if (!controller.signal.aborted) { setLoadError(true); setLoading(false) } })
    return () => controller.abort()
    // Initial hydration and explicit retry only; mode changes use the loaded documents.
  }, [query, account, device])
  useEffect(load, [load])

  function snapshot(): LayoutDocument {
    const current = latestDocument.current!
    const state = engine.current?.snapshot() ?? phoneSnapshot.current
    return layoutDocumentSchema.parse({ ...current, ...(state ? { engineState: state.engineState, hidden: state.hidden } : {}) })
  }
  function capture() {
    if (!engine.current || !latestDocument.current) return
    const state = engine.current.snapshot()
    phoneSnapshot.current = state
    const next = { ...latestDocument.current, engineState: state.engineState, hidden: state.hidden }
    latestDocument.current = next
    setDocuments(previous => ({ ...previous, [next.scope.mode]: next }))
    setGeometry(state.geometry)
  }
  function remember() {
    if (!latestDocument.current) return
    const next = snapshot()
    if (engine.current) {
      const state = engine.current.snapshot()
      phoneSnapshot.current = state
      setGeometry(state.geometry)
    }
    setDocuments(previous => ({ ...previous, [next.scope.mode]: next }))
    return next
  }
  async function save(asNew = false) {
    if (!doc || saving) return
    setSaving(true)
    setSaveError(false)
    const current = snapshot()
    const local = engine.current?.snapshot().geometry ?? geometry
    const updated: LayoutDocument = { ...current, id: asNew ? crypto.randomUUID() : current.id, name: name.trim() || current.name, rev: current.rev + 1, updatedAt: new Date().toISOString(), updatedBy: { device } }
    try {
      const result = await api.saveLayout(updated, true, asNew ? undefined : layoutClock(current))
      await api.saveLayoutGeometry(account, device, result.document.id, local)
      setList(previous => ({ documents: [...previous.documents.filter(row => !(row.id === updated.id && row.scope.mode === updated.scope.mode)), result.document, ...result.recovered], active: [...previous.active.filter(row => row.scope.mode !== updated.scope.mode), { scope: result.document.scope, layoutId: result.document.id }] }))
      setDocuments(previous => ({ ...previous, [updated.scope.mode]: result.document }))
      setAnnouncement(translate(result.recovered.length ? 'workspace.recovered' : 'workspace.saved'))
    } catch { setSaveError(true) }
    finally { setSaving(false) }
  }
  async function switchMode(next: ExperienceMode) {
    if (next === mode) return
    remember()
    setMode(next)
    phoneSnapshot.current = undefined
    setName(documents[next]?.name ?? next)
    setSelected('guanxi.core/chat')
    const nextDoc = documents[next]
    setGeometry({})
    setGeneration(value => value + 1)
    if (nextDoc) {
      try { const local = await api.layoutGeometry(account, device, nextDoc.id); setGeometry(local.geometry) } catch { setSaveError(true) }
    }
  }
  function openMove(id?: string) {
    const next = id ?? engine.current?.activeBlock() ?? selected
    if (doc?.blocks[next]) setMoving(next)
  }
  async function move() {
    if (!moving) return
    const id = moving
    setMoving(null)
    const success = await engine.current?.move(id, destination)
    if (success === false) setAnnouncement(translate('workspace.popoutFailed'))
    remember()
  }
  function hide(id: string) {
    if (phone && doc) {
      const groups = doc.engineState.groups.map(group => ({ ...group, blocks: group.blocks.filter(block => block !== id), active: group.active === id ? group.blocks.find(block => block !== id) : group.active })).filter(group => group.blocks.length)
      const next = layoutDocumentSchema.parse({ ...doc, hidden: [...new Set([...doc.hidden, id])], engineState: { ...doc.engineState, grid: undefined, groups } })
      phoneSnapshot.current = undefined
      setDocuments(previous => ({ ...previous, [mode]: next }))
    }
    engine.current?.hide(id)
    if (!phone) remember()
    setAnnouncement(translate('workspace.hiddenAnnouncement', { block: title(id) }))
  }
  function addBlock(contributionId: string) {
    const contribution = contributions.find(entry => entry.key === contributionId)?.value
    if (!contribution) return
    const existing = Object.keys(doc!.blocks).find(id => doc!.blocks[id]!.contribution === contributionId)
    if (existing && !contribution.multiInstance) {
      if (doc!.hidden.includes(existing)) show(existing)
      else { engine.current?.focus(existing); setSelected(existing) }
      return
    }
    remember()
    const current = latestDocument.current!
    const id = contribution.multiInstance ? `${contributionId}/${crypto.randomUUID()}` : contributionId
    const next = layoutDocumentSchema.parse({ ...current, blocks: { ...current.blocks, [id]: { contribution: contributionId, pluginVersion: '0.1.0', priority: Object.keys(current.blocks).length, params: {} } }, engineState: { ...current.engineState, grid: undefined, groups: [...current.engineState.groups, { id: `added-${crypto.randomUUID()}`, zone: contribution.defaultZone, blocks: [id], active: id }] } })
    phoneSnapshot.current = undefined
    setDocuments(previous => ({ ...previous, [mode]: next }))
    setGeneration(value => value + 1)
    setSelected(id)
    setAnnouncement(translate('workspace.added', { block: translate(contribution.title as LocaleKey) }))
  }
  function show(id: string) {
    engine.current?.show(id, contributionFor(id)?.defaultZone ?? 'center')
    if (phone && doc) {
      const next = { ...doc, hidden: doc.hidden.filter(block => block !== id), engineState: { ...doc.engineState, grid: undefined, groups: [...doc.engineState.groups, { id: `phone-${crypto.randomUUID()}`, zone: 'center' as const, blocks: [id], active: id }] } }
      setDocuments(previous => ({ ...previous, [mode]: layoutDocumentSchema.parse(next) }))
      setSelected(id)
    } else remember()
    setAnnouncement(translate('workspace.added', { block: title(id) }))
  }

  useEffect(() => {
    if (!import.meta.env.DEV) return
    Object.assign(window, { __GUANXI_WORKSPACE__: {
      snapshot: () => snapshot(), diagnostics: () => engine.current?.diagnostics(), restoreMs: () => restoreTime.current,
      // Development inspection only; browser assertions exercise user movement through UI.
    } })
    return () => { Reflect.deleteProperty(window, '__GUANXI_WORKSPACE__') }
  })

  if (loading) return <WorkspaceChrome kind="state" title={translate('workspace.loading')} />
  if (loadError || !doc) return <WorkspaceChrome kind="state" title={translate('workspace.error')} error action={{ label: translate('workspace.retry'), onClick: load }} />
  for (const id of Object.keys(doc.blocks)) if (!paneHosts.current.has(id)) { const host = document.createElement('div'); host.className = 'workspace-retained-pane'; paneHosts.current.set(id, host) }
  for (const host of paneHosts.current.values()) { host.dataset.theme = theme; host.dataset.density = doc.density; host.lang = locale }
  const visible = Object.keys(doc.blocks).filter(id => !doc.hidden.includes(id)).sort((a, b) => doc.blocks[a]!.priority - doc.blocks[b]!.priority || a.localeCompare(b))
  const selectedId = visible.includes(selected) ? selected : visible[0] ?? ''
  const choices = Object.keys(doc.blocks).map(id => ({ id, label: title(id) }))
  const renderPane = (id: string) => {
    const contribution = contributionFor(id)
    const builtIn = contribution?.id.startsWith('guanxi.core/') && 'component' in contribution.pane && contribution.pane.component.startsWith('core.')
    const name = contribution?.id.split('/')[1] as BuiltInBlock | undefined
    const Renderer = contribution && 'component' in contribution.pane ? paneRegistry.get(contribution.pane.component) : undefined
    const unavailable = !contribution || !contribution.modes.includes(mode) || (safeMode && !builtIn) || (!builtIn && !Renderer)
    if (unavailable) return <WorkspaceChrome kind="pane" id={id} title={title(id)} moveLabel={translate('workspace.move')} hideLabel={translate('workspace.hide')} onMove={() => openMove(id)} onHide={() => hide(id)} description={translate(safeMode ? 'workspace.safePlaceholder' : 'workspace.placeholder')} />
    if (Renderer && !builtIn) return <WorkspaceChrome kind="pane" id={id} title={title(id)} moveLabel={translate('workspace.move')} hideLabel={translate('workspace.hide')} onMove={() => openMove(id)} onHide={() => hide(id)}><Renderer instanceId={id} params={doc.blocks[id]!.params} /></WorkspaceChrome>
    return <BuiltInPane id={id} name={name!} title={title(id)} onMove={() => openMove(id)} onHide={() => hide(id)}>{name === 'chat' ? <><aside className="workspace-dock-lanes" aria-label={translate('workspace.dockLanes')}>{translate('workspace.lanesEmpty')}</aside>{children}</> : null}</BuiltInPane>
  }
  return <UiLocaleProvider locale={locale}><div className="workspace" data-theme={theme} data-density={doc.density} data-mode={mode} onKeyDown={event => {
    if (event.key === 'F6') { event.preventDefault(); engine.current?.cycleZone(event.shiftKey) }
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'm' && !phone) { event.preventDefault(); openMove() }
  }}>
    <WorkspaceChrome kind="toolbar" label={translate('workspace.title')} fields={[
      { label: translate('workspace.mode'), value: mode, choices: (['developer', 'visual'] as const).map(id => ({ id, label: translate(`workspace.${id}`) })), onChange: next => { void switchMode(next as ExperienceMode) } },
      { label: translate('workspace.density'), value: doc.density, choices: (['compact', 'comfortable'] as const).map(id => ({ id, label: translate(`workspace.${id}`) })), onChange: next => setDocuments(previous => ({ ...previous, [mode]: { ...doc, density: next as LayoutDocument['density'] } })) },
      { label: translate('workspace.layout'), value: `${layoutScopeKey(doc.scope)}#${doc.id}`, choices: list.documents.filter(row => row.scope.mode === mode).map(row => ({ id: `${layoutScopeKey(row.scope)}#${row.id}`, label: row.name === 'Recovered layout' ? translate('workspace.recoveredName') : row.name })), onChange: id => {
        const next = list.documents.find(row => `${layoutScopeKey(row.scope)}#${row.id}` === id && row.scope.mode === mode)
        if (next) { setDocuments(previous => ({ ...previous, [mode]: next })); setName(next.name); phoneSnapshot.current = undefined; setGeneration(value => value + 1) }
      } },
      { label: translate('workspace.add'), value: '', choices: contributions.filter(entry => entry.value.modes.includes(mode) && (!safeMode || entry.pluginId === 'guanxi.core')).map(entry => ({ id: entry.key, label: translate(entry.value.title as LocaleKey) })), onChange: addBlock },
      { label: translate('workspace.hidden'), value: '', choices: doc.hidden.map(id => ({ id, label: title(id) })), onChange: show },
    ]} name={{ label: translate('workspace.layout'), value: name, onChange: setName }} actions={[
      { label: translate('workspace.save'), onClick: () => { void save() }, disabled: saving },
      { label: translate('workspace.saveAs'), onClick: () => { void save(true) }, disabled: saving },
      { label: translate('workspace.move'), onClick: () => openMove(), disabled: phone },
      { label: translate('workspace.reset'), onClick: () => { const next = builtInLayout(query(mode)); setDocuments(previous => ({ ...previous, [mode]: next })); phoneSnapshot.current = undefined; setGeneration(value => value + 1) } },
    ]} />
    {saveError && <WorkspaceChrome kind="state" title={translate('workspace.saveError')} error action={{ label: translate('workspace.retry'), onClick: () => { void save() } }} />}
    <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="workspace-announcement">{announcement}</p>
    {doc.engineState.groups.some(group => group.zone === 'popout') && <p>{translate('workspace.popoutRestore')}</p>}
    <div className="workspace-content">
      {phone ? <><WorkspaceChrome kind="phone" label={translate('workspace.phone')} selected={selectedId} blocks={visible.map(id => ({ id, label: title(id) }))} onSelect={setSelected} />{visible.map(id => <div key={id} id={`phone-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={id !== selectedId} ref={element => { if (element) element.append(paneHosts.current.get(id)!) }} />)}</> : <WorkspaceLayout key={`${mode}:${generation}`} document={doc} geometry={geometry} hosts={paneHosts.current} title={title} handleRef={engine} onChange={capture} onMove={announceMove} onReady={elapsed => { restoreTime.current = elapsed }} />}
    </div>
    <PortalContainerProvider container={moving ? paneHosts.current.get(moving)?.ownerDocument.body ?? null : null}><WorkspaceChrome kind="mover" open={moving !== null} title={translate('workspace.moveTitle')} description={translate('workspace.move')} blockLabel={translate('workspace.block')} zoneLabel={translate('workspace.destination')} cancelLabel={translate('workspace.cancel')} moveLabel={translate('workspace.move')} blocks={choices.filter(choice => visible.includes(choice.id))} zones={zoneOrder.map(id => ({ id, label: translate(`workspace.zone.${id}`) }))} block={moving ?? ''} zone={destination} onBlock={setMoving} onZone={id => setDestination(id as WorkspaceZone)} onClose={() => setMoving(null)} onMove={() => { void move() }} /></PortalContainerProvider>
    {Object.keys(doc.blocks).map(id => createPortal(<PortalContainerProvider container={paneHosts.current.get(id)!}>{renderPane(id)}</PortalContainerProvider>, paneHosts.current.get(id)!, id))}
  </div></UiLocaleProvider>
}

function BuiltInPane({ id, name, title, onMove, onHide, children }: { id: string; name: BuiltInBlock; title: string; onMove: () => void; onHide: () => void; children?: ReactNode }) {
  const [draft, setDraft] = useState('')
  const hasDraft = name === 'terminal' || name === 'browser'
  const known = blockNames.includes(name)
  return <WorkspaceChrome kind="pane" id={id} title={title} moveLabel={translate('workspace.move')} hideLabel={translate('workspace.hide')} onMove={onMove} onHide={onHide} description={name !== 'chat' && known ? translate(`workspace.empty.${name}`) : undefined} draft={hasDraft ? { label: translate(name === 'terminal' ? 'workspace.draft' : 'workspace.preview'), value: draft, onChange: setDraft } : undefined}>{children}</WorkspaceChrome>
}
