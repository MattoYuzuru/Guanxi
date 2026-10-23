import type { Health } from '@guanxi/contract'
import { AppShellChrome, Button, type AppShellLabels } from '@guanxi/ui'
import type { ReactNode } from 'react'
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx'
import { translate as t } from '../../lib/locale.ts'
import { useRoute, type Route } from '../../lib/router.tsx'
import type { ThemePreference } from '../../lib/theme.tsx'
import { OllamaHealthNotice } from '../health/HealthGate.tsx'
import { RuntimeStatus } from '../health/RuntimeStatus.tsx'
import { useRuntimeProjection } from '../health/RuntimeContext.tsx'
import { ShellPalette } from './ShellPalette.tsx'
import { ShellSidebar } from './ShellSidebar.tsx'
import { ShellStatus } from './ShellStatus.tsx'
import { useShellController } from './useShellController.ts'

/**
 * The single product host for the prepared shell. Route content is supplied by
 * App; this component owns shell preferences, the palette and the one sampled
 * Runtime projection. It intentionally imports no workspace or catalog module,
 * so their existing lazy boundaries stay intact.
 */
export function MountedShell({
  health,
  retrying,
  onRetry,
  children,
}: {
  health: Health
  retrying: boolean
  onRetry: () => void
  children: ReactNode
}) {
  const shell = useShellController()
  const route = useRoute()
  const runtime = useRuntimeProjection()
  const labels: AppShellLabels = {
    show: t('shell.sidebar.show'),
    collapse: t('shell.sidebar.rail'),
    expand: t('shell.sidebar.expanded'),
    hide: t('shell.sidebar.hidden'),
    moveLeft: t('shell.sidebar.left'),
    moveRight: t('shell.sidebar.right'),
    palette: t('shell.palette'),
  }

  return (
    <div className="h-dvh min-w-0">
      <AppShellChrome
        side={shell.preferences.side}
        visibility={shell.preferences.visibility}
        sidebarLabel={t('shell.sidebar.label')}
        labels={labels}
        sidebar={
          <ShellSidebar
            rail={shell.preferences.visibility === 'rail'}
            location={shell.location}
            sessions={shell.sessions.sessions}
            unseen={shell.unseen}
            pinned={shell.preferences.pinned}
            loading={shell.sessions.loading}
            loadingMore={shell.sessions.loadingMore}
            error={shell.sessions.error}
            omitted={shell.sessions.omitted}
            observedAt={shell.sessions.observedAt}
            hasMore={shell.sessions.hasMore}
            onLoadMore={() => { void shell.sessions.loadMore() }}
            onRefresh={shell.sessions.reload}
            onPin={shell.togglePin}
          />
        }
        status={
          <>
            <ShellStatus
              breadcrumb={breadcrumb(route)}
              workspace={shell.workspace}
              runtime={runtime.data}
              stale={runtime.error !== null && runtime.data !== null}
            />
            <ShellThemeButton preference={shell.preference} onChange={shell.setPreference} />
          </>
        }
        onSide={(side) => shell.setPreferences((previous) => ({ ...previous, side }))}
        onVisibility={(visibility) =>
          shell.setPreferences((previous) => ({ ...previous, visibility }))
        }
        onOpenPalette={() => shell.setPaletteOpen(true)}
      >
        {/* The phone flow lets the page scroll, so route content that cannot reflow stays
            reachable by scrolling inside this host area, as the previous <main> did, instead of
            widening the document. */}
        <div data-slot="shell-route-host" className="flex h-full min-h-0 min-w-0 flex-col overflow-x-auto">
          <OllamaHealthNotice health={health} onRetry={onRetry} retrying={retrying} />
          <ErrorBoundary scope="runtime">
            <RuntimeStatus />
          </ErrorBoundary>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </div>
      </AppShellChrome>
      <ShellPalette
        open={shell.paletteOpen}
        onOpenChange={shell.setPaletteOpen}
        commands={shell.commands}
        sessionSearch={shell.sessionSearch}
      />
    </div>
  )
}

/** Keeps the legacy quick theme path reachable from the persistent status strip. */
function ShellThemeButton({
  preference,
  onChange,
}: {
  preference: ThemePreference
  onChange: (next: ThemePreference) => void
}) {
  const label =
    preference === 'dark'
      ? t('theme.dark')
      : preference === 'light'
        ? t('theme.light')
        : t('theme.system')
  const next: ThemePreference =
    preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark'
  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0"
      title={t('app.theme.switch', { theme: label })}
      aria-label={t('app.theme.current', { theme: label })}
      onClick={() => onChange(next)}
    >
      <span aria-hidden="true">
        {preference === 'dark' ? '◐' : preference === 'light' ? '◑' : '◒'}
      </span>
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )
}

function breadcrumb(route: Route): string {
  switch (route.name) {
    case 'workspace':
      return t('workspaceLayout.title')
    case 'agent':
      return t('native.nav')
    case 'launcher':
    case 'model':
      return t('app.navigation.models')
    case 'chat':
      return t('app.navigation.chat')
    case 'projectChat':
    case 'projects':
      return t('projects.navigation')
    case 'quickRuns':
      return t('quickRuns.navigation')
    case 'recipes':
      return t('recipes.navigation')
    case 'attachments':
      return t('attachments.navigation')
    case 'settings':
      return t('app.navigation.settings')
    case 'developerComponents':
      return t('shell.catalog')
    case 'voiceGlossary':
      return t('voiceGlossary.navigation')
    case 'inspector':
      return t('inspector.navigation')
    case 'notFound':
      return t('app.notFound.title')
  }
}
