import assert from 'node:assert/strict'
import { test } from 'node:test'
import { can, permissionSnapshot } from '../../src/auth/policy.ts'
import {
  ACTIONS,
  RESOURCE_TYPES,
  type Action,
  type Grant,
  type Principal,
  type Relation,
  type Resource,
  type ResourceType,
  type SubjectType,
} from '../../src/auth/types.ts'

const NOW = 1_800_000_000_000
const OWNER_ID = 'user-owner'

function user(userId: string, role: 'admin' | 'member' = 'member', groups: string[] = []): Principal {
  return { kind: 'user', userId, role, groups }
}

function buildResources(): Record<ResourceType, Resource> {
  return {
    project: { type: 'project', id: 'project-1', ownerUserId: OWNER_ID },
    session: {
      type: 'session', id: 'session-1', ownerUserId: OWNER_ID,
      parent: { type: 'project', id: 'project-1' },
      share: { ownerPaysForEditors: false, ownerConnectionKind: 'api_key' },
    },
    connection: { type: 'connection', id: 'connection-1', ownerUserId: OWNER_ID, connectionKind: 'api_key' },
    run: { type: 'run', id: 'run-1', ownerUserId: OWNER_ID, parent: { type: 'project', id: 'project-1' } },
    node: { type: 'node', id: 'node-1', ownerUserId: OWNER_ID },
  }
}

function makeGrant(
  resource: Resource,
  relation: Relation,
  subjectType: SubjectType,
  subjectId: string,
  expiresAt: number | null = null,
): Grant {
  return {
    resourceType: resource.type,
    resourceId: resource.id,
    relation,
    subjectType,
    subjectId,
    createdBy: OWNER_ID,
    createdAt: NOW - 1_000,
    expiresAt,
  }
}

function grantsForEveryResource(
  resources: Record<ResourceType, Resource>,
  relation: Relation,
  subjectType: SubjectType,
  subjectId: string,
  expiresAt: number | null = null,
): Grant[] {
  return RESOURCE_TYPES.map(type => makeGrant(resources[type], relation, subjectType, subjectId, expiresAt))
}

type Expected = Record<ResourceType, readonly Action[]>

const OWNER_EXPECTED: Expected = {
  project: ['project.read', 'project.write', 'project.share', 'project.delete'],
  session: ['session.read', 'session.prompt', 'session.stop', 'session.share', 'session.delete'],
  connection: ['connection.use', 'connection.read', 'connection.manage'],
  run: ['run.read', 'run.cancel'],
  node: ['node.admin'],
}
const EDITOR_EXPECTED: Expected = {
  project: ['project.read', 'project.write'],
  session: ['session.read', 'session.prompt', 'session.stop'],
  connection: ['connection.use', 'connection.read'],
  run: ['run.read', 'run.cancel'],
  node: [],
}
const VIEWER_EXPECTED: Expected = {
  project: ['project.read'],
  session: ['session.read'],
  connection: ['connection.read'],
  run: ['run.read'],
  node: [],
}
const ADMIN_EXPECTED: Expected = {
  project: ['account.invite', 'account.ban'],
  session: ['account.invite', 'account.ban'],
  connection: ['account.invite', 'account.ban'],
  run: ['account.invite', 'account.ban'],
  node: ['node.admin', 'account.invite', 'account.ban'],
}
const NONE_EXPECTED: Expected = { project: [], session: [], connection: [], run: [], node: [] }

interface MatrixCase {
  name: string
  principal: Principal
  grants: Grant[]
  expected: Expected
}

