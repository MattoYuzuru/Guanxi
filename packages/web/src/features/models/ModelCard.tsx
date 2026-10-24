/**
 * Карточка модели для сетки моделей. Работает и с установленной моделью, и с
 * карточкой каталога — это разные типы контракта, поэтому union, а не
 * «общий» самодельный тип.
 */
import { memo } from 'react'
import type { CatalogModel, LocalModel, ModelCapability } from '@guanxi/contract'
import { Badge, Button, cx } from '../../components/ui.tsx'
import { Icon as UiIcon, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@guanxi/ui'
import { Link, paths } from '../../lib/router.tsx'
import { formatBytes, formatContextLength } from '../../lib/format.ts'
import { FitIndicator } from './FitIndicator.tsx'
import { CatalogVariantInstall } from './CatalogVariantInstall.tsx'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { InstalledEvidenceCaution, InstalledEvidenceSummary } from './InstalledEvidence.tsx'
import { FactList, type Fact } from './Facts.tsx'

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
  onInstalled,
  selectedContextLength,
  compareTargets,
  onToggleCompare,
  onPullActiveChange,
}: {
  data: ModelCardData
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

  const contextFact: Fact | null = local?.contextLimit.state === 'declared'
    ? { label: translate('models.facts.context'), value: formatContextLength(local.contextLimit.value), title: translate('context.limit.declared') }
    : local
      ? { label: translate('models.facts.context'), value: translate('context.window.unknown'), tone: 'muted', title: translate('context.limit.unknown') }
      : model.contextLength !== null
        ? { label: translate('models.facts.context'), value: formatContextLength(model.contextLength), title: translate('model.context.declared') }
        : null
  const memoryFact: Fact | null = local
    ? { label: translate('models.facts.disk'), value: formatBytes(local.sizeBytes) }
    : catalog?.vramBytes !== null && catalog?.vramBytes !== undefined
      ? { label: translate('models.facts.vendorMemory'), value: formatBytes(catalog.vramBytes), title: translate('model.vendorMemory') }
      : null
  const planFact: Fact | null = catalog?.requiredPlan === 'pro' ? { label: translate('models.facts.plan'), value: translate('models.facts.plan.pro'), title: translate('model.paid') } : null
  // The card's key facts, most telling first; the details popover lists every fact.
  const keyFacts = [
    local && { label: translate('models.facts.parameters'), value: local.parameterSize },
    local && { label: translate('models.facts.quantization'), value: local.quantization },
    contextFact, memoryFact, planFact,
  ].filter((fact): fact is Fact => Boolean(fact))
  const allFacts = [
    local && { label: translate('models.facts.family'), value: local.family },
    ...keyFacts,
  ].filter((fact): fact is Fact => Boolean(fact))

  return (
    <article
      className={cx(
        'surface flex h-full w-full flex-col rounded-xl p-3 shadow-[var(--shadow-card)]',
        'transition-colors duration-150 hover:border-control',
      )}
      aria-label={model.name}
    >
      {/* Заголовок: имя ведёт в профиль, облако — единственная метка рядом с ним. */}
      <header className="mb-2">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={paths.model(model.name)}
            className="min-w-0 truncate font-mono text-[13px] font-semibold hover:text-accent focus-visible:text-accent"
            title={model.name}
          >
            {model.name}
          </Link>
          <div className="model-card-head-actions">
            {model.isCloud && (
              <Badge tone="accent" title={translate('model.cloud.memory')}>
                {translate('model.cloud')}
              </Badge>
            )}
            <Popover>
              <PopoverTrigger render={<IconButton size="sm" label={translate('models.details')} icon={<UiIcon name="info" />} />} />
              <PopoverContent align="end" className="model-details-popover">
                <PopoverTitle>{translate('models.details')}</PopoverTitle>
                <FactList label={translate('models.facts.label')} facts={allFacts} />
                {local ? <InstalledEvidenceSummary descriptor={local.descriptor} /> : null}
                {capabilities.length > 0 && (
                  <div className="model-details-capabilities" aria-label={translate('models.details.capabilities')} role="group">
                    {capabilities.map((capability) => (
                      <Badge key={capability} tone={primary.includes(capability) ? 'outline' : 'neutral'} title={translate(CAPABILITY_LABEL[capability].hint)}>
                        {translate(CAPABILITY_LABEL[capability].short)}
                      </Badge>
                    ))}
                  </div>
                )}
                {local ? <FitIndicator fit={model.fit} compact /> : null}
              </PopoverContent>
            </Popover>
          </div>
        </div>
        {catalog?.description ? (
          <p className="mt-1 line-clamp-2 text-2xs leading-4 text-muted" title={catalog.description}>
            {catalog.description}
          </p>
        ) : null}
      </header>

      {/* At most four key facts on the card (visual pass 3); the rest sits in the details popover. */}
      <FactList className="mb-2" label={translate('models.facts.label')} facts={keyFacts.slice(0, 4)} />
      {local ? <div className="model-card-caution"><InstalledEvidenceCaution descriptor={local.descriptor} /></div> : null}

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
          <div className="model-card-fit">
            <FitIndicator fit={model.fit} compact summary />
          </div>
          {/* One compact action, not a full-width primary; the profile opens from the model name. */}
          <footer className="model-card-footer">
            <Link
              to={`${paths.chat()}?model=${encodeURIComponent(model.name)}${selectedContextLength === undefined ? '' : `&numCtx=${selectedContextLength}`}`}
              className="model-card-action"
            >
              <UiIcon name="chat" size={14} aria-hidden="true" />
              {translate('model.startChat')}
            </Link>
          </footer>
        </>
      )}
    </article>
  )
})

/** Кнопка «Установить» в карточке каталога, когда скачивание ещё не начато. */
export function InstallButton({ onClick }: { onClick: () => void }) {
  return (
    // A compact primary, not a full-width bar on every card (visual pass 3).
    <Button variant="primary" size="sm" onClick={onClick}>
      {translate('model.install')}
    </Button>
  )
}
