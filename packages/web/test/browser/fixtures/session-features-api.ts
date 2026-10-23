/**
 * Shared mock node for the U1 session-feature specs (new-session screen, finished-unseen
 * indicator, ephemeral side chat). Every handler reads the mutable fixture at request time, so
 * a test can change the world (sessions finish, the node drops) between steps and count each
 * request exactly.
 */
import { PROJECT_PRESENTATION_VERSION, SESSION_ROUTES, type SessionPageItem } from '@guanxi/contract'
import type { Page, Route } from '@playwright/test'
import { browserSettings, runtimeBrowserSnapshot } from './runtime-snapshot.ts'

const observedAt = '2026-10-22T12:00:00.000Z'
export const FIXTURE_CONNECTION = '11111111-1111-4111-8111-111111111111'
export const FIXTURE_LOCAL_CONNECTION = '22222222-2222-4222-8222-222222222222'

const health = {
  ok: true,
  appVersion: 'test',
  application: { state: 'reachable', source: 'application_http', observedAt },
  ollama: {
    installed: true, installSource: 'runtime_response', running: true, state: 'reachable',
    source: 'ollama_api_version', observedAt, version: 'test', host: 'http://127.0.0.1:11434', installHint: null,
  },
  hardware: {
    platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8, totalMemoryBytes: 16_000_000_000,
    usableMemoryBytes: 12_000_000_000, accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null,
  },
  network: { ollamaComReachable: null, checkedAt: null, status: 'unknown', source: 'not_checked' },
}

export const fixtureConnection = (id = FIXTURE_CONNECTION, name = 'Fixture model', kind: 'model_api' | 'local_runtime' = 'model_api') => ({
  id, accountId: 'local', name, kind, provider: kind === 'model_api' ? 'deepseek' : 'ollama', auth: kind === 'model_api' ? 'api_key' : 'none',
  unattended: false, secretRef: null, facts: {}, balance: null, createdAt: '2026-10-21T00:00:00.000Z',
})
export const fixtureProject = (id: string, name: string, workspaceIds: string[] = []) => ({
  id, name, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
  filesystemBindings: workspaceIds.map(workspaceId => ({ workspaceId })),
})
export const fixtureWorkspace = (id: string, name: string, exists = true) => ({
  id, name, rootPath: `/fixture/${id}`, createdAt: '2026-10-21T00:00:00.000Z', lastUsedAt: null, exists,
})
export const nativeSession = (sessionId: string, title: string, state: 'working' | 'completed' | 'failed' | 'input_required', lastSeq: number, observed = observedAt): SessionPageItem => ({
  sessionId, kind: 'agent', threadId: null, title, createdAt: '2026-10-22T10:00:00.000Z', lastSeq, lastEventAt: observed,
  execution: { state, attemptState: state === 'completed' ? 'completed' : 'started', source: 'run-home', observedAt: observed, confidence: 'observed' },
  navigation: { kind: 'native', sessionId },
})

export interface SessionFeaturesFixture {
  locale: 'en' | 'ru'
  theme: 'light' | 'dark' | 'system'
  projects: unknown[]
  connections: unknown[]
  workspaces: unknown[] | 'fail'
  sessions: SessionPageItem[]
  /** Answers `POST /api/agent`; defaults to a 202 with `session-1`. */
  create(body: unknown): { status: number; body: unknown }
  /** Native progress bodies by session id. */
  progress: Record<string, unknown>
  /** `down` aborts every agent and connection request as a refused connection. */
  agentNetwork: 'up' | 'down'
  /** While set, `GET /api/agent/projects` waits for this promise. */
  holdProjects: Promise<void> | null
  requests: { create: unknown[]; projects: number; sessionPages: number; patch: unknown[] }
  /** Extra routes first; return true when handled. */
  extra?(route: Route, url: URL, method: string): Promise<boolean> | boolean
}

