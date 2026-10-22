import type { LayoutQuery, LayoutScope } from '@guanxi/contract'

const LAYOUT_SAVE_SCOPE = {
  account: 'account',
  project: 'project',
  device: 'device',
  projectDevice: 'project-device',
} as const
export type LayoutSaveScope = (typeof LAYOUT_SAVE_SCOPE)[keyof typeof LAYOUT_SAVE_SCOPE]

export function layoutSaveScope(scope: LayoutScope): LayoutSaveScope {
  return scope.device ? scope.project ? LAYOUT_SAVE_SCOPE.projectDevice : LAYOUT_SAVE_SCOPE.device
    : scope.project ? LAYOUT_SAVE_SCOPE.project : LAYOUT_SAVE_SCOPE.account
}
export function layoutSaveScopes(query: LayoutQuery): LayoutSaveScope[] {
  return query.project
    ? [LAYOUT_SAVE_SCOPE.account, LAYOUT_SAVE_SCOPE.project, LAYOUT_SAVE_SCOPE.device, LAYOUT_SAVE_SCOPE.projectDevice]
    : [LAYOUT_SAVE_SCOPE.account, LAYOUT_SAVE_SCOPE.device]
}
export function layoutScopeForSave(query: LayoutQuery, target: LayoutSaveScope): LayoutScope {
  if (!layoutSaveScopes(query).includes(target)) throw new Error('layout_project_scope_unavailable')
  return { account: query.account, mode: query.mode, deviceClass: query.deviceClass,
    ...(target === LAYOUT_SAVE_SCOPE.project || target === LAYOUT_SAVE_SCOPE.projectDevice ? { project: query.project! } : {}),
    ...(target === LAYOUT_SAVE_SCOPE.device || target === LAYOUT_SAVE_SCOPE.projectDevice ? { device: query.device } : {}) }
}
