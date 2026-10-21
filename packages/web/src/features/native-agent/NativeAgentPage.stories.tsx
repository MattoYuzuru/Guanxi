import { translate } from '../../lib/locale.ts'
import { NativeProgress } from './NativeAgentPage.tsx'
import type { AgentProgress } from '@guanxi/contract'
const progress: AgentProgress = { sessionId: 'fixture-session', projectId: 'fixture-project', connectionId: 'fixture-connection', model: 'fixture-model', mode: 'read-only',
  status: 'running', plan: [{ text: 'Inspect project', status: 'active' }], queue: [{ id: 'next', text: 'Check the result' }], summary: '', error: null,
  observedAt: '2026-10-21T00:00:00.000Z', source: 'session.log', confidence: 'high' }
export default { title: translate('native.progress'), component: NativeProgress, args: { progress, stop() {}, remove() {} } }
export const Running = {}
export const Empty = { args: { progress: { ...progress, plan: [], queue: [] } } }
export const Completed = { args: { progress: { ...progress, status: 'completed', summary: translate('native.story.result'), queue: [], plan: [{ text: 'Inspect project', status: 'verification_requested' }] } } }
export const Failed = { args: { progress: { ...progress, status: 'failed', error: 'agent_failed' } } }
export const Cancelled = { args: { progress: { ...progress, status: 'cancelled' } } }
export const Interrupted = { args: { progress: { ...progress, status: 'interrupted' } } }

export const CleanupUnconfirmed = { args: { progress: { ...progress, status: 'failed', error: 'cleanup_unconfirmed' } } }
