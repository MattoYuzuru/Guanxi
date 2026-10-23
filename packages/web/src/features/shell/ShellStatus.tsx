import type { Health, RuntimeMemoryFact, RuntimeSnapshot } from '@guanxi/contract'
import { StatusItem, type IconName, type StatusItemTone } from '@guanxi/ui'
import type { ReactNode } from 'react'
import { PRODUCT_NAME } from '../../lib/brand.ts'
import { formatBytes, formatTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'
import { ollamaHealthState } from '../health/HealthGate.tsx'
import { RuntimeDetails } from '../health/RuntimeStatus.tsx'
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
 * The status strip's icon items (D-202): device, memory, runtime, quota, keep-awake, power and
 * the inbox. Unknown stays unknown, never 0; values carry the weight; provenance is one sentence
 * with an absolute time and no "N s ago" counter (D-203). Updates arrive with the shared quiet
 * runtime sample, so nothing here flickers or offers a Retry.
 */
export function ShellStatusItems({ runtime, stale, health, inbox }: {
  runtime: RuntimeSnapshot | null
  /** The last sample is on screen but the latest read failed. */
  stale: boolean
  health: Health
  inbox?: ReactNode
}) {
  const profile = runtime?.host.profile
  const sample = runtime?.host.sample
  const observed = runtime ? formatTime(runtime.observedAt) : null
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
    <StatusItem icon={deviceIcon(profile?.platform)} label={t('shell.status.device')} tone={profile ? 'neutral' : 'unknown'}>
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
      value={memoryValue} tone={sample ? (sample.pressure.level === 'critical' ? 'danger' : sample.pressure.level === 'warning' ? 'warning' : 'neutral') : 'unknown'}>
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

    <StatusItem icon="quota" label={t('shell.quota')} tone="unknown">
      <p className="m-0 text-12 text-secondary">{t('shell.status.quota.unknown')}</p>
    </StatusItem>
    <StatusItem icon="keep-awake" label={t('shell.keepAwake')} tone="unknown">
      <p className="m-0 text-12 text-secondary">{t('shell.status.keepAwake.unknown')}</p>
    </StatusItem>
    <StatusItem icon="power" label={t('shell.power')} tone="unknown" align="end">
      <p className="m-0 text-12 text-secondary">{t('shell.status.power.unknown')}</p>
    </StatusItem>
    {inbox}
  </div>
}
