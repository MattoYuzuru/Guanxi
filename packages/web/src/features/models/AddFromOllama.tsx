import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  OllamaReferencePreview,
  PullStreamEvent,
} from '@alamo/contract'
import { Button, Input, Meter, Modal } from '../../components/ui.tsx'
import {
  ApiRequestError,
  api,
  streamOllamaReferencePull,
} from '../../lib/api.ts'
import { formatBytes, formatPercent } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

type Progress = Extract<PullStreamEvent, { type: 'progress' }>['data']

type FlowState =
  | { kind: 'editing' }
  | { kind: 'validating' }
  | { kind: 'invalid'; message: string }
  | { kind: 'preview'; preview: OllamaReferencePreview }
  | { kind: 'pulling'; preview: OllamaReferencePreview; progress: Progress | null }
  | { kind: 'cancelled'; preview: OllamaReferencePreview }
  | { kind: 'error'; preview: OllamaReferencePreview; message: string }
  | {
      kind: 'success'
      preview: OllamaReferencePreview
      installedConfirmed: boolean
      refreshFailed: boolean
    }

export function AddFromOllama({
  installedNames,
  onInstalled,
}: {
  installedNames: readonly string[]
  onInstalled: () => void
}) {
  const [open, setOpen] = useState(false)
  const [reference, setReference] = useState('')
  const [state, setState] = useState<FlowState>({ kind: 'editing' })
  const entryRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previewControllerRef = useRef<AbortController | null>(null)
  const pullControllerRef = useRef<AbortController | null>(null)
  const pullIntentRef = useRef(false)

  useEffect(() => () => {
    previewControllerRef.current?.abort('unmount')
    pullControllerRef.current?.abort('unmount')
  }, [])

  useEffect(() => {
    if (!open) return
    if (state.kind === 'preview') confirmRef.current?.focus()
    if (state.kind === 'pulling') cancelRef.current?.focus()
  }, [open, state.kind])

  const close = () => {
    if (state.kind === 'pulling') return
    previewControllerRef.current?.abort('dialog-closed')
    setOpen(false)
    setReference('')
    setState({ kind: 'editing' })
  }

  const changeReference = (value: string) => {
    previewControllerRef.current?.abort('input-changed')
    setReference(value)
    setState({ kind: 'editing' })
  }

  const preview = async (event: FormEvent) => {
    event.preventDefault()
    if (state.kind === 'validating' || state.kind === 'pulling') return
    const controller = new AbortController()
    previewControllerRef.current?.abort('new-preview')
    previewControllerRef.current = controller
    setState({ kind: 'validating' })
    try {
      const response = await api.previewOllamaReference(reference, controller.signal)
      if (!controller.signal.aborted) setState({ kind: 'preview', preview: response.preview })
    } catch (error) {
      if (controller.signal.aborted) return
      setState({
        kind: 'invalid',
        message:
          error instanceof ApiRequestError && error.status === 400
            ? translate('models.addOllama.invalid')
            : translate('models.addOllama.previewError'),
      })
    } finally {
      if (previewControllerRef.current === controller) previewControllerRef.current = null
    }
  }

  const startPull = async (target: OllamaReferencePreview) => {
    if (pullIntentRef.current) return
    pullIntentRef.current = true
    const controller = new AbortController()
    pullControllerRef.current = controller
    setState({ kind: 'pulling', preview: target, progress: null })
    try {
      let completed = false
      for await (const event of streamOllamaReferencePull({
        reference: target.displayValue,
        confirmedModelName: target.normalizedModelName,
      }, controller.signal)) {
        if (event.type === 'progress') {
          setState({ kind: 'pulling', preview: target, progress: event.data })
        } else if (event.type === 'error') {
          setState({ kind: 'error', preview: target, message: pullError(event.data.code) })
          return
        } else {
          completed = true
        }
      }
      if (controller.signal.aborted) {
        setState({ kind: 'cancelled', preview: target })
        return
      }
      if (!completed) {
        setState({
          kind: 'error', preview: target,
          message: translate('models.addOllama.error.protocol'),
        })
        return
      }

      try {
        const installed = await api.listModels(undefined, controller.signal)
        const installedConfirmed = installed.models.some(
          (model) => model.name.toLowerCase() === target.normalizedModelName,
        )
        setState({
          kind: 'success', preview: target, installedConfirmed,
          refreshFailed: false,
        })
        onInstalled()
      } catch {
        if (controller.signal.aborted) {
          setState({ kind: 'cancelled', preview: target })
          return
        }
        setState({
          kind: 'success', preview: target, installedConfirmed: false,
          refreshFailed: true,
        })
      }
    } catch {
      if (controller.signal.aborted) {
        setState({ kind: 'cancelled', preview: target })
      } else {
        setState({
          kind: 'error', preview: target,
          message: translate('models.addOllama.error.connection'),
        })
      }
    } finally {
      if (pullControllerRef.current === controller) pullControllerRef.current = null
      pullIntentRef.current = false
    }
  }

  const cancelPull = () => {
    pullControllerRef.current?.abort('explicit-cancel')
  }

  const previewValue = 'preview' in state ? state.preview : null
  const alreadyInstalled = previewValue
    ? installedNames.some((name) => name.toLowerCase() === previewValue.normalizedModelName)
    : false

  return (
    <>
      <Button
        ref={entryRef}
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label={translate('models.addOllama.open.aria')}
      >
        {translate('models.addOllama.open')}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title={translate('models.addOllama.title')}
        describedBy="add-from-ollama-description"
        initialFocusRef={inputRef}
        returnFocusRef={entryRef}
        dismissable={state.kind !== 'pulling'}
        closeLabel={translate('models.addOllama.close')}
        footer={
          state.kind === 'preview' ? (
            <>
              <Button variant="ghost" onClick={() => setState({ kind: 'editing' })}>
                {translate('models.addOllama.back')}
              </Button>
              <Button
                ref={confirmRef}
                variant="primary"
                onClick={() => void startPull(state.preview)}
                aria-label={translate('models.addOllama.confirm.aria')}
              >
                {translate('models.addOllama.confirm')}
              </Button>
            </>
          ) : state.kind === 'pulling' ? (
            <Button ref={cancelRef} variant="secondary" onClick={cancelPull}>
              {translate('models.addOllama.cancel')}
            </Button>
          ) : state.kind === 'error' || state.kind === 'cancelled' ? (
            <>
              <Button variant="ghost" onClick={close}>{translate('models.addOllama.close')}</Button>
              <Button variant="primary" onClick={() => void startPull(state.preview)}>
                {translate('models.addOllama.retry')}
              </Button>
            </>
          ) : state.kind === 'success' ? (
            <Button variant="primary" onClick={close}>{translate('models.addOllama.done')}</Button>
          ) : undefined
        }
      >
        <p id="add-from-ollama-description" className="text-xs text-[var(--fg-muted)]">
          {translate('models.addOllama.description')}
        </p>

        {(state.kind === 'editing' || state.kind === 'validating' || state.kind === 'invalid') && (
          <form className="mt-3 space-y-2" onSubmit={(event) => void preview(event)}>
            <label className="block text-xs font-medium" htmlFor="ollama-reference-input">
              {translate('models.addOllama.input.label')}
            </label>
            <Input
              ref={inputRef}
              id="ollama-reference-input"
              value={reference}
              onChange={(event) => changeReference(event.target.value)}
              placeholder={translate('models.addOllama.input.placeholder')}
              aria-describedby="ollama-reference-hint"
              aria-invalid={state.kind === 'invalid'}
              className="w-full min-w-0"
              autoComplete="off"
            />
            <p id="ollama-reference-hint" className="text-2xs text-[var(--fg-subtle)]">
              {translate('models.addOllama.input.hint')}
            </p>
            {state.kind === 'invalid' && <p role="alert" className="text-xs text-[var(--danger)]">{state.message}</p>}
            <Button type="submit" variant="primary" loading={state.kind === 'validating'}>
              {state.kind === 'validating'
                ? translate('models.addOllama.validating')
                : translate('models.addOllama.preview')}
            </Button>
          </form>
        )}

        {state.kind === 'preview' && (
          <div className="mt-3 space-y-3" role="status" aria-live="polite">
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-inset)] p-3">
              <p className="text-2xs text-[var(--fg-subtle)]">{translate('models.addOllama.normalized')}</p>
              <p className="min-w-0 break-all font-mono text-sm">{state.preview.normalizedModelName}</p>
              <p className="mt-2 text-2xs text-[var(--fg-subtle)]">
                {state.preview.inputKind === 'official_page_url'
                  ? translate('models.addOllama.kind.url')
                  : translate('models.addOllama.kind.name')}
              </p>
            </div>
            {alreadyInstalled && <p>{translate('models.addOllama.alreadyInstalled')}</p>}
            <p className="text-xs text-[var(--fg-muted)]">{translate('models.addOllama.confirm.warning')}</p>
            <p className="text-2xs text-[var(--fg-subtle)]">{translate('models.addOllama.preview.boundary')}</p>
          </div>
        )}

        {state.kind === 'pulling' && <PullProgress progress={state.progress} target={state.preview.normalizedModelName} />}

        {(state.kind === 'error' || state.kind === 'cancelled') && (
          <div role="alert" className="mt-3 rounded-md border border-[var(--danger)]/30 p-3">
            <p className="font-medium">
              {state.kind === 'cancelled'
                ? translate('models.addOllama.cancelled')
                : translate('models.addOllama.failed')}
            </p>
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              {state.kind === 'cancelled' ? translate('models.addOllama.cancelled.detail') : state.message}
            </p>
          </div>
        )}

        {state.kind === 'success' && (
          <div role={state.refreshFailed || !state.installedConfirmed ? 'alert' : 'status'} className="mt-3 space-y-2 rounded-md border border-[var(--border)] p-3">
            <p className="font-medium">{translate('models.addOllama.success')}</p>
            <p className="text-xs text-[var(--fg-muted)]">
              {state.refreshFailed
                ? translate('models.addOllama.refreshFailed')
                : state.installedConfirmed
                  ? translate('models.addOllama.installedConfirmed')
                  : translate('models.addOllama.notInTags')}
            </p>
            <p className="text-2xs text-[var(--fg-subtle)]">{translate('models.addOllama.success.boundary')}</p>
          </div>
        )}
      </Modal>
    </>
  )
}

