/**
 * Скачивание модели: кнопка → SSE-прогресс прямо в карточке.
 *
 * Прогресс приходит десятками кадров в секунду, поэтому в state кладём его
 * не на каждый кадр, а по rAF — иначе карусель начинает дёргаться.
 */
import { useEffect, useRef, useState } from 'react'
import type { PullStreamEvent } from '@guanxi/contract'
import { streamPull } from '../../lib/api.ts'
import { errorMessage } from '../../lib/api.ts'
import { Button, Meter, cx } from '../../components/ui.tsx'
import { formatBytes, formatBytesPerSecond, formatEta, formatPercent } from '../../lib/format.ts'
import { translate } from '../../lib/locale.ts'

type ProgressData = Extract<PullStreamEvent, { type: 'progress' }>['data']

export function PullControl({
  name,
  active,
  onStart,
  onFinish,
}: {
  name: string
  active: boolean
  onStart: () => void
  onFinish: (ok: boolean) => void
}) {
  const [progress, setProgress] = useState<ProgressData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Кадр держим в ref, в state переносим по rAF — прогресс сыпется очень часто.
  const pendingRef = useRef<ProgressData | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const scheduleFlush = () => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      if (pendingRef.current) setProgress(pendingRef.current)
    })
  }

  const start = async () => {
    setError(null)
    setDone(false)
    setProgress(null)
    onStart()

    const controller = new AbortController()
    abortRef.current = controller

    try {
      for await (const event of streamPull(name, controller.signal)) {
        if (event.type === 'progress') {
          pendingRef.current = event.data
          scheduleFlush()
        } else if (event.type === 'error') {
          setError(event.data.message)
          onFinish(false)
          return
        } else if (event.type === 'done') {
          setDone(true)
          onFinish(true)
          return
        }
      }
      // Стрим закончился без `done` — считаем это обрывом.
      if (!controller.signal.aborted) {
        setError(translate('model.pull.connectionLost'))
        onFinish(false)
      }
    } catch (streamError) {
      if (!controller.signal.aborted) {
        setError(errorMessage(streamError))
        onFinish(false)
      }
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    setProgress(null)
    onFinish(false)
  }

  if (error) {
    return (
      <div>
        <p className="mb-1.5 line-clamp-2 text-2xs text-danger" title={error}>
          {error}
        </p>
        <div className="flex gap-1.5">
          <Button variant="secondary" size="md" className="flex-1" onClick={start}>
            {translate('model.install')}
          </Button>
          <Button variant="ghost" size="md" onClick={() => setError(null)}>
            {translate('model.pull.hide')}
          </Button>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="flex h-8 items-center justify-center rounded-md border border-[var(--color-fit-green)]/40 bg-[var(--color-fit-green)]/10 text-xs font-medium text-[var(--color-fit-green)]">
        {translate('model.pull.installed')}
      </div>
    )
  }

  if (!active) {
    return (
      <Button variant="primary" size="md" className="w-full" onClick={start}>
        {translate('model.install')}
      </Button>
    )
  }

  const percent = progress?.percent ?? null
  const indeterminate = percent === null

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-2xs text-secondary" title={progress?.status}>
          {progress?.status ?? translate('model.pull.connecting')}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums">
          {indeterminate ? '' : formatPercent(percent, percent < 10 ? 1 : 0)}
        </span>
      </div>

      {indeterminate ? (
        <div className="sheen h-1 w-full rounded-full bg-inset" />
      ) : (
        <Meter value={percent / 100} height={4} label={translate('model.pull.aria', { name })} />
      )}

      <div className="mt-1 flex items-center justify-between gap-2 text-2xs text-muted">
        <span className="truncate font-mono tabular-nums">
          {progress?.completedBytes !== null && progress?.completedBytes !== undefined
            ? `${formatBytes(progress.completedBytes)}${
                progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''
              }`
            : '—'}
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          {formatBytesPerSecond(progress?.bytesPerSecond ?? null)}
        </span>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span
          className={cx(
            'font-mono text-2xs tabular-nums text-muted',
            indeterminate && 'anim-pulse-soft',
          )}
        >
          {progress?.etaSeconds !== null && progress?.etaSeconds !== undefined
            ? translate('model.pull.remaining', { eta: formatEta(progress.etaSeconds) })
            : translate('model.pull.estimating')}
        </span>
        <Button variant="ghost" size="sm" onClick={cancel}>
          {translate('model.pull.cancel')}
        </Button>
      </div>
    </div>
  )
}
