/**
 * Минимальный роутер на History API.
 *
 * Почему не react-router: у приложения пять экранов, нет вложенных layout-ов,
 * нет загрузчиков данных и нет code-splitting по маршрутам. Всё, что нужно —
 * «прочитать путь, подписаться на его изменения, перейти» — это файл ниже.
 * Тянуть роутер целиком ради этого смысла нет.
 */
import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from 'react'

type Listener = () => void

const listeners = new Set<Listener>()

function currentPath(): string {
  return window.location.pathname + window.location.search
}

function notify() {
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === currentPath()) return
  if (options.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  notify()
}

export function goBack(): void {
  window.history.back()
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify)
}

/* ─────────────────────────────── Разбор пути ──────────────────────────── */

export type Route =
  | { name: 'workspace'; threadId: string | null; projectId?: string }
  | { name: 'agent'; sessionId: string | null }
  | { name: 'launcher' }
  | { name: 'model'; modelName: string }
  | { name: 'chat'; threadId: string | null }
  | { name: 'quickRuns' }
  | { name: 'recipes' }
  | { name: 'attachments' }
  | { name: 'projectChat'; projectId: string; threadId: string | null }
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'developerComponents' }
  | { name: 'voiceGlossary' }
  | { name: 'inspector'; sessionId: string | null }
  | { name: 'notifications' }
  | { name: 'notFound'; path: string }

export function parseRoute(pathWithSearch: string): Route {
  const path = pathWithSearch.split('?')[0] ?? '/'
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent)

  if (segments.length === 0) return { name: 'launcher' }

  const first = segments[0] as string
  const rest = segments.slice(1)
  if (first === 'workspace' && rest.length <= 1) return { name: 'workspace', threadId: rest[0] ?? null, projectId: new URLSearchParams(pathWithSearch.split('?')[1]).get('project') ?? undefined }
  if (first === 'agent' && rest.length <= 1) return { name: 'agent', sessionId: rest[0] ?? null }

  if (first === 'models' && rest.length > 0) {
    // Имя модели содержит ':' (llama3.1:8b) — склеиваем остаток обратно.
    return { name: 'model', modelName: rest.join('/') }
  }
  if (first === 'chat') {
    return { name: 'chat', threadId: rest.length > 0 ? (rest[0] as string) : null }
  }
  if (first === 'quick-runs' && rest.length === 0) return { name: 'quickRuns' }
  if (first === 'recipes' && rest.length === 0) return { name: 'recipes' }
  if (first === 'attachments' && rest.length === 0) return { name: 'attachments' }
  if (first === 'projects' && rest.length === 0) return { name: 'projects' }
  if (
    first === 'projects' &&
    (rest.length === 2 || rest.length === 3) &&
    rest[1] === 'chats'
  ) {
    return {
      name: 'projectChat',
      projectId: rest[0] as string,
      threadId: rest.length === 3 ? (rest[2] as string) : null,
    }
  }
  if (first === 'settings' && rest.length === 0) return { name: 'settings' }
  if (first === 'settings' && rest.length === 2 && rest[0] === 'voice' && rest[1] === 'glossary') return { name: 'voiceGlossary' }
  if (first === 'settings' && rest.length === 2 && rest[0] === 'developer' && rest[1] === 'components') {
    return { name: 'developerComponents' }
  }
  if (first === 'notifications' && rest.length === 0) return { name: 'notifications' }
  if (first === 'inspector' && rest.length <= 1) {
    return { name: 'inspector', sessionId: rest.length === 1 ? (rest[0] as string) : null }
  }

  return { name: 'notFound', path }
}

export const paths = {
  workspace: (id?: string | null, project?: string | null) => `/workspace${id ? `/${encodeURIComponent(id)}` : ''}${project ? `?project=${encodeURIComponent(project)}` : ''}`,
  agent: (id?: string | null) => id ? `/agent/${encodeURIComponent(id)}` : '/agent',
  launcher: () => '/',
  model: (name: string) => `/models/${encodeURIComponent(name)}`,
  chat: (threadId?: string | null) =>
    threadId ? `/chat/${encodeURIComponent(threadId)}` : '/chat',
  quickRuns: () => '/quick-runs',
  recipes: () => '/recipes',
  attachments: () => '/attachments',
  projects: () => '/projects',
  projectChat: (projectId: string, threadId?: string | null) => {
    const base = `/projects/${encodeURIComponent(projectId)}/chats`
    return threadId ? `${base}/${encodeURIComponent(threadId)}` : base
  },
  settings: () => '/settings',
  developerComponents: () => '/settings/developer/components',
  voiceGlossary: () => '/settings/voice/glossary',
  notifications: () => '/notifications',
  inspector: (sessionId?: string | null) =>
    sessionId ? `/inspector/${encodeURIComponent(sessionId)}` : '/inspector',
}

/* ──────────────────────────────── Хуки ────────────────────────────────── */

export function useLocation(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/')
}

export function useRoute(): Route {
  const location = useLocation()
  return useMemo(() => parseRoute(location), [location])
}

export function useNavigate() {
  return useCallback((to: string, options?: { replace?: boolean }) => navigate(to, options), [])
}

/* ─────────────────────────────── Ссылка ───────────────────────────────── */

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }

/**
 * Обычный `<a>`, чтобы работали Cmd+клик, «открыть в новой вкладке» и клавиатура.
 * Перехватываем только простой левый клик.
 */
export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }

  return (
    <a {...rest} href={to} onClick={handleClick}>
      {children}
    </a>
  )
}
