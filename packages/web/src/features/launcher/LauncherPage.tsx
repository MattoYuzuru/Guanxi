/**
 * Стартовый экран: карусель установленных моделей и карусель каталога.
 *
 * Две секции, а не фильтр: у установленной модели и у карточки каталога разные
 * данные (квантизация против описания и вариантов) и разные действия
 * («Начать чат» против «Установить»). Смешивать их в один список — значит
 * половину карточек показывать пустыми.
 */
import { useCallback, useMemo, useState } from 'react'
import type { Health } from '@alamo/contract'
import { DEFAULT_NUM_CTX } from '@alamo/contract'
import { api, errorMessage } from '../../lib/api.ts'
import { useAsync, useDebounced } from '../../lib/useAsync.ts'
import {
  Button,
  Callout,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Stat,
  cx,
} from '../../components/ui.tsx'
import { ModelCarousel, type CarouselItem } from '../models/ModelCarousel.tsx'
import { ModelCard } from '../models/ModelCard.tsx'
import { formatBytes, formatContextLength, formatCount } from '../../lib/format.ts'

/** Окна, под которые пересчитываем вердикт прямо на лончере. */
const CONTEXT_CHOICES = [4096, 8192, 16384, 32768, 65536, 131072]

export function LauncherPage({ health }: { health: Health }) {
  const [contextLength, setContextLength] = useState(DEFAULT_NUM_CTX)
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 300)
  const [reloadToken, setReloadToken] = useState(0)

  const local = useAsync(
    (signal) => api.listModels(contextLength, signal),
    [contextLength, reloadToken],
  )
  const catalog = useAsync(
    (signal) => api.listCatalog({ q: debouncedQuery || undefined, contextLength }, signal),
    [debouncedQuery, contextLength, reloadToken],
  )

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
            onFocusCard={focusIndex}
            onInstalled={onInstalled}
          />
        ),
      })),
    [local.data, onInstalled],
  )

  const catalogItems: CarouselItem[] = useMemo(
    () =>
      (catalog.data?.models ?? []).map((model) => ({
        key: model.name,
        render: ({ focusIndex }) => (
          <ModelCard
            data={{ kind: 'catalog', model }}
            onFocusCard={focusIndex}
            onInstalled={onInstalled}
          />
        ),
      })),
    [catalog.data, onInstalled],
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
                label="Ускоритель"
                value={hardware.acceleratorName ?? hardware.accelerator}
                hint={`${hardware.cpuModel}, ${hardware.cpuCores} ядер`}
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

            <label className="flex items-center gap-1.5">
              <span className="text-2xs text-[var(--fg-subtle)]">окно</span>
              <Select
                ariaLabel="Размер окна контекста для расчёта влезаемости"
                value={String(contextLength)}
                onChange={(value) => setContextLength(Number(value))}
                options={CONTEXT_CHOICES.map((value) => ({
                  value: String(value),
                  label: formatContextLength(value),
                }))}
                className="w-24"
              />
            </label>
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
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Поиск по каталогу…"
              aria-label="Поиск по каталогу моделей"
              className="w-full sm:w-56"
              type="search"
            />
          }
        />

        {/* Честно про офлайн-снимок: у пользователя корпоративная сеть режет ollama.com */}
        {catalog.data && !catalog.data.live && (
          <Callout tone="warning" title="Каталог показан из офлайн-снимка">
            ollama.com сейчас недоступен
            {health.network.checkedAt && ' (проверено при запуске)'}, поэтому список моделей
            встроенный и может отставать. Установка уже скачанных моделей работает как обычно.
          </Callout>
        )}

        <div className={cx(catalog.data && !catalog.data.live && 'mt-3')}>
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
              title={query ? 'Ничего не найдено' : 'Каталог пуст'}
              description={
                query ? `По запросу «${query}» моделей нет.` : undefined
              }
              action={
                query ? (
                  <Button size="sm" onClick={() => setQuery('')}>
                    Сбросить поиск
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
