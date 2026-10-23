/**
 * A stateful in-memory stand-in for the node's `/api/voice/glossary` surface, shared by the
 * component tests (a `fetch` stub) and the browser specs (a Playwright route). It follows the
 * store's rules closely enough that flows behave like the real thing: one revision row per
 * mutation, revert to the previous revision's entry, inactive entries cannot be edited, a key
 * collision answers `422 glossary_invalid` with a code-only body and changes nothing, and the
 * preview hash is a SHA-256 over the effective ids and revisions.
 *
 * It is not the production matcher: replacement is whole-word, case-insensitive and supports the
 * D-157 shape (`пиара` -> `PR-а`) so the UI has realistic offsets to highlight.
 */
import { createHash } from 'node:crypto'
import {
  createGlossaryEntryBodySchema,
  glossaryPreviewBodySchema,
  updateGlossaryEntryBodySchema,
  type GlossaryEntryWire,
  type StoredGlossaryEntryWire,
} from '@guanxi/contract'

type Op = 'create' | 'update' | 'deactivate' | 'reactivate' | 'revert'
interface Revision { entryId: string; revision: number; op: Op; entry: GlossaryEntryWire | null; source: 'user' | 'import' | 'candidate'; createdAt: number }
export interface NodeRequest { method: string; path: string; query: Record<string, string>; body: unknown }
export interface NodeAnswer { status: number; body: unknown }
/** Without a `code` the answer has no body, like a proxy or gateway that cannot reach the node. */
export type FailureRule = { status: number; code?: string; once?: boolean } | 'abort'

const ENDINGS = 'аеиоуыэюяй'
const key = (value: string) => value.toLowerCase()

export interface GlossaryNode {
  entries: Map<string, StoredGlossaryEntryWire>
  revisions: Map<string, Revision[]>
  requests: NodeRequest[]
  /** Next answer for `METHOD /path-template` (e.g. `POST /revert`), consumed when `once` is set. */
  fail: Map<string, FailureRule>
  /** While set, `GET /` answers with the snapshot it took, but only once this promise settles. */
  holdList: Promise<void> | null
  /** While set, `POST /apply-preview` waits for this promise before answering. */
  holdPreview: Promise<void> | null
  /** `handle` returns `'abort'` for every request while down. */
  down: boolean
  seed(entry: Partial<GlossaryEntryWire> & { canonical: string }, options?: { id?: string; scope?: 'account' | 'project'; projectId?: string | null; active?: boolean }): StoredGlossaryEntryWire
  handle(method: string, rawPath: string, rawBody: unknown): Promise<NodeAnswer | 'abort'>
  count(method: string, suffix: string): number
}

