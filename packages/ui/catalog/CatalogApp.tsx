/**
 * Settings → Developer → Components (D-137): the live catalog. It renders every declared state
 * of every component through the same story files Storybook reads, under any theme, density,
 * glass level, motion, transparency and locale, and hosts the owner's review actions (D-138).
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '../src/index.ts'
import { useUiText, type UiLocale } from '../src/i18n/context.tsx'
import type { UiMessageKey } from '../src/i18n/messages.ts'
import type { CatalogEntry, CatalogStory } from './entries.ts'
import { useStorySettle } from './focus-guard.tsx'
import { DocMarkdown } from './markdown.tsx'
import { RegimeFrame } from './RegimeFrame.tsx'
import {
  DEFAULT_REGIME,
  DENSITIES,
  GLASS_LEVELS,
  LOCALES,
  MOTIONS,
  THEMES,
  TRANSPARENCIES,
  type Regime,
} from './regimes.ts'
import { ReviewPanel, type ReviewBinding } from './ReviewPanel.tsx'
import type { ReviewApi } from './review-api.ts'
import { StatusBadge, entryStatus } from './status-badge.tsx'
import { StoryBoundary, StoryView } from './StoryView.tsx'
import { T2PluginFrame } from './t2-sample/T2PluginFrame.tsx'
import { REQUIRED_DOC_SECTIONS } from './docs.ts'
import './catalog.css'

export type CatalogView = { kind: 'overview' } | { kind: 'component'; id: string } | { kind: 't2' }

export interface CatalogAppProps {
  entries: CatalogEntry[]
  /** The app's resolved theme; the catalog chrome follows it. */
  chromeTheme: 'light' | 'dark'
  chromeLocale: 'en' | 'ru'
  reviewApi: ReviewApi | null
  initialView?: CatalogView
  initialRegime?: Regime
  /** Called when the view or the preview regime changes, so the host can keep the URL. */
  onLocationChange?: (view: CatalogView, regime: Regime) => void
  /** Raw story sources by component id, for the Code tab. */
  storySources?: Record<string, string>
  /** `live` under Vite dev (source on disk is what renders), `bundle` for a built app. */
  reviewBinding?: ReviewBinding
}

const STATUS_FILTERS = ['all', 'draft', 'review', 'approved', 'stale', 'deprecated', 'invalid'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

function ChoiceSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  name: string
}) {
  const labelId = useId()
  return (
    <div className="gx-catalog-control">
      <span id={labelId} className="gx-catalog-control-label">
        {label}
      </span>
      <Select
        items={options as Array<{ value: T; label: string }>}
        value={value}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next as T)
        }}
        modal={false}
      >
        <SelectTrigger aria-labelledby={labelId} data-catalog-control={name}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function Toolbar({ regime, onChange }: { regime: Regime; onChange: (regime: Regime) => void }) {
  const t = useUiText()
  const options = <T extends string>(values: readonly T[], prefix: string) =>
    values.map((value) => ({ value, label: t(`${prefix}.${value}` as UiMessageKey) }))
  return (
    <section className="gx-catalog-toolbar" aria-label={t('catalog.toolbar')}>
      <ChoiceSelect
        name="theme"
        label={t('catalog.theme')}
        value={regime.theme}
        options={options(THEMES, 'catalog.theme')}
        onChange={(theme) => onChange({ ...regime, theme })}
      />
      <ChoiceSelect
        name="density"
        label={t('catalog.density')}
        value={regime.density}
        options={options(DENSITIES, 'catalog.density')}
        onChange={(density) => onChange({ ...regime, density })}
      />
      <ChoiceSelect
        name="glass"
        label={t('catalog.glass')}
        value={regime.glass}
        options={options(GLASS_LEVELS, 'catalog.glass')}
        onChange={(glass) => onChange({ ...regime, glass })}
      />
      <ChoiceSelect
        name="motion"
        label={t('catalog.motion')}
        value={regime.motion}
        options={options(MOTIONS, 'catalog.motion')}
        onChange={(motion) => onChange({ ...regime, motion })}
      />
      <ChoiceSelect
        name="transparency"
        label={t('catalog.transparency')}
        value={regime.transparency}
        options={options(TRANSPARENCIES, 'catalog.transparency')}
        onChange={(transparency) => onChange({ ...regime, transparency })}
      />
      <ChoiceSelect
        name="locale"
        label={t('catalog.locale')}
        value={regime.locale}
        options={options(LOCALES, 'catalog.locale') as Array<{ value: UiLocale; label: string }>}
        onChange={(locale) => onChange({ ...regime, locale })}
      />
    </section>
  )
}

