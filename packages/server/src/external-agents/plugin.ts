import { definePlugin } from '@guanxi/kernel'
import { join } from 'node:path'
import type { Connections } from '../connections/service.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { SessionLog } from '../session-log/log.ts'
import type { ExternalPolicy } from './types.ts'
import { ExternalAgents } from './service.ts'
import { ExternalStore } from './store.ts'

export const EXTERNAL_AGENT_SERVICE = 'agent.external'
export const externalAgentPlugin = definePlugin<{ dataDir: string; policy: ExternalPolicy }>({
  manifest: { id: 'guanxi.external-agents', engines: { guanxi: '^0.1.0' }, provides: [EXTERNAL_AGENT_SERVICE],
    requires: ['connections.registry', 'session.log', 'egress.scrubber'], trust: 'T0' },
  apply(ctx, config) {
    const scrubber = ctx.service<EgressScrubber>('egress.scrubber')
    const store = new ExternalStore(join(config.dataDir, 'external-agents.sqlite'), scrubber)
    let agents: ExternalAgents
    try { agents = new ExternalAgents(ctx.service<Connections>('connections.registry'), ctx.service<SessionLog>('session.log'),
      scrubber, config.dataDir, store, config.policy) } catch (error) { store.close(); throw error }
    ctx.provide(EXTERNAL_AGENT_SERVICE, Object.freeze({
      run: agents.run.bind(agents), resolve: agents.resolve.bind(agents), setProjectRoles: agents.setProjectRoles.bind(agents),
      setEditorAllowed: agents.setEditorAllowed.bind(agents), capabilities: agents.capabilities.bind(agents),
      limits: agents.limits.bind(agents), observeQuota: agents.observeQuota.bind(agents),
      observeClaudeStatusline: agents.observeClaudeStatusline.bind(agents), signInWithChatGPT: agents.signInWithChatGPT.bind(agents),
      observeConcurrency: agents.observeConcurrency.bind(agents),
      prepareLogin: agents.prepareLogin.bind(agents),
    }))
    ctx.effect(() => async () => { await agents.close(); store.close() }, 'external.close')
  },
})
export type ExternalAgentService = Pick<ExternalAgents, 'run' | 'resolve' | 'setProjectRoles' | 'setEditorAllowed' | 'capabilities' | 'limits' | 'observeQuota' | 'observeClaudeStatusline' | 'signInWithChatGPT' | 'observeConcurrency' | 'prepareLogin'>
