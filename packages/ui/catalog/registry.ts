/**
 * Product catalog registry: every component folder's stories, docs and review record, read
 * through Vite globs. Only the lazily loaded catalog chunk imports this module.
 */
import { buildEntries, type CatalogEntry } from './entries.ts'
import manifest from './manifest.json'
import type { CatalogManifest } from './manifest-types.ts'

const stories = import.meta.glob(
  ['../src/components/*/*.stories.tsx', '!../src/components/*/*.test.stories.tsx'],
  { eager: true },
)
const docs = import.meta.glob('../src/components/*/*.docs.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})
const reviews = import.meta.glob('../src/components/*/*.review.json', {
  eager: true,
  import: 'default',
})

export const catalogEntries: CatalogEntry[] = buildEntries(
  stories,
  docs,
  reviews,
  manifest as unknown as CatalogManifest,
)