function buildCases(resources: Record<ResourceType, Resource>): MatrixCase[] {
  const expiredUser = 'user-expired'
  return [
    { name: 'owner', principal: user(OWNER_ID), grants: [], expected: OWNER_EXPECTED },
    {
      name: 'editor',
      principal: user('user-editor'),
      grants: grantsForEveryResource(resources, 'editor', 'user', 'user-editor'),
      expected: EDITOR_EXPECTED,
    },
    {
      name: 'viewer',
      principal: user('user-viewer'),
      grants: grantsForEveryResource(resources, 'viewer', 'user', 'user-viewer'),
      expected: VIEWER_EXPECTED,
    },
    {
      name: 'group-editor',
      principal: user('user-group-editor', 'member', ['editors']),
      grants: grantsForEveryResource(resources, 'editor', 'group', 'editors'),
      expected: EDITOR_EXPECTED,
    },
    {
      name: 'expired-grant user',
      principal: user(expiredUser),
      grants: [
        ...grantsForEveryResource(resources, 'viewer', 'user', expiredUser, NOW - 1),
        ...grantsForEveryResource(resources, 'editor', 'user', expiredUser, NOW),
      ],
      expected: NONE_EXPECTED,
    },
    {
      name: 'link with grant',
      principal: { kind: 'link', linkId: 'link-1' },
      grants: grantsForEveryResource(resources, 'editor', 'link', 'link-1'),
      expected: EDITOR_EXPECTED,
    },
    { name: 'link without grant', principal: { kind: 'link', linkId: 'link-2' }, grants: [], expected: NONE_EXPECTED },
    { name: 'admin non-owner', principal: user('user-admin', 'admin'), grants: [], expected: ADMIN_EXPECTED },
    { name: 'member stranger', principal: user('user-stranger'), grants: [], expected: NONE_EXPECTED },
    { name: 'anonymous', principal: { kind: 'anonymous' }, grants: [], expected: NONE_EXPECTED },
  ]
}

test('authorization matrix: every principal, action and resource type has an explicit expected cell', () => {
  const resources = buildResources()
  const cases = buildCases(resources)
  let cells = 0

  for (const matrixCase of cases) {
    for (const type of RESOURCE_TYPES) {
      const expected = matrixCase.expected[type]
      assert.equal(new Set(expected).size, expected.length, `${matrixCase.name}/${type}: duplicate expectation`)
      assert.deepEqual(
        expected,
        ACTIONS.filter(action => expected.includes(action)),
        `${matrixCase.name}/${type}: expectation must list every action once in canonical order`,
      )
      for (const action of ACTIONS) {
        const result = can(matrixCase.principal, action, resources[type], matrixCase.grants, NOW)
        assert.equal(result.allowed, expected.includes(action), `${matrixCase.name} / ${type} / ${action}`)
        cells++
      }
    }
  }

  assert.equal(cells, cases.length * RESOURCE_TYPES.length * ACTIONS.length)
  assert.equal(cells, 10 * 5 * 17)
})

test('project grants inherit to sessions and runs, while session grants never leak upward', () => {
  const resources = buildResources()
  const viewer = user('user-viewer')
  const projectViewer = makeGrant(resources.project, 'viewer', 'user', 'user-viewer')

  assert.equal(can(viewer, 'session.read', resources.session, [projectViewer], NOW).allowed, true)
  assert.equal(can(viewer, 'run.read', resources.run, [projectViewer], NOW).allowed, true)
  assert.equal(can(viewer, 'session.prompt', resources.session, [projectViewer], NOW).allowed, false)
  assert.equal(can(viewer, 'run.cancel', resources.run, [projectViewer], NOW).allowed, false)
  assert.equal(can(viewer, 'project.share', resources.project, [projectViewer], NOW).allowed, false)

  const sessionViewer = makeGrant(resources.session, 'viewer', 'user', 'user-viewer')
  assert.equal(can(viewer, 'project.read', resources.project, [sessionViewer], NOW).allowed, false)
  assert.equal(can(viewer, 'project.write', resources.project, [sessionViewer], NOW).allowed, false)
  assert.equal(can(viewer, 'run.read', resources.run, [sessionViewer], NOW).allowed, false)

  const sessionEditor = makeGrant(resources.session, 'editor', 'user', 'user-editor')
  const editor = user('user-editor')
  assert.equal(can(editor, 'project.read', resources.project, [sessionEditor], NOW).allowed, false)
  assert.equal(can(editor, 'project.write', resources.project, [sessionEditor], NOW).allowed, false)

  const projectEditor = makeGrant(resources.project, 'editor', 'user', 'user-both')
  const directViewer = makeGrant(resources.session, 'viewer', 'user', 'user-both')
  assert.equal(can(user('user-both'), 'session.prompt', resources.session, [projectEditor, directViewer], NOW).allowed, true)

  const expiredProjectEditor = makeGrant(resources.project, 'editor', 'user', 'user-expired', NOW)
  assert.equal(can(user('user-expired'), 'session.prompt', resources.session, [expiredProjectEditor], NOW).allowed, false)

  const familyViewer = makeGrant(resources.project, 'viewer', 'group', 'family')
  assert.equal(can(user('user-family', 'member', ['family']), 'session.read', resources.session, [familyViewer], NOW).allowed, true)
  assert.equal(can(user('user-outside'), 'session.read', resources.session, [familyViewer], NOW).allowed, false)

  const projectLinkViewer = makeGrant(resources.project, 'viewer', 'link', 'link-inherited')
  const link = { kind: 'link', linkId: 'link-inherited' } as const
  assert.equal(can(link, 'session.read', resources.session, [projectLinkViewer], NOW).allowed, true)
  assert.equal(can(link, 'run.read', resources.run, [projectLinkViewer], NOW).allowed, true)
  assert.equal(can(link, 'session.prompt', resources.session, [projectLinkViewer], NOW).allowed, false)

  const otherProject = { ...makeGrant(resources.project, 'viewer', 'user', 'user-other'), resourceId: 'project-2' }
  assert.equal(can(user('user-other'), 'session.read', resources.session, [otherProject], NOW).allowed, false)

  const connectionWithParent: Resource = {
    ...resources.connection,
    parent: { type: 'project', id: resources.project.id },
  }
  assert.equal(can(viewer, 'connection.read', connectionWithParent, [projectViewer], NOW).allowed, false)
  assert.equal(can(viewer, 'connection.use', connectionWithParent, [projectViewer], NOW).allowed, false)
})

