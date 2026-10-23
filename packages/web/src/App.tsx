/**
 * Корень приложения: проверка здоровья, продуктовый shell и разбор маршрута.
 */
import { lazy, Suspense, useState } from 'react'
import { api } from './lib/api.ts'
import { useAsync } from './lib/useAsync.ts'
import { Link, paths, useRoute } from './lib/router.tsx'
import { EmptyState } from './components/ui.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { HealthLoading, HealthUnreachable } from './features/health/HealthGate.tsx'
import { RuntimeProvider } from './features/health/RuntimeContext.tsx'
import { MountedShell } from './features/shell/MountedShell.tsx'
import { LauncherPage } from './features/launcher/LauncherPage.tsx'
import { ModelPage } from './features/models/ModelPage.tsx'
import { ChatPage } from './features/chat/ChatPage.tsx'
import { SettingsPage } from './features/settings/SettingsPage.tsx'
import { DeveloperCatalogPage } from './features/catalog/DeveloperCatalogPage.tsx'
import { ProjectsPage } from './features/projects/ProjectsPage.tsx'
import { QuickRunsPage } from './features/quick-runs/QuickRunsPage.tsx'
import { RecipesPage } from './features/recipes/RecipesPage.tsx'
import { AttachmentsPage } from './features/attachments/AttachmentsPage.tsx'
import { InspectorPage } from './features/inspector/InspectorPage.tsx'
import { NativeAgentPage } from './features/native-agent/NativeAgentPage.tsx'
import { UiLocaleProvider } from '@guanxi/ui'
import { translate } from './lib/locale.ts'
import { useLocale } from './lib/locale-context.tsx'

const Workspace = lazy(() => import('./features/workspace/Workspace.tsx').then(module => ({ default: module.Workspace })))

export function App() {
  const { locale } = useLocale()
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
    <UiLocaleProvider locale={locale}>
    <RuntimeProvider>
      <MountedShell health={data} retrying={retrying} onRetry={retry}>
        {route.name === 'workspace' && <Suspense fallback={<div role="status">{translate('workspaceLayout.loading')}</div>}><Workspace key={route.projectId ?? 'local'} project={route.projectId} safeMode={new URLSearchParams(window.location.search).get('safe') === '1'}><ChatPage threadId={route.threadId} projectId={route.projectId} health={data} workspace /></Workspace></Suspense>}
        {route.name === 'launcher' && <LauncherPage health={data} />}
        {route.name === 'agent' && <NativeAgentPage key={route.sessionId ?? 'new'} sessionId={route.sessionId} />}
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
        {route.name === 'developerComponents' && <DeveloperCatalogPage />}
        {route.name === 'projects' && <ProjectsPage />}
        {route.name === 'inspector' && <InspectorPage sessionId={route.sessionId} />}
        {route.name === 'notFound' && (
          <EmptyState
            title={translate('app.notFound.title')}
            description={route.path}
            action={
              <Link
                to={paths.launcher()}
                className="text-xs text-accent underline underline-offset-2"
              >
                {translate('app.notFound.home')}
              </Link>
            }
          />
        )}
      </MountedShell>
    </RuntimeProvider>
    </UiLocaleProvider>
  )
}
