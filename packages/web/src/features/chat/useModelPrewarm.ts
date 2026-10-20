import type { LocalModel, PrewarmModelResponse } from '@guanxi/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api.ts'
import { useRuntimeProjection } from '../health/RuntimeContext.tsx'

export const MODEL_PREWARM_DEBOUNCE_MS = 600
export const MODEL_PREWARM_CLIENT_TIMEOUT_MS = 35_000

export type ModelPrewarmState =
  | { phase: 'idle' | 'pending' | 'warming'; reason: null }
  | {
      phase: 'warmed' | 'reused' | 'skipped' | 'cancelled'
      reason:
        | PrewarmModelResponse['reason']
        | 'document_hidden'
        | 'normal_work_present'
        | 'fit_unknown'
        | 'fit_unavailable'
        | 'disabled'
    }

export function useModelPrewarm(options: {
  model: LocalModel | null
  contextLength: number
  enabled: boolean | undefined
}): ModelPrewarmState {
  const runtime = useRuntimeProjection()
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [state, setState] = useState<ModelPrewarmState>({ phase: 'idle', reason: null })
  const generationRef = useRef(0)
  const normalWorkPresent = useMemo(
    () =>
      Boolean(
        runtime.data?.governor.activeLease?.priority === 'normal' ||
          runtime.data?.governor.queued.some((entry) => entry.priority === 'normal'),
      ),
    [runtime.data],
  )

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  const model = options.model
  const modelName = model?.name ?? null
  const modelDigest = model?.digest ?? null
  const fitLevel = model?.fit.level ?? null
  const fitBasis = model?.fit.basis ?? null

  useEffect(() => {
    const generation = ++generationRef.current
    const isCurrent = () => generationRef.current === generation
    let timer: ReturnType<typeof setTimeout> | null = null
    let requestController: AbortController | null = null

    if (!modelName || !modelDigest || !fitLevel || !fitBasis || options.enabled === undefined) {
      setState({ phase: 'idle', reason: null })
      return undefined
    }
    if (!options.enabled) {
      setState({ phase: 'skipped', reason: 'disabled' })
      return undefined
    }
    if (!visible) {
      setState({ phase: 'cancelled', reason: 'document_hidden' })
      return undefined
    }
    if (normalWorkPresent) {
      setState({ phase: 'cancelled', reason: 'normal_work_present' })
      return undefined
    }
    if (fitLevel === 'unknown') {
      setState({ phase: 'skipped', reason: 'fit_unknown' })
      return undefined
    }
    if (fitLevel === 'red') {
      setState({ phase: 'skipped', reason: 'fit_unavailable' })
      return undefined
    }

    setState({ phase: 'pending', reason: null })
    timer = setTimeout(() => {
      timer = null
      if (!isCurrent()) return
      requestController = new AbortController()
      const controller = requestController
      const deadline = setTimeout(
        () => controller.abort('prewarm_client_timeout'),
        MODEL_PREWARM_CLIENT_TIMEOUT_MS,
      )
      setState({ phase: 'warming', reason: null })
      void api
        .prewarmModel(
          modelName,
          {
            operation: 'chat',
            contextLength: options.contextLength,
            selection: {
              digest: modelDigest,
              fitLevel,
              fitBasis,
            },
          },
          controller.signal,
        )
        .then((result) => {
          if (!isCurrent() || controller.signal.aborted) return
          setState({ phase: result.status, reason: result.reason })
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return
          if (controller.signal.aborted || isAbort(error)) {
            setState({
              phase: 'cancelled',
              reason:
                controller.signal.reason === 'prewarm_client_timeout'
                  ? 'request_timeout'
                  : 'request_cancelled',
            })
            return
          }
          setState({ phase: 'skipped', reason: 'runtime_unavailable' })
        })
        .finally(() => clearTimeout(deadline))
    }, MODEL_PREWARM_DEBOUNCE_MS)

    return () => {
      generationRef.current += 1
      if (timer !== null) clearTimeout(timer)
      requestController?.abort('prewarm_selection_cleanup')
    }
  }, [
    fitBasis,
    fitLevel,
    modelDigest,
    modelName,
    normalWorkPresent,
    options.contextLength,
    options.enabled,
    visible,
  ])

  return state
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
