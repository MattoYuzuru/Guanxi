import { translate } from '../../lib/locale.ts'
import { NativeProgress, NativeSessionActions } from './NativeAgentPage.tsx'
import { NativeTimeline, type TimelineMessage } from './NativeTimeline.tsx'
import type { AgentProgress } from '@guanxi/contract'
const progress: AgentProgress = { sessionId: 'fixture-session', projectId: 'fixture-project', connectionId: 'fixture-connection', model: 'fixture-model', mode: 'read-only',
  status: 'running', plan: [{ text: 'Inspect project', status: 'active' }], queue: [{ id: 'next', text: 'Check the result' }], summary: '', error: null,
  observedAt: '2026-10-21T00:00:00.000Z', source: 'session.log', confidence: 'high' }
export default { title: translate('native.progress'), component: NativeProgress, args: { progress, remove() {} } }
export const Running = {}
export const Empty = { args: { progress: { ...progress, plan: [], queue: [] } } }
export const Completed = { args: { progress: { ...progress, status: 'completed', summary: translate('native.story.result'), queue: [], plan: [{ text: 'Inspect project', status: 'verification_requested' }] } } }
export const Failed = { args: { progress: { ...progress, status: 'failed', error: 'agent_failed' } } }
export const Cancelled = { args: { progress: { ...progress, status: 'cancelled' } } }
export const Interrupted = { args: { progress: { ...progress, status: 'interrupted' } } }

export const CleanupUnconfirmed = { args: { progress: { ...progress, status: 'failed', error: 'cleanup_unconfirmed' } } }

export const SessionActions = { render: () => <NativeSessionActions progress={{ ...progress, status: 'completed', retention: { mode: 'ttl', state: 'active', expiresAt: null, recoveryDeadline: null } }} busy={false} remove={() => {}} retain={() => {}} leave={() => {}} /> }
export const DeletingSession = { render: () => <NativeSessionActions progress={{ ...progress, status: 'completed' }} busy remove={() => {}} retain={() => {}} leave={() => {}} /> }
export const InputRequired = { args: { progress: { ...progress, status: 'input_required', error: 'process_restarted' } } }

const turns: TimelineMessage[] = [
  { seq: 1, role: 'user', text: translate('native.story.prompt'), at: '2026-10-21T00:00:00.000Z' },
  { seq: 2, role: 'agent', text: translate('native.story.answer'), at: '2026-10-21T00:01:00.000Z' },
]
export const TimelineLoading = { render: () => <NativeTimeline sessionId="fixture-session" messages={null} summary="" observedAt={progress.observedAt} /> }
export const TimelineSummaryOnly = { render: () => <NativeTimeline sessionId="fixture-session" messages={[]} summary={translate('native.story.result')} observedAt={progress.observedAt} /> }
export const TimelineConversation = { render: () => <NativeTimeline sessionId="fixture-session" messages={turns} summary="" observedAt={progress.observedAt} /> }
