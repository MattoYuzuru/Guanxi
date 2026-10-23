/**
 * Playwright wiring for the stateful glossary stand-in node (`test/fixtures/glossary-node.ts`),
 * layered on the shared session-features mock so the shell, settings and project routes answer.
 */
import type { Route } from '@playwright/test'
import { createGlossaryNode, type GlossaryNode } from '../../fixtures/glossary-node.ts'
import { createSessionFeaturesFixture, type SessionFeaturesFixture } from './session-features-api.ts'

export function seedGlossary(node: GlossaryNode): GlossaryNode {
  node.seed({ canonical: 'Hono', variants: ['хоно', 'хона'] }, { id: 'gl_hono' })
  node.seed({ canonical: 'PR', variants: ['пиар'] }, { id: 'gl_pr' })
  node.seed({ canonical: 'Vite', variants: ['вайт'] }, { id: 'gl_vite', scope: 'project', projectId: 'p' })
  return node
}

export function glossaryFixture(node: GlossaryNode, overrides: Partial<SessionFeaturesFixture> = {}): SessionFeaturesFixture {
  const inner = overrides.extra
  return createSessionFeaturesFixture({
    ...overrides,
    extra: async (route: Route, url: URL, method: string) => {
      if (inner && await inner(route, url, method)) return true
      if (!url.pathname.startsWith('/api/voice/glossary')) return false
      const raw = route.request().postData()
      const answer = await node.handle(method, url.pathname + url.search, raw ? JSON.parse(raw) as unknown : undefined)
      if (answer === 'abort') { await route.abort('connectionrefused'); return true }
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: answer.body === null ? '' : JSON.stringify(answer.body) })
      return true
    },
  })
}

export { createGlossaryNode }