export function createSessionFeaturesFixture(overrides: Partial<SessionFeaturesFixture> = {}): SessionFeaturesFixture {
  return {
    locale: 'en', theme: 'light',
    projects: [fixtureProject('p', 'Alpha'), fixtureProject('q', 'Beta', ['w1'])],
    connections: [fixtureConnection()],
    workspaces: [fixtureWorkspace('w1', 'Repo'), fixtureWorkspace('w2', 'Docs')],
    sessions: [], progress: {}, agentNetwork: 'up', holdProjects: null,
    create: () => ({ status: 202, body: { sessionId: 'session-1' } }),
    requests: { create: [], projects: 0, sessionPages: 0, patch: [] },
    ...overrides,
  }
}

export async function installSessionFeaturesApi(page: Page, fixture: SessionFeaturesFixture): Promise<void> {
  const finish = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (fixture.extra && await fixture.extra(route, url, method)) return
    const path = url.pathname
    if (path === '/api/health') return finish(route, health)
    if (path === '/api/settings') return finish(route, browserSettings({ locale: fixture.locale, localeSource: 'user_setting', theme: fixture.theme }))
    if (path === '/api/runtime') return finish(route, runtimeBrowserSnapshot())
    if (path === SESSION_ROUTES.page()) {
      fixture.requests.sessionPages++
      return finish(route, { sessions: fixture.sessions, nextCursor: null, omitted: { withheld: false, catchingUp: false } })
    }
    if (path === '/api/models') return finish(route, { models: [] })
    if (path === '/api/threads' && method === 'GET') return finish(route, { ownershipVersion: 1, scope: 'projectless', chats: [] })
    if (path === '/api/projects') return finish(route, { presentationVersion: PROJECT_PRESENTATION_VERSION, projects: [] })
    if (path === '/api/layouts/context') return finish(route, { account: 'local', replication: false })
    if (path === '/api/layouts') {
      if (method === 'PUT') return finish(route, { document: (request.postDataJSON() as { document: unknown }).document, recovered: [] })
      return finish(route, { documents: [], active: [] })
    }
    if (path === '/api/layouts/geometry') return finish(route, method === 'PUT' ? { geometry: request.postDataJSON() } : { geometry: {} })
    const agentOrConnection = path === '/api/workspaces' || path === '/api/connections' || path.startsWith('/api/agent')
    if (agentOrConnection && fixture.agentNetwork === 'down') return route.abort('connectionrefused')
    if (path === '/api/workspaces') {
      return fixture.workspaces === 'fail'
        ? finish(route, { code: 'internal_error', message: 'workspaces', details: null }, 500)
        : finish(route, { workspaces: fixture.workspaces })
    }
    if (path === '/api/connections') return finish(route, { connections: fixture.connections, costs: [], vault: { unlocked: false, unattendedAvailable: false } })
    if (path === '/api/agent/projects') {
      fixture.requests.projects++
      if (fixture.holdProjects) await fixture.holdProjects
      return finish(route, { projects: fixture.projects })
    }
    if (path.startsWith('/api/agent/projects/') && method === 'PATCH') {
      fixture.requests.patch.push(request.postDataJSON())
      return finish(route, {})
    }
    if (path === '/api/agent' && method === 'POST') {
      const body: unknown = request.postDataJSON()
      fixture.requests.create.push(body)
      const answer = fixture.create(body)
      return finish(route, answer.body, answer.status)
    }
    const progress = /^\/api\/agent\/([^/]+)$/u.exec(path)
    if (progress && method === 'GET' && fixture.progress[decodeURIComponent(progress[1] ?? '')]) {
      return finish(route, fixture.progress[decodeURIComponent(progress[1] ?? '')])
    }
    return finish(route, { code: 'internal_error', message: `Unhandled fixture route ${method} ${path}`, details: null }, 500)
  })
}

export function completedProgress(sessionId: string, summary = 'Fixture response') {
  return {
    sessionId, projectId: 'p', connectionId: FIXTURE_CONNECTION, model: 'fixture', mode: 'read-only', status: 'completed',
    plan: [{ text: 'Fixture item', status: 'verification_requested' }], queue: [], summary, error: null,
    source: 'session.log', confidence: 'high', observedAt: '2026-10-21T00:00:00.000Z',
  }
}
