import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SideChatContextFacts, SideChatRespondRequest } from '@guanxi/contract'
import { Button, ErrorState, Textarea, Input } from '@guanxi/ui'
import { Select } from '../../components/ui.tsx'
import { formatTime } from '../../lib/format.ts'
import { translate as t, type LocaleKey } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { sideChatApi, SideChatRequestError, type SideChatFailureCode } from './api.ts'

/**
 * Side chat (W4, D-135). Every turn lives in this component's React state and nowhere else:
 * no storage, no session log. The two buttons that make anything durable (Save to session log,
 * Send to main) each carry a client-chosen operation id, reused for a retry and replaced when
 * the content changes, so a lost response can never post or save twice.
 */
interface Turn { id: string; role: 'user' | 'assistant'; text: string; facts?: SideChatContextFacts }
type Action = 'respond' | 'save' | 'send'
interface Failure { action: Action; code: SideChatFailureCode; details?: SideChatRequestError['details']; at: string; turnId?: string }
type SendState = { status: 'sending' } | { status: 'sent'; delivery: 'queued' | 'started' | 'already_sent' }
type ContextMode = 'session' | 'last' | 'none'

const digestOf = (turns: readonly Turn[]) => JSON.stringify(turns.map(turn => [turn.role, turn.text]))
const ERROR_KEYS = ['validation_failed', 'session_not_found', 'session_unavailable', 'session_busy', 'egress_unavailable', 'context_too_large', 'connection_unavailable',
  'quota_exhausted', 'model_failed', 'operation_conflict', 'cancelled', 'agent_unavailable'] as const
const SOURCE_KEYS = { respond: 'sideChat.source.respond', save: 'sideChat.source.save', send: 'sideChat.source.send' } as const satisfies Record<Action, LocaleKey>

function failureText(failure: Failure): string {
  if (failure.code === 'unreachable') return t('sideChat.error.unreachable')
  if (failure.code === 'context_too_large' && failure.details) {
    return t('sideChat.error.context_too_large', { bytes: failure.details.bytes, bound: failure.details.boundBytes, window: failure.details.windowTokens,
      output: failure.details.outputTokens, source: failure.details.source })
  }
  return t((ERROR_KEYS as readonly string[]).includes(failure.code) ? `sideChat.error.${failure.code as (typeof ERROR_KEYS)[number]}` : 'sideChat.error.agent_unavailable')
}

