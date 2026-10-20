/**
 * Lazily loaded catalog chunk: the @guanxi/ui catalog with this app's theme, locale, URL and
 * the node's review API.
 */
import { useCallback, useMemo } from 'react'
import {
  CatalogApp,
  DEFAULT_REGIME,
  catalogEntries,
  regimeFromSearch,
  storySources,
  type CatalogView,
  type Regime,
} from '@guanxi/ui/catalog'
import { useLocale } from '../../lib/locale-context.tsx'
import { useTheme } from '../../lib/theme.tsx'
import { createReviewApi } from './review-api.ts'

function initialView(search: URLSearchParams): CatalogView {
  const component = search.get('component')
  if (component && catalogEntries.some((entry) => entry.id === component)) return { kind: 'component', id: component }
  if (search.get('view') === 't2') return { kind: 't2' }
  return { kind: 'overview' }
}

function locationFor(view: CatalogView, regime: Regime): string {
  const search = new URLSearchParams()
  if (view.kind === 'component') search.set('component', view.id)
  if (view.kind === 't2') search.set('view', 't2')
  for (const key of Object.keys(DEFAULT_REGIME) as Array<keyof Regime>) {
    if (regime[key] !== DEFAULT_REGIME[key]) search.set(key, regime[key])
  }
  const query = search.toString()
  return `${window.location.pathname}${query ? `?${query}` : ''}`
}

export default function CatalogRoute() {
  const { locale } = useLocale()
  const { resolved } = useTheme()
  const search = useMemo(() => new URLSearchParams(window.location.search), [])
  const reviewApi = useMemo(createReviewApi, [])
  // Keeps the address shareable (a link to one component in one regime) without a navigation.
  const onLocationChange = useCallback((view: CatalogView, regime: Regime) => {
    const next = locationFor(view, regime)
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, '', next)
  }, [])
  return (
    <CatalogApp
      entries={catalogEntries}
      storySources={storySources}
      chromeTheme={resolved}
      chromeLocale={locale}
      reviewApi={reviewApi}
      initialView={initialView(search)}
      initialRegime={regimeFromSearch(search)}
      onLocationChange={onLocationChange}
      reviewBinding={import.meta.env.DEV ? 'live' : 'bundle'}
    />
  )
}
