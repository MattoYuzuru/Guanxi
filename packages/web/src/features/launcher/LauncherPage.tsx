/**
 * Стартовый экран: карусель установленных моделей и карусель каталога.
 *
 * Две секции, а не фильтр: у установленной модели и у карточки каталога разные
 * данные (квантизация против описания и вариантов) и разные действия
 * («Начать чат» против «Установить»). Смешивать их в один список — значит
 * половину карточек показывать пустыми.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CatalogModel,
  CatalogSourceHealth,
  CatalogVariant,
  Health,
  ListCatalogResponse,
} from '@alamo/contract'
import { CATALOG_DEFAULT_PAGE_SIZE, DEFAULT_NUM_CTX } from '@alamo/contract'
import { api, errorMessage } from '../../lib/api.ts'
import { useAsync, useDebounced } from '../../lib/useAsync.ts'
import {
  Button,
  Callout,
  EmptyState,
  Input,
  Skeleton,
  Stat,
} from '../../components/ui.tsx'
import { ModelCarousel, type CarouselItem } from '../models/ModelCarousel.tsx'
import { ModelCard } from '../models/ModelCard.tsx'
import { AddFromOllama } from '../models/AddFromOllama.tsx'
import {
  formatBytes,
  formatContextLength,
  formatCount,
  formatDateTime,
} from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import {
  CatalogFilters,
  EMPTY_CATALOG_FILTERS,
  catalogFilterQuery,
  filterSummary,
  hasCatalogFilters,
  type CatalogFilterState,
} from '../models/CatalogFilters.tsx'
import {
  CatalogCompare,
  exactCatalogRows,
  type CatalogComparisonRow,
} from '../models/CatalogCompare.tsx'

/** Окна, под которые пересчитываем вердикт прямо на лончере. */
const CONTEXT_SUGGESTIONS = [4096, 8192, 16384, 32768, 65536, 131072]

