import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveStatuses, nextReady } from '../../src/work/status.ts'
import type { EvidenceEvent, ItemSpec, PlanRevision } from '../../src/work/types.ts'

const AT = '2026-10-20T12:00:00.000Z'

function item(id: string, overrides: Partial<ItemSpec> = {}): ItemSpec {
  return {
    id,
    title: `Item ${id}`,
    acceptance: 'node --test',
    dependsOn: [],
    estimateMinutes: null,
    ownerRole: null,
    protectedPaths: [],
    ...overrides,
  }
}

function plan(items: ItemSpec[], revision = 1): PlanRevision {
  return { projectId: 'project', revision, createdAt: AT, author: 'user', items }
}

function claimed(itemId: string): EvidenceEvent {
  return { type: 'claimed', itemId, at: AT, source: 'agent:executor' }
}
function released(itemId: string): EvidenceEvent {
  return { type: 'released', itemId, at: AT, source: 'agent:executor' }
}
function verification(itemId: string): EvidenceEvent {
  return { type: 'verification_requested', itemId, at: AT, source: 'agent:executor' }
}
function acceptance(
  itemId: string,
  passed: boolean,
  cleanCheckout = true,
  commit = 'commit-1',
  command = 'node --test',
): EvidenceEvent {
  return {
    type: 'acceptance_result', itemId, at: AT, source: 'harness:acceptance',
    passed, cleanCheckout, commit, command,
  }
}
function commitAccepted(itemId: string, commit = 'commit-1'): EvidenceEvent {
  return { type: 'commit_accepted', itemId, at: AT, source: 'harness:commits', commit }
}
function human(itemId: string, decision: 'done' | 'reopen' | 'cancel'): EvidenceEvent {
  return { type: 'human_decision', itemId, at: AT, source: 'user:owner', decision }
}
function judge(itemId: string, verdict: 'pass' | 'fail' | 'escalate'): EvidenceEvent {
  return { type: 'judge_verdict', itemId, at: AT, source: 'harness:judge', verdict }
}
function proposed(spec: ItemSpec): EvidenceEvent {
  return { type: 'proposed', itemId: spec.id, at: AT, source: 'agent:planner', item: spec }
}
function accepted(itemId: string): EvidenceEvent {
  return { type: 'accepted', itemId, at: AT, source: 'lead:owner' }
}
function rejected(itemId: string): EvidenceEvent {
  return { type: 'rejected', itemId, at: AT, source: 'lead:owner' }
}

test('a planted done claim needs clean acceptance and an accepted commit', () => {
  const p = plan([item('a')])
  const claimAndClaimDone = [claimed('a'), verification('a')]
  let statuses = deriveStatuses(p, claimAndClaimDone)
  assert.equal(statuses.get('a')!.status, 'verification_requested')
  assert.equal(statuses.get('a')!.reason, 'verification_requested')

  const failing = [...claimAndClaimDone, acceptance('a', false)]
  statuses = deriveStatuses(p, failing)
  assert.equal(statuses.get('a')!.status, 'failed')
  assert.equal(statuses.get('a')!.reason, 'acceptance_failed')

  const dirtyPass = [...claimAndClaimDone, acceptance('a', true, false)]
  statuses = deriveStatuses(p, dirtyPass)
  assert.equal(statuses.get('a')!.status, 'verification_requested')
  assert.notEqual(statuses.get('a')!.status, 'done')

  const passWithoutCommit = [...claimAndClaimDone, acceptance('a', true, true, 'c1')]
  statuses = deriveStatuses(p, passWithoutCommit)
  assert.equal(statuses.get('a')!.status, 'verification_requested')
  assert.notEqual(statuses.get('a')!.status, 'done')

  const withCommit = [...passWithoutCommit, commitAccepted('a', 'c1')]
  statuses = deriveStatuses(p, withCommit)
  assert.equal(statuses.get('a')!.status, 'done')
  assert.equal(statuses.get('a')!.reason, 'acceptance_passed_clean_commit')
  assert.equal(statuses.get('a')!.evidence.length, 4)

  const laterFailure = [...withCommit, acceptance('a', false, true, 'c2')]
  statuses = deriveStatuses(p, laterFailure)
  assert.equal(statuses.get('a')!.status, 'failed')

  const reopened = [...laterFailure, human('a', 'reopen')]
  statuses = deriveStatuses(p, reopened)
  assert.equal(statuses.get('a')!.status, 'ready')
  assert.equal(statuses.get('a')!.reason, 'ready')

  statuses = deriveStatuses(p, [...reopened, claimed('a')])
  assert.equal(statuses.get('a')!.status, 'in_progress')
})

