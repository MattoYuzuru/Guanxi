import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, StoredGlossaryEntryWire } from '@guanxi/contract'
import { agentRequest } from '../native-agent/api.ts'
import { glossaryApi } from './api.ts'
import { classify, type Failure } from './model.ts'

export type GlossaryStatus = 'loading' | 'ready' | 'failed'

/**
 * Loads the entries of one view (a project filter plus the inactive switch). Data belongs to
 * the view it was loaded for: switching view shows the skeleton instead of another view's
 * entries, while a failed refresh of the same view keeps the last good entries and their time.
 */
export function useGlossaryEntries(projectId: string, includeInactive: boolean) {
  const viewKey = `${projectId}|${includeInactive}`
  const [data, setData] = useState<{ key: string; entries: StoredGlossaryEntryWire[]; observedAt: string } | null>(null)
  const [failureState, setFailure] = useState<(Failure & { key: string }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  // Counts the local patches (a mutation's answer). A read that started before a patch may carry
  // an older picture, so it is discarded and the view is read once more instead of being shown.
  const patches = useRef(0)
  useEffect(() => {
    const abort = new AbortController()
    const startedAt = patches.current
    setLoading(true)
    glossaryApi.list({ ...(projectId === '' ? {} : { projectId }), includeInactive }, abort.signal).then(
      (response) => {
        if (abort.signal.aborted) return
        if (patches.current !== startedAt) { setRevision((value) => value + 1); return }
        setData({ key: viewKey, entries: response.entries, observedAt: new Date().toISOString() })
        setFailure(null)
        setLoading(false)
      },
      (error: unknown) => {
        if (abort.signal.aborted) return
        setFailure({ code: classify(error), at: new Date().toISOString(), key: viewKey })
        setLoading(false)
      },
    )
    return () => abort.abort()
  }, [projectId, includeInactive, viewKey, revision])

  const current = data !== null && data.key === viewKey ? data : null
  const failure = failureState !== null && failureState.key === viewKey ? failureState : null
  const status: GlossaryStatus = current === null ? (failure !== null && !loading ? 'failed' : 'loading') : 'ready'
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  /**
   * Patches the loaded view with a mutation's answer (the node returned the complete stored row).
   * An entry already in the view is replaced; a new one is added only when `belongs` says it fits
   * to the view being shown now, and an entry the view hides (inactive while they are hidden) leaves.
   */
  const patch = useCallback((stored: StoredGlossaryEntryWire, belongs: boolean) => {
    patches.current += 1
    setData((previous) => {
      if (previous === null) return previous
      const exists = previous.entries.some((entry) => entry.id === stored.id)
      if (!belongs) return exists ? { ...previous, entries: previous.entries.filter((entry) => entry.id !== stored.id) } : previous
      return { ...previous, entries: exists ? previous.entries.map((entry) => (entry.id === stored.id ? stored : entry)) : [...previous.entries, stored] }
    })
  }, [])
  return {
    status,
    entries: current?.entries ?? null,
    observedAt: current?.observedAt ?? null,
    failure,
    refreshing: loading && current !== null,
    reload,
    patch,
  }
}

export interface ProjectChoices { status: 'loading' | 'ready' | 'unavailable'; projects: Project[]; names: ReadonlyMap<string, string> }

/** The native project list names project ids; if it fails the page degrades to ids. */
export function useProjectChoices(): ProjectChoices {
  const [state, setState] = useState<{ status: ProjectChoices['status']; projects: Project[] }>({ status: 'loading', projects: [] })
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        const body = await agentRequest('/projects', 'GET', undefined, abort.signal) as { projects?: Project[] }
        if (!abort.signal.aborted) setState({ status: 'ready', projects: Array.isArray(body.projects) ? body.projects : [] })
      } catch {
        if (!abort.signal.aborted) setState({ status: 'unavailable', projects: [] })
      }
    })()
    return () => abort.abort()
  }, [])
  const names = useMemo(() => new Map(state.projects.map((project) => [project.id, project.name])), [state.projects])
  return { ...state, names }
}