test('D-155: admins get only node/admin account capabilities and have no data override', () => {
  const resources = buildResources()
  const admin = user('user-admin', 'admin')
  const dataActions: Action[] = [
    'session.read', 'session.prompt', 'session.stop', 'session.share', 'session.delete',
    'project.read', 'project.write', 'project.share', 'project.delete',
    'connection.use', 'connection.read', 'connection.manage',
    'run.read', 'run.cancel',
  ]

  for (const type of RESOURCE_TYPES) {
    for (const action of dataActions) {
      assert.equal(can(admin, action, resources[type], [], NOW).allowed, false, `admin / ${type} / ${action}`)
    }
  }
  assert.equal(can(admin, 'node.admin', resources.node, [], NOW).allowed, true)
  assert.equal(can(admin, 'account.invite', resources.project, [], NOW).allowed, true)
  assert.equal(can(admin, 'account.ban', resources.session, [], NOW).allowed, true)
  assert.equal(can(admin, 'node.admin', resources.project, [], NOW).allowed, false)

  const ownedNode: Resource = { ...resources.node, id: 'node-owned', ownerUserId: 'user-node-owner' }
  assert.equal(can(user('user-node-owner'), 'node.admin', ownedNode, [], NOW).allowed, true)
  assert.equal(can(user('user-stranger'), 'node.admin', ownedNode, [], NOW).allowed, false)

  const viewerGrant = makeGrant(resources.session, 'viewer', 'user', 'user-admin')
  assert.equal(can(admin, 'session.read', resources.session, [viewerGrant], NOW).allowed, true)
  assert.equal(can(admin, 'session.prompt', resources.session, [viewerGrant], NOW).allowed, false)
  assert.equal(can(admin, 'session.share', resources.session, [viewerGrant], NOW).allowed, false)

  const ownSession: Resource = { ...resources.session, id: 'session-admin', ownerUserId: 'user-admin' }
  assert.equal(can(admin, 'session.read', ownSession, [], NOW).allowed, true)
  assert.equal(can(admin, 'session.prompt', ownSession, [], NOW).allowed, true)
})

