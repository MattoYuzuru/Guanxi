import { Button } from '@guanxi/ui'
import { useId } from 'react'
import type { RuntimeSnapshot } from '@guanxi/contract'
import { PRODUCT_NAME } from '../../lib/brand.ts'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'
import { requestWorkspaceMode } from '../workspace/commands.ts'
import type { WorkspaceShellState } from '../workspace/shell-state.ts'

/** Unknown providers stay visible as unknown; sampled host facts retain their source and time. */
export function ShellStatus({ breadcrumb, workspace, runtime, stale }: {
  breadcrumb: string
  workspace: WorkspaceShellState
  runtime: RuntimeSnapshot | null
  stale: boolean
}) {
  const modeReason = useId()
  const machine = runtime?.host.profile
  return <div className="flex min-w-0 flex-wrap items-center gap-2 text-12">
    <nav aria-label={t('shell.breadcrumb')} className="flex min-w-0 flex-wrap items-center gap-1">
      <Link to={paths.launcher()} className="text-14 font-heading">{PRODUCT_NAME}</Link>
      <span aria-hidden="true">/</span><span aria-current="page" className="break-words">{breadcrumb}</span>
    </nav>
    <div role="group" aria-label={t('workspaceLayout.mode')} className="flex flex-wrap gap-1"
      aria-describedby={!workspace.ready || workspace.busy ? modeReason : undefined}>
      {(['developer', 'visual'] as const).map(mode => <Button key={mode} variant="ghost" size="sm"
        disabled={!workspace.ready || workspace.busy} aria-pressed={workspace.mode === mode}
        onClick={() => requestWorkspaceMode(mode)}>{t(`workspaceLayout.${mode}`)}</Button>)}
      {(!workspace.ready || workspace.busy) && <span id={modeReason}>{t(!workspace.ready ? 'shell.workspace.required' : 'shell.workspace.busy')}</span>}
    </div>
    <dl className="flex min-w-0 flex-wrap items-start gap-2">
      <div><dt className="font-heading">{t('shell.machine')}</dt>
        <dd>{machine ? `${machine.platform} · ${machine.arch}` : t('shell.status.unknown')}</dd>
        {machine && <dd className="text-secondary">{t('shell.machine.source', { time: formatDateTime(machine.observedAt) })}
          {stale && <> · {t('shell.observation.stale')}</>}
        </dd>}
      </div>
      {(['quota', 'keepAwake', 'power', 'inbox'] as const).map(item => <div key={item}>
        <dt className="font-heading">{t(`shell.${item}`)}</dt><dd className="text-secondary">{t('shell.status.unknown')}</dd>
      </div>)}
    </dl>
  </div>
}
