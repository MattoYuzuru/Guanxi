import { definePlugin } from '@guanxi/kernel'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { ProjectIndex } from './service.ts'
import type { IndexSettings } from './types.ts'

export const PROJECT_INDEX_SERVICE = 'project.index'
export const projectIndexPlugin = definePlugin<{ dataDir: string; settings?: Partial<IndexSettings> }>({
  manifest: { id: 'guanxi.project-index', engines: { guanxi: '^0.1.0' }, provides: [PROJECT_INDEX_SERVICE], requires: ['governor', 'egress.scrubber'], trust: 'T0' },
  apply(ctx, config) {
    const index = new ProjectIndex({ ...config, governor: ctx.service<ResourceGovernor>('governor'), scrubber: ctx.service<EgressScrubber>('egress.scrubber') })
    ctx.provide(PROJECT_INDEX_SERVICE, Object.freeze({ track: index.track.bind(index), map: index.map.bind(index), search: index.search.bind(index), status: index.status.bind(index) }))
    ctx.effect(() => () => index.close(), 'index.close')
  },
})
export type ProjectIndexService = Pick<ProjectIndex, 'track' | 'map' | 'search' | 'status'>