test('commit acceptance may arrive before the passing acceptance', () => {
  const p = plan([item('a')])
  const events = [claimed('a'), verification('a'), commitAccepted('a', 'c9'), acceptance('a', true, true, 'c9')]
  assert.equal(deriveStatuses(p, events).get('a')!.status, 'done')
})

test('a human reopen discards old acceptance evidence and a cancel is terminal until reopen', () => {
  const p = plan([item('a')])
  const done = [claimed('a'), verification('a'), acceptance('a', true), commitAccepted('a')]
  assert.equal(deriveStatuses(p, done).get('a')!.status, 'done')
  const reopened = deriveStatuses(p, [...done, human('a', 'reopen')])
  assert.equal(reopened.get('a')!.status, 'ready')
  assert.equal(reopened.get('a')!.reason, 'ready')

  const canceled = deriveStatuses(p, [claimed('a'), human('a', 'cancel')])
  assert.equal(canceled.get('a')!.status, 'canceled')
  assert.equal(canceled.get('a')!.reason, 'human_canceled')
  const stillCanceled = deriveStatuses(p, [claimed('a'), human('a', 'cancel'), claimed('a'), released('a')])
  assert.equal(stillCanceled.get('a')!.status, 'canceled')
  assert.equal(deriveStatuses(p, [human('a', 'cancel'), human('a', 'reopen')]).get('a')!.status, 'ready')
})

test('reopen requires fresh commit acceptance for the new attempt', () => {
  const p = plan([item('a')])
  const done = [claimed('a'), verification('a'), acceptance('a', true), commitAccepted('a')]
  const reopened = [...done, human('a', 'reopen'), claimed('a'), acceptance('a', true)]
  const statuses = deriveStatuses(p, reopened)
  assert.equal(statuses.get('a')!.status, 'in_progress')
  assert.notEqual(statuses.get('a')!.status, 'done')
  assert.equal(deriveStatuses(p, [...reopened, commitAccepted('a')]).get('a')!.status, 'done')
})

test('null acceptance can only be completed by a human decision', () => {
  const p = plan([item('a', { acceptance: null })])
  const events = [claimed('a'), verification('a'), acceptance('a', true), commitAccepted('a')]
  const statuses = deriveStatuses(p, events)
  assert.equal(statuses.get('a')!.status, 'verification_requested')
  assert.notEqual(statuses.get('a')!.status, 'done')
  assert.equal(deriveStatuses(p, [...events, human('a', 'done')]).get('a')!.status, 'done')
})

test('acceptance evidence only counts for the exact current acceptance command', () => {
  const wrongPass = [claimed('a'), acceptance('a', true, true, 'commit-1', 'true'), commitAccepted('a', 'commit-1')]
  let statuses = deriveStatuses(plan([item('a')]), wrongPass)
  assert.notEqual(statuses.get('a')!.status, 'done')
  assert.equal(statuses.get('a')!.status, 'in_progress')

  const wrongFailure = [claimed('a'), acceptance('a', false, true, 'commit-1', 'true')]
  statuses = deriveStatuses(plan([item('a')]), wrongFailure)
  assert.notEqual(statuses.get('a')!.status, 'failed')
  assert.equal(statuses.get('a')!.status, 'in_progress')

  const matching = [claimed('a'), acceptance('a', true), commitAccepted('a')]
  assert.equal(deriveStatuses(plan([item('a')], 1), matching).get('a')!.status, 'done')
  const revised = deriveStatuses(plan([item('a', { acceptance: 'npm run strict-gate' })], 2), matching)
  assert.notEqual(revised.get('a')!.status, 'done')
  assert.equal(revised.get('a')!.status, 'in_progress')
})

