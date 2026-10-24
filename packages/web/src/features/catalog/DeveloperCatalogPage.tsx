/**
 * Route for Settings → Design system → Components. The catalog is code-split: its chunk (every
 * story, docs file and review record) is requested only when this route renders. No Developer
 * mode gates it (owner feedback 2026-10-23 supersedes D-137's switch: one interface).
 */
import { Component, lazy, Suspense, type ReactNode } from 'react'
import { Button, EmptyState, Skeleton } from '../../components/ui.tsx'
import { translate } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'

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
