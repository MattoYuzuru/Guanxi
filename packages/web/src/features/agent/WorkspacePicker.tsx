/**
 * Выбор рабочей директории для агента.
 *
 * Инвариант: фронт никогда не читает файловую систему сам — только через
 * /api/workspaces/browse. Никакого File System Access API, никаких
 * <input webkitdirectory>. От этого зависит вынос сервера на другую машину:
 * там «локальной» ФС у браузера просто не будет.
 */
import { useState } from 'react'
import type { Workspace } from '@guanxi/contract'
import { api, errorMessage } from '../../lib/api.ts'
import { useAsync } from '../../lib/useAsync.ts'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Modal,
  Spinner,
  cx,
} from '../../components/ui.tsx'
import { formatRelativeTime, shortenPath } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

export function WorkspacePicker({
  open,
  currentId,
  onClose,
  onPick,
}: {
  open: boolean
  currentId: string | null
  onClose: () => void
  onPick: (workspace: Workspace | null) => void
}) {
  const [tab, setTab] = useState<'saved' | 'browse'>('saved')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={translate('workspace.title')}
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={() => onPick(null)}>
            {translate('workspace.none')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {translate('workspace.close')}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex gap-1">
        <TabButton active={tab === 'saved'} onClick={() => setTab('saved')}>
          {translate('workspace.saved')}
        </TabButton>
        <TabButton active={tab === 'browse'} onClick={() => setTab('browse')}>
          {translate('workspace.choose')}
        </TabButton>
      </div>

      {tab === 'saved' ? (
        <SavedList currentId={currentId} onPick={onPick} />
      ) : (
        <DirectoryBrowser onPick={onPick} />
      )}
    </Modal>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'rounded-md px-2 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-inset text-foreground'
          : 'text-secondary hover:bg-inset',
      )}
    >
      {children}
    </button>
  )
}

function SavedList({
  currentId,
  onPick,
}: {
  currentId: string | null
  onPick: (workspace: Workspace) => void
}) {
  const workspaces = useAsync((signal) => api.listWorkspaces(signal), [])

  if (workspaces.loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-secondary">
        <Spinner /> {translate('workspace.loading')}
      </div>
    )
  }

  if (workspaces.error) {
    return <Callout tone="danger" title={translate('workspace.loadError')}>{errorMessage(workspaces.error)}</Callout>
  }

  const list = workspaces.data?.workspaces ?? []
  if (list.length === 0) {
    return (
      <EmptyState
        title={translate('workspace.empty.title')}
        description={translate('workspace.empty.description')}
      />
    )
  }

  return (
    <ul className="max-h-80 space-y-1 overflow-auto">
      {list.map((workspace) => (
        <li key={workspace.id}>
          <button
            type="button"
            onClick={() => onPick(workspace)}
            disabled={!workspace.exists}
            className={cx(
              'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors',
              workspace.id === currentId
                ? 'border-accent bg-accent/5'
                : 'border-divider hover:bg-inset',
              !workspace.exists && 'opacity-55',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{workspace.name}</span>
              <span
                className="block truncate font-mono text-2xs text-secondary"
                title={workspace.rootPath}
              >
                {workspace.rootPath}
              </span>
            </span>
            {!workspace.exists && <Badge tone="red">{translate('workspace.missing')}</Badge>}
            {workspace.id === currentId && <Badge tone="accent">{translate('workspace.selected')}</Badge>}
            <span className="shrink-0 text-2xs text-secondary">
              {formatRelativeTime(workspace.lastUsedAt ?? workspace.createdAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function DirectoryBrowser({ onPick }: { onPick: (workspace: Workspace) => void }) {
  const [path, setPath] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const listing = useAsync((signal) => api.browse(path, signal), [path])

  const create = async (rootPath: string) => {
    setCreating(true)
    setError(null)
    try {
      const workspace = await api.createWorkspace({ rootPath })
      onPick(workspace)
    } catch (createError) {
      setError(errorMessage(createError))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      {/* Текущий путь и переход наверх */}
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={!listing.data?.parent}
          onClick={() => setPath(listing.data?.parent ?? undefined)}
        >
          {translate('workspace.up')}
        </Button>
        <code
          className="min-w-0 flex-1 truncate rounded border border-divider bg-inset px-2 py-1 font-mono text-2xs"
          title={listing.data?.path}
        >
          {listing.data?.path ?? '…'}
        </code>
        <Button
          variant="primary"
          size="sm"
          loading={creating}
          disabled={!listing.data}
          onClick={() => listing.data && create(listing.data.path)}
        >
          {translate('workspace.chooseCurrent')}
        </Button>
      </div>

      {error && (
        <div className="mb-2">
          <Callout tone="danger" title={translate('workspace.addError')}>
            {error}
          </Callout>
        </div>
      )}

      {listing.loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-secondary">
          <Spinner /> {translate('workspace.reading')}
        </div>
      ) : listing.error ? (
        <Callout tone="danger" title={translate('workspace.unavailable')}>
          {errorMessage(listing.error)}
        </Callout>
      ) : (
        <ul className="max-h-72 overflow-auto rounded-md border border-divider">
          {(listing.data?.entries ?? []).length === 0 && (
            <li className="px-2 py-3 text-center text-2xs text-muted">
              {translate('workspace.directoryEmpty')}
            </li>
          )}
          {(listing.data?.entries ?? []).map((entry) => (
            <li key={entry.path} className="border-b border-divider last:border-0">
              <button
                type="button"
                disabled={!entry.isDirectory}
                onDoubleClick={() => entry.isDirectory && create(entry.path)}
                onClick={() => entry.isDirectory && setPath(entry.path)}
                className={cx(
                  'flex w-full items-center gap-2 px-2 py-1 text-left',
                  entry.isDirectory
                    ? 'hover:bg-inset'
                    : 'cursor-default opacity-50',
                )}
                title={entry.isDirectory ? translate('workspace.entryHint') : entry.path}
              >
                <span aria-hidden className="w-3.5 shrink-0 text-center text-2xs">
                  {entry.isDirectory ? '▸' : '·'}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-2xs">{entry.name}</span>
                {entry.isGitRepo && (
                  <Badge tone="accent" title={translate('workspace.git')}>
                    git
                  </Badge>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-2xs text-muted">
        {translate('workspace.browserHint')}
      </p>
    </div>
  )
}

/** Компактная плашка выбранной директории для шапки треда. */
export function WorkspaceChip({
  workspace,
  onClick,
}: {
  workspace: Workspace | null
  onClick: () => void
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onClick}
      title={workspace ? workspace.rootPath : translate('workspace.notSelected')}
    >
      {workspace ? shortenPath(workspace.rootPath) : translate('workspace.choose')}
    </Button>
  )
}