test('removing the acceptance command in a later revision reopens automatic proof', () => {
  const events = [claimed('a'), acceptance('a', true), commitAccepted('a')]
  const p = plan([item('a', { acceptance: null })], 2)
  const statuses = deriveStatuses(p, events)
  assert.notEqual(statuses.get('a')!.status, 'done')
  assert.equal(statuses.get('a')!.status, 'in_progress')
  assert.equal(deriveStatuses(p, [...events, human('a', 'done')]).get('a')!.status, 'done')
})

test('a later judge failure prevents done; a later claim does not clear a failure', () => {
  const p = plan([item('a')])
  const done = [claimed('a'), verification('a'), acceptance('a', true), commitAccepted('a')]
  assert.equal(deriveStatuses(p, [...done, judge('a', 'fail')]).get('a')!.status, 'failed')
  const failed = deriveStatuses(p, [claimed('a'), acceptance('a', false), claimed('a'), verification('a')])
  assert.equal(failed.get('a')!.status, 'failed')
  assert.equal(deriveStatuses(p, [claimed('a'), acceptance('a', false), judge('a', 'pass')]).get('a')!.status, 'in_progress')
})

test('dependencies gate readiness, claims and releases change ownership', () => {
  const p = plan([
    item('a'),
    item('b', { dependsOn: ['a'] }),
    item('c', { dependsOn: ['b'] }),
  ])
  let statuses = deriveStatuses(p, [])
  assert.equal(statuses.get('a')!.status, 'ready')
  assert.equal(statuses.get('b')!.status, 'blocked')
  assert.equal(statuses.get('c')!.status, 'blocked')
  assert.equal(statuses.get('b')!.reason, 'dependency_blocked')

  statuses = deriveStatuses(p, [claimed('b')])
  assert.equal(statuses.get('b')!.status, 'blocked')

  statuses = deriveStatuses(p, [claimed('a'), released('a')])
  assert.equal(statuses.get('a')!.status, 'ready')
  statuses = deriveStatuses(p, [claimed('a')])
  assert.equal(statuses.get('a')!.status, 'in_progress')

  statuses = deriveStatuses(p, [human('a', 'done')])
  assert.equal(statuses.get('a')!.status, 'done')
  assert.equal(statuses.get('b')!.status, 'ready')
  assert.equal(statuses.get('c')!.status, 'blocked')
})

test('proposals are proposed until accepted, rejected proposals leave the graph', () => {
  const p = plan([item('a')])
  const d = item('d', { title: 'Proposed D' })
  const e = item('e')
  const events: EvidenceEvent[] = [proposed(d), proposed(e), rejected('e')]
  let statuses = deriveStatuses(p, events)
  assert.equal(statuses.get('d')!.status, 'proposed')
  assert.equal(statuses.get('e'), undefined)
  assert.deepEqual(statuses.items.map(entry => entry.id), ['a', 'd'])
  assert.deepEqual(statuses.warnings, [])

  statuses = deriveStatuses(p, [proposed(d), accepted('d')])
  assert.equal(statuses.get('d')!.status, 'ready')
  assert.deepEqual(statuses.items.map(entry => entry.id), ['a', 'd'])

  const reAccepted = deriveStatuses(p, [proposed(e), rejected('e'), accepted('e')])
  assert.equal(reAccepted.get('e')!.status, 'ready')
  assert.deepEqual(reAccepted.items.map(entry => entry.id), ['a', 'e'])

  const duplicate = deriveStatuses(p, [proposed(d), proposed(d), accepted('d')])
  assert.deepEqual(duplicate.warnings, [{ itemId: 'd', type: 'proposed', reason: 'duplicate_proposal' }])
  assert.equal(duplicate.get('d')!.status, 'ready')
})

