import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PortalContainerProvider, UiLocaleProvider, WorkspaceChrome } from '@guanxi/ui'
import { WORKSPACE_BLOCK_SLOT, type BlockContribution } from '@guanxi/kernel'
import { WORKSPACE_ENGINE_MAJOR, compareLayouts, layoutClock, layoutScopeKey, resolveLayout, layoutDocumentSchema, type ExperienceMode, type LayoutClock, type LayoutDocument, type LayoutGeometry, type LayoutList, type LayoutQuery, type WorkspaceZone } from '@guanxi/contract'
import { webKernel, webKernelReady } from '../../kernel/runtime.ts'
import { api } from '../../lib/api.ts'
import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { useTheme } from '../../lib/theme.tsx'
import { builtInLayout } from './defaults.ts'
import { MOVE_BLOCK_COMMAND, REVEAL_BLOCK_COMMAND } from './commands.ts'
import { useAutoRecover } from '../../lib/recover.ts'
import { clearWorkspaceShellState, publishWorkspaceShellState } from './shell-state.ts'
import { layoutSaveScope, layoutSaveScopes, layoutScopeForSave, type LayoutSaveScope } from './scopes.ts'
import { paneRegistry } from './renderers.ts'
import { blockNames, type BuiltInBlock } from './blocks.ts'
import { WorkspaceLayout, type WorkspaceLayoutHandle } from './WorkspaceLayout/index.tsx'
import { workspaceFailure, workspaceStep, type WorkspaceFailure } from './failure.ts'
import { WorkspaceControlsContext, type WorkspaceLayoutControls } from './controls.ts'
import { useSessionContext } from '../session/session-context.ts'
import { ContextPanel } from '../context/ContextPanel.tsx'
import { SessionPanelsMenu } from '../session/SessionPanelsMenu.tsx'
import './workspace.css'

const WORKSPACE_RECOVERY = { baseMs: 10_000, maxMs: 60_000 } as const

type SaveAttempt = { document: LayoutDocument; geometry: LayoutGeometry; basedOn?: LayoutClock; result?: Awaited<ReturnType<typeof api.saveLayout>>; applied?: boolean }
type ActivationAttempt = { remembered?: boolean; response?: Awaited<ReturnType<typeof api.saveLayout>>; next?: LayoutDocument; applied?: boolean }

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
/**
 * One interface (D-204): the workspace has one experience mode. Layouts stay stored under the
 * `developer` scope so documents saved before D-204 keep resolving; no view ever switches it.
 */
export const WORKSPACE_MODE: ExperienceMode = 'developer'