export function createGlossaryNode(): GlossaryNode {
  let clock = Date.parse('2026-10-22T12:00:00.000Z')
  let counter = 0
  const tick = () => (clock += 60_000)
  const entries = new Map<string, StoredGlossaryEntryWire>()
  const revisions = new Map<string, Revision[]>()
  const node: GlossaryNode = {
    entries, revisions, requests: [], fail: new Map(), holdList: null, holdPreview: null, down: false,
    seed(entry, options = {}) {
      const id = options.id ?? `gl_seed_${++counter}`
      const body = normalize({ id, canonical: entry.canonical, variants: entry.variants ?? [], language: entry.language ?? 'en', caseSensitive: entry.caseSensitive, inflect: entry.inflect })
      const now = tick()
      const scope = options.scope ?? 'account'
      const stored: StoredGlossaryEntryWire = { id, scope, projectId: scope === 'project' ? options.projectId ?? null : null, entry: body, active: true, revision: 1, createdAt: now, updatedAt: now }
      entries.set(id, stored)
      revisions.set(id, [{ entryId: id, revision: 1, op: 'create', entry: body, source: 'user', createdAt: now }])
      if (options.active === false) mutate(id, 'deactivate')
      return entries.get(id) as StoredGlossaryEntryWire
    },
    count: (method, suffix) => node.requests.filter((request) => request.method === method && request.path.endsWith(suffix)).length,
    async handle(method, rawPath, rawBody) {
      const url = new URL(rawPath, 'http://node.test')
      const path = url.pathname.replace(/^\/api\/voice\/glossary/u, '') || '/'
      const query = Object.fromEntries(url.searchParams)
      node.requests.push({ method, path, query, body: rawBody })
      if (node.down) return 'abort'
      const template = path === '/' || path === '/apply-preview' ? path : path.replace(/^\/[^/]+/u, '/:id')
      const rule = node.fail.get(`${method} ${template}`)
      if (rule === 'abort') return 'abort'
      if (rule) {
        if (rule.once) node.fail.delete(`${method} ${template}`)
        return { status: rule.status, body: rule.code === undefined ? null : { code: rule.code } }
      }
      if (method === 'GET' && path === '/') {
        const includeInactive = query.includeInactive === 'true'
        const list = structuredClone([...entries.values()].filter((stored) => (includeInactive || stored.active)
          && (query.projectId === undefined || stored.scope === 'account' || stored.projectId === query.projectId)))
        if (node.holdList) await node.holdList // the snapshot above is what a slow read answers with
        return { status: 200, body: { entries: list } }
      }
      if (method === 'POST' && path === '/') {
        const parsed = createGlossaryEntryBodySchema.safeParse(rawBody)
        if (!parsed.success) return { status: 400, body: { code: 'validation_failed' } }
        const body = parsed.data
        const id = body.id ?? `gl_new_${++counter}`
        if (entries.has(id)) return { status: 409, body: { code: 'entry_exists' } }
        const entry = normalize({ ...body.entry, id })
        const scope = body.scope
        const projectId = scope === 'project' ? body.projectId ?? null : null
        if (!compatible(entry, scope, projectId, id)) return { status: 422, body: { code: 'glossary_invalid' } }
        const now = tick()
        const stored: StoredGlossaryEntryWire = { id, scope, projectId, entry, active: true, revision: 1, createdAt: now, updatedAt: now }
        entries.set(id, stored)
        revisions.set(id, [{ entryId: id, revision: 1, op: 'create', entry, source: 'user', createdAt: now }])
        return { status: 201, body: stored }
      }
      if (method === 'POST' && path === '/apply-preview') {
        const parsed = glossaryPreviewBodySchema.safeParse(rawBody)
        if (!parsed.success) return { status: 400, body: { code: 'validation_failed' } }
        if (node.holdPreview) await node.holdPreview
        return { status: 200, body: preview(parsed.data.text, parsed.data.projectId ?? null) }
      }
      const match = /^\/([^/]+)(?:\/(deactivate|reactivate|revert|history))?$/u.exec(path)
      if (!match) return { status: 404, body: { code: 'entry_not_found' } }
      const id = decodeURIComponent(match[1] as string)
      const stored = entries.get(id)
      if (!stored) return { status: 404, body: { code: 'entry_not_found' } }
      const action = match[2]
      if (method === 'GET' && action === 'history') return { status: 200, body: { revisions: revisions.get(id) } }
      if (method === 'PUT' && action === undefined) {
        const parsed = updateGlossaryEntryBodySchema.safeParse(rawBody)
        if (!parsed.success) return { status: 400, body: { code: 'validation_failed' } }
        if (!stored.active) return { status: 409, body: { code: 'entry_inactive' } }
        const entry = normalize({ ...parsed.data.entry, id })
        if (!compatible(entry, stored.scope, stored.projectId, id)) return { status: 422, body: { code: 'glossary_invalid' } }
        return { status: 200, body: mutate(id, 'update', entry) }
      }
      if (method === 'POST' && action === 'deactivate') return stored.active ? { status: 200, body: mutate(id, 'deactivate') } : { status: 409, body: { code: 'already_inactive' } }
      if (method === 'POST' && action === 'reactivate') {
        if (stored.active) return { status: 409, body: { code: 'already_active' } }
        // The store validates the effective sets a mutation could change, reactivation included.
        if (!compatible(stored.entry, stored.scope, stored.projectId, id)) return { status: 422, body: { code: 'glossary_invalid' } }
        return { status: 200, body: mutate(id, 'reactivate') }
      }
      if (method === 'POST' && action === 'revert') {
        const target = revertTarget(id)
        if (target.active && !compatible(target.entry, stored.scope, stored.projectId, id)) return { status: 422, body: { code: 'glossary_invalid' } }
        return { status: 200, body: mutate(id, 'revert') }
      }
      return { status: 404, body: { code: 'entry_not_found' } }
    },
  }

  /** Same rule as the store: forms may not collide inside one effective set; a project entry hides an account entry of the same canonical term. */
  function compatible(entry: GlossaryEntryWire, scope: 'account' | 'project', projectId: string | null, ownId: string): boolean {
    if (/[!?]/u.test(entry.canonical) || entry.variants.some((variant) => /[!?]/u.test(variant))) return false
    const forms = (value: GlossaryEntryWire) => [value.canonical, ...value.variants].map(key)
    const mine = forms(entry)
    if (new Set(mine).size !== mine.length) return false
    for (const other of entries.values()) {
      if (other.id === ownId || !other.active) continue
      const sameSet = other.scope === 'account' || scope === 'account' || other.projectId === projectId
      if (!sameSet) continue
      if (other.scope !== scope && key(other.entry.canonical) === key(entry.canonical)) continue
      if (forms(other.entry).some((form) => mine.includes(form))) return false
    }
    return true
  }

  function replayActive(history: readonly Revision[], target: number): boolean {
    const activeBy = new Map<number, boolean>()
    for (const row of history) {
      if (row.revision > target) break
      let active: boolean
      if (row.op === 'deactivate') active = false
      else if (row.op === 'revert') {
        let reverted: Revision | null = null
        for (const candidate of history) { if (candidate.revision >= row.revision - 1) break; if (candidate.entry !== null) reverted = candidate }
        active = reverted === null ? false : activeBy.get(reverted.revision) ?? false
      } else active = true
      activeBy.set(row.revision, active)
    }
    return activeBy.get(target) ?? false
  }

  /** The store always writes explicit flags (`compileGlossary` defaults them), so the wire carries them. */
  function normalize(entry: Omit<GlossaryEntryWire, 'caseSensitive' | 'inflect'> & { caseSensitive?: boolean | undefined; inflect?: boolean | undefined }): GlossaryEntryWire {
    return { id: entry.id, canonical: entry.canonical, variants: [...entry.variants], language: entry.language, caseSensitive: entry.caseSensitive ?? false, inflect: entry.inflect ?? true }
  }

  function revertTarget(id: string): { entry: GlossaryEntryWire; active: boolean } {
    const current = entries.get(id) as StoredGlossaryEntryWire
    const previous = (revisions.get(id) as Revision[]).filter((row) => row.revision < current.revision)
    let target: Revision | null = null
    for (const row of previous) if (row.entry !== null) target = row
    return { entry: target?.entry ?? current.entry, active: target === null ? false : replayActive(previous, target.revision) }
  }

  function mutate(id: string, op: Exclude<Op, 'create'>, next?: GlossaryEntryWire): StoredGlossaryEntryWire {
    const current = entries.get(id) as StoredGlossaryEntryWire
    const history = revisions.get(id) as Revision[]
    const revision = current.revision + 1
    const now = tick()
    let entry = current.entry
    let active = current.active
    if (op === 'update') entry = next as GlossaryEntryWire
    else if (op === 'deactivate') active = false
    else if (op === 'reactivate') active = true
    else ({ entry, active } = revertTarget(id))
    const stored: StoredGlossaryEntryWire = { ...current, entry, active, revision, updatedAt: now }
    entries.set(id, stored)
    history.push({ entryId: id, revision, op, entry, source: 'user', createdAt: now })
    return stored
  }

  function effective(projectId: string | null): StoredGlossaryEntryWire[] {
    const active = [...entries.values()].filter((stored) => stored.active)
    const project = active.filter((stored) => stored.scope === 'project' && stored.projectId === projectId && projectId !== null)
    const hidden = new Set(project.map((stored) => key(stored.entry.canonical)))
    return [...project, ...active.filter((stored) => stored.scope === 'account' && !hidden.has(key(stored.entry.canonical)))]
  }

  function preview(text: string, projectId: string | null) {
    const set = effective(projectId)
    const forms = set.flatMap((stored) => [stored.entry.canonical, ...stored.entry.variants].map((form) => ({ form, stored })))
      .sort((a, b) => b.form.length - a.form.length)
    const replacements: Array<{ start: number; end: number; original: string; replacement: string; entryId: string }> = []
    const taken: Array<[number, number]> = []
    for (const { form, stored } of forms) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${form.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(\\p{L}?)(?![\\p{L}\\p{N}])`, 'giu')
      for (const found of text.matchAll(pattern)) {
        const start = found.index ?? 0
        const ending = found[1] ?? ''
        const inflected = ending !== '' && ENDINGS.includes(ending.toLowerCase()) && /\p{Script=Cyrillic}/u.test(form)
          && /\p{Script=Latin}/u.test(stored.entry.canonical) && stored.entry.language === 'en' && stored.entry.inflect !== false && stored.entry.caseSensitive !== true
        if (ending !== '' && !inflected) continue
        const end = start + found[0].length
        if (taken.some(([a, b]) => start < b && end > a)) continue
        taken.push([start, end])
        replacements.push({ start, end, original: found[0], replacement: inflected ? `${stored.entry.canonical}-${ending}` : stored.entry.canonical, entryId: stored.id })
      }
    }
    replacements.sort((a, b) => a.start - b.start)
    let output = ''
    let cursor = 0
    for (const replacement of replacements) { output += text.slice(cursor, replacement.start) + replacement.replacement; cursor = replacement.end }
    output += text.slice(cursor)
    const identity = set.map((stored) => ({ id: stored.id, revision: stored.revision })).sort((a, b) => a.id.localeCompare(b.id))
    return { text: output, replacements, glossaryRevision: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), entryCount: set.length }
  }
  return node
}

/** `fetch` stub for jsdom tests: answers the glossary routes and defers everything else to `other`. */
export function glossaryFetch(node: GlossaryNode, other: (path: string, init?: RequestInit) => Response | Promise<Response> = (path) => { throw new Error(`Unexpected request ${path}`) }) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input)
    if (!path.startsWith('/api/voice/glossary')) return other(path, init)
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
    const answer = await node.handle(init?.method ?? 'GET', path, body)
    if (answer === 'abort') throw new TypeError('Failed to fetch')
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return answer.body === null ? new Response(null, { status: answer.status }) : Response.json(answer.body, { status: answer.status })
  }
}
