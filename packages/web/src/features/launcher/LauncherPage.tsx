/**
 * Стартовый экран: карусель установленных моделей и карусель каталога.
 *
 * Две секции, а не фильтр: у установленной модели и у карточки каталога разные
 * данные (квантизация против описания и вариантов) и разные действия
 * («Начать чат» против «Установить»). Смешивать их в один список — значит
 * половину карточек показывать пустыми.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CatalogSourceHealth, CatalogVariant, Health } from '@alamo/contract'
import { DEFAULT_NUM_CTX } from '@alamo/contract'
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
import { CatalogCompare, exactCatalogRows } from '../models/CatalogCompare.tsx'

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
  const [compareTargets, setCompareTargets] = useState<string[]>([])
  const [compareNotice, setCompareNotice] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const local = useAsync(
    (signal) => api.listModels(contextLength, signal),
    [contextLength, reloadToken],
  )
  const catalog = useAsync(
    (signal) => api.listCatalog({
      q: debouncedQuery || undefined,
      contextLength,
      ...catalogFilterQuery(debouncedFilters),
    }, signal),
    [debouncedQuery, debouncedFilters, contextLength, reloadToken],
  )

  const compareRows = useMemo(
    () => exactCatalogRows(catalog.data?.models ?? []),
    [catalog.data?.models],
  )

  useEffect(() => {
    if (!catalog.data) return
    const available = new Set(compareRows.map((row) => row.variant.normalizedName))
    setCompareTargets((current) => {
      const retained = current.filter((target) => available.has(target))
      if (retained.length !== current.length) {
        setCompareNotice(translate('catalog.compare.vanished'))
      }
      return retained.length === current.length ? current : retained
    })
  }, [catalog.data, compareRows])

  const toggleCompare = useCallback((variant: CatalogVariant) => {
    const target = variant.normalizedName
    if (target === null) return
    setCompareNotice(null)
    setCompareTargets((current) => {
      if (current.includes(target)) return current.filter((value) => value !== target)
      if (current.length >= 2) return current
      return [...current, target]
    })
  }, [])

  const onInstalled = useCallback(() => {
    // Модель переехала из каталога в установленные — перечитываем оба списка.
    setReloadToken((value) => value + 1)
  }, [])

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
      (catalog.data?.models ?? []).map((model) => ({
        key: model.name,
        render: ({ focusIndex }) => (
          <ModelCard
            data={{ kind: 'catalog', model }}
            selectedContextLength={contextLength}
            onFocusCard={focusIndex}
            onInstalled={onInstalled}
            compareTargets={compareTargets}
            onToggleCompare={toggleCompare}
          />
        ),
      })),
    [catalog.data, compareTargets, contextLength, onInstalled, toggleCompare],
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
                  onBlur={() => applyContextDraft(contextDraft, setContextLength, setContextError)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    applyContextDraft(contextDraft, setContextLength, setContextError)
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
            <Button variant="ghost" size="sm" onClick={() => setReloadToken((v) => v + 1)}>
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
          count={catalog.data?.models.length}
          refreshing={catalog.refreshing}
          action={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <AddFromOllama
                installedNames={(local.data?.models ?? []).map((model) => model.name)}
                onInstalled={onInstalled}
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Поиск по каталогу…"
                aria-label="Поиск по каталогу моделей"
                className="w-full sm:w-56"
                type="search"
              />
              <CatalogCompare
                rows={compareRows}
                selectedTargets={compareTargets}
                onRemove={(target) => setCompareTargets((current) => current.filter((value) => value !== target))}
                onSwap={() => setCompareTargets((current) => [...current].reverse())}
              />
            </div>
          }
        />

        <CatalogFilters
          value={filters}
          onChange={(next) => {
            setCompareNotice(null)
            setFilters(next)
          }}
          onClear={() => {
            setFilters(EMPTY_CATALOG_FILTERS)
            setCompareNotice(null)
          }}
        />

        {compareNotice ? (
          <p className="mt-2 text-2xs text-[var(--warning)]" role="status">
            {compareNotice}
          </p>
        ) : null}

        {catalog.data && <CatalogSourceNotice source={catalog.data.source ?? null} />}

        <div className={catalog.data ? 'mt-3' : ''}>
          {catalog.loading ? (
            <CarouselSkeleton />
          ) : catalog.error ? (
            <Callout
              tone="danger"
              title="Каталог недоступен"
              action={
                <Button size="sm" onClick={catalog.reload}>
                  Повторить
                </Button>
              }
            >
              {errorMessage(catalog.error)}
            </Callout>
          ) : catalogItems.length === 0 ? (
            <EmptyState
              title={query || hasCatalogFilters(filters) ? translate('catalog.empty.filtered.title') : 'Каталог пуст'}
              description={
                query || hasCatalogFilters(filters)
                  ? `${translate('catalog.empty.filtered.description')} ${[
                      query ? `${translate('catalog.search.summary')}: ${query}` : '',
                      ...filterSummary(filters),
                    ].filter(Boolean).join(' · ')}`
                  : undefined
              }
              action={
                query || hasCatalogFilters(filters) ? (
                  <Button size="sm" onClick={() => {
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
      </section>
    </div>
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