export function Workspace({ children, account, project, safeMode = false }: WorkspaceProps) {
  const { locale, setLocale } = useLocale()
  const { resolved: theme } = useTheme()
  const [menuHosts, setMenuHosts] = useState(0)
  const registerMenu = useCallback(() => { setMenuHosts(count => count + 1); return () => setMenuHosts(count => count - 1) }, [])
  const phone = usePhone()
  const [device] = useState(deviceId)
  const [nodeAccount, setNodeAccount] = useState(account ?? 'local')
  const [deviceClass] = useState<LayoutQuery['deviceClass']>(() => phone ? 'phone' : 'desktop')
  const mode = WORKSPACE_MODE
  const [documents, setDocuments] = useState<Partial<Record<ExperienceMode, LayoutDocument>>>({})
  const [list, setList] = useState<LayoutList>({ documents: [], active: [] })
  const [geometry, setGeometry] = useState<LayoutGeometry>({})
  const [generation, setGeneration] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<WorkspaceFailure | null>(null)
  const [saveError, setSaveError] = useState<WorkspaceFailure | null>(null)
  const [saving, setSaving] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [announcementRevision, setAnnouncementRevision] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const [name, setName] = useState('')
  const [saveScopes, setSaveScopes] = useState<Partial<Record<ExperienceMode, LayoutSaveScope>>>({})
  const [shellWriter] = useState(() => Symbol('workspace-shell'))
  const [selected, setSelected] = useState('guanxi.core/chat')
  const [moving, setMoving] = useState<string | null>(null)
  const [destination, setDestination] = useState<WorkspaceZone>('right')
  const engine = useRef<WorkspaceLayoutHandle | null>(null)
  const restoreTime = useRef(0)
  const selectionEpoch = useRef(0)
  const operationBusy = useRef(false)
  const loadController = useRef<AbortController | null>(null)
  const geometryCache = useRef(new Map<string, LayoutGeometry>())
  const retryOperation = useRef<() => void>(() => undefined)
  const returnFocus = useRef<HTMLElement | null>(null)
  const paneHosts = useRef(new Map<string, HTMLDivElement>())
  const pendingPaneFocus = useRef<{ id: string; epoch: number } | null>(null)
  const focusEpoch = useRef(0)
  const latestDocument = useRef<LayoutDocument | undefined>(undefined)
  const phoneSnapshot = useRef<ReturnType<WorkspaceLayoutHandle['snapshot']> | undefined>(undefined)
  useSyncExternalStore(paneRegistry.subscribe, paneRegistry.snapshot)
  const contributions = useSyncExternalStore(
    useCallback(callback => webKernel.slots.subscribe(callback), []),
    useCallback(() => webKernel.slots.list<BlockContribution>(WORKSPACE_BLOCK_SLOT), []),
  )
  const query = useCallback((nextMode: ExperienceMode): LayoutQuery => ({ account: account ?? nodeAccount, ...(project ? { project } : {}), device, deviceClass, mode: nextMode }), [account, nodeAccount, project, device, deviceClass])
  const doc = documents[mode]
  latestDocument.current = doc
  const contributionFor = (id: string) => contributions.find(entry => entry.key === doc?.blocks[id]?.contribution && entry.value.id === entry.key)?.value
  const title = (id: string) => {
    const contribution = contributionFor(id)
    return contribution ? translate(contribution.title as LocaleKey) : id
  }
  function say(message: string) { setAnnouncement(message); setAnnouncementRevision(value => value + 1) }
  const announceMove = (id: string, zone: WorkspaceZone) => say(translate('workspaceLayout.moved', { block: title(id), zone: translate(`workspaceLayout.zone.${zone}`) }))

  const load = useCallback(() => {
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    setLoading(true)
    void workspaceStep('kernel-ready', () => webKernelReady).then(async () => {
      if (controller.signal.aborted) return
      const ownedAccount = account ?? (await workspaceStep('layout-context', () => api.layoutContext(controller.signal))).account
      if (controller.signal.aborted) return
      const queryFor = (nextMode: ExperienceMode): LayoutQuery => ({ account: ownedAccount, ...(project ? { project } : {}), device, deviceClass, mode: nextMode })
      const layouts = await workspaceStep('load-layouts', () => api.layouts(queryFor(mode), controller.signal))
      const current = await workspaceStep('resolve-layout', () => resolveLayout(layouts, queryFor(mode), builtInLayout(queryFor(mode))))
      const nextDocuments: Partial<Record<ExperienceMode, LayoutDocument>> = { [mode]: current }
      const local = await workspaceStep('load-layout-geometry', () => api.layoutGeometry(current.scope, device, current.id, controller.signal))
      if (controller.signal.aborted) return
      setNodeAccount(ownedAccount)
      setList({ documents: layouts.documents.filter(row => row.scope.mode === mode), active: layouts.active.filter(row => row.scope.mode === mode) })
      setDocuments(nextDocuments)
      setSaveScopes({})
      geometryCache.current.set(`${layoutScopeKey(current.scope)}#${current.id}`, local.geometry)
      setGeometry(local.geometry)
      setName(current.name)
      setGeneration(value => value + 1)
      setLoadError(null)
      setLoading(false)
    }).catch(error => { if (!controller.signal.aborted) { setLoadError(workspaceFailure(error, 'load-workspace')); setLoading(false) } })
    return () => loadController.current?.abort()
    // Initial hydration and automatic recovery only (D-203).
  }, [account, project, device, deviceClass])
  useEffect(load, [load])
  // Layout reads fail mostly while the node restarts: the first automatic re-read waits 10 s so a
  // failure is readable (and copyable) before it is replaced; focus or reconnect re-reads at once.
  useAutoRecover(loadError, () => { load() }, WORKSPACE_RECOVERY)

  function snapshot(): LayoutDocument {
    const current = latestDocument.current!
    const state = engine.current?.snapshot() ?? phoneSnapshot.current
    return layoutDocumentSchema.parse({ ...current, ...(state ? { engineState: state.engineState, hidden: state.hidden } : {}) })
  }
  function capture() {
    if (!engine.current || !latestDocument.current) return
    const state = engine.current.snapshot()
    phoneSnapshot.current = state
    geometryCache.current.set(`${layoutScopeKey(latestDocument.current.scope)}#${latestDocument.current.id}`, state.geometry)
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
      geometryCache.current.set(`${layoutScopeKey(next.scope)}#${next.id}`, state.geometry)
      setGeometry(state.geometry)
    }
    setDocuments(previous => ({ ...previous, [next.scope.mode]: next }))
    return next
  }
  function compatible(candidate: LayoutDocument): LayoutDocument {
    return candidate.engineState.major === WORKSPACE_ENGINE_MAJOR && candidate.scope.mode === mode ? candidate : builtInLayout(query(mode))
  }
  async function activateDocument(candidate: LayoutDocument, persist = false, attempt: ActivationAttempt = {}) {
    if (operationBusy.current) return
    pendingPaneFocus.current = null
    focusEpoch.current++
    operationBusy.current = true
    const epoch = ++selectionEpoch.current
    setSwitching(true)
    if (!attempt.remembered) setSaveError(null)
    retryOperation.current = () => { void activateDocument(candidate, persist, attempt) }
    try {
      if (!attempt.remembered) {
        await workspaceStep('snapshot-layout', remember)
        attempt.remembered = true
      }
      if (persist && !attempt.response) attempt.response = await workspaceStep('activate-layout', () => api.saveLayout(candidate, true, layoutClock(candidate)))
      const response = attempt.response
      const next = attempt.next ?? await workspaceStep('resolve-layout', () => compatible(response?.document ?? candidate))
      attempt.next = next
      if (response && !attempt.applied) {
        const scopeKey = layoutScopeKey(response.document.scope)
        setList(previous => ({ documents: [...previous.documents.filter(row => !(row.id === response.document.id && layoutScopeKey(row.scope) === scopeKey)), response.document, ...response.recovered], active: [...previous.active.filter(row => layoutScopeKey(row.scope) !== scopeKey), { scope: response.document.scope, layoutId: response.document.id }] }))
        attempt.applied = true
      }
      const key = `${layoutScopeKey(next.scope)}#${next.id}`
      const local = geometryCache.current.get(key) ?? (await workspaceStep('activate-layout-geometry', () => api.layoutGeometry(next.scope, device, next.id))).geometry
      if (epoch !== selectionEpoch.current) return
      geometryCache.current.set(key, local)
      phoneSnapshot.current = undefined
      setGeometry(local)
      setDocuments(previous => ({ ...previous, [next.scope.mode]: next }))
      setSaveScopes(previous => ({ ...previous, [next.scope.mode]: layoutSaveScope(next.scope) }))
      setName(next.name)
      setSelected('guanxi.core/chat')
      setGeneration(value => value + 1)
      setSaveError(null)
    } catch (error) { if (epoch === selectionEpoch.current) setSaveError(workspaceFailure(error, 'save-workspace')) }
    finally { if (epoch === selectionEpoch.current) { operationBusy.current = false; setSwitching(false) } }
  }
  async function save(asNew = false, previousAttempt?: SaveAttempt, nameOverride?: string) {
    if (!doc || operationBusy.current) return
    operationBusy.current = true
    setSaving(true)
    if (!previousAttempt) setSaveError(null)
    retryOperation.current = () => { void save(asNew, previousAttempt, nameOverride) }
    try {
      const captured = previousAttempt ? undefined : await workspaceStep('snapshot-layout', () => ({ current: snapshot(), local: engine.current?.snapshot().geometry ?? geometry }))
      const attempt: SaveAttempt = previousAttempt ?? await workspaceStep('prepare-layout-save', () => {
        const { current, local } = captured!
        const scope = layoutScopeForSave(query(mode), saveScopes[mode] ?? layoutSaveScope(current.scope))
        const updated: LayoutDocument = { ...current, scope, id: asNew ? crypto.randomUUID() : current.id, name: (nameOverride ?? name).trim() || current.name, rev: current.rev + 1, updatedAt: new Date().toISOString(), updatedBy: { device } }
        const sameScope = layoutScopeKey(current.scope) === layoutScopeKey(scope)
        return { document: updated, geometry: local, basedOn: asNew || !sameScope ? undefined : layoutClock(current) } satisfies SaveAttempt
      })
      // The same attempt survives unknown PUT outcomes and known-successful geometry failures.
      retryOperation.current = () => { void save(asNew, attempt) }
      const updated = attempt.document, local = attempt.geometry
      const result = attempt.result ?? await workspaceStep('save-layout', () => api.saveLayout(updated, true, attempt.basedOn))
      attempt.result = result
      const won = compareLayouts(result.document, updated) === 0
      const scopeKey = layoutScopeKey(result.document.scope)
      if (!attempt.applied) {
        setList(previous => ({ documents: [...previous.documents.filter(row => !(row.id === updated.id && layoutScopeKey(row.scope) === scopeKey)), result.document, ...result.recovered], active: [...previous.active.filter(row => layoutScopeKey(row.scope) !== scopeKey), { scope: result.document.scope, layoutId: result.document.id }] }))
        if (won) {
          // Preserve edits made while the request was in flight, while advancing their base clock.
          setDocuments(previous => ({ ...previous, [updated.scope.mode]: { ...previous[updated.scope.mode]!, scope: result.document.scope, id: result.document.id, name: result.document.name, rev: result.document.rev, updatedAt: result.document.updatedAt, updatedBy: result.document.updatedBy } }))
          setName(result.document.name)
          geometryCache.current.set(`${scopeKey}#${result.document.id}`, local)
        }
        attempt.applied = true
      }
      if (won) {
        await workspaceStep('save-layout-geometry', () => api.saveLayoutGeometry(result.document.scope, device, result.document.id, local))
      } else {
        const winner = await workspaceStep('resolve-layout', () => compatible(result.document))
        const savedGeometry = (await workspaceStep('recover-layout-geometry', () => api.layoutGeometry(winner.scope, device, winner.id))).geometry
        phoneSnapshot.current = undefined
        geometryCache.current.set(`${layoutScopeKey(winner.scope)}#${winner.id}`, savedGeometry)
        setDocuments(previous => ({ ...previous, [updated.scope.mode]: winner }))
        setGeometry(savedGeometry)
        setName(winner.name)
        setGeneration(value => value + 1)
      }
      setSaveError(null)
      say(translate(result.recovered.length || !won ? 'workspaceLayout.recovered' : 'workspaceLayout.saved'))
    } catch (error) { setSaveError(workspaceFailure(error, 'save-workspace')) }
    finally { operationBusy.current = false; setSaving(false) }
  }
  function reset() {
    if (!doc || operationBusy.current) return
    const next = { ...builtInLayout(query(mode)), id: doc.id, name: doc.name, scope: doc.scope, rev: doc.rev, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy }
    phoneSnapshot.current = undefined
    geometryCache.current.delete(`${layoutScopeKey(doc.scope)}#${doc.id}`)
    setGeometry({})
    setDocuments(previous => ({ ...previous, [mode]: next }))
    setGeneration(value => value + 1)
  }
  function openMove(id?: string) {
    if (phone || operationBusy.current) return
    const next = id ?? engine.current?.activeBlock() ?? selected
    if (doc?.blocks[next] && !doc.hidden.includes(next)) { returnFocus.current = paneHosts.current.get(next)?.ownerDocument.activeElement as HTMLElement | null; setMoving(next) }
  }
  async function move() {
    if (!moving || phone || operationBusy.current) return
    operationBusy.current = true
    setSwitching(true)
    const id = moving
    setMoving(null)
    try {
      const success = await engine.current?.move(id, destination)
      if (!success) say(translate('workspaceLayout.popoutFailed'))
      remember()
    } catch { say(translate('workspaceLayout.popoutFailed')) }
    finally { operationBusy.current = false; setSwitching(false) }
  }
  function hide(id: string) {
    pendingPaneFocus.current = null
    const epoch = ++focusEpoch.current
    if (phone && doc) {
      const groups = doc.engineState.groups.map(group => ({ ...group, blocks: group.blocks.filter(block => block !== id), active: group.active === id ? group.blocks.find(block => block !== id) : group.active })).filter(group => group.blocks.length)
      const next = layoutDocumentSchema.parse({ ...doc, hidden: [...new Set([...doc.hidden, id])], engineState: { ...doc.engineState, grid: undefined, groups } })
      phoneSnapshot.current = undefined
      setDocuments(previous => ({ ...previous, [mode]: next }))
    }
    engine.current?.hide(id)
    if (!phone) { remember(); requestAnimationFrame(() => { if (focusEpoch.current !== epoch) return; const id = engine.current?.activeBlock(); if (id) engine.current?.focus(id) }) }
    else requestAnimationFrame(() => { if (focusEpoch.current === epoch) document.getElementById(`tab-${visible.find(block => block !== id) ?? ''}`)?.focus() })
    say(translate('workspaceLayout.hiddenAnnouncement', { block: title(id) }))
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
    const next = layoutDocumentSchema.parse({ ...current, blocks: { ...current.blocks, [id]: { contribution: contributionId, pluginVersion: contributionId.startsWith('guanxi.core/') ? '0.1.0' : 'unknown', priority: Object.keys(current.blocks).length, params: {} } }, engineState: { ...current.engineState, grid: undefined, groups: [...current.engineState.groups, { id: `added-${crypto.randomUUID()}`, zone: contribution.defaultZone, blocks: [id], active: id }] } })
    phoneSnapshot.current = undefined
    setDocuments(previous => ({ ...previous, [mode]: next }))
    setGeneration(value => value + 1)
    setSelected(id)
    say(translate('workspaceLayout.added', { block: translate(contribution.title as LocaleKey) }))
  }
  function show(id: string) {
    engine.current?.show(id, contributionFor(id)?.defaultZone ?? 'center')
    if ((phone || !engine.current) && doc) {
      const next = { ...doc, hidden: doc.hidden.filter(block => block !== id), engineState: { ...doc.engineState, grid: undefined, groups: [...doc.engineState.groups, { id: `phone-${crypto.randomUUID()}`, zone: 'center' as const, blocks: [id], active: id }] } }
      setDocuments(previous => ({ ...previous, [mode]: layoutDocumentSchema.parse(next) }))
      setSelected(id)
    } else remember()
    say(translate('workspaceLayout.added', { block: title(id) }))
  }
  function focusPendingPane(id: string) {
    const intent = pendingPaneFocus.current
    if (!intent || intent.id !== id) return
    requestAnimationFrame(() => {
      if (pendingPaneFocus.current !== intent || focusEpoch.current !== intent.epoch) return
      const host = paneHosts.current.get(id)
      const pane = host?.querySelector<HTMLElement>('[data-block]')
      if (!host?.isConnected || !pane || host.closest<HTMLElement>('[role="tabpanel"]')?.hidden) return
      pane.focus()
      if (pane.ownerDocument.activeElement === pane) pendingPaneFocus.current = null
    })
  }

  useEffect(() => () => clearWorkspaceShellState(shellWriter), [shellWriter])
  useEffect(() => {
    publishWorkspaceShellState(shellWriter, {
      ready: !loading && !loadError && Boolean(doc), busy: saving || switching, phone,
      mode: doc?.scope.mode ?? null,
      blocks: doc ? Object.keys(doc.blocks).map(id => ({ id, label: title(id), hidden: doc.hidden.includes(id) })) : [],
    })
  }, [shellWriter, loading, loadError, saving, switching, phone, mode, doc, contributions, locale])

  useEffect(() => {
    const command = (event: Event) => openMove((event as CustomEvent<{ instanceId?: string }>).detail?.instanceId)
    const reveal = (event: Event) => {
      const id: unknown = (event as CustomEvent<{ instanceId?: unknown }>).detail?.instanceId
      if (loading || loadError || operationBusy.current || !doc || typeof id !== 'string' || !Object.hasOwn(doc.blocks, id)) return
      pendingPaneFocus.current = { id, epoch: ++focusEpoch.current }
      if (doc.hidden.includes(id)) show(id)
      else setSelected(id)
      // An inactive Dockview tab may not have attached its retained host yet.
      // Activate it before waiting for the next committed frame to focus its pane.
      if (!phone) engine.current?.focus(id)
      focusPendingPane(id)
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'F6') { event.preventDefault(); engine.current?.cycleZone(event.shiftKey) }
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'm') { event.preventDefault(); openMove() }
    }
    window.addEventListener(MOVE_BLOCK_COMMAND, command)
    window.addEventListener(REVEAL_BLOCK_COMMAND, reveal)
    window.addEventListener('keydown', keyboard)
    return () => { window.removeEventListener(MOVE_BLOCK_COMMAND, command); window.removeEventListener(REVEAL_BLOCK_COMMAND, reveal); window.removeEventListener('keydown', keyboard) }
  })

  useEffect(() => {
    if (!import.meta.env.DEV) return
    Object.assign(window, { __GUANXI_WORKSPACE__: {
      setLocale, snapshot: () => snapshot(), diagnostics: () => engine.current?.diagnostics(), restoreMs: () => restoreTime.current,
      // Development inspection only; browser assertions exercise user movement through UI.
    } })
    return () => { Reflect.deleteProperty(window, '__GUANXI_WORKSPACE__') }
  })

  const failureTitle = (failure: WorkspaceFailure) => translate(failure.operation === 'save-layout-geometry' ? 'workspaceLayout.geometrySaveError'
    : failure.operation === 'load-layout-geometry' || failure.operation === 'activate-layout-geometry' || failure.operation === 'recover-layout-geometry' ? 'workspaceLayout.geometryLoadError'
      : failure.operation === 'snapshot-layout' || failure.operation === 'resolve-layout' || failure.operation === 'prepare-layout-save' ? 'workspaceLayout.localError'
        : failure.operation === 'kernel-ready' ? 'workspaceLayout.kernelError'
          : failure.operation === 'save-layout' || failure.operation === 'activate-layout' || failure.operation === 'save-workspace' ? 'workspaceLayout.saveError' : 'workspaceLayout.error')
  // D-203: a failed read recovers by itself (useAutoRecover above) and shows no button; a failed
  // save or switch keeps the user's own action, named by its verb, never "Retry".
  const loadErrorState = (failure: WorkspaceFailure) => <WorkspaceChrome kind="state" title={failureTitle(failure)} error failure={failure} />
  const actionErrorState = (failure: WorkspaceFailure, repeat: () => void, busy = false) => <WorkspaceChrome kind="state" title={failureTitle(failure)} error failure={failure}
    action={{ label: translate(failure.operation === 'activate-layout' || failure.operation === 'activate-layout-geometry' ? 'workspaceLayout.switchAgain' : 'workspaceLayout.save'),
      onClick: repeat, busy, loadingLabel: translate('workspaceLayout.saving') }} />
  if (!doc) return <UiLocaleProvider locale={locale}>{loadError ? loadErrorState(loadError)
    : <WorkspaceChrome kind="state" title={translate('workspaceLayout.loading')} loading />}</UiLocaleProvider>
  for (const id of Object.keys(doc.blocks)) if (!paneHosts.current.has(id)) { const host = document.createElement('div'); host.className = 'workspace-retained-pane'; paneHosts.current.set(id, host) }
  for (const host of paneHosts.current.values()) { host.dataset.theme = theme; host.dataset.density = doc.density; host.lang = locale }
  const visible = Object.keys(doc.blocks).filter(id => !doc.hidden.includes(id)).sort((a, b) => doc.blocks[a]!.priority - doc.blocks[b]!.priority || a.localeCompare(b))
  const hiddenToShow = doc.hidden.find(id => { const contribution = contributionFor(id); return contribution?.id.startsWith('guanxi.core/') && contribution.modes.includes(mode) })
  const coreChatReady = contributions.some(entry => entry.key === 'guanxi.core/chat' && entry.value.modes.includes(mode))
  const selectedId = visible.includes(selected) ? selected : visible[0] ?? ''
  const choices = Object.keys(doc.blocks).map(id => ({ id, label: title(id) }))
  const renderPane = (id: string) => {
    const contribution = contributionFor(id)
    const builtIn = contribution?.id.startsWith('guanxi.core/') && 'component' in contribution.pane && contribution.pane.component.startsWith('core.')
    const name = contribution?.id.split('/')[1] as BuiltInBlock | undefined
    const Renderer = contribution && 'component' in contribution.pane ? paneRegistry.get(contribution.pane.component) : undefined
    const unavailable = !contribution || !contribution.modes.includes(mode) || (safeMode && !builtIn) || (!builtIn && !Renderer)
    const labels = paneLabels(title(id))
    if (unavailable) return <WorkspaceChrome kind="pane" id={id} title={title(id)} {...labels} canMove={!phone} onMove={() => openMove(id)} onHide={() => hide(id)} description={translate(safeMode ? 'workspaceLayout.safePlaceholder' : 'workspaceLayout.placeholder')} />
    if (Renderer && !builtIn) return <WorkspaceChrome kind="pane" id={id} title={title(id)} {...labels} canMove={!phone} onMove={() => openMove(id)} onHide={() => hide(id)}><Renderer instanceId={id} params={doc.blocks[id]!.params} /></WorkspaceChrome>
    return <BuiltInPane id={id} name={name!} title={title(id)} onMove={() => openMove(id)} onHide={() => hide(id)} canMove={!phone}>{name === 'chat' ? children : null}</BuiltInPane>
  }
  const busy = loading || saving || switching
  // The session header carries the menu only while the session block is on screen: not hidden, not
  // behind another phone tab. Otherwise the workspace's own bar shows it (review P1).
  const isSession = (id: string) => doc.blocks[id]?.contribution === 'guanxi.core/chat'
  const sessionOnScreen = coreChatReady && (phone ? isSession(selectedId) : visible.some(isSession))
  const layoutLabel = (row: LayoutDocument) => row.name === 'Recovered layout' ? translate('workspaceLayout.recoveredName')
    : row.id.startsWith('default-') && (row.name === 'developer' || row.name === 'visual') ? translate('workspaceLayout.defaultName') : row.name
  // The session header's panels menu replaces the toolbar row (round 4, owner feedback 2026-10-23).
  const controls: WorkspaceLayoutControls = {
    busy, phone,
    // The session block is a row too: hidden from its dock tab, it comes back from this menu (review P1).
    blocks: Object.keys(doc.blocks)
      .sort((a, b) => doc.blocks[a]!.priority - doc.blocks[b]!.priority || a.localeCompare(b))
      .map(id => ({ id, label: title(id), hidden: doc.hidden.includes(id) })),
    addable: contributions.filter(entry => entry.value.modes.includes(mode) && (!safeMode || entry.pluginId === 'guanxi.core')
      && entry.key !== 'guanxi.core/chat' && (entry.value.multiInstance || !Object.values(doc.blocks).some(block => block.contribution === entry.key)))
      .map(entry => ({ id: entry.key, label: translate(entry.value.title as LocaleKey) })),
    setVisible: (id, next) => { if (next) show(id); else hide(id) },
    add: addBlock,
    density: doc.density,
    setDensity: next => setDocuments(previous => ({ ...previous, [mode]: { ...doc, density: next } })),
    scope: saveScopes[mode] ?? layoutSaveScope(doc.scope),
    scopes: layoutSaveScopes(query(mode)).map(id => ({ id, label: translate(`workspaceLayout.scope.${id}`) })),
    setScope: next => setSaveScopes(previous => ({ ...previous, [mode]: next as LayoutSaveScope })),
    layout: `${layoutScopeKey(doc.scope)}#${doc.id}`,
    layouts: list.documents.filter(row => row.scope.mode === mode).map(row => ({ id: `${layoutScopeKey(row.scope)}#${row.id}`, label: layoutLabel(row) })),
    activate: id => {
      const next = list.documents.find(row => `${layoutScopeKey(row.scope)}#${row.id}` === id && row.scope.mode === mode)
      if (next) void activateDocument(next, true)
    },
    name: layoutLabel(doc),
    save: () => { void save() },
    // The new name becomes the layout's name only once the node confirms the save (review P2).
    saveAs: next => { void save(true, undefined, next) },
    reset,
    move: () => openMove(),
    registerMenu,
  }
  return <UiLocaleProvider locale={locale}><WorkspaceControlsContext.Provider value={controls}><div className="workspace" aria-busy={loading || undefined} data-theme={theme} data-density={doc.density} data-mode={mode} onKeyDown={event => {
    if (event.defaultPrevented) return
    if (event.key === 'F6') { event.preventDefault(); engine.current?.cycleZone(event.shiftKey) }
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'm' && !phone) { event.preventDefault(); openMove() }
  }}>
    {/* The session header carries the panels menu; when no session block shows, the menu stays reachable here. */}
    {(menuHosts === 0 || !sessionOnScreen) && <div className="workspace-bar"><SessionPanelsMenu layout={controls} fallback /></div>}
    {loadError && loadErrorState(loadError)}
    {saveError && actionErrorState(saveError, () => retryOperation.current(), saving || switching)}
    <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="workspace-announcement"><span key={announcementRevision}>{announcement}</span></p>
    {doc.engineState.groups.some(group => group.zone === 'popout') && <p>{translate('workspaceLayout.popoutRestore')}</p>}
    <div className="workspace-content" inert={loading || saving || switching || undefined}>
      {visible.length === 0 ? (
        !hiddenToShow && !coreChatReady ? <WorkspaceChrome kind="state" title={translate('workspaceLayout.loading')} loading />
          : <WorkspaceChrome kind="state" title={translate('workspaceLayout.noVisibleBlocks')} action={hiddenToShow ? { label: translate('workspaceLayout.showBlock', { block: title(hiddenToShow) }), onClick: () => show(hiddenToShow) } : { label: translate('workspaceLayout.addChat'), onClick: () => addBlock('guanxi.core/chat') }} />
      ) : phone ? <>
        <WorkspaceChrome kind="phone" label={translate('workspaceLayout.phone')} selected={selectedId} blocks={visible.map(id => ({ id, label: title(id) }))} onSelect={setSelected} />
        {visible.map(id => <div key={id} id={`phone-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={id !== selectedId} ref={element => { const host = paneHosts.current.get(id); if (element && host) { if (host.parentElement !== element) element.append(host); focusPendingPane(id) } }} />)}
      </> : (
        <WorkspaceLayout key={`${mode}:${generation}`} document={doc} geometry={geometry} hosts={paneHosts.current} title={title} handleRef={engine} onMoveRequested={openMove} hideLabel={translate('workspaceLayout.hide')} onHidden={id => say(translate('workspaceLayout.hiddenAnnouncement', { block: title(id) }))} onChange={capture} onMove={announceMove} onReady={elapsed => { restoreTime.current = elapsed }} onPaneAttached={focusPendingPane} />
      )}
    </div>
    {moving !== null && <PortalContainerProvider container={paneHosts.current.get(moving)?.ownerDocument.body ?? null}><WorkspaceChrome kind="mover" open={moving !== null} title={translate('workspaceLayout.moveTitle')} description={translate('workspaceLayout.move')} blockLabel={translate('workspaceLayout.block')} zoneLabel={translate('workspaceLayout.destination')} cancelLabel={translate('workspaceLayout.cancel')} moveLabel={translate('workspaceLayout.move')} blocks={choices.filter(choice => visible.includes(choice.id))} zones={zoneOrder.map(id => ({ id, label: translate(`workspaceLayout.zone.${id}`) }))} block={moving ?? ''} zone={destination} onBlock={setMoving} onZone={id => setDestination(id as WorkspaceZone)} onClose={() => { const id = moving; setMoving(null); requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (id) engine.current?.focus(id) }) }} onMove={() => { void move() }} /></PortalContainerProvider>}
    {Object.keys(doc.blocks).map(id => createPortal(<PortalContainerProvider container={paneHosts.current.get(id)!}>{renderPane(id)}{paneHosts.current.get(id)!.ownerDocument !== document && <p className="sr-only" aria-live="polite" aria-atomic="true"><span key={announcementRevision}>{announcement}</span></p>}</PortalContainerProvider>, paneHosts.current.get(id)!, id))}
  </div></WorkspaceControlsContext.Provider></UiLocaleProvider>
}

/** Pane actions are icons named with the block ("Move Terminal…"), never text buttons (round 4). */
function paneLabels(block: string) {
  return { moveLabel: translate('workspaceLayout.movePanel', { block }), hideLabel: translate('workspaceLayout.hidePanel', { block }) }
}

function BuiltInPane({ id, name, title, onMove, onHide, canMove, children }: { id: string; name: BuiltInBlock; title: string; onMove: () => void; onHide: () => void; canMove: boolean; children?: ReactNode }) {
  const [draft, setDraft] = useState('')
  const hasDraft = name === 'terminal' || name === 'browser'
  const known = blockNames.includes(name)
  const session = useSessionContext()
  // The session timeline brings its own header; its dock tab already names it.
  if (name === 'chat') return <WorkspaceChrome kind="pane" id={id} title={title} {...paneLabels(title)} onMove={onMove} onHide={onHide} canMove={canMove} chromeless>{children}</WorkspaceChrome>
  // The Context block shows the open session's context panel when there is one.
  if (name === 'context' && session) return <WorkspaceChrome kind="pane" id={id} title={title} {...paneLabels(title)} onMove={onMove} onHide={onHide} canMove={canMove}>
    <ContextPanel context={session.context} usage={session.usage} compacting={session.compacting} onCompact={session.onCompact} disabled={session.disabled} />
  </WorkspaceChrome>
  return <WorkspaceChrome kind="pane" id={id} title={title} {...paneLabels(title)} onMove={onMove} onHide={onHide} canMove={canMove} description={known ? translate(`workspaceLayout.empty.${name}`) : undefined} draft={hasDraft ? { label: translate(name === 'terminal' ? 'workspaceLayout.draft' : 'workspaceLayout.preview'), value: draft, onChange: setDraft } : undefined}>{children}</WorkspaceChrome>
}
