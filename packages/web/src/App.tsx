/**
 * Корень приложения: проверка здоровья, шапка, разбор маршрута.
 */
import { useState } from 'react'
import { api } from './lib/api.ts'
import { useAsync } from './lib/useAsync.ts'
import { Link, paths, useRoute } from './lib/router.tsx'
import { useTheme } from './lib/theme.tsx'
import { Button, Callout, EmptyState, cx } from './components/ui.tsx'
import {
  HealthLoading,
  HealthUnreachable,
  OllamaUnavailable,
} from './features/health/HealthGate.tsx'
import { LauncherPage } from './features/launcher/LauncherPage.tsx'
import { ModelPage } from './features/models/ModelPage.tsx'
import { ChatPage } from './features/chat/ChatPage.tsx'
import { SettingsPage } from './features/settings/SettingsPage.tsx'

export function App() {
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

  const ollamaUnavailable = !data.ollama.installed || !data.ollama.running

  // Каталог без Ollama бесполезен, но история и настройки должны оставаться доступны.
  if (ollamaUnavailable && route.name !== 'chat' && route.name !== 'settings') {
    return <OllamaUnavailable health={data} onRetry={retry} retrying={retrying} />
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <main className="flex-1">
        {ollamaUnavailable && route.name === 'settings' && (
          <div className="px-3 pt-3">
            <Callout
              tone="warning"
              title={data.ollama.installed ? 'Ollama не запущена' : 'Ollama не установлена'}
              action={
                <Button size="sm" onClick={retry} loading={retrying}>
                  Проверить
                </Button>
              }
            >
              История и настройки доступны, генерация временно выключена.
            </Callout>
          </div>
        )}
        {route.name === 'launcher' && <LauncherPage health={data} />}
        {route.name === 'model' && <ModelPage name={route.modelName} health={data} />}
        {route.name === 'chat' && <ChatPage threadId={route.threadId} health={data} />}
        {route.name === 'settings' && <SettingsPage />}
        {route.name === 'notFound' && (
          <EmptyState
            title="Страница не найдена"
            description={route.path}
            action={
              <Link
                to={paths.launcher()}
                className="text-xs text-[var(--accent)] underline underline-offset-2"
              >
                На главную
              </Link>
            }
          />
        )}
      </main>
    </div>
  )
}

function TopBar() {
  const route = useRoute()
  const { preference, setPreference } = useTheme()

  const tabs = [
    { to: paths.launcher(), label: 'Модели', active: route.name === 'launcher' || route.name === 'model' },
    { to: paths.chat(), label: 'Чат', active: route.name === 'chat' },
    { to: paths.settings(), label: 'Настройки', active: route.name === 'settings' },
  ]

  const nextTheme = preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark'
  const themeLabel = { dark: 'Тёмная', light: 'Светлая', system: 'Системная' }[preference]

  return (
    <header className="sticky top-0 z-30 flex h-11 shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--bg)]/85 px-4 backdrop-blur-md">
      <div className="flex items-center gap-4">
        <Link to={paths.launcher()} className="text-xs font-semibold tracking-tight">
          Alamo
        </Link>
        <nav className="flex items-center gap-0.5">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={tab.active ? 'page' : undefined}
              className={cx(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
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
        title={`Тема: ${themeLabel}. Нажмите, чтобы переключить.`}
        aria-label={`Тема: ${themeLabel}`}
      >
        {preference === 'dark' ? '◐' : preference === 'light' ? '◑' : '◒'} {themeLabel}
      </Button>
    </header>
  )
}
