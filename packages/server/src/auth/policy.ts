/**
 * Pure authorization policy (ADR-0027 decisions 2-4, D-154/D-155, D-190).
 *
 * `can` never reads storage and never mutates its inputs. Callers pass the grants relevant to
 * the decision (or a wider set; unrelated grants are ignored), a resource projection and a
 * clock value. That makes the policy table-testable and keeps expiry deterministic.
 */
import {
  ACTIONS,
  type Action,
  type CanResult,
  type Grant,
  type Payer,
  type PermissionSnapshotEntry,
  type Principal,
  type Relation,
  type Resource,
  type ResourceType,
} from './types.ts'

/**
 * The resource type each action belongs to. `null` marks global account actions, which ignore
 * the resource they are checked against.
 */
const ACTION_RESOURCE_TYPE: Record<Action, ResourceType | null> = {
  'session.read': 'session',
  'session.prompt': 'session',
  'session.stop': 'session',
  'session.share': 'session',
  'session.delete': 'session',
  'project.read': 'project',
  'project.write': 'project',
  'project.share': 'project',
  'project.delete': 'project',
  'connection.use': 'connection',
  'connection.read': 'connection',
  'connection.manage': 'connection',
  'run.read': 'run',
  'run.cancel': 'run',
  'node.admin': 'node',
  'account.invite': null,
  'account.ban': null,
}

/** The single read action of each resource family; viewers get exactly this one. */
const READ_ACTION: Partial<Record<ResourceType, Action>> = {
  project: 'project.read',
  session: 'session.read',
  connection: 'connection.read',
  run: 'run.read',
}

/** Actions an editor adds on top of the viewer read action. */
const EDITOR_EXTRA: Record<ResourceType, readonly Action[]> = {
  project: ['project.write'],
  session: ['session.prompt', 'session.stop'],
  connection: ['connection.use'],
  run: ['run.cancel'],
  node: [],
}

/** Actions an owner adds on top of the viewer read action. */
const OWNER_EXTRA: Record<ResourceType, readonly Action[]> = {
  project: ['project.write', 'project.share', 'project.delete'],
  session: ['session.prompt', 'session.stop', 'session.share', 'session.delete'],
  connection: ['connection.use', 'connection.manage'],
  run: ['run.cancel'],
  node: ['node.admin'],
}

const RELATION_STRENGTH: Record<Relation, number> = { viewer: 1, editor: 2, owner: 3 }

function allow(reason: string, payer?: Payer): CanResult {
  return payer === undefined ? { allowed: true, reason } : { allowed: true, reason, payer }
}

function deny(reason: string): CanResult {
  return { allowed: false, reason }
}

function expired(grant: Grant, now: number): boolean {
  if (grant.expiresAt === null) return false
  // A malformed stored value must fail closed: only a finite integer can be compared to the clock.
  if (!Number.isFinite(grant.expiresAt) || !Number.isInteger(grant.expiresAt)) return true
  return grant.expiresAt <= now
}

function subjectMatches(grant: Grant, principal: Principal): boolean {
  if (principal.kind === 'user') {
    if (grant.subjectType === 'user') return grant.subjectId === principal.userId
    if (grant.subjectType === 'group') return principal.groups.includes(grant.subjectId)
    return false
  }
  if (principal.kind === 'link') {
    return grant.subjectType === 'link' && grant.subjectId === principal.linkId
  }
  return false
}

/** Project grants reach sessions and runs; a session grant never reaches upward. */
function grantReaches(grant: Grant, resource: Resource): boolean {
  if (grant.resourceType === resource.type && grant.resourceId === resource.id) return true
  if ((resource.type === 'session' || resource.type === 'run') && resource.parent?.type === 'project') {
    return grant.resourceType === 'project' && grant.resourceId === resource.parent.id
  }
  return false
}

/**
 * Strongest unexpired relation. Ownership comes only from `ownerUserId`; user and group grants
 * cap at `editor`, and link grants cap at `viewer` (ADR-0027 decision 4).
 */
