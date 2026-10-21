import { z } from 'zod'

export const LAYOUT_VERSION = 'guanxi.layout/1' as const
export const WORKSPACE_ENGINE_MAJOR = 8
const id = z.string().min(1).max(160).regex(/^[\w./:-]+$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))
export const experienceModeSchema = z.enum(['developer', 'visual'])
export const workspaceZoneSchema = z.enum(['left', 'right', 'top', 'bottom', 'center', 'floating', 'popout'])
export const layoutScopeSchema = z.object({
  account: id,
  project: id.optional(),
  mode: experienceModeSchema,
  deviceClass: z.enum(['desktop', 'tablet', 'phone']),
  device: id.optional(),
}).strict()

// Layouts carry presentation configuration, never free text/credentials. String values
// must be opaque references. Plugins needing richer params must define a reviewed schema.
export const layoutParamsSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), z.union([
  z.boolean(), z.number().finite(), z.null(),
  z.object({ ref: z.string().regex(/^(?:secret|resource):\/\/[\w./:-]+$/) }).strict(),
])).superRefine((params, ctx) => {
  for (const key of Object.keys(params)) if (/password|token|credential|apiKey|secret/i.test(key)) {
    if (typeof params[key] !== 'object' || params[key] === null || !('ref' in params[key]!)) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Credentials must be references' })
    }
  }
})
export const layoutBlockSchema = z.object({
  contribution: id,
  pluginVersion: z.string().min(1).max(80),
  priority: z.number().int(),
  params: layoutParamsSchema.default({}),
}).strict()
const groupSchema = z.object({
  id,
  zone: workspaceZoneSchema,
  blocks: z.array(id),
  active: id.optional(),
}).strict()
export type LayoutTree = { group: string; size: number } | { children: LayoutTree[]; size: number }
// Validate iteratively before any recursive engine traversal; hostile deep trees
// must be a 400 response rather than a parser stack overflow.
const treeSchema: z.ZodType<LayoutTree> = z.custom<LayoutTree>((input) => {
  const pending = [{ value: input, depth: 0 }]
  const seen = new Set<unknown>()
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (!value || typeof value !== 'object' || depth > 32 || seen.has(value)) return false
    seen.add(value)
    const row = value as Record<string, unknown>
    if (typeof row.size !== 'number' || !Number.isFinite(row.size) || row.size < 0) return false
    if ('group' in row) {
      if (Object.keys(row).some(key => !['group', 'size'].includes(key)) || !id.safeParse(row.group).success) return false
    } else {
      if (Object.keys(row).some(key => !['children', 'size'].includes(key)) || !Array.isArray(row.children) || !row.children.length) return false
      row.children.forEach(child => pending.push({ value: child, depth: depth + 1 }))
    }
  }
  return true
})
export const layoutClockSchema = z.object({ rev: z.number().int().nonnegative(), updatedAt: z.string().datetime(), device: id }).strict()
export type LayoutClock = z.infer<typeof layoutClockSchema>
export function layoutClock(document: LayoutDocument): LayoutClock { return { rev: document.rev, updatedAt: document.updatedAt, device: document.updatedBy.device } }
export const layoutDocumentSchema = z.object({
  schema: z.literal(LAYOUT_VERSION),
  id,
  name: z.string().trim().min(1).max(120),
  scope: layoutScopeSchema,
  density: z.enum(['compact', 'comfortable']),
  basePreset: experienceModeSchema,
  engineState: z.object({
    engine: z.literal('dockview'),
    major: z.number().int().positive(),
    groups: z.array(groupSchema),
    grid: z.object({ root: treeSchema, orientation: z.enum(['HORIZONTAL', 'VERTICAL']), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict().optional(),
  }).strict(),
  blocks: z.record(id, layoutBlockSchema),
  hidden: z.array(id),
  statusItems: z.array(id),
  rev: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().datetime(),
  updatedBy: z.object({ device: id }).strict(),
}).strict().superRefine((doc, ctx) => {
  const seen = new Set<string>()
  const groups = new Set<string>()
  for (const group of doc.engineState.groups) {
    if (groups.has(group.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate group' })
    groups.add(group.id)
    if (group.active && !group.blocks.includes(group.active)) ctx.addIssue({ code: 'custom', message: 'Active block missing from group' })
    for (const block of group.blocks) {
      if (!Object.hasOwn(doc.blocks, block) || seen.has(block)) ctx.addIssue({ code: 'custom', message: 'Missing or duplicate block' })
      seen.add(block)
    }
  }
  for (const block of doc.hidden) {
    if (!Object.hasOwn(doc.blocks, block) || seen.has(block)) ctx.addIssue({ code: 'custom', message: 'Missing or duplicate hidden block' })
    seen.add(block)
  }
  if (seen.size !== Object.keys(doc.blocks).length) ctx.addIssue({ code: 'custom', message: 'Unplaced block' })
  if (doc.engineState.grid) {
    const leaves = new Set<string>()
    const visit = (tree: LayoutTree, depth: number) => {
      if (depth > 32) { ctx.addIssue({ code: 'custom', message: 'Layout tree too deep' }); return }
      if ('group' in tree) {
        const group = doc.engineState.groups.find(g => g.id === tree.group)
        if (!group || ['floating', 'popout'].includes(group.zone) || leaves.has(tree.group)) ctx.addIssue({ code: 'custom', message: 'Invalid grid group' })
        leaves.add(tree.group)
      } else tree.children.forEach(child => visit(child, depth + 1))
    }
    visit(doc.engineState.grid.root, 0)
    for (const group of doc.engineState.groups) if (!['floating', 'popout'].includes(group.zone) && !leaves.has(group.id)) ctx.addIssue({ code: 'custom', message: 'Grid omits group' })
  }
})
export type LayoutDocument = z.infer<typeof layoutDocumentSchema>
export type LayoutScope = z.infer<typeof layoutScopeSchema>
export type ExperienceMode = z.infer<typeof experienceModeSchema>
export type WorkspaceZone = z.infer<typeof workspaceZoneSchema>
export const layoutQuerySchema = layoutScopeSchema.required({ device: true })
export type LayoutQuery = z.infer<typeof layoutQuerySchema>
export const layoutGeometrySchema = z.record(id, z.object({
  left: z.number().finite(), top: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive(),
}).strict())
export type LayoutGeometry = z.infer<typeof layoutGeometrySchema>
export const saveLayoutBody = z.object({ document: layoutDocumentSchema, activate: z.boolean().default(true), basedOn: layoutClockSchema.optional() }).strict()
export const saveLayoutResponse = z.object({ document: layoutDocumentSchema, recovered: z.array(layoutDocumentSchema) }).strict()
export const layoutListResponse = z.object({
  documents: z.array(layoutDocumentSchema),
  active: z.array(z.object({ scope: layoutScopeSchema, layoutId: id }).strict()),
}).strict()
export type LayoutList = z.infer<typeof layoutListResponse>
export const layoutGeometryBody = z.object({ account: id, device: id, layoutId: id, geometry: layoutGeometrySchema }).strict()
export const layoutGeometryResponse = z.object({ geometry: layoutGeometrySchema }).strict()

export function layoutScopeKey(scope: LayoutScope): string {
  return JSON.stringify([scope.account, scope.project ?? null, scope.mode, scope.deviceClass, scope.device ?? null])
}
export function compareLayouts(a: LayoutDocument, b: LayoutDocument): number {
  return a.rev - b.rev || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || (a.updatedBy.device < b.updatedBy.device ? -1 : a.updatedBy.device > b.updatedBy.device ? 1 : 0)
}
/** Exact mode/class match; device > project > account > built-in. Named inactive copies never win. */
export function resolveLayout(list: LayoutList, query: LayoutQuery, builtIn: LayoutDocument): LayoutDocument {
  const scopes: LayoutScope[] = [
    { ...query },
    ...(query.project ? [{ account: query.account, project: query.project, mode: query.mode, deviceClass: query.deviceClass }] : []),
    { account: query.account, mode: query.mode, deviceClass: query.deviceClass },
  ]
  // Device overrides can be account-wide too.
  if (query.project) scopes.splice(1, 0, { account: query.account, mode: query.mode, deviceClass: query.deviceClass, device: query.device })
  for (const scope of scopes) {
    const key = layoutScopeKey(scope)
    const active = list.active.find(row => layoutScopeKey(row.scope) === key)
    const doc = list.documents.find(row => row.id === active?.layoutId && layoutScopeKey(row.scope) === key)
    if (doc) return doc.engineState.major === WORKSPACE_ENGINE_MAJOR ? doc : builtIn
  }
  return builtIn
}
