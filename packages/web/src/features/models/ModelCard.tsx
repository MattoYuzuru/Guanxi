/**
 * Карточка модели для карусели. Работает и с установленной моделью, и с
 * карточкой каталога — это разные типы контракта, поэтому union, а не
 * «общий» самодельный тип.
 */
import { memo } from 'react'
import type { CatalogModel, LocalModel, ModelCapability } from '@alamo/contract'
import { Badge, Button, cx } from '../../components/ui.tsx'
import { Link, paths } from '../../lib/router.tsx'
import { formatBytes, formatContextLength } from '../../lib/format.ts'
import { FitIndicator } from './FitIndicator.tsx'
import { CatalogVariantInstall } from './CatalogVariantInstall.tsx'
import { translate } from '../../lib/locale.ts'
import { InstalledEvidenceSummary } from './InstalledEvidence.tsx'

export type ModelCardData =
  | { kind: 'local'; model: LocalModel }
  | { kind: 'catalog'; model: CatalogModel }

const CAPABILITY_LABEL: Record<ModelCapability, { short: string; hint: string }> = {
  completion: { short: 'текст', hint: 'Обычная генерация текста' },
  tools: { short: 'tools', hint: 'Умеет вызывать инструменты — нужно для агентного режима' },
  vision: { short: 'vision', hint: 'Понимает изображения' },
  insert: { short: 'fill', hint: 'Дополняет текст в середине (fill-in-the-middle)' },
  thinking: { short: 'thinking', hint: 'Отдельный блок рассуждений перед ответом' },
  embedding: { short: 'embed', hint: 'Только эмбеддинги, для чата не подходит' },
}

const HIGHLIGHT_CAPABILITIES: ModelCapability[] = ['tools', 'vision', 'thinking']

export const ModelCard = memo(function ModelCard({
  data,
  onFocusCard,
  onInstalled,
  selectedContextLength,
}: {
  data: ModelCardData
  onFocusCard?: () => void
  onInstalled?: (name: string) => void
  selectedContextLength?: number
}) {
  const model = data.model
  const local = data.kind === 'local' ? data.model : null
  const catalog = data.kind === 'catalog' ? data.model : null

  const capabilities =
    local && local.descriptor.capabilities.state !== 'declared'
      ? []
      : model.capabilities
  const primary = capabilities.filter((capability) =>
    HIGHLIGHT_CAPABILITIES.includes(capability),
  )
  const secondary = capabilities.filter(
    (capability) => !HIGHLIGHT_CAPABILITIES.includes(capability),
  )

  return (
    <article
      className={cx(
        'surface flex h-full w-[300px] flex-col rounded-xl p-3 shadow-[var(--shadow-card)]',
        'transition-colors duration-150 hover:border-[var(--border-strong)]',
      )}
      aria-label={model.name}
    >
      {/* Заголовок */}
      <header className="mb-2">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={paths.model(model.name)}
            onFocus={onFocusCard}
            className="min-w-0 truncate font-mono text-[13px] font-semibold hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
            title={model.name}
          >
            {model.name}
          </Link>
          {model.isCloud && (
            <Badge tone="accent" title="Считается в облаке Ollama, локальная память не тратится">
              облако
            </Badge>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-[var(--fg-subtle)]">
          {local ? (
            <>
              <span title="Семейство модели">{local.family}</span>
              <Dot />
              <span title="Число параметров">{local.parameterSize}</span>
              <Dot />
              <span title="Квантизация">{local.quantization}</span>
            </>
          ) : (
            <span className="line-clamp-2 leading-4" title={catalog?.description}>
              {catalog?.description}
            </span>
          )}
        </div>
      </header>

      {local ? <InstalledEvidenceSummary descriptor={local.descriptor} /> : null}

      {/* Характеристики */}
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {local?.contextLimit.state === 'declared' ? (
          <Badge tone="outline" title={translate('context.limit.declared')}>
            {translate('context.window.short')} {formatContextLength(local.contextLimit.value)}
          </Badge>
        ) : local ? (
          <Badge tone="outline" title={translate('context.limit.unknown')}>
            {translate('context.window.unknown')}
          </Badge>
        ) : model.contextLength !== null ? (
          <Badge tone="outline" title="Заявленный каталогом размер окна контекста">
            окно {formatContextLength(model.contextLength)}
          </Badge>
        ) : null}
        {local ? (
          <Badge tone="outline" title="Занимает на диске">
            {formatBytes(local.sizeBytes)}
          </Badge>
        ) : (
          catalog?.vramBytes !== null && (
            <Badge tone="outline" title="Подсказка вендора по требуемой видеопамяти">
              vram ~{formatBytes(catalog?.vramBytes)}
            </Badge>
          )
        )}
        {catalog?.requiredPlan === 'pro' && (
          <Badge tone="accent" title="Требуется платный план Ollama">
            pro
          </Badge>
        )}
      </div>

      {/* Возможности */}
      {(primary.length > 0 || secondary.length > 0) && (
        <div className="mb-2.5 flex flex-wrap gap-1">
          {primary.map((capability) => (
            <Badge key={capability} tone="accent" title={CAPABILITY_LABEL[capability].hint}>
              {CAPABILITY_LABEL[capability].short}
            </Badge>
          ))}
          {secondary.map((capability) => (
            <Badge key={capability} tone="neutral" title={CAPABILITY_LABEL[capability].hint}>
              {CAPABILITY_LABEL[capability].short}
            </Badge>
          ))}
        </div>
      )}

      {catalog ? (
        <CatalogVariantInstall
          model={catalog}
          selectedContextLength={selectedContextLength}
          onInstalled={onInstalled}
        />
      ) : (
        <>
          <div className="mb-2.5 flex-1">
            <FitIndicator fit={model.fit} compact />
          </div>
          <footer className="mt-auto">
          <div className="flex gap-1.5">
            <Link
              to={paths.model(model.name)}
              onFocus={onFocusCard}
              className="flex h-8 flex-1 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 text-xs font-medium hover:bg-[var(--bg-subtle)]"
            >
              Профиль
            </Link>
            <Link
              to={`${paths.chat()}?model=${encodeURIComponent(model.name)}${selectedContextLength === undefined ? '' : `&numCtx=${selectedContextLength}`}`}
              onFocus={onFocusCard}
              className="flex h-8 flex-1 items-center justify-center rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-fg)] hover:brightness-110"
            >
              Начать чат
            </Link>
          </div>
          </footer>
        </>
      )}
    </article>
  )
})

function Dot() {
  return <span className="text-[var(--border-strong)]">·</span>
}

/** Кнопка «Установить» в карточке каталога, когда скачивание ещё не начато. */
export function InstallButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="primary" size="md" className="w-full" onClick={onClick}>
      Установить
    </Button>
  )
}