function effectiveRelation(principal: Principal, resource: Resource, grants: Grant[], now: number): Relation | null {
  let strength = 0
  if (principal.kind === 'user' && principal.userId === resource.ownerUserId) strength = RELATION_STRENGTH.owner
  const grantCap = principal.kind === 'link' ? RELATION_STRENGTH.viewer : RELATION_STRENGTH.editor
  for (const grant of grants) {
    if (expired(grant, now) || !subjectMatches(grant, principal) || !grantReaches(grant, resource)) continue
    strength = Math.max(strength, Math.min(RELATION_STRENGTH[grant.relation], grantCap))
  }
  if (strength >= RELATION_STRENGTH.owner) return 'owner'
  if (strength >= RELATION_STRENGTH.editor) return 'editor'
  if (strength >= RELATION_STRENGTH.viewer) return 'viewer'
  return null
}

function relationAllows(relation: Relation, action: Action, resource: Resource): boolean {
  const readAction = READ_ACTION[resource.type]
  if (relation === 'viewer') return action === readAction
  if (relation === 'editor') return action === readAction || EDITOR_EXTRA[resource.type].includes(action)
  return action === readAction || OWNER_EXTRA[resource.type].includes(action)
}

/**
 * `connection.use` by a non-owner needs a grant made directly on that connection.
 * @internal Exported so the cross-type id-confusion test can pin the type guard.
 */
export function hasDirectConnectionGrant(principal: Principal, resource: Resource, grants: Grant[], now: number): boolean {
  return grants.some(grant =>
    grant.resourceType === 'connection' && grant.resourceId === resource.id &&
    (grant.relation === 'editor' || grant.relation === 'owner') &&
    !expired(grant, now) && subjectMatches(grant, principal))
}

/** D-154 as amended by D-190. Only `ownerUserId` pays as the owner; a granted owner is an editor. */
function promptPayer(principal: Principal, resource: Resource): Payer {
  if (principal.kind === 'user' && principal.userId === resource.ownerUserId) return 'owner'
  const share = resource.share
  if (share?.ownerPaysForEditors === true && (share.ownerConnectionKind === 'api_key' || share.ownerConnectionKind === 'local')) {
    return 'owner'
  }
  return 'actor'
}

/**
 * Decide one action. Private by default: only the owner and explicit, unexpired grants count.
 * A subscription connection is usable only by its owner (D-190). Admins receive the three
 * server-admin actions in addition to normal owner/grant rules; they have no override for
 * another user's data (D-155).
 */
export function can(principal: Principal, action: Action, resource: Resource, grants: Grant[], now: number): CanResult {
  const expectedType = ACTION_RESOURCE_TYPE[action]
  if (expectedType !== null && expectedType !== resource.type) return deny('action_not_applicable')
  if (principal.kind === 'anonymous') return deny('anonymous')

  if (action === 'account.invite' || action === 'account.ban') {
    return principal.kind === 'user' && principal.role === 'admin' ? allow('admin') : deny('admin_required')
  }
  // A server admin may administer any node; a node owner reaches the same action below.
  if (action === 'node.admin' && principal.kind === 'user' && principal.role === 'admin') return allow('admin')

  const relation = effectiveRelation(principal, resource, grants, now)
  if (relation === null) return deny('no_grant')

  if (action === 'connection.use') {
    const actualOwner = principal.kind === 'user' && principal.userId === resource.ownerUserId
    if (resource.connectionKind === 'subscription' && !actualOwner) return deny('subscription_owner_only')
    if (relation !== 'owner' && !hasDirectConnectionGrant(principal, resource, grants, now)) {
      return deny('connection_use_requires_grant')
    }
  }

  if (!relationAllows(relation, action, resource)) return deny('insufficient_relation')
  if (action === 'session.prompt') return allow(relation, promptPayer(principal, resource))
  return allow(relation)
}

/**
 * The client-facing permission projection: for each supplied resource, the allowed actions in
 * canonical `ACTIONS` order. This is exactly what `can` would answer for the same inputs.
 */
export function permissionSnapshot(
  principal: Principal,
  resources: Resource[],
  grants: Grant[],
  now: number,
): PermissionSnapshotEntry[] {
  return resources.map(resource => ({
    resourceType: resource.type,
    resourceId: resource.id,
    actions: ACTIONS.filter(action => can(principal, action, resource, grants, now).allowed),
  }))
}
