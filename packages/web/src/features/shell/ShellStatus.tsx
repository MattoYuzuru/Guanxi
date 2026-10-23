import type { Health, RuntimeMemoryFact, RuntimeSnapshot } from '@guanxi/contract'
import { StatusItem, type IconName, type StatusItemTone } from '@guanxi/ui'
import type { ReactNode } from 'react'
import { PRODUCT_NAME } from '../../lib/brand.ts'
import { formatBytes, formatTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'
import { ollamaHealthState } from '../health/HealthGate.tsx'
import { RuntimeDetails } from '../health/RuntimeStatus.tsx'
import { useRuntimeProjection } from '../health/RuntimeContext.tsx'
import { BrandMark } from '../new-session/BrandMark.tsx'

/** Breadcrumb at the left of the strip: the mark links home, the page name is plain text. */
export function ShellBreadcrumb({ page }: { page: string }) {
  return <nav aria-label={t('shell.breadcrumb')} className="flex min-w-0 items-center gap-2">
    <Link to={paths.launcher()} className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-foreground hover:bg-inset focus-visible:outline-focus"
      aria-label={t('shell.brand', { product: PRODUCT_NAME })}>
      <BrandMark className="size-4" />
    </Link>
    <span aria-current="page" className="truncate text-13 font-label text-secondary">{page}</span>
  </nav>
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="gx-popover-facts">
    {rows.map(([label, value]) => <div key={label} className="contents"><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>
}

function Footnote({ children }: { children: ReactNode }) {
  return <p className="gx-popover-footnote">{children}</p>
}

const bytes = (fact: RuntimeMemoryFact) => fact.bytes === null ? t('shell.status.unknownValue') : formatBytes(fact.bytes)

/** Device icon from the platform; the popover states the observed facts. */
function deviceIcon(platform: string | undefined): IconName {
  if (platform === 'linux') return 'device-server'
  if (platform === 'darwin' || platform === 'win32') return 'device-laptop'
  return 'device-desktop'
}

/**
 * The status strip's icon items (D-202): device, memory, runtime and the inbox; quota,
 * keep-awake and power appear only once they have a source. Unknown stays unknown, never 0; values carry the weight; provenance is one sentence
 * with an absolute time and no "N s ago" counter (D-203). Updates arrive with the shared quiet
 * runtime sample, so nothing here flickers or offers a Retry.
 */
/**
 * The status items bound to the shared runtime sample. This is the only shell component that reads
 * the sample, so a poll re-renders the strip and nothing else in the shell (P2, D-203).
 */
export function ShellRuntimeStatusItems(props: { health: Health; healthStale?: boolean; inbox?: ReactNode }) {
  const runtime = useRuntimeProjection()
  return <ShellStatusItems runtime={runtime.data} stale={runtime.error !== null && runtime.data !== null} {...props} />
}

export function ShellStatusItems({ runtime, stale, health, healthStale = false, inbox }: {
  runtime: RuntimeSnapshot | null
  /** The last sample is on screen but the latest read failed. */
  stale: boolean
  health: Health
  /** The last health answer is on screen but the latest health read failed. */
  healthStale?: boolean
  inbox?: ReactNode
}) {
  const profile = runtime?.host.profile
  const sample = runtime?.host.sample
  const observed = runtime ? formatTime(runtime.observedAt) : null
  const staleLabel = observed ? t('shell.status.staleName', { time: observed }) : undefined
  const provenance = (source: string) => observed === null ? null
    : <Footnote>{stale ? t('shell.status.lastObserved', { time: observed }) : t('shell.status.observed', { source, time: observed })}</Footnote>

  const ollama = ollamaHealthState(health)
  const governor = runtime?.governor
  const runtimeTone: StatusItemTone = ollama === 'incompatible' ? 'danger' : ollama === 'unavailable' ? 'warning'
    : governor?.activeLease ? 'accent' : runtime ? 'neutral' : 'unknown'
  const queued = governor?.queued.length ?? 0

  const available = sample?.availableMemoryBytes
  const memoryValue = available && available.bytes !== null ? formatBytes(available.bytes) : undefined

  return <div className="flex min-w-0 flex-wrap items-center gap-0.5" data-testid="shell-status-items">
    <StatusItem icon={deviceIcon(profile?.platform)} label={t('shell.status.device')} tone={profile ? 'neutral' : 'unknown'} stale={stale && Boolean(profile)} staleLabel={staleLabel}>
      {profile ? <>
        <Facts rows={[
          [t('shell.status.platform'), <span className="font-mono">{`${profile.platform} ${profile.arch}`}</span>],
          [t('shell.status.accelerator'), profile.acceleratorName ?? profile.accelerator],
          [t('shell.status.unifiedMemory'), bytes(profile.totalMemoryBytes)],
        ]} />
        {provenance(t('shell.status.source.hardware'))}
      </> : undefined}
    </StatusItem>

    <StatusItem icon={profile?.unifiedMemory === false ? 'memory-ram' : 'memory-unified'} label={t('shell.status.memory')}
      title={profile?.unifiedMemory ? t('shell.status.unifiedMemory') : t('shell.status.memory')}
      value={memoryValue} tone={sample ? (sample.pressure.level === 'critical' ? 'danger' : sample.pressure.level === 'warning' ? 'warning' : 'neutral') : 'unknown'}
      stale={stale && Boolean(sample)} staleLabel={staleLabel}>
      {profile && sample ? <>
        <Facts rows={[
          [t('shell.status.memory.total'), bytes(profile.totalMemoryBytes)],
          [t('shell.status.memory.available'), bytes(sample.availableMemoryBytes)],
          [t('shell.status.memory.freePages'), bytes(sample.freeMemoryBytes)],
          [t('shell.status.memory.pressure'), t(`shell.status.memory.pressure.${sample.pressure.level}`)],
        ]} />
        {provenance(t('shell.status.source.sample'))}
      </> : undefined}
    </StatusItem>

    <StatusItem icon="runtime" label={t('shell.status.runtime')} tone={runtimeTone} badge={ollama !== 'reachable' ? true : queued > 0 ? queued : undefined}
      value={ollama === 'unavailable' ? t('shell.status.runtime.short.unavailable') : ollama === 'incompatible' ? t('shell.status.runtime.short.incompatible') : undefined}
      stale={(stale && runtime !== null) || healthStale} staleLabel={staleLabel ?? t('shell.status.staleHealth')}
      align="end" wide>
      <div className="flex flex-col gap-2" data-testid="shell-runtime-popover">
        {ollama === 'reachable'
          ? <p className="text-12 text-secondary">{t('shell.status.runtime.ready')}</p>
          : <div role={ollama === 'incompatible' ? 'alert' : 'status'} className="flex flex-col gap-1 text-12">
            <p>{t(ollama === 'incompatible' ? 'shell.status.runtime.incompatible' : 'shell.status.runtime.unavailable')}</p>
            {ollama === 'unavailable' && health.ollama.installHint && <>
              <p className="text-secondary">{t('shell.status.runtime.start')}</p>
              <code className="rounded-inline bg-inset px-2 py-1 font-mono text-12">{health.ollama.installHint.command}</code>
            </>}
            <p className="text-secondary">{t('shell.status.runtime.recovering')}</p>
          </div>}
        <RuntimeDetails snapshot={runtime} stale={stale} />
      </div>
    </StatusItem>

    {/* Quota, keep-awake and power join the strip when the node reports a source for them (P3);
        until then they are not shown, rather than as permanent Unknown icons. */}
    {inbox}
  </div>
}
