import { useEffect, useId, useState } from 'react'
import type { Connection, ConnectionErrorCode, ConnectionModel } from '@guanxi/contract'
import { Icon, IconButton, Input, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@guanxi/ui'
import { translate as t } from '../../lib/locale.ts'
import { useAsync } from '../../lib/useAsync.ts'
import { connectionApi, ConnectionRequestError } from './api.ts'
import { connectionLabel } from './labels.ts'

function reasonCode(error: unknown): ConnectionErrorCode | null {
  return error instanceof ConnectionRequestError ? error.code : null
}

function ModelList({ connection, onLoaded }: { connection: Connection; onLoaded: (count: number) => void }) {
  const [search, setSearch] = useState('')
  const id = useId()
  const models = useAsync<ConnectionModel[]>(signal => connectionApi.models(connection.id, signal), [connection.id])
  useEffect(() => { if (models.data) onLoaded(models.data.length) }, [models.data, onLoaded])
  const query = search.trim().toLocaleLowerCase()
  const filtered = (models.data ?? []).filter(model => model.id.toLocaleLowerCase().includes(query))
  const code = reasonCode(models.error)
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-12 font-label text-secondary">{t('connections.models.search')}</label>
      <Input id={id} type="search" value={search} onChange={event => setSearch(event.target.value)} autoComplete="off" />
    </div>
    {models.loading && !models.data && <p role="status" className="m-0 text-12 text-secondary">{t('connections.models.loading')}</p>}
    {models.error !== null && <p role="alert" className="m-0 text-12 text-danger">
      {t('connections.models.error')} {code ? t(`connections.error.${code}`) : ''}
    </p>}
    {models.data && filtered.length === 0 && <p className="m-0 text-12 text-muted">
      {query ? t('connections.models.noMatch') : t('connections.models.empty')}
    </p>}
    {filtered.length > 0 && <ul aria-label={t('connections.models.list', { name: connectionLabel(connection) })}
      className="connections-models-list m-0 flex max-h-64 flex-col gap-1 overflow-y-auto p-0">
      {filtered.map(model => <li key={model.id} className="min-w-0 break-all font-mono text-12">{model.id}</li>)}
    </ul>}
  </div>
}

/** A per-connection model list. A failed read recovers by itself (D-203); no Retry button exists. */
export function ModelsPopover({ connection, disabled, onLoaded }: {
  connection: Connection
  disabled?: boolean
  onLoaded: (count: number) => void
}) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<IconButton disabled={disabled} label={t('connections.action.models', { name: connectionLabel(connection) })}
      icon={<Icon name="models" />} />} />
    <PopoverContent side="bottom" align="end" className="w-sm">
      <PopoverTitle>{t('connections.models.title', { name: connectionLabel(connection) })}</PopoverTitle>
      {open && <ModelList connection={connection} onLoaded={onLoaded} />}
    </PopoverContent>
  </Popover>
}
