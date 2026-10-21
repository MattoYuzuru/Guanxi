/**
 * Корень приложения: проверка здоровья, шапка, разбор маршрута.
 */
import { useState } from 'react'
import { api } from './lib/api.ts'
import { useAsync } from './lib/useAsync.ts'
import { Link, paths, useRoute } from './lib/router.tsx'
import { useTheme } from './lib/theme.tsx'
import { Button, EmptyState, cx } from './components/ui.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import {
  HealthLoading,
  HealthUnreachable,
  OllamaHealthNotice,
} from './features/health/HealthGate.tsx'
import { RuntimeStatus } from './features/health/RuntimeStatus.tsx'
import { RuntimeProvider } from './features/health/RuntimeContext.tsx'
import { LauncherPage } from './features/launcher/LauncherPage.tsx'
import { ModelPage } from './features/models/ModelPage.tsx'
import { ChatPage } from './features/chat/ChatPage.tsx'
import { SettingsPage } from './features/settings/SettingsPage.tsx'
import { ProjectsPage } from './features/projects/ProjectsPage.tsx'
import { QuickRunsPage } from './features/quick-runs/QuickRunsPage.tsx'
import { RecipesPage } from './features/recipes/RecipesPage.tsx'
import { AttachmentsPage } from './features/attachments/AttachmentsPage.tsx'
import { InspectorPage } from './features/inspector/InspectorPage.tsx'
import { translate } from './lib/locale.ts'
import { useLocale } from './lib/locale-context.tsx'
import { PRODUCT_NAME } from './lib/brand.ts'

export function App() {
  useLocale()
  const route = useRoute()
  const health = useAsync((signal) => api.health(signal), [])
  const [retrying, setRetrying] = useState(false)

  const retry = () => {
    setRetrying(true)
    health.reload()
    // Кнопка не должна мигать быстрее, чем человек успевает заметить нажатие.
    setTimeout(() => setRetrying(false), 400)
  }

  if (health.loading) return <HealthLoading />
  if (health.error || !health.data) {
    return <HealthUnreachable error={health.error} onRetry={retry} />
  }

  const { data } = health

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden">
      <TopBar />
      <OllamaHealthNotice
        health={data}
        onRetry={retry}
        retrying={retrying}
      />
      <RuntimeProvider>
        <ErrorBoundary scope="runtime">
          <RuntimeStatus />
        </ErrorBoundary>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {route.name === 'launcher' && <LauncherPage health={data} />}
          {route.name === 'model' && <ModelPage name={route.modelName} health={data} />}
          {route.name === 'chat' && (
            <ErrorBoundary
              key={route.threadId === null ? 'new-chat' : route.threadId}
              scope="chat"
            >
              <ChatPage threadId={route.threadId} health={data} />
            </ErrorBoundary>
          )}
          {route.name === 'projectChat' && (
            <ErrorBoundary
              key={`${route.projectId}:${route.threadId ?? 'new-chat'}`}
              scope="chat"
            >
              <ChatPage
                threadId={route.threadId}
                projectId={route.projectId}
                health={data}
              />
            </ErrorBoundary>
          )}
          {route.name === 'quickRuns' && <QuickRunsPage />}
          {route.name === 'recipes' && <RecipesPage />}
          {route.name === 'attachments' && <AttachmentsPage />}
          {route.name === 'settings' && <SettingsPage />}
          {route.name === 'projects' && <ProjectsPage />}
          {route.name === 'inspector' && <InspectorPage sessionId={route.sessionId} />}
          {route.name === 'notFound' && (
            <EmptyState
              title={translate('app.notFound.title')}
              description={route.path}
              action={
                <Link
                  to={paths.launcher()}
                  className="text-xs text-[var(--accent)] underline underline-offset-2"
                >
                  {translate('app.notFound.home')}
                </Link>
              }
            />
          )}
        </main>
      </RuntimeProvider>
    </div>
  )
}

function TopBar() {
  const route = useRoute()
  const { preference, setPreference } = useTheme()
  useLocale()

  const tabs = [
    { to: paths.launcher(), label: translate('app.navigation.models'), active: route.name === 'launcher' || route.name === 'model' },
    { to: paths.chat(), label: translate('app.navigation.chat'), active: route.name === 'chat' },
    {
      to: paths.quickRuns(),
      label: translate('quickRuns.navigation'),
      active: route.name === 'quickRuns',
    },
    {
      to: paths.recipes(),
      label: translate('recipes.navigation'),
      active: route.name === 'recipes',
    },
    {
      to: paths.attachments(),
      label: translate('attachments.navigation'),
      active: route.name === 'attachments',
    },
    {
      to: paths.projects(),
      label: translate('projects.navigation'),
      active: route.name === 'projects' || route.name === 'projectChat',
    },
    { to: paths.settings(), label: translate('app.navigation.settings'), active: route.name === 'settings' },
    { to: paths.inspector(), label: translate('inspector.navigation'), active: route.name === 'inspector' },
  ]

  const nextTheme = preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark'
  const themeLabel = {
    dark: translate('theme.dark'),
    light: translate('theme.light'),
    system: translate('theme.system'),
  }[preference]

  return (
    <header className="sticky top-0 z-30 flex h-11 w-full min-w-0 shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--bg)]/85 px-2 backdrop-blur-md sm:gap-4 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-4">
        <Link to={paths.launcher()} className="shrink-0 text-xs font-semibold tracking-tight">
          {PRODUCT_NAME}
        </Link>
        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={tab.active ? 'page' : undefined}
              className={cx(
                'rounded-md px-1.5 py-1 text-xs font-medium transition-colors sm:px-2',
                tab.active
                  ? 'bg-[var(--bg-inset)] text-[var(--fg)]'
                  : 'text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]',
              )}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setPreference(nextTheme)}
        title={translate('app.theme.switch', { theme: themeLabel })}
        aria-label={translate('app.theme.current', { theme: themeLabel })}
        className="shrink-0 px-1.5 sm:px-2"
      >
        {preference === 'dark' ? '◐' : preference === 'light' ? '◑' : '◒'}
        <span className="hidden sm:inline">{themeLabel}</span>
      </Button>
    </header>
  )
}
