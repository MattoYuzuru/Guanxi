/**
 * Installed-profile management of explicit positive user capability assertions.
 *
 * This region is deliberately separate from the provider-declaration region and
 * from the completion-probe region: an assertion here is the user's own statement
 * about one exact artifact, so it never recolours a declaration and never hides a
 * conflicting, degraded or unknown provider state.
 *
 * Nothing mounts, hovers, focuses, navigates, reloads or exports its way into a
 * mutation. Every change needs an explicit action plus an explicit confirmation.
 */
import { useEffect, useRef, useState } from 'react'
import type {
  ModelCapability,
  ModelCapabilityOverride,
  ModelCapabilityOverrideConflictReason,
  ModelCapabilityOverrideOutcome,
  ModelDetail,
} from '@guanxi/contract'
import { modelCapabilitySchema } from '@guanxi/contract'
import { Badge, Button, Modal, Select } from '../../components/ui.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { formatDateTime } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'
import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'

const CAPABILITIES = modelCapabilitySchema.options

/** Deliberately stable: the export must not change between two identical reads. */
const EXPORT_SCHEMA = 'guanxi.model-capability-overrides'

type Intent =
  | { kind: 'add'; capability: ModelCapability }
  | { kind: 'remove'; capability: ModelCapability }

type Feedback =
  | { kind: 'outcome'; outcome: ModelCapabilityOverrideOutcome }
  | { kind: 'error'; message: string }
  | { kind: 'export'; state: 'copied' | 'downloaded' | 'failed' }

interface ExactIdentity {
  normalizedModelReference: string
  artifactDigest: string
  runtimeVersion: string
}

/**
 * Only an unambiguous canonical reference with an exact digest and a sourced
 * runtime version can carry an assertion; anything else disables mutation instead
 * of addressing a write by model name.
 */
function exactIdentity(model: ModelDetail): ExactIdentity | null {
  const { reference, artifact, runtime } = model.descriptor
  if (
    reference.state !== 'canonical'
    || artifact.state !== 'exact_digest'
    || runtime.state !== 'sourced'
  ) {
    return null
  }
  return {
    normalizedModelReference: reference.normalized,
    artifactDigest: artifact.digest,
    runtimeVersion: runtime.version,
  }
}

