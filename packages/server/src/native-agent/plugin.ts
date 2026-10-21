import { definePlugin } from '@guanxi/kernel'
import type { Connections } from '../connections/service.ts'
import type { SessionLog } from '../session-log/log.ts'
import type { ProjectIndexService } from '../indexing/plugin.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { NativeAgents, type NativeHost } from './service.ts'
export const NATIVE_AGENT_SERVICE = 'agent.native'
export const nativeAgentPlugin = definePlugin<{ host: NativeHost; dataDir: string; nodePorts?: () => number[] }>({
  manifest: { id: 'guanxi.native-agent', engines: { guanxi: '^0.1.0' }, provides: [NATIVE_AGENT_SERVICE],
    requires: ['connections.registry', 'session.log', 'egress.scrubber'], uses: ['project.index'], trust: 'T0' },
  apply(ctx, config) {
    const agents = new NativeAgents(config.host, ctx.service<SessionLog>('session.log'), ctx.service<Connections>('connections.registry'),
      ctx.service<EgressScrubber>('egress.scrubber'), config.dataDir, config.nodePorts, undefined, ctx.optionalService<ProjectIndexService>('project.index'))
    ctx.provide(NATIVE_AGENT_SERVICE, Object.freeze({
      create: agents.create.bind(agents), prompt: agents.prompt.bind(agents), progress: agents.progress.bind(agents),
      result: agents.result.bind(agents), wait: agents.wait.bind(agents), stop: agents.stop.bind(agents),
      queue: agents.queue.bind(agents), removeQueued: agents.removeQueued.bind(agents),
      projects: agents.projects.bind(agents), setRoots: agents.setRoots.bind(agents), shutdown: agents.close.bind(agents),
    }))
    ctx.effect(() => () => agents.close(), 'native.close')
  },
})
export type NativeAgentService = Pick<NativeAgents, 'create' | 'prompt' | 'progress' | 'result' | 'wait' | 'stop' | 'queue' | 'removeQueued' | 'setRoots' | 'projects'> & { shutdown(): Promise<void> }