export function LauncherPage({ health }: { health: Health }) {
  const [contextLength, setContextLength] = useState(DEFAULT_NUM_CTX)
  const [contextDraft, setContextDraft] = useState(String(DEFAULT_NUM_CTX))
  const [contextError, setContextError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 300)
  const [filters, setFilters] = useState<CatalogFilterState>(EMPTY_CATALOG_FILTERS)
  const debouncedFilters = useDebounced(filters, 250)
  const [catalogPage, setCatalogPage] = useState(1)
  const [compareRows, setCompareRows] = useState<CatalogComparisonRow[]>([])
  const [compareNotice, setCompareNotice] = useState<string | null>(null)
  const [catalogPullActive, setCatalogPullActive] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const catalogBasisRef = useRef<string | null>(null)
  const acceptedQueryBasis = JSON.stringify([
    debouncedQuery,
    debouncedFilters,
    contextLength,
    reloadToken,
  ])
  const pageBasisRef = useRef(acceptedQueryBasis)
  const catalogRequestPage = pageBasisRef.current === acceptedQueryBasis ? catalogPage : 1

  const compareTargets = useMemo(
    () => compareRows.map((row) => row.variant.normalizedName),
    [compareRows],
  )

  const invalidateCatalogBasis = useCallback((notice = true, resetPage = true) => {
    catalogBasisRef.current = null
    if (resetPage) setCatalogPage(1)
    setCompareRows((current) => {
      if (notice && current.length > 0) {
        setCompareNotice(translate('catalog.compare.invalidated'))
      }
      return current.length === 0 ? current : []
    })
  }, [])

  useEffect(() => {
    if (pageBasisRef.current === acceptedQueryBasis) return
    pageBasisRef.current = acceptedQueryBasis
    setCatalogPage(1)
  }, [acceptedQueryBasis])

  const local = useAsync(
    (signal) => api.listModels(contextLength, signal),
    [contextLength, reloadToken],
  )
  const catalog = useAsync(
    (signal) => api.listCatalog({
      q: debouncedQuery || undefined,
      contextLength,
      ...catalogFilterQuery(debouncedFilters),
      page: catalogRequestPage,
      pageSize: CATALOG_DEFAULT_PAGE_SIZE,
    }, signal),
    [debouncedQuery, debouncedFilters, contextLength, catalogRequestPage, reloadToken],
  )

  const catalogProjection = useMemo(
    () => projectCatalogPage(catalog.data, catalogRequestPage),
    [catalog.data, catalogRequestPage],
  )
  const availableComparisonRows = useMemo(
    () => exactCatalogRows(catalogProjection.models),
    [catalogProjection.models],
  )

  useEffect(() => {
    if (!catalog.data || catalog.data.pagination?.mode !== 'paged') return
    const source = catalog.data.source
    const basis = JSON.stringify([
      source?.state ?? null,
      source?.source ?? null,
      source?.fetchedAt ?? null,
      catalog.data.pagination.totalItems,
    ])
    if (catalogBasisRef.current !== null && catalogBasisRef.current !== basis) {
      setCompareRows((current) => {
        if (current.length > 0) setCompareNotice(translate('catalog.compare.invalidated'))
        return current.length === 0 ? current : []
      })
    }
    catalogBasisRef.current = basis
  }, [catalog.data])

  const toggleCompare = useCallback((model: CatalogModel, variant: CatalogVariant) => {
    const target = variant.normalizedName
    if (target === null) return
    const exact = availableComparisonRows.find((row) =>
      row.model === model && row.variant.normalizedName === target,
    )
    if (!exact) return
    setCompareNotice(null)
    setCompareRows((current) => {
      if (current.some((row) => row.variant.normalizedName === target)) {
        return current.filter((row) => row.variant.normalizedName !== target)
      }
      if (current.length >= 2) return current
      return [...current, exact]
    })
  }, [availableComparisonRows])

  const onInstalled = useCallback(() => {
    // Модель переехала из каталога в установленные — перечитываем оба списка.
    invalidateCatalogBasis()
    setReloadToken((value) => value + 1)
  }, [invalidateCatalogBasis])

  const localItems: CarouselItem[] = useMemo(
    () =>
      (local.data?.models ?? []).map((model) => ({
        key: model.name,
        render: ({ focusIndex }) => (
          <ModelCard
            data={{ kind: 'local', model }}
            selectedContextLength={contextLength}
            onFocusCard={focusIndex}
            onInstalled={onInstalled}
          />
        ),
      })),
    [contextLength, local.data, onInstalled],
  )

  const catalogItems: CarouselItem[] = useMemo(
    () =>
      catalogProjection.models.map((model) => ({
        key: model.name,
        render: ({ focusIndex }) => (
          <ModelCard
            data={{ kind: 'catalog', model }}
            selectedContextLength={contextLength}
            onFocusCard={focusIndex}
            onInstalled={onInstalled}
            compareTargets={compareTargets}
            onToggleCompare={(variant) => toggleCompare(model, variant)}
            onPullActiveChange={setCatalogPullActive}
          />
        ),
      })),
    [catalogProjection.models, compareTargets, contextLength, onInstalled, toggleCompare],
  )

  const hardware = health.hardware

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1600px] px-4 py-5 sm:px-5">
      {/* Железо: под него считается вся влезаемость, поэтому оно вверху */}
      <section className="mb-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Модели</h1>
            <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
              Вердикты посчитаны под это железо и выбранный размер окна.
            </p>
          </div>

          <div className="flex items-end gap-4">
            <div className="hidden items-center gap-4 sm:flex">
              <Stat
                label={translate('hardware.acceleratorProfile')}
                value={hardware.acceleratorName ?? hardware.accelerator}
                hint={`${hardware.cpuModel}, ${hardware.cpuCores} ядер · ${translate('hardware.deviceCountUnknown')}`}
              />
              <Stat
                label="Доступно памяти"
                value={formatBytes(hardware.usableMemoryBytes)}
                hint={
                  hardware.unifiedMemory
                    ? `Общая память CPU и GPU, всего ${formatBytes(hardware.totalMemoryBytes)}`
                    : `Всего в системе ${formatBytes(hardware.totalMemoryBytes)}`
                }
              />
              {hardware.freeDiskBytes !== null && (
                <Stat label="Свободно на диске" value={formatBytes(hardware.freeDiskBytes)} />
              )}
            </div>

            <div className="min-w-0">
              <label className="flex items-center gap-1.5">
                <span className="text-2xs text-[var(--fg-subtle)]">
                  {translate('launcher.context.short')}
                </span>
                <Input
                  aria-label={translate('launcher.context.aria')}
                  aria-describedby="launcher-context-hint"
                  value={contextDraft}
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  list="launcher-context-suggestions"
                  aria-invalid={contextError !== null}
                  onChange={(event) => setContextDraft(event.target.value)}
                  onBlur={() => applyContextDraft(
                    contextDraft,
                    (value) => {
                      if (value !== contextLength) invalidateCatalogBasis()
                      setContextLength(value)
                    },
                    setContextError,
                  )}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    applyContextDraft(
                      contextDraft,
                      (value) => {
                        if (value !== contextLength) invalidateCatalogBasis()
                        setContextLength(value)
                      },
                      setContextError,
                    )
                  }}
                  className="w-28"
                />
                <datalist id="launcher-context-suggestions">
                  {CONTEXT_SUGGESTIONS.map((value) => (
                    <option key={value} value={value}>{formatContextLength(value)}</option>
                  ))}
                </datalist>
              </label>
              <p id="launcher-context-hint" className="mt-1 max-w-64 text-2xs text-[var(--fg-subtle)]">
                {translate('launcher.context.hint')}
              </p>
              {contextError ? (
                <p className="mt-1 max-w-64 text-2xs text-[var(--danger)]" role="alert">
                  {contextError}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* Установленные */}
      <section className="mb-7">
        <SectionHeader
          title="Установленные"
          count={local.data?.models.length}
          refreshing={local.refreshing}
          action={
            <Button variant="ghost" size="sm" onClick={() => {
              invalidateCatalogBasis()
              setReloadToken((v) => v + 1)
            }}>
              Обновить
            </Button>
          }
        />

        {local.loading ? (
          <CarouselSkeleton />
        ) : local.error ? (
          <Callout
            tone="danger"
            title="Не удалось получить список моделей"
            action={
              <Button size="sm" onClick={local.reload}>
                Повторить
              </Button>
            }
          >
            {errorMessage(local.error)}
          </Callout>
        ) : localItems.length === 0 ? (
          <EmptyState
            title="Пока ничего не установлено"
            description="Выберите модель в каталоге ниже и нажмите «Установить»."
          />
        ) : (
          <ModelCarousel items={localItems} ariaLabel="Установленные модели" />
        )}
      </section>

      {/* Каталог */}
      <section>
        <SectionHeader
          title="Каталог"
          count={catalogProjection.totalItems}
          refreshing={catalog.refreshing}
          action={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <AddFromOllama
                installedNames={(local.data?.models ?? []).map((model) => model.name)}
                onInstalled={onInstalled}
              />
              <Input
                value={query}
                onChange={(event) => {
                  // The accepted debounced basis resets page 1 atomically, so
                  // typing never issues page 1 for the previous query.
                  invalidateCatalogBasis(true, false)
                  setQuery(event.target.value)
                }}
                placeholder="Поиск по каталогу…"
                aria-label="Поиск по каталогу моделей"
                className="w-full sm:w-56"
                type="search"
              />
              <CatalogCompare
                rows={compareRows}
                selectedTargets={compareTargets}
                onRemove={(target) => setCompareRows((current) => current.filter(
                  (row) => row.variant.normalizedName !== target,
                ))}
                onSwap={() => setCompareRows((current) => [...current].reverse())}
              />
            </div>
          }
        />

        <CatalogFilters
          value={filters}
          onChange={(next) => {
            invalidateCatalogBasis(true, false)
            setFilters(next)
          }}
          onClear={() => {
            invalidateCatalogBasis(true, false)
            setFilters(EMPTY_CATALOG_FILTERS)
          }}
        />

        {compareNotice ? (
          <p className="mt-2 text-2xs text-[var(--warning)]" role="status">
            {compareNotice}
          </p>
        ) : null}

        {catalog.data && <CatalogSourceNotice source={catalog.data.source ?? null} />}

        <div className={catalog.data ? 'mt-3' : ''}>
          {catalog.loading || catalog.refreshing ? (
            <CarouselSkeleton />
          ) : catalog.error ? (
            <Callout
              tone="danger"
              title="Каталог недоступен"
              action={
                <Button size="sm" onClick={() => {
                  invalidateCatalogBasis()
                  catalog.reload()
                }}>
                  Повторить
                </Button>
              }
            >
              {errorMessage(catalog.error)}
            </Callout>
          ) : catalogProjection.outOfRange ? (
            <EmptyState
              title={translate('catalog.pagination.outOfRange.title')}
              description={translate('catalog.pagination.outOfRange.description')}
              action={(
                <Button size="sm" onClick={() => setCatalogPage(1)}>
                  {translate('catalog.pagination.first')}
                </Button>
              )}
            />
          ) : catalogItems.length === 0 ? (
            <EmptyState
              title={catalog.data?.source?.state === 'unavailable'
                ? translate('catalog.empty.unavailable.title')
                : query || hasCatalogFilters(filters)
                  ? translate('catalog.empty.filtered.title')
                  : 'Каталог пуст'}
              description={
                catalog.data?.source?.state === 'unavailable'
                  ? translate('catalog.empty.unavailable.description')
                  : query || hasCatalogFilters(filters)
                  ? `${translate('catalog.empty.filtered.description')} ${[
                      query ? `${translate('catalog.search.summary')}: ${query}` : '',
                      ...filterSummary(filters),
                    ].filter(Boolean).join(' · ')}`
                  : undefined
              }
              action={
                query || hasCatalogFilters(filters) ? (
                  <Button size="sm" onClick={() => {
                    invalidateCatalogBasis()
                    setQuery('')
                    setFilters(EMPTY_CATALOG_FILTERS)
                  }}>
                    {translate('catalog.filters.clearAll')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ModelCarousel items={catalogItems} ariaLabel="Каталог моделей" />
          )}
        </div>

        {catalog.data ? (
          <CatalogPager
            page={catalogProjection.page}
            totalPages={catalogProjection.totalPages}
            totalItems={catalogProjection.totalItems ?? 0}
            pageItems={catalogProjection.models.length}
            previousPage={catalogProjection.previousPage}
            nextPage={catalogProjection.nextPage}
            loading={catalog.loading || catalog.refreshing}
            pullActive={catalogPullActive}
            onPage={setCatalogPage}
          />
        ) : null}
      </section>
    </div>
  )
}

type CatalogPageProjection = {
  models: CatalogModel[]
  page: number
  totalItems: number | undefined
  totalPages: number
  previousPage: number | null
  nextPage: number | null
  outOfRange: boolean
}

/** New servers page explicitly; legacy full responses remain bounded client-side. */
export function projectCatalogPage(
  response: ListCatalogResponse | null,
  requestedPage: number,
): CatalogPageProjection {
  if (!response) {
    return {
      models: [], page: requestedPage, totalItems: undefined, totalPages: 0,
      previousPage: null, nextPage: null, outOfRange: false,
    }
  }
  if (response.pagination?.mode === 'paged') {
    const metadata = response.pagination
    return {
      models: response.models,
      page: metadata.page,
      totalItems: metadata.totalItems,
      totalPages: metadata.totalPages,
      previousPage: metadata.previousPage,
      nextPage: metadata.nextPage,
      outOfRange: metadata.totalItems > 0 && metadata.page > metadata.totalPages,
    }
  }

  const totalItems = response.pagination?.totalItems ?? response.models.length
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / CATALOG_DEFAULT_PAGE_SIZE)
  const start = requestedPage <= totalPages
    ? (requestedPage - 1) * CATALOG_DEFAULT_PAGE_SIZE
    : null
  return {
    models: start === null
      ? []
      : response.models.slice(start, start + CATALOG_DEFAULT_PAGE_SIZE),
    page: requestedPage,
    totalItems,
    totalPages,
    previousPage:
      totalPages === 0 ? null : requestedPage > totalPages ? totalPages : requestedPage > 1 ? requestedPage - 1 : null,
    nextPage: requestedPage < totalPages ? requestedPage + 1 : null,
    outOfRange: totalItems > 0 && requestedPage > totalPages,
  }
}

export function CatalogPager({
  page,
  totalPages,
  totalItems,
  pageItems,
  previousPage,
  nextPage,
  loading,
  pullActive,
  onPage,
}: {
  page: number
  totalPages: number
  totalItems: number
  pageItems: number
  previousPage: number | null
  nextPage: number | null
  loading: boolean
  pullActive: boolean
  onPage: (page: number) => void
}) {
  const blocked = loading || pullActive
  const descriptionId = pullActive ? 'catalog-pager-pull-boundary' : undefined
  const previousRef = useRef<HTMLButtonElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const pendingFocusRef = useRef<'previous' | 'next' | null>(null)

  useEffect(() => {
    const requested = pendingFocusRef.current
    if (loading || requested === null) return
    pendingFocusRef.current = null
    const preferred = requested === 'previous' ? previousRef.current : nextRef.current
    const fallback = requested === 'previous' ? nextRef.current : previousRef.current
    const target = preferred && !preferred.disabled ? preferred : fallback
    if (target && !target.disabled) target.focus({ preventScroll: true })
  }, [loading, page])

  const requestPage = (direction: 'previous' | 'next', target: number | null) => {
    if (target === null || blocked) return
    pendingFocusRef.current = direction
    onPage(target)
  }

  return (
    <nav
      className="mt-4 flex min-w-0 flex-wrap items-center justify-center gap-3"
      aria-label={translate('catalog.pagination.label')}
      aria-describedby={descriptionId}
      aria-busy={loading}
    >
      <Button
        ref={previousRef}
        variant="secondary"
        size="sm"
        className="h-11 sm:h-6"
        disabled={blocked || previousPage === null}
        onClick={() => requestPage('previous', previousPage)}
      >
        {translate('catalog.pagination.previous')}
      </Button>
      <span className="min-w-0 text-center text-xs" role="status" aria-live="polite">
        {translate('catalog.pagination.status')
          .replace('{page}', String(page))
          .replace('{totalPages}', String(totalPages))
          .replace('{pageItems}', String(pageItems))
          .replace('{totalItems}', String(totalItems))}
      </span>
      <Button
        ref={nextRef}
        variant="secondary"
        size="sm"
        className="h-11 sm:h-6"
        disabled={blocked || nextPage === null}
        onClick={() => requestPage('next', nextPage)}
      >
        {translate('catalog.pagination.next')}
      </Button>
      {pullActive ? (
        <p id={descriptionId} className="basis-full text-center text-2xs text-[var(--warning)]" role="status">
          {translate('catalog.pagination.pullBlocked')}
        </p>
      ) : null}
    </nav>
  )
}

function applyContextDraft(
  draft: string,
  apply: (value: number) => void,
  setError: (value: string | null) => void,
): void {
  const parsed = Number(draft)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    setError(translate('context.validation.positiveSafeInteger'))
    return
  }
  setError(null)
  apply(parsed)
}