export function CapabilityOverrides({
  model,
  onRefresh,
}: {
  model: ModelDetail
  onRefresh: () => void
}) {
  const [overrides, setOverrides] = useState<ModelCapabilityOverride[]>(
    model.descriptor.overrides,
  )
  const [draft, setDraft] = useState<ModelCapability>(CAPABILITIES[0]!)
  const [intent, setIntent] = useState<Intent | null>(null)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const removeRefs = useRef(new Map<ModelCapability, HTMLButtonElement | null>())
  /**
   * Stable identity on purpose: Modal's focus effect depends on this ref, so a
   * fresh object per render would tear that effect down and bounce focus back to
   * the trigger on every re-render while the dialog is still open.
   */
  const returnFocusRef = useRef<HTMLElement | null>(null)
  /** Set when a mutation may have deleted the control that currently has focus. */
  const recoverFocusRef = useRef(false)
  const mountedRef = useRef(true)
  const controllerRef = useRef<AbortController | null>(null)
  const pendingRef = useRef(false)

  // A server projection is authoritative; a route change to a different artifact
  // must not keep showing the previous model's assertions.
  useEffect(() => {
    setOverrides(model.descriptor.overrides)
  }, [model.descriptor.overrides])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort('model-profile-unmounted')
    }
  }, [])

  /*
   * After a removal commits, the Remove button the dialog returned focus to is
   * gone and focus has fallen to `<body>`. Move it to the Add control so the
   * keyboard position stays inside this region.
   */
  useEffect(() => {
    if (!recoverFocusRef.current) return
    recoverFocusRef.current = false
    if (document.activeElement === document.body) addRef.current?.focus()
  }, [overrides])

  const identity = exactIdentity(model)
  const asserted = new Set(overrides.map((override) => override.capability))
  const addable = CAPABILITIES.filter((capability) => !asserted.has(capability))

  useEffect(() => {
    if (!asserted.has(draft) || addable.length === 0) return
    setDraft(addable[0]!)
  }, [addable, asserted, draft])

  const mutate = async (current: Intent) => {
    // One intent per activation: a double click or a repeated Enter cannot send
    // two mutations for the same decision.
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setIntent(null)
    setFeedback(null)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const body = {
        capability: current.capability,
        expectedDigest: identity!.artifactDigest,
        expectedRuntimeVersion: identity!.runtimeVersion,
      }
      const response = current.kind === 'add'
        ? await api.applyCapabilityOverride(model.name, body, controller.signal)
        : await api.clearCapabilityOverride(model.name, body, controller.signal)
      if (!mountedRef.current || controller.signal.aborted) return
      setFeedback({ kind: 'outcome', outcome: response.outcome })
      if (response.outcome.state !== 'conflict') {
        // The dialog already restored focus to the Remove control, which this
        // update may delete. Recover the focus position after the list commits.
        recoverFocusRef.current = true
        setOverrides(response.outcome.overrides)
      }
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return
      setFeedback({ kind: 'error', message: errorMessage(error) })
    } finally {
      pendingRef.current = false
      if (mountedRef.current && !controller.signal.aborted) setPending(false)
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  const exportPayload = identity === null ? null : JSON.stringify(
    {
      schema: EXPORT_SCHEMA,
      version: 1,
      provider: 'ollama',
      normalizedModelReference: identity.normalizedModelReference,
      artifactDigest: identity.artifactDigest,
      runtimeVersion: identity.runtimeVersion,
      overrides: overrides.map((override) => ({
        version: override.version,
        source: override.source,
        state: override.state,
        value: override.value,
        capability: override.capability,
        createdAt: override.createdAt,
        updatedAt: override.updatedAt,
      })),
    },
    null,
    2,
  )

  const exportFilename = identity === null ? '' : exportFilenameFor(identity)

  const copyExport = async () => {
    if (exportPayload === null) return
    try {
      await navigator.clipboard.writeText(exportPayload)
      if (mountedRef.current) setFeedback({ kind: 'export', state: 'copied' })
    } catch {
      if (mountedRef.current) setFeedback({ kind: 'export', state: 'failed' })
    }
  }

  const downloadExport = () => {
    if (exportPayload === null) return
    try {
      const url = URL.createObjectURL(
        new Blob([exportPayload], { type: 'application/json' }),
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = exportFilename
      anchor.click()
      // Revoking in the same tick can cancel the download the click just started,
      // so release the URL only after the browser has picked it up.
      setTimeout(() => URL.revokeObjectURL(url), 0)
      setFeedback({ kind: 'export', state: 'downloaded' })
    } catch {
      setFeedback({ kind: 'export', state: 'failed' })
    }
  }

  return (
    <div className="min-w-0 space-y-3" aria-label={translate('models.override.label')}>
      <p className="text-2xs text-secondary">
        {translate('models.override.explanation')}
      </p>
      <p className="text-2xs text-muted">
        {translate('models.override.boundary')}
      </p>

      {identity === null ? (
        <p className="text-2xs text-muted" role="note">
          {translate('models.override.identity.unavailable')}
        </p>
      ) : (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-2xs">
          <dt className="text-muted">
            {translate('models.override.identity.reference')}
          </dt>
          <dd className="min-w-0 break-all font-mono">{identity.normalizedModelReference}</dd>
          <dt className="text-muted">
            {translate('models.override.identity.digest')}
          </dt>
          <dd className="min-w-0 break-all font-mono">{identity.artifactDigest}</dd>
          <dt className="text-muted">
            {translate('models.override.identity.runtime')}
          </dt>
          <dd className="min-w-0 break-all font-mono">{identity.runtimeVersion}</dd>
        </dl>
      )}

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="rounded-md border border-divider bg-inset p-2 text-2xs"
      >
        {pending ? (
          <Badge tone="yellow">{translate('models.override.pending')}</Badge>
        ) : feedback === null ? (
          overrides.length === 0 ? (
            <p>{translate('models.override.empty')}</p>
          ) : (
            <p>{translate('models.override.list')}</p>
          )
        ) : (
          <Feedback feedback={feedback} onRefresh={onRefresh} />
        )}
      </div>

      {overrides.length > 0 ? (
        <ul className="space-y-1.5 text-2xs">
          {overrides.map((override) => (
            <li
              key={override.capability}
              className="rounded-md border border-divider bg-inset p-2"
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  <Badge tone="accent">{override.capability}</Badge>
                  <Badge tone="outline">{translate('models.override.state')}</Badge>
                  <span className="text-secondary">
                    {translate('models.override.source')}
                  </span>
                </div>
                <Button
                  ref={(node) => {
                    removeRefs.current.set(override.capability, node)
                  }}
                  variant="ghost"
                  size="sm"
                  disabled={identity === null || pending}
                  onClick={() => {
                    /*
                     * Capture the exact activating control before the list
                     * rerenders. A confirmed removal deletes that very button, so
                     * fall back to the Add control instead of dropping focus on
                     * `<body>` and losing the keyboard position entirely.
                     */
                    returnFocusRef.current =
                      removeRefs.current.get(override.capability) ?? addRef.current
                    setIntent({ kind: 'remove', capability: override.capability })
                  }}
                  aria-label={`${translate('models.override.remove.aria')} ${override.capability}`}
                >
                  {translate('models.override.remove')}
                </Button>
              </div>
              <p className="mt-1 min-w-0 break-all text-secondary">
                {translate('models.override.created')} {formatDateTime(override.createdAt)} ·{' '}
                {translate('models.override.updated')} {formatDateTime(override.updatedAt)}
              </p>
              <p className="mt-1 min-w-0 break-all font-mono text-secondary">
                {override.normalizedModelReference} · {override.artifactDigest} · Ollama{' '}
                {override.runtimeVersion}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="min-w-0">
          <label
            htmlFor="capability-override-draft"
            className="block text-2xs font-medium"
          >
            {translate('models.override.capability.label')}
          </label>
          <div className="mt-1">
            <Select
              id="capability-override-draft"
              value={draft}
              onChange={(next) => setDraft(modelCapabilitySchema.parse(next))}
              disabled={identity === null || pending || addable.length === 0}
              ariaLabel={translate('models.override.capability.label')}
              options={addable.map((capability) => ({
                value: capability,
                label: capability,
              }))}
            />
          </div>
        </div>
        <Button
          ref={addRef}
          variant="secondary"
          disabled={identity === null || pending || addable.length === 0}
          onClick={() => {
            returnFocusRef.current = addRef.current
            setIntent({ kind: 'add', capability: draft })
          }}
          aria-label={translate('models.override.add.aria')}
        >
          {translate('models.override.add')}
        </Button>
      </div>

      <div className="min-w-0 space-y-1.5">
        <p className="text-2xs font-medium">{translate('models.override.export')}</p>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={exportPayload === null}
            onClick={() => void copyExport()}
            aria-label={translate('models.override.export.copy.aria')}
          >
            {translate('models.override.export.copy')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={exportPayload === null}
            onClick={downloadExport}
            aria-label={translate('models.override.export.download.aria')}
          >
            {translate('models.override.export.download')}
          </Button>
        </div>
        <p className="text-2xs text-muted">
          {translate('models.override.export.boundary')}
        </p>
      </div>

      <Modal
        open={intent !== null}
        onClose={() => setIntent(null)}
        title={translate(
          intent?.kind === 'remove'
            ? 'models.override.confirm.removeTitle'
            : 'models.override.confirm.addTitle',
        )}
        describedBy="capability-override-confirmation"
        initialFocusRef={confirmRef}
        returnFocusRef={returnFocusRef}
        closeLabel={translate('models.override.confirm.close')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setIntent(null)}>
              {translate('models.override.confirm.back')}
            </Button>
            <Button
              ref={confirmRef}
              variant="primary"
              onClick={() => {
                if (intent !== null) void mutate(intent)
              }}
            >
              {translate(
                intent?.kind === 'remove'
                  ? 'models.override.confirm.remove'
                  : 'models.override.confirm.add',
              )}
            </Button>
          </>
        }
      >
        <div
          id="capability-override-confirmation"
          className="space-y-2 text-xs text-secondary"
        >
          <p>
            {translate(
              intent?.kind === 'remove'
                ? 'models.override.confirm.removeDescription'
                : 'models.override.confirm.addDescription',
            )}
          </p>
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
            <dt>{translate('models.override.confirm.capability')}</dt>
            <dd className="min-w-0 break-all font-mono">{intent?.capability}</dd>
            <dt>{translate('models.override.identity.reference')}</dt>
            <dd className="min-w-0 break-all font-mono">
              {identity?.normalizedModelReference}
            </dd>
            <dt>{translate('models.override.identity.digest')}</dt>
            <dd className="min-w-0 break-all font-mono">{identity?.artifactDigest}</dd>
            <dt>{translate('models.override.identity.runtime')}</dt>
            <dd className="min-w-0 break-all font-mono">{identity?.runtimeVersion}</dd>
          </dl>
        </div>
      </Modal>
    </div>
  )
}

function Feedback({
  feedback,
  onRefresh,
}: {
  feedback: Feedback
  onRefresh: () => void
}) {
  // Identity drift means the shown model is stale: re-read it at once instead of asking the user
  // to press Reload (D-203). Once per conflict outcome.
  const drifted = feedback.kind === 'outcome' && feedback.outcome.state === 'conflict'
    && (feedback.outcome.reason === 'digest_expectation_mismatch' || feedback.outcome.reason === 'runtime_expectation_mismatch')
    ? feedback.outcome : null
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh
  useEffect(() => { if (drifted) refreshRef.current() }, [drifted])
  if (feedback.kind === 'export') {
    if (feedback.state === 'failed') {
      return (
        <>
          <Badge tone="yellow">{translate('models.override.export.failed')}</Badge>
        </>
      )
    }
    return (
      <Badge tone="outline">
        {translate(
          feedback.state === 'copied'
            ? 'models.override.export.copied'
            : 'models.override.export.downloaded',
        )}
      </Badge>
    )
  }
  if (feedback.kind === 'error') {
    return (
      <>
        <Badge tone="yellow">{translate('models.override.error')}</Badge>
        <p className="mt-1 break-words">{feedback.message}</p>
      </>
    )
  }
  const outcome = feedback.outcome
  if (outcome.state === 'conflict') {
    return (
      <>
        <Badge tone="yellow">{translate('models.override.conflict.title')}</Badge>
        <p className="mt-1">{conflictReason(outcome.reason)}</p>
        {outcome.reason === 'digest_expectation_mismatch'
          || outcome.reason === 'runtime_expectation_mismatch' ? (
            <p className="mt-1 text-secondary">{translate('models.override.reloaded')}</p>
          ) : null}
      </>
    )
  }
  return (
    <Badge tone="outline">
      {translate(
        outcome.state === 'applied'
          ? 'models.override.success.applied'
          : outcome.state === 'cleared'
            ? 'models.override.success.cleared'
            : 'models.override.success.absent',
      )}
    </Badge>
  )
}

function conflictReason(reason: ModelCapabilityOverrideConflictReason): string {
  const keys = {
    invalid_model_reference: 'models.override.conflict.invalid_model_reference',
    model_not_installed: 'models.override.conflict.model_not_installed',
    installed_reference_ambiguous: 'models.override.conflict.installed_reference_ambiguous',
    installed_digest_missing: 'models.override.conflict.installed_digest_missing',
    runtime_version_unavailable: 'models.override.conflict.runtime_version_unavailable',
    provider_unavailable: 'models.override.conflict.provider_unavailable',
    digest_expectation_mismatch: 'models.override.conflict.digest_expectation_mismatch',
    runtime_expectation_mismatch: 'models.override.conflict.runtime_expectation_mismatch',
    persistence_failed: 'models.override.conflict.persistence_failed',
  } as const satisfies Record<
    ModelCapabilityOverrideConflictReason,
    Parameters<typeof translate>[0]
  >
  return translate(keys[reason])
}

/** Derived from the identity only, so two identical exports share one filename. */
function exportFilenameFor(identity: ExactIdentity): string {
  const safe = (value: string) => value.replace(/[^a-z0-9._-]/giu, '-')
  return `${PRODUCT_FILE_PREFIX}-capability-overrides-${safe(identity.normalizedModelReference)}-${safe(identity.artifactDigest).slice(0, 24)}.json`
}
