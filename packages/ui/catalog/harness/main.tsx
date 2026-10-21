/**
 * Test harness for the browser gates (G13–G16): renders one story, or the whole catalog,
 * through the same interpreter and regime frames as the in-app catalog, without the app shell
 * or a node. Fixture stories with seeded violations load only with `?fixtures=1`.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../generated/tokens.css'
import { CatalogApp } from '../CatalogApp.tsx'
import { buildEntries, type CatalogEntry } from '../entries.ts'
import manifest from '../manifest.json'
import type { CatalogManifest } from '../manifest-types.ts'
import { RegimeFrame } from '../RegimeFrame.tsx'
import { regimeFromSearch } from '../regimes.ts'
import { StoryBoundary, StoryView } from '../StoryView.tsx'
import { storySources } from '../story-sources.ts'
import './harness.css'

const search = new URLSearchParams(window.location.search)

const componentStories = import.meta.glob(
  ['../../src/components/*/*.stories.tsx', '!../../src/components/*/*.test.stories.tsx'],
  { eager: true },
)
const fixtureStories = import.meta.glob('../../gates/catalog/fixtures/browser/*/*.stories.tsx', {
  eager: true,
})
const docs = import.meta.glob('../../src/components/*/*.docs.md', { eager: true, query: '?raw', import: 'default' })
const reviews = import.meta.glob('../../src/components/*/*.review.json', { eager: true, import: 'default' })

const entries: CatalogEntry[] = buildEntries(
  search.get('fixtures') === '1' ? { ...componentStories, ...fixtureStories } : componentStories,
  docs,
  reviews,
  manifest as unknown as CatalogManifest,
)

declare global {
  interface Window {
    __GUANXI_HARNESS__?: {
      stories: Array<{ key: string; component: string; level: string; frame: string; state: string }>
      ready: boolean
    }
  }
}

window.__GUANXI_HARNESS__ = {
  stories: entries.flatMap((entry) =>
    entry.stories.map((item) => ({
      key: item.key,
      component: entry.id,
      level: entry.level,
      frame: item.story.parameters?.guanxi?.frame ?? item.meta.parameters?.guanxi?.frame ?? 'inline',
      state: item.name,
    })),
  ),
  ready: false,
}

// G13 seeded violation: one semantic token changes, so every baseline must differ.
if (search.get('seed') === 'g13') {
  const style = document.createElement('style')
  style.textContent = "[data-theme] { --color-background-accent: var(--color-background-danger); --color-background-secondary: var(--color-background-hover); }"
  document.head.append(style)
}

const regime = regimeFromSearch(search)
const storyKey = search.get('story')
const item = storyKey ? entries.flatMap((entry) => entry.stories).find((story) => story.key === storyKey) : undefined

function Harness() {
  if (search.get('mode') === 'catalog') {
    return (
      <CatalogApp
        entries={entries}
        chromeTheme={regime.theme.startsWith('dark') ? 'dark' : 'light'}
        chromeLocale={regime.locale === 'ru' ? 'ru' : 'en'}
        reviewApi={null}
        initialRegime={regime}
        storySources={storySources}
      />
    )
  }
  if (!item) return <p data-harness-missing="">{storyKey ?? ''}</p>
  const frame = item.story.parameters?.guanxi?.frame ?? item.meta.parameters?.guanxi?.frame ?? 'inline'
  return (
    <RegimeFrame regime={regime} className="gx-harness-stage">
      <div className="gx-harness-cell" data-frame={frame} data-harness-story={item.key}>
        <StoryBoundary fallback={<p data-story-error="">error</p>}>
          <StoryView meta={item.meta} story={item.story} />
        </StoryBoundary>
      </div>
    </RegimeFrame>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
)

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    if (window.__GUANXI_HARNESS__) window.__GUANXI_HARNESS__.ready = true
  })
})
