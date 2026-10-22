import { LAYOUT_VERSION, WORKSPACE_ENGINE_MAJOR, layoutDocumentSchema, type ExperienceMode, type LayoutDocument, type LayoutQuery, type WorkspaceZone } from '@guanxi/contract'
import { builtInBlocks } from './blocks.ts'

/** LAYOUT_AND_SCREENS §4–5: all ten shells are available in each preset. */
export function builtInLayout(query: LayoutQuery): LayoutDocument {
  const visual = query.mode === 'visual'
  const zones: Record<string, WorkspaceZone> = visual
    ? { chat: 'center', artifacts: 'center', browser: 'center', plan: 'right', subagents: 'right', context: 'left', changes: 'left', processes: 'bottom', environment: 'bottom', files: 'bottom', terminal: 'bottom' }
    : { chat: 'center', changes: 'center', terminal: 'bottom', context: 'right', plan: 'right', processes: 'right', environment: 'right', files: 'right', artifacts: 'left', browser: 'left', subagents: 'left' }
  const blocks = Object.fromEntries(builtInBlocks.map((block, i) => [block.id, { contribution: block.id, pluginVersion: '0.1.0', priority: i, params: {} }]))
  const groups = (['center', 'left', 'right', 'top', 'bottom'] as const).flatMap(zone => {
    const ids = builtInBlocks.filter(block => zones[block.id.split('/')[1]!] === zone).map(block => block.id)
    return ids.length ? [{ id: `zone-${zone}`, zone, blocks: ids, active: ids[0] }] : []
  })
  return layoutDocumentSchema.parse({
    schema: LAYOUT_VERSION, id: `default-${query.mode}`, name: query.mode, scope: query,
    density: 'comfortable', basePreset: query.mode, engineState: { engine: 'dockview', major: WORKSPACE_ENGINE_MAJOR, groups },
    blocks, hidden: [], statusItems: [], rev: 0, updatedAt: '2026-10-21T00:00:00.000Z', updatedBy: { device: query.device },
  })
}
export function layoutForMode(mode: ExperienceMode, query: LayoutQuery): LayoutDocument {
  return builtInLayout({ ...query, mode })
}
