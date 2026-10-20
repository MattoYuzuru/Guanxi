import { parseReviewRecord, type ReviewRecord } from './approval/record.ts'
import { parseDocs, type ComponentDocs } from './docs.ts'
import type { CatalogManifest, ManifestComponent } from './manifest-types.ts'
import type { AnyStory, AnyStoryMeta } from './StoryView.tsx'

export interface CatalogStory {
  /** `<component id>--<state>`, stable across reloads and used in URLs and test ids. */
  key: string
  name: string
  meta: AnyStoryMeta
  story: AnyStory
}

export interface CatalogEntry {
  id: string
  title: string
  level: 'primitive' | 'pattern'
  docs: ComponentDocs
  docsSource: string
  stories: CatalogStory[]
  review: ReviewRecord | null
  manifest: ManifestComponent | null
}

type StoryModule = Record<string, unknown> & { default: AnyStoryMeta }

function folderId(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 2] ?? path
}

function order(states: string[], name: string): number {
  const index = states.indexOf(name)
  return index === -1 ? states.length : index
}

function isStory(value: unknown): value is AnyStory {
  return typeof value === 'object' && value !== null && typeof (value as AnyStory).name === 'string'
}

/** Joins Vite glob results into catalog entries, ordered primitives first, then by title. */
export function buildEntries(
  storyModules: Record<string, unknown>,
  docsModules: Record<string, unknown>,
  reviewModules: Record<string, unknown>,
  manifest: CatalogManifest | null,
): CatalogEntry[] {
  const docsById = new Map(Object.entries(docsModules).map(([path, source]) => [folderId(path), String(source)]))
  const reviewById = new Map(Object.entries(reviewModules).map(([path, json]) => [folderId(path), json]))
  const manifestById = new Map((manifest?.components ?? []).map((component) => [component.id, component]))
  const entries: CatalogEntry[] = []
  for (const [path, raw] of Object.entries(storyModules)) {
    const module = raw as StoryModule
    const id = folderId(path)
    const docsSource = docsById.get(id) ?? ''
    const docs = parseDocs(docsSource)
    const parsedReview = reviewById.has(id) ? parseReviewRecord(reviewById.get(id), id) : null
    const stories = Object.entries(module)
      .filter(([name, value]) => name !== 'default' && isStory(value))
      .map(([, value]) => value as AnyStory)
      .map((story) => ({ key: `${id}--${story.name}`, name: story.name, meta: module.default, story }))
      // Namespace objects list exports alphabetically; show states in their declared order.
      .sort((a, b) => order(docs.states, a.name) - order(docs.states, b.name))
    entries.push({
      id,
      title: docs.title ?? module.default.title.split('/').pop() ?? id,
      level: docs.level ?? 'primitive',
      docs,
      docsSource,
      stories,
      review: parsedReview?.ok ? parsedReview.record : null,
      manifest: manifestById.get(id) ?? null,
    })
  }
  return entries.sort((a, b) =>
    a.level === b.level ? a.title.localeCompare(b.title) : a.level === 'primitive' ? -1 : 1,
  )
}