test('D-154 as amended by D-190: editor prompts pay the owner only for allowed API-key/local shares', () => {
  const editor = user('user-editor')
  const owner = user(OWNER_ID)
  const shareCases: Array<{ name: string; share?: NonNullable<Resource['share']>; payer: 'owner' | 'actor' }> = [
    { name: 'api_key and owner pays', share: { ownerPaysForEditors: true, ownerConnectionKind: 'api_key' }, payer: 'owner' },
    { name: 'local and owner pays', share: { ownerPaysForEditors: true, ownerConnectionKind: 'local' }, payer: 'owner' },
    { name: 'subscription never pays', share: { ownerPaysForEditors: true, ownerConnectionKind: 'subscription' }, payer: 'actor' },
    { name: 'owner declined', share: { ownerPaysForEditors: false, ownerConnectionKind: 'api_key' }, payer: 'actor' },
    { name: 'no share configuration', payer: 'actor' },
  ]

  let index = 0
  for (const shareCase of shareCases) {
    const session: Resource = {
      type: 'session', id: `session-payer-${index++}`, ownerUserId: OWNER_ID,
      parent: { type: 'project', id: 'project-1' },
      ...(shareCase.share === undefined ? {} : { share: shareCase.share }),
    }
    const grant = makeGrant(session, 'editor', 'user', 'user-editor')
    const result = can(editor, 'session.prompt', session, [grant], NOW)
    assert.equal(result.allowed, true, shareCase.name)
    assert.equal(result.payer, shareCase.payer, shareCase.name)
  }

  const ownerSession: Resource = {
    type: 'session', id: 'session-owner-pays', ownerUserId: OWNER_ID,
    share: { ownerPaysForEditors: false, ownerConnectionKind: 'subscription' },
  }
  const ownerPrompt = can(owner, 'session.prompt', ownerSession, [], NOW)
  assert.equal(ownerPrompt.allowed, true)
  assert.equal(ownerPrompt.payer, 'owner')

  const inheritedSession: Resource = {
    type: 'session', id: 'session-inherited-pays', ownerUserId: OWNER_ID,
    parent: { type: 'project', id: 'project-1' },
    share: { ownerPaysForEditors: true, ownerConnectionKind: 'local' },
  }
  const projectEditor = makeGrant(buildResources().project, 'editor', 'user', 'user-editor')
  assert.equal(can(editor, 'session.prompt', inheritedSession, [projectEditor], NOW).payer, 'owner')

  const groupSession: Resource = {
    type: 'session', id: 'session-group-pays', ownerUserId: OWNER_ID,
    share: { ownerPaysForEditors: true, ownerConnectionKind: 'api_key' },
  }
  const groupGrant = makeGrant(groupSession, 'editor', 'group', 'editors')
  assert.equal(can(user('user-group', 'member', ['editors']), 'session.prompt', groupSession, [groupGrant], NOW).payer, 'owner')

  const viewerSession: Resource = {
    ...groupSession, id: 'session-viewer-denied',
  }
  const viewerGrant = makeGrant(viewerSession, 'viewer', 'user', 'user-viewer')
  const denied = can(user('user-viewer'), 'session.prompt', viewerSession, [viewerGrant], NOW)
  assert.equal(denied.allowed, false)
  assert.equal('payer' in denied, false)
})

test('D-190: subscription connections are owner-only and connection.use needs a direct grant', () => {
  const resources = buildResources()
  const subscription: Resource = {
    type: 'connection', id: 'connection-subscription', ownerUserId: OWNER_ID, connectionKind: 'subscription',
  }
  const apiKey: Resource = {
    type: 'connection', id: 'connection-api-key', ownerUserId: OWNER_ID, connectionKind: 'api_key',
  }

  assert.equal(can(user(OWNER_ID), 'connection.use', subscription, [], NOW).allowed, true)
  const subscriptionEditor = makeGrant(subscription, 'editor', 'user', 'user-editor')
  const editorUse = can(user('user-editor'), 'connection.use', subscription, [subscriptionEditor], NOW)
  assert.equal(editorUse.allowed, false)
  assert.equal(editorUse.reason, 'subscription_owner_only')
  const subscriptionOwnerGrant = makeGrant(subscription, 'owner', 'user', 'user-other')
  assert.equal(can(user('user-other'), 'connection.use', subscription, [subscriptionOwnerGrant], NOW).allowed, false)
  assert.equal(can(user('user-other'), 'connection.manage', subscription, [subscriptionOwnerGrant], NOW).allowed, false)
  assert.equal(can(user('user-admin', 'admin'), 'connection.use', subscription, [], NOW).allowed, false)

  const apiKeyEditor = makeGrant(apiKey, 'editor', 'user', 'user-editor')
  assert.equal(can(user('user-editor'), 'connection.use', apiKey, [apiKeyEditor], NOW).allowed, true)
  assert.equal(can(user('user-editor'), 'connection.manage', apiKey, [apiKeyEditor], NOW).allowed, false)
  const apiKeyOwnerGrant = makeGrant(apiKey, 'owner', 'user', 'user-other')
  assert.equal(can(user('user-other'), 'connection.use', apiKey, [apiKeyOwnerGrant], NOW).allowed, true)
  assert.equal(can(user('user-other'), 'connection.manage', apiKey, [apiKeyOwnerGrant], NOW).allowed, false)
  const apiKeyViewer = makeGrant(apiKey, 'viewer', 'user', 'user-viewer')
  assert.equal(can(user('user-viewer'), 'connection.use', apiKey, [apiKeyViewer], NOW).allowed, false)

  const connectionWithParent: Resource = { ...apiKey, id: 'connection-child', parent: { type: 'project', id: 'project-1' } }
  const projectEditor = makeGrant(resources.project, 'editor', 'user', 'user-project-editor')
  assert.equal(can(user('user-project-editor'), 'connection.use', connectionWithParent, [projectEditor], NOW).allowed, false)
})

