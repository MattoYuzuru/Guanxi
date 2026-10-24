import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { connectionSecretInputSchema, type Connection, type ConnectionErrorCode, type ProviderCatalogEntry } from '@guanxi/contract'
import {
  Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, Icon, IconButton, Input,
} from '@guanxi/ui'
import { translate as t } from '../../lib/locale.ts'
import { connectionLabel } from './labels.ts'
import { connectionApi } from './api.ts'
import type { ConnectionMutate } from './ConnectionsPage.tsx'

function Field({ label, hint, error, children }: {
  label: string; hint?: string; error?: string; children: (control: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
}) {
  const id = useId(), hintId = `${id}-hint`, errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  return <div className="flex min-w-0 flex-col gap-1">
    <label htmlFor={id} className="text-12 font-label text-secondary">{label}</label>
    {children({ id, describedBy, invalid: Boolean(error) })}
    {hint && <p id={hintId} className="m-0 text-12 text-muted">{hint}</p>}
    {error && <p id={errorId} role="alert" className="m-0 text-12 text-danger">{error}</p>}
  </div>
}

function errorCopy(code: ConnectionErrorCode | undefined): string {
  return code ? t(`connections.error.${code}`) : t('connections.error')
}

/** The wire schema owns the minimum; the dialog must never accept a key the server will reject. */
const minimumKeyLength = connectionSecretInputSchema.shape.value.minLength ?? 1

/**
 * Add or replace one credential. The key lives in local state only until the request starts:
 * it is cleared before the first await and never rendered back. A failed create is rolled back
 * with DELETE so no half-connected provider is left behind.
 */
export function ConnectionKeyDialog({ entry, connection, open, busy, run, onOpenChange }: {
  entry: ProviderCatalogEntry
  /** Present for a rotation; absent when adding a new connection. */
  connection?: Connection
  open: boolean
  busy: boolean
  run: ConnectionMutate
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [visible, setVisible] = useState(false)
  const [failure, setFailure] = useState<ConnectionErrorCode>()
  const rotating = connection !== undefined
  const needsKey = entry.auth === 'api_key'
  const baseUrl = connection?.baseUrl ?? ''
  const defaultName = connection ? connectionLabel(connection) : entry.label
  const canSubmit = !busy && (!needsKey || key.length >= minimumKeyLength)

  useEffect(() => {
    // Clear the typed key as soon as the dialog closes, not only when it is opened again.
    if (!open) { setKey(''); setVisible(false); setFailure(undefined); return }
    setName(defaultName)
    setKey(''); setVisible(false); setFailure(undefined)
  }, [open, defaultName])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    const value = key
    // The field is empty for the whole request, including a validation refusal.
    setKey(''); setFailure(undefined)
    let createdId: string | undefined
    const result = await run(async () => {
      try {
        const target = connection ?? await connectionApi.create({
          name: (name.trim() || entry.label).slice(0, 160),
          kind: entry.kind,
          provider: entry.provider,
          auth: entry.auth,
        })
        // Only a row created here may be rolled back. A rotation targets an existing,
        // already-good connection and a failed PUT must never delete it.
        if (!connection) createdId = target.id
        if (needsKey && value) await connectionApi.secret(target.id, value)
      } catch (error) {
        // A created row with no stored secret would look connected but never work.
        if (createdId) await connectionApi.remove(createdId).catch(() => undefined)
        throw error
      }
    })
    if (result.ok) onOpenChange(false)
    else setFailure(result.code)
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogTitle>{rotating ? t('connections.key.titleRotate', { name: connectionLabel(connection) }) : t('connections.key.titleAdd', { provider: entry.label })}</DialogTitle>
      <DialogDescription>{needsKey ? t('connections.key.description') : t('connections.key.connectDescription')}</DialogDescription>
      <form onSubmit={event => void submit(event)} className="flex min-w-0 flex-col gap-3 pt-2">
        {!rotating && <Field label={t('connections.key.name')} hint={t('connections.key.nameHint', { provider: entry.label })}>
          {({ id: fieldId, describedBy }) => <Input id={fieldId} aria-describedby={describedBy} maxLength={160}
            autoComplete="off" value={name} disabled={busy} onChange={event => setName(event.target.value)} />}
        </Field>}
        {needsKey && <Field label={t('connections.secret')} error={failure ? errorCopy(failure) : undefined}>
          {({ id: fieldId, describedBy, invalid }) => <div className="flex min-w-0 items-center gap-1">
            <Input id={fieldId} aria-describedby={describedBy} invalid={invalid} type={visible ? 'text' : 'password'}
              autoComplete="off" spellCheck={false} value={key} disabled={busy}
              onChange={event => setKey(event.target.value)} className="min-w-0 flex-1" />
            <IconButton label={t(visible ? 'connections.key.hide' : 'connections.key.show')}
              icon={<Icon name={visible ? 'hide' : 'show'} />} onClick={() => setVisible(value => !value)} />
          </div>}
        </Field>}
        {entry.baseUrl !== 'none' && <Field label={t('connections.key.baseUrl')} hint={t('connections.key.baseUrlHint')}>
          {({ id: fieldId, describedBy }) => <Input id={fieldId} aria-describedby={describedBy} value={baseUrl}
            readOnly placeholder={t('connections.key.baseUrlNone')} className="font-mono" />}
        </Field>}
        {failure && !needsKey && <p role="alert" className="m-0 text-12 text-danger">{errorCopy(failure)}</p>}
        {entry.docsUrl && <a href={entry.docsUrl} target="_blank" rel="noreferrer" className="text-12 text-accent underline underline-offset-2">
          {t('connections.key.docs')}
        </a>}
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" type="button" />}>{t('connections.key.cancel')}</DialogClose>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={busy}
            loadingLabel={t('connections.key.saving')}>
            {rotating ? t('connections.key.submitRotate') : needsKey ? t('connections.key.submitAdd') : t('connections.key.submitConnect')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
