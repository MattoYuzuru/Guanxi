import type { Db } from '../store/db.ts'
import type { DurableRunsService } from '../runs/plugin.ts'
import { definePlugin } from '@guanxi/kernel'
import type { Connections } from '../connections/service.ts'
import type { SessionLog } from '../session-log/log.ts'
import type { ProjectIndexService } from '../indexing/plugin.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { NativeAgents, type NativeHost } from './service.ts'
export const NATIVE_AGENT_SERVICE = 'agent.native'
export const nativeAgentPlugin = definePlugin<{ db: Db; host: NativeHost; dataDir: string; nodePorts?: () => number[] }>({
  manifest: { id: 'guanxi.native-agent', engines: { guanxi: '^0.1.0' }, provides: [NATIVE_AGENT_SERVICE],
    requires: ['runs.durable', 'connections.registry', 'session.log', 'egress.scrubber'], uses: ['project.index'], trust: 'T0' },
  apply(ctx, config) {
    const agents = new NativeAgents(config.host, ctx.service<SessionLog>('session.log'), ctx.service<Connections>('connections.registry'),
      ctx.service<EgressScrubber>('egress.scrubber'), config.dataDir, config.nodePorts, undefined, { db: config.db, runs: ctx.service<DurableRunsService>('runs.durable').store }, ctx.optionalService<ProjectIndexService>('project.index'))
    ctx.provide(NATIVE_AGENT_SERVICE, Object.freeze({
      create: agents.create.bind(agents), deleteSession: agents.deleteSession.bind(agents), setRetention: agents.setRetention.bind(agents), leaveSession: agents.leaveSession.bind(agents), prompt: agents.prompt.bind(agents), progress: agents.progress.bind(agents), progressV2: agents.progressV2.bind(agents),
      result: agents.result.bind(agents), wait: agents.wait.bind(agents), stop: agents.stop.bind(agents),
      queue: agents.queue.bind(agents), removeQueued: agents.removeQueued.bind(agents),
      sideChatRespond: agents.sideChatRespond.bind(agents), sideChatSave: agents.sideChatSave.bind(agents), sideChatSend: agents.sideChatSend.bind(agents),
      projects: agents.projects.bind(agents), setRoots: agents.setRoots.bind(agents), shutdown: agents.close.bind(agents),
    }))
    ctx.effect(() => () => agents.close(), 'native.close')
  },
})
export type NativeAgentService = Pick<NativeAgents, 'leaveSession' | 'setRetention' | 'deleteSession' | 'create' | 'prompt' | 'progress' | 'progressV2' | 'result' | 'wait' | 'stop' | 'queue' | 'removeQueued' | 'setRoots' | 'projects' | 'sideChatRespond' | 'sideChatSave' | 'sideChatSend'> & { shutdown(): Promise<void> }