test('accepted proposals use plan-style dependency gating', () => {
  const p = plan([item('a')])
  const d = item('d', { dependsOn: ['a'] })
  const blocked = deriveStatuses(p, [proposed(d), accepted('d')])
  assert.equal(blocked.get('d')!.status, 'blocked')
  const ready = deriveStatuses(p, [proposed(d), accepted('d'), human('a', 'done')])
  assert.equal(ready.get('d')!.status, 'ready')
})

test('unknown item events are ignored and reported as warnings', () => {
  const p = plan([item('a')])
  const statuses = deriveStatuses(p, [
    claimed('ghost'),
    { type: 'judge_verdict', itemId: 'ghost', at: AT, source: 'harness:judge', verdict: 'fail' },
    accepted('never-proposed'),
  ])
  assert.equal(statuses.has('a'), true)
  assert.equal(statuses.get('a')!.status, 'ready')
  assert.equal(statuses.has('ghost'), false)
  assert.deepEqual(statuses.warnings, [
    { itemId: 'ghost', type: 'claimed', reason: 'unknown_item' },
    { itemId: 'ghost', type: 'judge_verdict', reason: 'unknown_item' },
    { itemId: 'never-proposed', type: 'accepted', reason: 'unknown_item' },
  ])
})

test('nextReady derives capacity from leases and permits, and review queues cap at three', () => {
  const p = plan([
    item('a'),
    item('b', { ownerRole: 'reviewer' }),
    item('c'),
    item('d', { ownerRole: 'reviewer' }),
    item('e', { ownerRole: 'reviewer' }),
    item('f', { dependsOn: ['a'] }),
  ])
  const statuses = deriveStatuses(p, [])
  assert.deepEqual(
    nextReady(statuses, p, { freeWorktreeLeases: 3, governorPermits: 2, inProgress: 1, reviewQueueByPerson: {} }).map(i => i.id),
    ['a'],
  )
  assert.deepEqual(
    nextReady(statuses, p, { freeWorktreeLeases: 1, governorPermits: 10, inProgress: 0, reviewQueueByPerson: {} }).map(i => i.id),
    ['a'],
  )
  assert.deepEqual(
    nextReady(statuses, p, { freeWorktreeLeases: 9, governorPermits: 9, inProgress: 0, reviewQueueByPerson: {} }).map(i => i.id),
    ['a', 'c'],
  )
  assert.deepEqual(
    nextReady(statuses, p, { freeWorktreeLeases: 9, governorPermits: 9, inProgress: 99, reviewQueueByPerson: { alice: 0 } }).map(i => i.id),
    [],
  )
  assert.deepEqual(
    nextReady(statuses, p, {
      freeWorktreeLeases: 9, governorPermits: 9, inProgress: 0,
      reviewQueueByPerson: { alice: 1, bob: 2 },
    }).map(i => i.id),
    ['a', 'b', 'c', 'd', 'e'],
  )
  assert.deepEqual(
    nextReady(statuses, p, {
      freeWorktreeLeases: 9, governorPermits: 9, inProgress: 0,
      reviewQueueByPerson: { alice: 3 },
    }).map(i => i.id),
    ['a', 'c'],
  )
  assert.deepEqual(
    nextReady(statuses, p, {
      freeWorktreeLeases: 9, governorPermits: 9, inProgress: 0,
      reviewQueueByPerson: { alice: 0 },
    }).map(i => i.id),
    ['a', 'b', 'c', 'd', 'e'],
  )
  assert.throws(
    () => nextReady(statuses, p, { freeWorktreeLeases: -1, governorPermits: 9, inProgress: 0, reviewQueueByPerson: {} }),
    /invalid_capacity/,
  )
})

test('nextReady includes accepted proposals after plan items', () => {
  const p = plan([item('a')])
  const d = item('d', { title: 'Proposal D' })
  const statuses = deriveStatuses(p, [proposed(d), accepted('d')])
  assert.deepEqual(
    nextReady(statuses, p, {
      freeWorktreeLeases: 5, governorPermits: 5, inProgress: 0, reviewQueueByPerson: {},
    }).map(entry => entry.id),
    ['a', 'd'],
  )
})
