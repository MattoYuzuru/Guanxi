/**
 * Authorization model for accounts and sharing (ADR-0027).
 *
 * This file is deliberately data-only: it has no authentication provider, no storage and no
 * framework dependency. Better Auth will produce `Principal` values later; the policy, grant
 * store and route guards consume them today.
 */

/** Every resource that can be owned or shared. */
export const RESOURCE_TYPES = ['project', 'session', 'connection', 'run', 'node'] as const

/** A resource family. */
export type ResourceType = (typeof RESOURCE_TYPES)[number]

/** Relation strength on a resource, weakest first. */
export const RELATIONS = ['viewer', 'editor', 'owner'] as const

/** The access relation a grant confers. */
export type Relation = (typeof RELATIONS)[number]

/** The kind of subject a grant is addressed to. */
export const SUBJECT_TYPES = ['user', 'group', 'link'] as const

/** The kind of subject a grant is addressed to. */
export type SubjectType = (typeof SUBJECT_TYPES)[number]

/**
 * A person or machine acting on a resource.
 *
 * - `user` is an authenticated account with a global role;
 * - `anonymous` is an unauthenticated request and may do nothing;
 * - `link` is a holder of an explicit share link and has no account identity.
 */
export type Principal =
  | { kind: 'user'; userId: string; role: 'admin' | 'member'; groups: string[] }
  | { kind: 'anonymous' }
  | { kind: 'link'; linkId: string }

/** The payment source for a prompt. */
export type Payer = 'owner' | 'actor'

/**
 * A shareable object. Ownership is private by default: `ownerUserId` is the only implicit
 * relation. `parent` links a session or run to its project so project grants can inherit.
 */
export interface Resource {
  type: ResourceType
  id: string
  ownerUserId: string
  parent?: { type: 'project'; id: string }
  /** Present on a session: whether the owner lets editors spend the owner's connections. */
  share?: {
    ownerPaysForEditors: boolean
    ownerConnectionKind: 'subscription' | 'api_key' | 'local'
  }
  /** Present on a connection: a subscription is bound to its owner (D-190). */
  connectionKind?: 'subscription' | 'api_key' | 'local'
}

/** A Zanzibar-style relation tuple. */
export interface Grant {
  resourceType: ResourceType
  resourceId: string
  relation: Relation
  subjectType: SubjectType
  subjectId: string
  createdBy: string
  createdAt: number
  /** Epoch milliseconds; `null` never expires. */
  expiresAt: number | null
}

/**
 * Every action the server authorizes. Actions are checked against one resource; the resource
 * type an action belongs to is fixed (account actions are global and ignore the resource).
 */
export const ACTIONS = [
  /** Read a session, its events and sub-agent view. */
  'session.read',
  /** Send a prompt into a session, including an editor turn. */
  'session.prompt',
  /** Stop the active run or turn in a session. */
  'session.stop',
  /** Create, change or revoke share grants on a session. */
  'session.share',
  /** Permanently delete a session. */
  'session.delete',
  /** Read a project and its metadata. */
  'project.read',
  /** Change project metadata, roots and configuration. */
  'project.write',
  /** Create, change or revoke share grants on a project. */
  'project.share',
  /** Permanently delete a project. */
  'project.delete',
  /** Dispatch a request through a connection (D-190 restricts subscriptions). */
  'connection.use',
  /** Read a connection's metadata, never its secret material. */
  'connection.read',
  /** Change, test, share or delete a connection. */
  'connection.manage',
  /** Read a run, its events and attempt history. */
  'run.read',
  /** Cancel a run. */
  'run.cancel',
  /** Administer a compute node as its owner, or any node as a server admin. */
  'node.admin',
  /** Invite an account. This is a server-admin capability. */
  'account.invite',
  /** Ban an account and revoke its sessions. This is a server-admin capability. */
  'account.ban',
] as const

/** Any action the server authorizes. */
export type Action = (typeof ACTIONS)[number]

/** The result of one authorization decision. */
export interface CanResult {
  allowed: boolean
  /** Stable low-cardinality explanation, suitable for logs and tests. */
  reason: string
  /** Present only for an allowed `session.prompt`: who pays for that turn. */
  payer?: Payer
}

/** The actions one principal may perform on one resource, as sent to clients. */
export interface PermissionSnapshotEntry {
  resourceType: ResourceType
  resourceId: string
  /** Allowed actions in canonical `ACTIONS` order. */
  actions: Action[]
}
