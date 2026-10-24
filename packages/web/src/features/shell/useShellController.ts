import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../../lib/api.ts'
import { translate as t } from '../../lib/locale.ts'
import { navigate, paths, useLocation } from '../../lib/router.tsx'
import { useTheme } from '../../lib/theme.tsx'
import { useAsync } from '../../lib/useAsync.ts'
import { projectFromLocation, useCurrentProject } from '../../lib/current-project.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { requestBlockMove, requestBlockReveal } from '../workspace/commands.ts'
import { workspaceShellState } from '../workspace/shell-state.ts'
import { readShellPreferences, writeShellPreferences } from './preferences.ts'
import type { ShellCommand, ShellSessionSearch } from './ShellPalette.tsx'
import { sessionNavigationPath } from './sessionNavigation.ts'
import { useShellSessions } from './useShellSessions.ts'
import { useUnseenSessions } from './useUnseenSessions.ts'

/** Host behavior without any layout-engine import or draft catalog component dependency. */
export function useShellController() {
  useLocale()
  const location = useLocation()
  const [preferences, setPreferences] = useState(readShellPreferences)
  const [paletteOpen, updatePaletteOpen] = useState(false), [modelsRequested, setModelsRequested] = useState(false)
  const sessions = useShellSessions(location)
  // D-207: a new session opens in the current project (the open session's, else the routed one).
  const currentProject = useCurrentProject() ?? projectFromLocation(location)
  const newSessionPath = paths.agent(null, currentProject)
  const unseen = useUnseenSessions(sessions.sessions, location, sessions.reads, !sessions.hasMore && !sessions.omitted && !sessions.error)
  const setPaletteOpen = useCallback((next: boolean) => {
    if (!next) sessions.cancelSearch()
    updatePaletteOpen(next)
  }, [sessions.cancelSearch])
  const workspace = useSyncExternalStore(workspaceShellState.subscribe, workspaceShellState.snapshot)
  const { preference, setPreference } = useTheme()
  const models = useAsync(signal => modelsRequested ? api.listModels(undefined, signal) : Promise.resolve({ models: [] }), [modelsRequested], { revalidate: { onFocus: true } })
  useEffect(() => { writeShellPreferences(preferences) }, [preferences])
  useEffect(() => { if (paletteOpen) setModelsRequested(true) }, [paletteOpen])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault(); setPaletteOpen(!paletteOpen)
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [paletteOpen, setPaletteOpen])
  const commands: ShellCommand[] = [
    { id: 'new', label: t('shell.new'), execute: () => navigate(newSessionPath) },
    { id: 'projects', label: t('shell.projects'), execute: () => navigate(paths.projects()) },
    { id: 'models', label: t('shell.models'), execute: () => navigate(paths.launcher()) },
    { id: 'settings', label: t('shell.settings'), execute: () => navigate(paths.settings()) },
    ...[
      { id: 'workspace', label: t('workspaceLayout.title'), path: paths.workspace() },
      { id: 'chat', label: t('app.navigation.chat'), path: paths.chat() },
      { id: 'quick-runs', label: t('quickRuns.navigation'), path: paths.quickRuns() },
      { id: 'recipes', label: t('recipes.navigation'), path: paths.recipes() },
      { id: 'attachments', label: t('attachments.navigation'), path: paths.attachments() },
      { id: 'notifications', label: t('notifications.command'), path: paths.notifications() },
      { id: 'inspector', label: t('inspector.navigation'), path: paths.inspector() },
      { id: 'voice-glossary', label: t('voiceGlossary.navigation'), path: paths.voiceGlossary() },
      { id: 'components', label: t('shell.catalog'), path: paths.developerComponents() },
    ].map(item => ({ id: item.id, label: item.label, execute: () => navigate(item.path) })),
    ...sessions.sessions.map(session => ({ id: `session:${session.sessionId}`,
      label: t('shell.command.session', { title: session.title || t('shell.sessions.untitled') }),
      execute: () => navigate(sessionNavigationPath(session.navigation)) })),
    ...(sessions.hasMore ? [{ id: 'session-more', label: t('shell.sessions.more'), disabled: sessions.loading || sessions.loadingMore,
      execute: () => { void sessions.loadMore() } }] : []),
    ...(models.data?.models ?? []).map(model => ({ id: `model:${model.name}`, label: t('shell.command.model', { name: model.name }),
      execute: () => navigate(paths.model(model.name)) })),
    ...((models.loading || models.refreshing) ? [{ id: 'model-loading', label: t('shell.models.loading'), disabled: true, execute() {} }] : []),
    // A failed model read recovers by itself (useAsync retry); the entry only says why it is empty.
    ...(models.error && !models.data?.models.length ? [{ id: 'model-unavailable', label: t('shell.models.error'), disabled: true, execute() {} }] : []),
    ...workspace.blocks.flatMap(block => [
      { id: `block:${block.id}`, label: t(block.hidden ? 'shell.command.showBlock' : 'shell.command.focusBlock', { title: block.label }),
        disabled: !workspace.ready || workspace.busy, reason: workspace.busy ? t('shell.workspace.busy') : undefined,
        execute: () => requestBlockReveal(block.id) },
      { id: `move:${block.id}`, label: t('shell.command.moveBlock', { title: block.label }),
        disabled: !workspace.ready || workspace.busy || workspace.phone || block.hidden,
        reason: workspace.phone ? t('shell.workspace.phone') : block.hidden ? t('shell.workspace.showFirst') : workspace.busy ? t('shell.workspace.busy') : undefined,
        execute: () => requestBlockMove(block.id) },
    ]),
    ...(['left', 'right'] as const).map(side => ({ id: `sidebar:${side}`, label: t(`shell.sidebar.${side}`),
      execute: () => setPreferences(previous => ({ ...previous, side })) })),
    ...(['expanded', 'rail', 'hidden'] as const).map(visibility => ({ id: `sidebar:${visibility}`, label: t(`shell.sidebar.${visibility}`),
      execute: () => setPreferences(previous => ({ ...previous, visibility })) })),
    ...(['light', 'dark', 'system'] as const).map(theme => ({ id: `theme:${theme}`, label: t('shell.command.theme', { theme: t(`theme.${theme}`) }),
      execute: () => setPreference(theme) })),
  ]
  const sessionSearch: ShellSessionSearch = { loaded: sessions.sessions.length, loading: sessions.loading || (sessions.loadingMore && !sessions.searchingAll),
    hasMore: sessions.hasMore, searching: sessions.searchingAll, error: sessions.error,
    refreshFailed: sessions.error && !sessions.paginationReady, omitted: sessions.omitted,
    search: () => { if (!sessions.paginationReady) sessions.reload(); else void sessions.searchAll() }, cancel: sessions.cancelSearch }
  return { location, newSessionPath, preferences, setPreferences, paletteOpen, setPaletteOpen, commands, sessionSearch, sessions, unseen, workspace, preference, setPreference,
    togglePin: (id: string) => setPreferences(previous => ({ ...previous, pinned: previous.pinned.includes(id)
      ? previous.pinned.filter(value => value !== id) : [...previous.pinned, id] })) }
}
