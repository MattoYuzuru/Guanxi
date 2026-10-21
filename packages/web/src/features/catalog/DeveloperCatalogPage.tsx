/**
 * Route for Settings → Developer → Components. The catalog is code-split: its chunk (every
 * story, docs file and review record) is requested only after Developer mode is on and this
 * route renders.
 */
import { Component, lazy, Suspense, type ReactNode } from 'react'
import { Button, EmptyState, Skeleton } from '../../components/ui.tsx'
import { translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { Link, paths } from '../../lib/router.tsx'
import { useDeveloperMode } from './developer-mode.ts'

const CatalogRoute = lazy(() => import('./CatalogRoute.tsx'))

/** A failed chunk load or a catalog crash stays inside the route and offers a reload. */
class CatalogBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert">
        <EmptyState
          title={translate('developer.catalog.loadError')}
          action={
            <Button size="sm" onClick={() => window.location.reload()}>
              {translate('developer.catalog.reload')}
            </Button>
          }
        />
      </div>
    )
  }
}

export function DeveloperCatalogPage() {
  useLocale()
  const [developerMode] = useDeveloperMode()
  if (!developerMode) {
    return (
      <EmptyState
        title={translate('developer.catalog.off.title')}
        description={translate('developer.catalog.off.description')}
        action={
          <Link to={paths.settings()} className="text-12 text-accent underline underline-offset-2">
            {translate('developer.catalog.off.action')}
          </Link>
        }
      />
    )
  }
  return (
    <CatalogBoundary>
      <Suspense
        fallback={
          <div className="space-y-3 px-5 py-5" role="status" aria-label={translate('developer.catalog.loading')}>
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-64" />
          </div>
        }
      >
        <CatalogRoute />
      </Suspense>
    </CatalogBoundary>
  )
}