test('non-finite and fractional expiry values are treated as expired', () => {
  const resources = buildResources()
  const subject = 'user-invalid-expiry'
  for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
    const grant = makeGrant(resources.session, 'viewer', 'user', subject, expiresAt)
    assert.equal(
      can(user(subject), 'session.read', resources.session, [grant], NOW).allowed,
      false,
      String(expiresAt),
    )
  }

  const live = makeGrant(resources.session, 'viewer', 'user', subject, NOW + 1)
  assert.equal(can(user(subject), 'session.read', resources.session, [live], NOW).allowed, true)
  const never = makeGrant(resources.session, 'viewer', 'user', subject, null)
  assert.equal(can(user(subject), 'session.read', resources.session, [never], NOW).allowed, true)
})

test('a granted owner relation is editor-level and only a real owner pays', () => {
  const grantedOwner = user('user-granted-owner')
  const subscriptionSession: Resource = {
    type: 'session', id: 'session-owner-grant-subscription', ownerUserId: OWNER_ID,
    share: { ownerPaysForEditors: true, ownerConnectionKind: 'subscription' },
  }
  const subscriptionGrant = makeGrant(subscriptionSession, 'owner', 'user', 'user-granted-owner')
  const prompt = can(grantedOwner, 'session.prompt', subscriptionSession, [subscriptionGrant], NOW)
  assert.equal(prompt.allowed, true)
  assert.equal(prompt.reason, 'editor')
  assert.equal(prompt.payer, 'actor')
  assert.equal(can(grantedOwner, 'session.read', subscriptionSession, [subscriptionGrant], NOW).allowed, true)
  assert.equal(can(grantedOwner, 'session.stop', subscriptionSession, [subscriptionGrant], NOW).allowed, true)
  assert.equal(can(grantedOwner, 'session.share', subscriptionSession, [subscriptionGrant], NOW).allowed, false)
  assert.equal(can(grantedOwner, 'session.delete', subscriptionSession, [subscriptionGrant], NOW).allowed, false)

  const apiKeySession: Resource = {
    ...subscriptionSession, id: 'session-owner-grant-api-key',
    share: { ownerPaysForEditors: true, ownerConnectionKind: 'api_key' },
  }
  const apiKeyGrant = makeGrant(apiKeySession, 'owner', 'user', 'user-granted-owner')
  const apiKeyPrompt = can(grantedOwner, 'session.prompt', apiKeySession, [apiKeyGrant], NOW)
  assert.equal(apiKeyPrompt.allowed, true)
  assert.equal(apiKeyPrompt.reason, 'editor')
  assert.equal(apiKeyPrompt.payer, 'owner')
})

test('permission snapshot equals the authorization matrix for the same inputs', () => {
  const resources = buildResources()
  const resourceList = RESOURCE_TYPES.map(type => resources[type])

  for (const matrixCase of buildCases(resources)) {
    const snapshot = permissionSnapshot(matrixCase.principal, resourceList, matrixCase.grants, NOW)
    assert.equal(snapshot.length, RESOURCE_TYPES.length, matrixCase.name)
    for (const [index, type] of RESOURCE_TYPES.entries()) {
      const entry = snapshot[index]!
      assert.equal(entry.resourceType, type, matrixCase.name)
      assert.equal(entry.resourceId, resources[type].id, matrixCase.name)
      assert.deepEqual(entry.actions, matrixCase.expected[type], `${matrixCase.name} / ${type}`)
    }
  }

  assert.deepEqual(permissionSnapshot(user('user-nobody'), [], [], NOW), [])
})
