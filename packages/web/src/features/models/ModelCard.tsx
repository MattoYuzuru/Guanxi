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
  const secondary = capabilities.filter(
    (capability) => !HIGHLIGHT_CAPABILITIES.includes(capability),
  )

  return (
    <article
      className={cx(
        'surface flex h-full w-[300px] flex-col rounded-xl p-3 shadow-[var(--shadow-card)]',
        'transition-colors duration-150 hover:border-control',
      )}
      aria-label={model.name}
    >
      {/* Заголовок */}
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

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted">
          {local ? (
            <>
              <span title={translate('model.family')}>{local.family}</span>
              <span title={translate('model.parameters')}>{local.parameterSize}</span>
              <span title={translate('model.quantization')}>{local.quantization}</span>
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
          <Badge tone="outline" title={translate('model.context.declared')}>
            {translate('model.context.short')} {formatContextLength(model.contextLength)}
          </Badge>
        ) : null}
        {local ? (
          <Badge tone="outline" title={translate('model.disk')}>
            {formatBytes(local.sizeBytes)}
          </Badge>
        ) : (
          catalog?.vramBytes !== null && (
            <Badge tone="outline" title={translate('model.vendorMemory')}>
              vram ~{formatBytes(catalog?.vramBytes)}
            </Badge>
          )
        )}
        {catalog?.requiredPlan === 'pro' && (
          <Badge tone="accent" title={translate('model.paid')}>
            pro
          </Badge>
        )}
      </div>

      {/* Возможности */}
      {(primary.length > 0 || secondary.length > 0) && (
        <div className="mb-2.5 flex flex-wrap gap-1">
          {primary.map((capability) => (
            <Badge key={capability} tone="accent" title={translate(CAPABILITY_LABEL[capability].hint)}>
              {translate(CAPABILITY_LABEL[capability].short)}
            </Badge>
          ))}
          {secondary.map((capability) => (
            <Badge key={capability} tone="neutral" title={translate(CAPABILITY_LABEL[capability].hint)}>
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
          <footer className="mt-auto">
          <div className="flex gap-1.5">
            <Link
              to={paths.model(model.name)}
              onFocus={onFocusCard}
              className="flex h-8 flex-1 items-center justify-center rounded-md border border-control bg-surface px-3 text-xs font-medium hover:bg-inset"
            >
              {translate('model.profile')}
            </Link>
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
