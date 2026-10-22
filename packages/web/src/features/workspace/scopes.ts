import type { LayoutQuery, LayoutScope } from '@guanxi/contract'

export type LayoutSaveScope = 'account' | 'project' | 'device' | 'project-device'
export function layoutSaveScope(scope: LayoutScope): LayoutSaveScope {
  return scope.device ? scope.project ? 'project-device' : 'device' : scope.project ? 'project' : 'account'
}
export function layoutSaveScopes(query: LayoutQuery): LayoutSaveScope[] {
  return query.project ? ['account', 'project', 'device', 'project-device'] : ['account', 'device']
}
export function layoutScopeForSave(query: LayoutQuery, target: LayoutSaveScope): LayoutScope {
  if (!layoutSaveScopes(query).includes(target)) throw new Error('layout_project_scope_unavailable')
  return { account: query.account, mode: query.mode, deviceClass: query.deviceClass,
    ...(target === 'project' || target === 'project-device' ? { project: query.project! } : {}),
    ...(target === 'device' || target === 'project-device' ? { device: query.device } : {}) }
}
