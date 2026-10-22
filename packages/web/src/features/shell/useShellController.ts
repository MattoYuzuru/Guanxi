import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../../lib/api.ts'
import { translate as t } from '../../lib/locale.ts'
import { navigate, paths, useLocation } from '../../lib/router.tsx'
import { useTheme } from '../../lib/theme.tsx'
import { useAsync } from '../../lib/useAsync.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { requestBlockMove, requestBlockReveal, requestWorkspaceMode } from '../workspace/commands.ts'
import { workspaceShellState } from '../workspace/shell-state.ts'
import { readShellPreferences, writeShellPreferences } from './preferences.ts'
import type { ShellCommand } from './ShellPalette.tsx'
import { sessionNavigationPath } from './sessionNavigation.ts'
import { useShellSessions } from './useShellSessions.ts'

/** Host behavior without any layout-engine import or draft catalog component dependency. */
export function useShellController() {
  useLocale()
  const location = useLocation()
  const [preferences, setPreferences] = useState(readShellPreferences)
  const [paletteOpen, setPaletteOpen] = useState(false), [modelsRequested, setModelsRequested] = useState(false)
  const sessions = useShellSessions(location)
  const workspace = useSyncExternalStore(workspaceShellState.subscribe, workspaceShellState.snapshot)
  const { preference, setPreference } = useTheme()
  const models = useAsync(signal => modelsRequested ? api.listModels(undefined, signal) : Promise.resolve({ models: [] }), [modelsRequested])
  useEffect(() => { writeShellPreferences(preferences) }, [preferences])
  useEffect(() => { if (paletteOpen) setModelsRequested(true) }, [paletteOpen])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault(); setPaletteOpen(value => !value)
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [])
  const commands: ShellCommand[] = [
    { id: 'new', label: t('shell.new'), execute: () => navigate(paths.agent()) },
    { id: 'projects', label: t('shell.projects'), execute: () => navigate(paths.projects()) },
    { id: 'models', label: t('shell.models'), execute: () => navigate(paths.launcher()) },
    { id: 'settings', label: t('shell.settings'), execute: () => navigate(paths.settings()) },
    ...[
      { id: 'workspace', label: t('workspaceLayout.title'), path: paths.workspace() },
      { id: 'chat', label: t('app.navigation.chat'), path: paths.chat() },
      { id: 'quick-runs', label: t('quickRuns.navigation'), path: paths.quickRuns() },
      { id: 'recipes', label: t('recipes.navigation'), path: paths.recipes() },
      { id: 'attachments', label: t('attachments.navigation'), path: paths.attachments() },
      { id: 'inspector', label: t('inspector.navigation'), path: paths.inspector() },
      { id: 'components', label: t('shell.catalog'), path: paths.developerComponents() },
    ].map(item => ({ id: item.id, label: item.label, execute: () => navigate(item.path) })),
    ...sessions.sessions.map(session => ({ id: `session:${session.sessionId}`,
      label: t('shell.command.session', { title: session.title || t('shell.sessions.untitled') }),
      execute: () => navigate(sessionNavigationPath(session.navigation)) })),
    { id: 'session-refresh', label: t('shell.sessions.refresh'), disabled: sessions.loading || sessions.loadingMore,
      reason: sessions.error ? t('shell.sessions.error') : sessions.loading ? t('shell.sessions.loading') : sessions.omitted ? t('shell.sessions.omitted') : undefined,
      execute: sessions.reload },
    ...(sessions.hasMore ? [{ id: 'session-more', label: t('shell.sessions.more'), disabled: sessions.loading || sessions.loadingMore,
      execute: () => { void sessions.loadMore() } }] : []),
    ...(models.data?.models ?? []).map(model => ({ id: `model:${model.name}`, label: t('shell.command.model', { name: model.name }),
      execute: () => navigate(paths.model(model.name)) })),
    ...((models.loading || models.refreshing) ? [{ id: 'model-loading', label: t('shell.models.loading'), disabled: true, execute() {} }] : []),
    ...(models.error ? [{ id: 'model-retry', label: t('shell.models.retry'), reason: t('shell.models.error'), execute: models.reload }] : []),
    ...(['developer', 'visual'] as const).map(mode => ({ id: `mode:${mode}`, label: t(`workspaceLayout.${mode}`),
      disabled: !workspace.ready || workspace.busy, reason: !workspace.ready ? t('shell.workspace.required') : workspace.busy ? t('shell.workspace.busy') : undefined,
      execute: () => requestWorkspaceMode(mode) })),
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
  return { location, preferences, setPreferences, paletteOpen, setPaletteOpen, commands, sessions, workspace, preference,
    togglePin: (id: string) => setPreferences(previous => ({ ...previous, pinned: previous.pinned.includes(id)
      ? previous.pinned.filter(value => value !== id) : [...previous.pinned, id] })) }
}
