/**
 * In-app catalog entry point (`@guanxi/ui/catalog`). Import it only from a lazily loaded
 * chunk: it pulls in every story, docs file and review record.
 */
export { CatalogApp, type CatalogAppProps, type CatalogView } from './CatalogApp.tsx'
export { catalogEntries } from './registry.ts'
export { storySources } from './story-sources.ts'
export { DEFAULT_REGIME, regimeFromSearch, type Regime } from './regimes.ts'
export {
  ReviewApiError,
  type ReadOnlyReason,
  type ReviewApi,
  type ReviewCapability,
  type ReviewFailure,
  type ReviewState,
  type ReviewSubmitBody,
} from './review-api.ts'