export function SideChatPanel({ sessionId }: { sessionId: string }) {
  useLocale()
  const [turns, setTurns] = useState<Turn[]>([]), [draft, setDraft] = useState('')
  const [mode, setMode] = useState<ContextMode>('session'), [lastTurns, setLastTurns] = useState('3')
  const [asking, setAsking] = useState(false), [saving, setSaving] = useState(false)
  const [canceled, setCanceled] = useState(false), [failure, setFailure] = useState<Failure | null>(null)
  const [saved, setSaved] = useState<{ count: number; digest: string; seq: number; duplicate: boolean } | null>(null)
  const [sends, setSends] = useState<Record<string, SendState>>({})
  const [confirming, setConfirming] = useState(false)
  const abort = useRef<AbortController | null>(null), saveOperation = useRef<{ digest: string; id: string } | null>(null)
  const sendOperations = useRef(new Map<string, string>()), busy = useRef(false)
  const promptRef = useRef<HTMLTextAreaElement>(null), keepRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const turnsInvalid = mode === 'last' && !(Number.isInteger(Number(lastTurns)) && Number(lastTurns) > 0)
  const unsaved = useMemo(() => {
    if (turns.length === 0) return 0
    if (saved && saved.count <= turns.length && digestOf(turns.slice(0, saved.count)) === saved.digest) return turns.length - saved.count
    return turns.length
  }, [turns, saved])
  // Reloading or leaving discards unsaved turns; say so before it happens.
  useEffect(() => {
    if (unsaved === 0 && !asking) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved, asking])
  // Leaving the page cancels an in-flight question; the node aborts the owned model request.
  useEffect(() => () => abort.current?.abort(), [])
  useEffect(() => { if (confirming) keepRef.current?.focus() }, [confirming])

  const contextRequest = (): SideChatRespondRequest['context'] =>
    mode === 'none' ? { include: 'none' } : mode === 'last' ? { include: 'session', lastTurns: Number(lastTurns) } : { include: 'session' }
  const perform = async (conversation: Turn[]) => {
    if (busy.current) return
    busy.current = true
    const controller = new AbortController()
    abort.current = controller
    setAsking(true); setFailure(null); setCanceled(false)
    try {
      const answer = await sideChatApi.respond(sessionId, { requestId: crypto.randomUUID(), context: contextRequest(),
        messages: conversation.map(({ role, text }) => ({ role, text })) }, controller.signal)
      setTurns([...conversation, { id: crypto.randomUUID(), role: 'assistant', text: answer.text, facts: answer.context }])
    } catch (error) {
      if (controller.signal.aborted) { if (abort.current === controller) setCanceled(true) }
      else setFailure({ action: 'respond', code: error instanceof SideChatRequestError ? error.code : 'agent_unavailable',
        ...(error instanceof SideChatRequestError && error.details ? { details: error.details } : {}), at: new Date().toISOString() })
    } finally { abort.current = null; busy.current = false; setAsking(false) }
  }
  const canAsk = !asking && !saving && draft.trim().length > 0 && !turnsInvalid
  const ask = () => {
    if (!canAsk) return
    const next = [...turns, { id: crypto.randomUUID(), role: 'user' as const, text: draft }]
    setTurns(next); setDraft('')
    void perform(next)
  }
  const promptKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !canAsk) return
    event.preventDefault(); ask()
  }
  const failWith = (action: Action, error: unknown, turnId?: string) => setFailure({ action, code: error instanceof SideChatRequestError ? error.code : 'agent_unavailable',
    ...(error instanceof SideChatRequestError && error.details ? { details: error.details } : {}), at: new Date().toISOString(), ...(turnId ? { turnId } : {}) })
  const save = async () => {
    if (busy.current || turns.length === 0) return
    busy.current = true
    const digest = digestOf(turns), count = turns.length
    if (saveOperation.current?.digest !== digest) saveOperation.current = { digest, id: crypto.randomUUID() }
    setSaving(true); setFailure(null)
    try {
      const receipt = await sideChatApi.save(sessionId, saveOperation.current.id, turns.map(({ role, text }) => ({ role, text })))
      setSaved({ count, digest, seq: receipt.seq, duplicate: receipt.duplicate })
    } catch (error) { failWith('save', error) } finally { busy.current = false; setSaving(false) }
  }
  const sendToMain = async (turn: Turn) => {
    if (sends[turn.id]) return
    const operation = sendOperations.current.get(turn.id) ?? crypto.randomUUID()
    sendOperations.current.set(turn.id, operation)
    setSends(previous => ({ ...previous, [turn.id]: { status: 'sending' } })); setFailure(null)
    try {
      const receipt = await sideChatApi.send(sessionId, operation, turn.text)
      setSends(previous => ({ ...previous, [turn.id]: { status: 'sent', delivery: receipt.delivery } }))
    } catch (error) {
      setSends(previous => { const { [turn.id]: _dropped, ...rest } = previous; return rest })
      failWith('send', error, turn.id)
    }
  }
  const retry = () => {
    if (!failure) return
    if (failure.action === 'respond') void perform(turns)
    else if (failure.action === 'save') void save()
    else { const turn = turns.find(item => item.id === failure.turnId); if (turn) void sendToMain(turn) }
  }
  const discard = () => {
    abort.current?.abort(); abort.current = null
    setTurns([]); setDraft(''); setSaved(null); setSends({}); setFailure(null); setCanceled(false); setConfirming(false)
    saveOperation.current = null; sendOperations.current.clear()
    promptRef.current?.focus()
  }
  const lastFacts = (turn: Turn) => turn.facts
  const receipt = saved && saved.digest === digestOf(turns.slice(0, saved.count)) ? saved : null

  return <section aria-labelledby={`${id}-title`} data-testid="side-chat-panel" className="flex min-w-0 flex-col gap-3 rounded-panel border border-divider bg-surface p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h2 id={`${id}-title`} className="text-15 font-heading">{t('sideChat.title')}</h2>
      <span data-testid="side-chat-ephemeral" className="rounded-control border border-divider bg-inset px-2 py-1 text-12 font-heading">{t('sideChat.ephemeral')}</span>
    </div>
    <p data-testid="side-chat-notice" className="text-12 text-secondary">{t('sideChat.ephemeral.notice')}</p>
    <p className="text-12 text-secondary">{t('sideChat.reads')}</p>

    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-context`} className="text-14 font-heading">{t('sideChat.context')}</label>
        <Select id={`${id}-context`} describedBy={`${id}-context-hint`} value={mode} disabled={asking} onChange={value => setMode(value as ContextMode)}
          options={[{ value: 'session', label: t('sideChat.context.session') }, { value: 'last', label: t('sideChat.context.last') }, { value: 'none', label: t('sideChat.context.none') }]} />
      </div>
      {mode === 'last' && <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${id}-turns`} className="text-14 font-heading">{t('sideChat.context.turns')}</label>
        <Input id={`${id}-turns`} inputMode="numeric" invalid={turnsInvalid} aria-describedby={turnsInvalid ? `${id}-turns-error` : undefined} value={lastTurns} disabled={asking}
          onChange={event => setLastTurns(event.target.value)} />
        {turnsInvalid && <p id={`${id}-turns-error`} className="text-12 text-danger">{t('sideChat.context.turnsInvalid')}</p>}
      </div>}
    </div>
    <p id={`${id}-context-hint`} className="text-12 text-secondary">{t('sideChat.context.hint')}</p>

    <div role="log" aria-label={t('sideChat.messages')}><ol className="flex min-w-0 flex-col gap-3">
      {turns.length === 0 && <li className="text-14 text-secondary">{t('sideChat.empty')}</li>}
      {turns.map((turn, index) => {
        const send = sends[turn.id]
        const facts = lastFacts(turn)
        return <li key={turn.id} data-testid="side-chat-turn" data-role={turn.role} className="flex min-w-0 flex-col gap-1 rounded-control border border-divider p-3">
          <p className="text-12 font-heading">{t(turn.role === 'user' ? 'sideChat.role.user' : 'sideChat.role.assistant')}</p>
          <p className="whitespace-pre-wrap break-words text-14">{turn.text}</p>
          {facts && <p className="text-12 text-secondary">{facts.include === 'none'
            ? t('sideChat.provenance.none', { time: formatTime(facts.observedAt) })
            : t('sideChat.provenance', { seq: facts.upToSeq, turns: facts.turns, bytes: facts.bytes, time: formatTime(facts.observedAt) })}
            {facts.excerpted > 0 ? ` · ${t('sideChat.provenance.excerpts', { count: facts.excerpted })}` : ''}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" aria-label={t('sideChat.send.named', { n: index + 1 })} disabled={send !== undefined || saving} loading={send?.status === 'sending'}
              onClick={() => void sendToMain(turn)}>{t('sideChat.send')}</Button>
            {send?.status === 'sent' && <p role="status" className="text-12">{t(send.delivery === 'queued' ? 'sideChat.sent.queued' : send.delivery === 'started' ? 'sideChat.sent.started' : 'sideChat.sent.already')}</p>}
          </div>
        </li>
      })}
    </ol></div>

    {failure && <div className="flex min-w-0 flex-col gap-2">
      <ErrorState title={`${t('sideChat.error.title')}. ${failureText(failure)}`} source={t(SOURCE_KEYS[failure.action])} occurredAt={failure.at} timeMeaning="observed" details={failure.code}
        action={failure.code === 'context_too_large' || failure.code === 'validation_failed' ? undefined : <Button onClick={retry}>{t('sideChat.retry')}</Button>} />
    </div>}
    {asking && <p role="status" className="text-14">{t('sideChat.thinking')}</p>}
    {canceled && <p role="status" className="text-14">{t('sideChat.canceled')}</p>}

    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`${id}-prompt`} className="text-14 font-heading">{t('sideChat.prompt')}</label>
      <Textarea ref={promptRef} id={`${id}-prompt`} aria-describedby={`${id}-prompt-hint`} rows={3} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={promptKey} />
      <p id={`${id}-prompt-hint`} className="text-12 text-secondary">{t('sideChat.prompt.hint')}</p>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" disabled={!canAsk} onClick={ask}>{t('sideChat.ask')}</Button>
      {asking && <Button onClick={() => abort.current?.abort()}>{t('sideChat.cancel')}</Button>}
    </div>

    <div className="flex min-w-0 flex-col gap-2 border-t border-divider pt-3">
      <p data-testid="side-chat-unsaved" className="text-12 text-secondary">{turns.length === 0 ? '' : unsaved > 0 ? t('sideChat.unsaved', { count: unsaved }) : t('sideChat.allSaved')}</p>
      <p id={`${id}-save-hint`} className="text-12 text-secondary">{t('sideChat.save.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button aria-describedby={`${id}-save-hint`} disabled={turns.length === 0 || asking || saving || (unsaved === 0 && receipt !== null)} loading={saving} loadingLabel={t('sideChat.saving')}
          onClick={() => void save()}>{t('sideChat.save')}</Button>
        <Button variant="danger" disabled={turns.length === 0 || saving} onClick={() => (unsaved > 0 ? setConfirming(true) : discard())}>{t('sideChat.discard')}</Button>
      </div>
      {receipt && unsaved === 0 && <p role="status" className="text-14">{t(receipt.duplicate ? 'sideChat.saved.duplicate' : 'sideChat.saved', { seq: receipt.seq })}</p>}
      {confirming && <div role="group" aria-label={t('sideChat.discard')} className="flex flex-col gap-2 rounded-control border border-danger p-3">
        <p>{t('sideChat.discard.confirm', { count: unsaved })}</p>
        <div className="flex flex-wrap gap-2">
          <Button ref={keepRef} onClick={() => { setConfirming(false); promptRef.current?.focus() }}>{t('sideChat.discard.no')}</Button>
          <Button variant="danger" onClick={discard}>{t('sideChat.discard.yes')}</Button>
        </div>
      </div>}
    </div>
  </section>
}