function PullProgress({ progress, target }: { progress: Progress | null; target: string }) {
  const percent = progress?.percent ?? null
  return (
    <div className="mt-3 space-y-2" role="status" aria-live="polite" aria-atomic="true">
      <p className="font-medium">{translate('models.addOllama.pulling')}</p>
      <p className="break-all font-mono text-xs">{target}</p>
      <p className="text-xs text-[var(--fg-muted)]">{pullStatus(progress?.status)}</p>
      {percent === null ? (
        <div className="sheen h-1 w-full rounded-full bg-[var(--bg-inset)]" aria-label={translate('models.addOllama.progress.indeterminate')} />
      ) : (
        <Meter value={percent / 100} label={translate('models.addOllama.progress')} />
      )}
      <p className="font-mono text-2xs text-[var(--fg-subtle)]">
        {percent === null ? translate('models.addOllama.progress.unknown') : formatPercent(percent, percent < 10 ? 1 : 0)}
        {progress?.completedBytes !== null && progress?.completedBytes !== undefined
          ? ` · ${formatBytes(progress.completedBytes)}`
          : ''}
      </p>
    </div>
  )
}

function pullStatus(status: string | undefined): string {
  const normalized = status?.toLowerCase() ?? ''
  if (normalized.includes('manifest')) return translate('models.addOllama.phase.manifest')
  if (normalized.includes('verif')) return translate('models.addOllama.phase.verifying')
  if (normalized.includes('success')) return translate('models.addOllama.phase.finishing')
  if (normalized.includes('download') || normalized.includes('pull')) return translate('models.addOllama.phase.downloading')
  return translate('models.addOllama.phase.working')
}

function pullError(code: string): string {
  if (code === 'ollama_unavailable') return translate('models.addOllama.error.unavailable')
  if (code === 'runtime_protocol') return translate('models.addOllama.error.protocol')
  return translate('models.addOllama.error.provider')
}