export function CatalogSourceNotice({
  source,
}: {
  source: CatalogSourceHealth | null
}) {
  const state = source?.state ?? 'unknown'
  const copy =
    state === 'fresh_remote'
      ? {
          title: translate('catalog.source.fresh.title'),
          summary: translate('catalog.source.fresh.summary'),
          tone: 'info' as const,
        }
      : state === 'stale_cache'
        ? {
            title: translate('catalog.source.stale.title'),
            summary: translate('catalog.source.stale.summary'),
            tone: 'warning' as const,
          }
        : state === 'bundled_fallback'
          ? {
              title: translate('catalog.source.bundled.title'),
              summary: translate('catalog.source.bundled.summary'),
              tone: 'warning' as const,
            }
          : state === 'unavailable'
            ? {
                title: translate('catalog.source.unavailable.title'),
                summary: translate('catalog.source.unavailable.summary'),
                tone: 'danger' as const,
              }
            : {
                title: translate('catalog.source.unknown.title'),
                summary: translate('catalog.source.unknown.summary'),
                tone: 'neutral' as const,
              }

  return (
    <div
      role={state === 'unavailable' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <Callout tone={copy.tone} title={copy.title}>
        <p>{copy.summary}</p>
        {source && (
          <p className="mt-1 text-2xs">
            {source.source}
            {' · '}
            {translate('catalog.source.observedAt')}: {formatDateTime(source.observedAt)}
            {source.fetchedAt && (
              <>
                {' · '}
                {translate('catalog.source.fetchedAt')}: {formatDateTime(source.fetchedAt)}
              </>
            )}
          </p>
        )}
      </Callout>
    </div>
  )
}

function SectionHeader({
  title,
  count,
  refreshing,
  action,
}: {
  title: string
  count?: number
  refreshing?: boolean
  action?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {count !== undefined && (
          <span className="text-2xs text-[var(--fg-subtle)]">
            {formatCount(count, 'модель', 'модели', 'моделей')}
          </span>
        )}
        {refreshing && <span className="anim-pulse-soft text-2xs text-[var(--fg-subtle)]">…</span>}
      </div>
      {action}
    </div>
  )
}

function CarouselSkeleton() {
  return (
    <div className="flex gap-3.5 overflow-hidden px-[6vw]">
      {[0, 1, 2, 3, 4].map((index) => (
        <Skeleton
          key={index}
          className="h-[268px] w-[300px] shrink-0"
        />
      ))}
    </div>
  )
}
