import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Connection, Project, Workspace } from '@guanxi/contract'
import { api } from '../../lib/api.ts'
import { ZodError } from 'zod'
import { connectionApi, ConnectionRequestError } from '../connections/api.ts'
import { agentRequest, AgentRequestError } from '../native-agent/api.ts'

export interface SessionChoices {
  projects: Project[]
  connections: Connection[]
  /** `null` means the folder list is unavailable (degraded), never an empty list. */
  workspaces: Workspace[] | null
}
export type ChoiceSource = 'projects' | 'connections'
/** `unreachable`: no HTTP answer at all. `rejected`: the node answered with an error or an invalid body. */
export interface ChoiceFailure { source: ChoiceSource; code: string; kind: 'unreachable' | 'rejected'; at: string }
export type ChoiceStatus = 'loading' | 'ready' | 'failed'

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener) }
}
/** The browser's own connectivity signal; it says nothing about the node. */
export function useBrowserOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
}

// Machine discriminants stay typed references so no display string is a function return.
const FAILURE_KIND = { unreachable: 'unreachable', rejected: 'rejected' } as const
const FALLBACK_CODE = { agent: 'agent_unavailable' } as const
const failureCode = (error: unknown): string =>
  error instanceof AgentRequestError || error instanceof ConnectionRequestError ? error.code : FALLBACK_CODE.agent
const failureKind = (error: unknown): ChoiceFailure['kind'] =>
  error instanceof AgentRequestError || error instanceof ConnectionRequestError || error instanceof ZodError
    ? FAILURE_KIND.rejected : FAILURE_KIND.unreachable

/**
 * Loads the three read-only sources of the new-session screen. Projects and connections
 * are required; the folder list is optional and reports a degraded state instead.
 * A failed refresh keeps the last good choices with their observation time.
 */
export function useSessionChoices() {
  const [choices, setChoices] = useState<SessionChoices | null>(null)
  const [observedAt, setObservedAt] = useState<string | null>(null)
  const [failure, setFailure] = useState<ChoiceFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const hasChoices = useRef(false)
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    void (async () => {
      const [projects, connections, workspaces] = await Promise.allSettled([
        agentRequest('/projects', 'GET', undefined, abort.signal) as Promise<{ projects: Project[] }>,
        connectionApi.list(abort.signal),
        api.listWorkspaces(abort.signal),
      ])
      if (abort.signal.aborted) return
      if (projects.status === 'rejected' || connections.status === 'rejected') {
        const source: ChoiceSource = projects.status === 'rejected' ? 'projects' : 'connections'
        const reason = projects.status === 'rejected' ? projects.reason : (connections as PromiseRejectedResult).reason
        setFailure({ source, code: failureCode(reason), kind: failureKind(reason), at: new Date().toISOString() })
        return
      }
      hasChoices.current = true
      setChoices({
        projects: projects.value.projects,
        connections: connections.value.connections.filter(connection => connection.kind === 'model_api' || connection.kind === 'local_runtime'),
        workspaces: workspaces.status === 'fulfilled' ? workspaces.value.workspaces : null,
      })
      setObservedAt(new Date().toISOString())
      setFailure(null)
    })().finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [revision])
  const reload = useCallback(() => setRevision(value => value + 1), [])
  const status: ChoiceStatus = loading && !hasChoices.current ? 'loading' : failure ? 'failed' : 'ready'
  return { status, choices, observedAt, failure, refreshing: loading && hasChoices.current, reload }
}
