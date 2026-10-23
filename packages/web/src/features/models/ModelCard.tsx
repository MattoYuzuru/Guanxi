/**
 * Карточка модели для карусели. Работает и с установленной моделью, и с
 * карточкой каталога — это разные типы контракта, поэтому union, а не
 * «общий» самодельный тип.
 */
import { memo } from 'react'
import type { CatalogModel, LocalModel, ModelCapability } from '@guanxi/contract'
import { Badge, Button, cx } from '../../components/ui.tsx'
import { Link, paths } from '../../lib/router.tsx'
import { formatBytes, formatContextLength } from '../../lib/format.ts'
import { FitIndicator } from './FitIndicator.tsx'
import { CatalogVariantInstall } from './CatalogVariantInstall.tsx'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { InstalledEvidenceSummary } from './InstalledEvidence.tsx'
import { FactList } from './Facts.tsx'

export type ModelCardData =
  | { kind: 'local'; model: LocalModel }
  | { kind: 'catalog'; model: CatalogModel }

const CAPABILITY_LABEL: Record<ModelCapability, { short: LocaleKey; hint: LocaleKey }> = {
  completion: { short: 'model.capability.completion', hint: 'model.capability.completionHint' },
  tools: { short: 'model.capability.tools', hint: 'model.capability.toolsHint' },
  vision: { short: 'model.capability.vision', hint: 'model.capability.visionHint' },
  insert: { short: 'model.capability.insert', hint: 'model.capability.insertHint' },
  thinking: { short: 'model.capability.thinking', hint: 'model.capability.thinkingHint' },
  embedding: { short: 'model.capability.embedding', hint: 'model.capability.embeddingHint' },
}

const HIGHLIGHT_CAPABILITIES: ModelCapability[] = ['tools', 'vision', 'thinking']

export const ModelCard = memo(function ModelCard({
  data,
  onFocusCard,
  onInstalled,
  selectedContextLength,
  compareTargets,
  onToggleCompare,
  onPullActiveChange,
}: {
  data: ModelCardData
  onFocusCard?: () => void
  onInstalled?: (name: string) => void
  selectedContextLength?: number
  compareTargets?: readonly string[]
  onToggleCompare?: (variant: CatalogModel['variants'][number]) => void
  onPullActiveChange?: (active: boolean) => void
}) {
  useLocale()
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

  return (
    <article
      className={cx(
        'surface flex h-full w-[300px] flex-col rounded-xl p-3 shadow-[var(--shadow-card)]',
        'transition-colors duration-150 hover:border-control',
      )}
      aria-label={model.name}
    >
      {/* Заголовок: имя ведёт в профиль, облако — единственная метка рядом с ним. */}
      <header className="mb-2">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={paths.model(model.name)}
            onFocus={onFocusCard}
            className="min-w-0 truncate font-mono text-[13px] font-semibold hover:text-accent focus-visible:text-accent"
            title={model.name}
          >
            {model.name}
          </Link>
          {model.isCloud && (
            <Badge tone="accent" title={translate('model.cloud.memory')}>
              {translate('model.cloud')}
            </Badge>
          )}
        </div>
        {catalog?.description ? (
          <p className="mt-1 line-clamp-2 text-2xs leading-4 text-muted" title={catalog.description}>
            {catalog.description}
          </p>
        ) : null}
      </header>

      {/* Факты вместо россыпи меток: подпись и значение, значение весом. */}
      <FactList
        className="mb-2"
        label={translate('models.facts.label')}
        facts={[
          local && { label: translate('models.facts.family'), value: local.family },
          local && { label: translate('models.facts.parameters'), value: local.parameterSize },
          local && { label: translate('models.facts.quantization'), value: local.quantization },
          local?.contextLimit.state === 'declared'
            ? { label: translate('models.facts.context'), value: formatContextLength(local.contextLimit.value), title: translate('context.limit.declared') }
            : local
              ? { label: translate('models.facts.context'), value: translate('context.window.unknown'), tone: 'muted', title: translate('context.limit.unknown') }
              : model.contextLength !== null
                ? { label: translate('models.facts.context'), value: formatContextLength(model.contextLength), title: translate('model.context.declared') }
                : null,
          local
            ? { label: translate('models.facts.disk'), value: formatBytes(local.sizeBytes) }
            : catalog?.vramBytes !== null && catalog?.vramBytes !== undefined
              ? { label: translate('models.facts.vendorMemory'), value: formatBytes(catalog.vramBytes), title: translate('model.vendorMemory') }
              : null,
          catalog?.requiredPlan === 'pro' && { label: translate('models.facts.plan'), value: translate('models.facts.plan.pro'), title: translate('model.paid') },
        ]}
      />

      {local ? <InstalledEvidenceSummary descriptor={local.descriptor} /> : null}

      {/* Только заметные возможности; полный список — в профиле модели. */}
      {primary.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-1">
          {primary.map((capability) => (
            <Badge key={capability} tone="outline" title={translate(CAPABILITY_LABEL[capability].hint)}>
              {translate(CAPABILITY_LABEL[capability].short)}
            </Badge>
          ))}
        </div>
      )}

      {catalog ? (
        <CatalogVariantInstall
          model={catalog}
          selectedContextLength={selectedContextLength}
          onInstalled={onInstalled}
          compareTargets={compareTargets}
          onToggleCompare={onToggleCompare}
          onPullActiveChange={onPullActiveChange}
        />
      ) : (
        <>
          <div className="mb-2.5 flex-1">
            <FitIndicator fit={model.fit} compact />
          </div>
          {/* Одно главное действие; профиль открывается по имени модели. */}
          <footer className="mt-auto">
          <div className="flex gap-1.5">
            <Link
              to={`${paths.chat()}?model=${encodeURIComponent(model.name)}${selectedContextLength === undefined ? '' : `&numCtx=${selectedContextLength}`}`}
              onFocus={onFocusCard}
              className="flex h-8 flex-1 items-center justify-center rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:brightness-110"
            >
              {translate('model.startChat')}
            </Link>
          </div>
          </footer>
        </>
      )}
    </article>
  )
})

/** Кнопка «Установить» в карточке каталога, когда скачивание ещё не начато. */
export function InstallButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="primary" size="md" className="w-full" onClick={onClick}>
      {translate('model.install')}
    </Button>
  )
}
