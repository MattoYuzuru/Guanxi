import type { Health } from '@guanxi/contract'
import { AppShellChrome, type AppShellLabels } from '@guanxi/ui'
import type { ReactNode } from 'react'
import { AppearanceProvider, useOptionalAppearance } from '../../lib/appearance.tsx'
import { translate as t } from '../../lib/locale.ts'
import { useRoute, type Route } from '../../lib/router.tsx'
import { NotificationBell } from '../notifications/NotificationBell.tsx'
import { NotificationsProvider } from '../notifications/NotificationsProvider.tsx'
import { MaxGraphics } from './MaxGraphics.tsx'
import { ShellCustomise, ShellThemeToggle } from './ShellCustomise.tsx'
import { ShellPalette } from './ShellPalette.tsx'
import { ShellSidebar } from './ShellSidebar.tsx'
import { ShellBreadcrumb, ShellRuntimeStatusItems } from './ShellStatus.tsx'
import { useShellController } from './useShellController.ts'

/** The platform's palette shortcut keys; machine values, not translated. */
function paletteKeys(): string[] {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent
  return /Mac|iPhone|iPad/u.test(platform) ? ['\u2318', 'K'] : ['Ctrl', 'K']
}

/**
 * The single product host. Route content is supplied by App; this component owns shell
 * preferences, the palette and the one sampled Runtime projection, shown as icon status items
 * (D-202) instead of a runtime bar. It intentionally imports no workspace or catalog module, so
 * their lazy boundaries stay intact. There is no Retry anywhere in the chrome: health, runtime,
 * sessions and the inbox refresh quietly and recover by themselves (D-203).
 */
export function MountedShell(props: { health: Health; healthStale?: boolean; children: ReactNode }) {
  // The appearance store normally comes from main.tsx; hosts that render App alone (tests,
  // fixtures) still get one, so the customisation popover always has a store.
  return useOptionalAppearance() ? <Shell {...props} /> : <AppearanceProvider><Shell {...props} /></AppearanceProvider>
}

function Shell({
  health,
  healthStale = false,
  children,
}: {
  health: Health
  healthStale?: boolean
  children: ReactNode
}) {
  const shell = useShellController()
  const route = useRoute()
  const labels: AppShellLabels = {
    show: t('shell.sidebar.show'),
    collapse: t('shell.sidebar.rail'),
    expand: t('shell.sidebar.expanded'),
    hide: t('shell.sidebar.hidden'),
    moveLeft: t('shell.sidebar.left'),
    moveRight: t('shell.sidebar.right'),
    palette: t('shell.palette'),
    navigation: t('shell.navigation.open'),
    more: t('shell.more'),
  }

  return (
    <NotificationsProvider>
    <div className="h-dvh min-w-0">
      <MaxGraphics />
      <AppShellChrome
        side={shell.preferences.side}
        visibility={shell.preferences.visibility}
        sidebarLabel={t('shell.sidebar.label')}
        labels={labels}
        paletteShortcut={paletteKeys()}
        sidebar={({ rail }) =>
          <ShellSidebar
            rail={rail}
            location={shell.location}
            newSessionPath={shell.newSessionPath}
            sessions={shell.sessions.sessions}
            unseen={shell.unseen}
            pinned={shell.preferences.pinned}
            loading={shell.sessions.loading}
            loadingMore={shell.sessions.loadingMore}
            error={shell.sessions.error}
            omitted={shell.sessions.omitted}
            hasMore={shell.sessions.hasMore}
            onLoadMore={() => { void shell.sessions.loadMore() }}
            onPin={shell.togglePin}
          />
        }
        status={<ShellBreadcrumb page={breadcrumb(route)} />}
        actions={
          <>
            {/* Only the status items read the runtime sample, so a poll re-renders them alone (P2). */}
            <ShellRuntimeStatusItems
              health={health}
              healthStale={healthStale}
              inbox={<NotificationBell />}
            />
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-hairline" />
            <ShellCustomise preferences={shell.preferences} onPreferences={shell.setPreferences} />
            <ShellThemeToggle />
          </>
        }
        onSide={(side) => shell.setPreferences((previous) => ({ ...previous, side }))}
        onVisibility={(visibility) =>
          shell.setPreferences((previous) => ({ ...previous, visibility }))
        }
        onOpenPalette={() => shell.setPaletteOpen(true)}
      >
        {/* The phone flow lets the page scroll, so route content that cannot reflow stays
            reachable by scrolling inside this host area instead of widening the document. */}
        <div data-slot="shell-route-host" className="flex h-full min-h-0 min-w-0 flex-col overflow-x-auto">
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
    </NotificationsProvider>
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
    case 'connections':
      return t('shell.connections')
    case 'settings':
      return t('app.navigation.settings')
    case 'developerComponents':
      return t('shell.catalog')
    case 'voiceGlossary':
      return t('voiceGlossary.navigation')
    case 'inspector':
      return t('inspector.navigation')
    case 'notifications':
      return t('notifications.navigation')
    case 'notFound':
      return t('app.notFound.title')
  }
}