/** One declared state, rendered inside its own regime frame. */
export function StoryCell({ item, regime }: { item: CatalogStory; regime: Regime }) {
  const t = useUiText()
  const frame = item.story.parameters?.guanxi?.frame ?? item.meta.parameters?.guanxi?.frame ?? 'inline'
  const cell = useRef<HTMLElement>(null)
  useStorySettle(cell, frame !== 'inline')
  return (
    <figure ref={cell} className="gx-catalog-cell" data-frame={frame} data-story={item.key}>
      <RegimeFrame regime={regime} className="gx-catalog-stage">
        <StoryBoundary
          fallback={
            <p role="alert" data-story-error="">
              {t('catalog.story.failed')}
            </p>
          }
        >
          <StoryView meta={item.meta} story={item.story} />
        </StoryBoundary>
      </RegimeFrame>
      <figcaption className="gx-catalog-caption">{item.name}</figcaption>
    </figure>
  )
}

function StateGrid({ entry, regime }: { entry: CatalogEntry; regime: Regime }) {
  return (
    <div className="gx-catalog-grid" data-component={entry.id}>
      {entry.stories.map((item) => (
        <StoryCell key={item.key} item={item} regime={regime} />
      ))}
    </div>
  )
}

function Overview({ entries, regime }: { entries: CatalogEntry[]; regime: Regime }) {
  const t = useUiText()
  return (
    <div className="gx-catalog-overview">
      {entries.map((entry) => (
        <section key={entry.id} aria-labelledby={`catalog-${entry.id}`}>
          <header className="gx-catalog-section-head">
            <h2 id={`catalog-${entry.id}`}>{entry.title}</h2>
            <StatusBadge status={entryStatus(entry)} />
            <span className="gx-catalog-muted">
              {t('catalog.states.count', { count: entry.docs.states.length })}
            </span>
          </header>
          <StateGrid entry={entry} regime={regime} />
        </section>
      ))}
    </div>
  )
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gx-catalog-meta-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function TokensTab({ entry }: { entry: CatalogEntry }) {
  const t = useUiText()
  const variables = entry.manifest?.cssVariables ?? []
  return (
    <div>
      <p className="gx-catalog-muted">{t('catalog.tokens.description')}</p>
      {variables.length === 0 ? (
        <p>{t('catalog.tokens.none')}</p>
      ) : (
        <ul className="gx-catalog-tokens">
          {variables.map((name) => (
            <li key={name}>
              {name.startsWith('--color-') ? (
                <span className="gx-catalog-swatch" aria-hidden="true" style={{ backgroundColor: `var(${name})` }} />
              ) : null}
              <code>{name}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ComponentPage({
  entry,
  regime,
  reviewApi,
  reviewBinding,
  storySource,
}: {
  entry: CatalogEntry
  regime: Regime
  reviewApi: ReviewApi | null
  reviewBinding: ReviewBinding
  storySource: string | undefined
}) {
  const t = useUiText()
  const manifest = entry.manifest
  const snapshots = Object.keys(manifest?.snapshotHashes ?? {}).length
  // The node's status wins over the bundled one once the review panel has read it.
  const [status, setStatus] = useState(entryStatus(entry))
  return (
    <article aria-labelledby="catalog-component-title">
      <header className="gx-catalog-page-head">
        <h2 id="catalog-component-title">{entry.title}</h2>
        <StatusBadge status={status} />
      </header>
      <dl className="gx-catalog-meta">
        <MetaItem label={t('catalog.meta.level')}>
          {t(entry.level === 'primitive' ? 'catalog.level.primitive' : 'catalog.level.pattern')}
        </MetaItem>
        <MetaItem label={t('catalog.meta.usage')}>{manifest ? manifest.usage.count : '—'}</MetaItem>
        <MetaItem label={t('catalog.meta.since')}>{entry.docs.since ?? '—'}</MetaItem>
        <MetaItem label={t('catalog.meta.source')}>
          <code>{manifest ? manifest.sourceHash.slice(0, 19) : '—'}</code>
        </MetaItem>
        <MetaItem label={t('catalog.meta.snapshots')}>
          {snapshots > 0 ? t('catalog.meta.snapshotsCount', { count: snapshots }) : t('catalog.meta.snapshotsPending')}
        </MetaItem>
      </dl>
      <Tabs defaultValue="states">
        <TabsList aria-label={t('catalog.tabs')}>
          <TabsTab value="states">{t('catalog.tab.states')}</TabsTab>
          <TabsTab value="docs">{t('catalog.tab.docs')}</TabsTab>
          <TabsTab value="code">{t('catalog.tab.code')}</TabsTab>
          <TabsTab value="tokens">{t('catalog.tab.tokens')}</TabsTab>
          <TabsTab value="review">{t('catalog.tab.review')}</TabsTab>
        </TabsList>
        <TabsPanel value="states">
          <p className="gx-catalog-muted">{t('catalog.states.count', { count: entry.docs.states.length })}</p>
          <StateGrid entry={entry} regime={regime} />
        </TabsPanel>
        <TabsPanel value="docs" className="gx-catalog-docs" lang="en">
          {REQUIRED_DOC_SECTIONS.map((section) => (
            <section key={section}>
              <h3>{section}</h3>
              <DocMarkdown source={entry.docs.sections[section] ?? ''} />
            </section>
          ))}
        </TabsPanel>
        <TabsPanel value="code">
          <p className="gx-catalog-muted">{t('catalog.code.description')}</p>
          <pre className="gx-catalog-code" tabIndex={0} aria-label={t('catalog.tab.code')} lang="en">
            <code>{storySource ?? ''}</code>
          </pre>
        </TabsPanel>
        <TabsPanel value="tokens">
          <RegimeFrame regime={regime} className="gx-catalog-token-frame">
            <TokensTab entry={entry} />
          </RegimeFrame>
        </TabsPanel>
        <TabsPanel value="review">
          <ReviewPanel entry={entry} api={reviewApi} binding={reviewBinding} onStatus={setStatus} />
        </TabsPanel>
      </Tabs>
    </article>
  )
}

function T2Page({ regime }: { regime: Regime }) {
  const t = useUiText()
  const hostTheme = regime.theme.startsWith('dark') ? 'dark' : 'light'
  return (
    <section aria-labelledby="catalog-t2-title">
      <h2 id="catalog-t2-title">{t('catalog.t2.title')}</h2>
      <p className="gx-catalog-muted">{t('catalog.t2.description')}</p>
      <RegimeFrame regime={regime} className="gx-catalog-t2">
        <T2PluginFrame
          hostTheme={hostTheme}
          regimeKey={`${regime.theme}/${regime.density}/${regime.glass}`}
          title={t('catalog.t2.frame')}
        />
      </RegimeFrame>
    </section>
  )
}

function Navigation({
  entries,
  view,
  onSelect,
}: {
  entries: CatalogEntry[]
  view: CatalogView
  onSelect: (view: CatalogView) => void
}) {
  const t = useUiText()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const searchId = useId()
  const needle = query.trim().toLowerCase()
  const visible = entries.filter(
    (entry) =>
      (filter === 'all' || entryStatus(entry) === filter) &&
      (needle === '' || entry.title.toLowerCase().includes(needle) || entry.id.includes(needle)),
  )
  const group = (level: CatalogEntry['level']) => visible.filter((entry) => entry.level === level)
  const link = (target: CatalogView, label: ReactNode, current: boolean, key: string) => (
    <li key={key}>
      <button
        type="button"
        className="gx-catalog-nav-link gx-focusable"
        aria-current={current ? 'page' : undefined}
        onClick={() => onSelect(target)}
      >
        {label}
      </button>
    </li>
  )
  return (
    <nav className="gx-catalog-nav" aria-label={t('catalog.nav')}>
      <label htmlFor={searchId} className="gx-catalog-control-label">
        {t('catalog.search')}
      </label>
      <Input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      <ChoiceSelect
        name="status-filter"
        label={t('catalog.filter')}
        value={filter}
        options={STATUS_FILTERS.map((value) => ({
          value,
          label: t(value === 'all' ? 'catalog.filter.all' : (`catalog.status.${value}` as UiMessageKey)),
        }))}
        onChange={setFilter}
      />
      <ul className="gx-catalog-nav-list">
        {link({ kind: 'overview' }, t('catalog.nav.overview'), view.kind === 'overview', 'overview')}
        {link({ kind: 't2' }, t('catalog.t2.title'), view.kind === 't2', 't2')}
      </ul>
      <p role="status" className="gx-catalog-muted" data-catalog-results="">
        {visible.length === 0 ? t('catalog.empty') : t('catalog.results', { count: visible.length })}
      </p>
      {(['primitive', 'pattern'] as const).map((level) =>
        group(level).length === 0 ? null : (
          <div key={level}>
            <h2 className="gx-catalog-nav-heading">
              {t(level === 'primitive' ? 'catalog.level.primitive' : 'catalog.level.pattern')}
            </h2>
            <ul className="gx-catalog-nav-list">
              {group(level).map((entry) =>
                link(
                  { kind: 'component', id: entry.id },
                  <>
                    <span>{entry.title}</span>
                    <StatusBadge status={entryStatus(entry)} />
                  </>,
                  view.kind === 'component' && view.id === entry.id,
                  entry.id,
                ),
              )}
            </ul>
          </div>
        ),
      )}
    </nav>
  )
}

export function CatalogApp({
  entries,
  chromeTheme,
  chromeLocale,
  reviewApi,
  initialView = { kind: 'overview' },
  initialRegime = DEFAULT_REGIME,
  onLocationChange,
  storySources = {},
  reviewBinding = 'live',
}: CatalogAppProps) {
  const [view, setView] = useState<CatalogView>(initialView)
  const [regime, setRegime] = useState<Regime>(initialRegime)
  const chromeRegime = useMemo<Regime>(
    () => ({ ...DEFAULT_REGIME, theme: chromeTheme, density: 'comfortable', motion: 'system', locale: chromeLocale }),
    [chromeTheme, chromeLocale],
  )
  const entry = view.kind === 'component' ? entries.find((item) => item.id === view.id) : undefined

  useEffect(() => {
    onLocationChange?.(view, regime)
  }, [view, regime, onLocationChange])

  return (
    <RegimeFrame regime={chromeRegime} className="gx-catalog">
      <CatalogChrome
        entries={entries}
        view={entry || view.kind !== 'component' ? view : { kind: 'overview' }}
        setView={setView}
        regime={regime}
        setRegime={setRegime}
        entry={entry}
        reviewApi={reviewApi}
        reviewBinding={reviewBinding}
        storySources={storySources}
      />
    </RegimeFrame>
  )
}

function CatalogChrome({
  entries,
  view,
  setView,
  regime,
  setRegime,
  entry,
  reviewApi,
  reviewBinding,
  storySources,
}: {
  entries: CatalogEntry[]
  view: CatalogView
  setView: (view: CatalogView) => void
  regime: Regime
  setRegime: (regime: Regime) => void
  entry: CatalogEntry | undefined
  reviewApi: ReviewApi | null
  reviewBinding: ReviewBinding
  storySources: Record<string, string>
}) {
  const t = useUiText()
  return (
    <div className="gx-catalog-layout">
      <a className="gx-catalog-skip gx-focusable" href="#gx-catalog-preview">
        {t('catalog.skip')}
      </a>
      <header className="gx-catalog-header">
        <h1>{t('catalog.title')}</h1>
        <p className="gx-catalog-muted">{t('catalog.description')}</p>
      </header>
      <Toolbar regime={regime} onChange={setRegime} />
      <div className="gx-catalog-body">
        <Navigation entries={entries} view={view} onSelect={setView} />
        {/* The host app owns the <main> landmark; this is its content. */}
        <div id="gx-catalog-preview" className="gx-catalog-main" data-catalog-view={view.kind} tabIndex={-1}>
          {view.kind === 'overview' ? <Overview entries={entries} regime={regime} /> : null}
          {view.kind === 't2' ? <T2Page regime={regime} /> : null}
          {view.kind === 'component' && entry ? (
            <ComponentPage
              key={entry.id}
              entry={entry}
              regime={regime}
              reviewApi={reviewApi}
              reviewBinding={reviewBinding}
              storySource={storySources[entry.id]}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
