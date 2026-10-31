/** The production boot (`start()` wired from the home's `lead` section) gives the lead the node-served project view only when `home.lead.projectView` is true
 * (opt-in, lead default 2026-10-31). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLiveWorld } from './live-world.ts'

const HOUR = 3_600_000

test('with `home.lead.projectView: true` the production boot gives the lead a read-only view of the registered project: the commit it reports is the base, secrets and traversal are refused, and each call is audited', async t => {
  const w = await createLiveWorld(t, { lead: true })
  await w.registerProject()
  w.patchHome(config => { config.home.lead.projectView = true })
  const connectionId = w.home.find('started')!['connectionId']
  const brief = { objective: 'Produce one green artifact per item', definitionOfDone: ['every item gate is green in a clean checkout'],
    plan: { revision: 'r1', base: w.base, goal: 'Write ms1-<item>.txt for each item and prove it.', protectedPaths: [],
      items: [{ id: 'i1', title: 'artifact i1', dependsOn: [], acceptance: ['grep', '-q', 'ms1-green-i1', 'ms1-i1.txt'], protectedPaths: [] }] },
    caps: { cycles: 40, tokens: 2_000_000, moneyMicros: 500_000, wallMs: 12 * HOUR }, executor: { connectionId, model: 'fixture' },
    deadlineMs: 8 * HOUR, onDeadline: 'wrap_up', onCancel: 'cancel' }
  const calls = [{ name: 'guanxi_project_tree', arguments: {} }, { name: 'guanxi_project_read', arguments: { path: 'README.md' } },
    { name: 'guanxi_project_read', arguments: { path: '.env' } }, { name: 'guanxi_project_read', arguments: { path: '../outside' } },
    { name: 'guanxi_project_search', arguments: { text: 'fixture project' } }]
  const started = await w.restartHomeWithLead(brief, 'Make the fixture project green', { projectCalls: calls })
  await w.home.wait('lead-first', 90_000)
  const events = w.agentEvents()
  assert.deepEqual(events.find(e => e.event === 'tool_list')!['tools'], ['guanxi_delegate', 'guanxi_project_tree', 'guanxi_project_read', 'guanxi_project_search'])
  const answers = events.filter(e => e.event === 'project_answer')
  assert.equal(answers.length, 5)
  const tree = JSON.parse(answers[0]!['text'])
  assert.equal(tree.commit, w.base, 'the commit the tools report is the one the relay will clone')
  assert.deepEqual(tree.entries, [{ path: 'README.md', type: 'file', size: 'MS1 live fixture project\n'.length }])
  assert.equal(JSON.parse(answers[1]!['text']).text, 'MS1 live fixture project\n')
  assert.deepEqual([answers[2]!['isError'], answers[2]!['text']], [true, 'path_denied'])
  assert.deepEqual([answers[3]!['isError'], answers[3]!['text']], [true, 'path_invalid'])
  assert.equal(JSON.parse(answers[4]!['text']).matches[0].path, 'README.md')
  const audited = w.home.rows<{ payload: string }>("SELECT payload FROM session_events WHERE session_id=? AND type='agent.note' ORDER BY seq", started['runId'])
    .map(row => { try { return (JSON.parse((JSON.parse(row.payload) as { text: string }).text) as { lead?: Record<string, unknown> }).lead } catch { return undefined } })
    .filter(note => note?.['action'] === 'project_view')
  assert.deepEqual(audited.map(note => note!['outcome']), ['ok', 'ok', 'path_denied', 'path_invalid', 'ok'])
})

test('by default the production boot gives the lead no project tools: they are not listed and a call to one is refused', async t => {
  const w = await createLiveWorld(t, { lead: true })
  await w.registerProject()
  const connectionId = w.home.find('started')!['connectionId']
  const brief = { objective: 'Produce one green artifact', definitionOfDone: ['the item gate is green in a clean checkout'],
    plan: { revision: 'r1', base: w.base, goal: 'Write ms1-i1.txt and prove it.', protectedPaths: [],
      items: [{ id: 'i1', title: 'artifact i1', dependsOn: [], acceptance: ['grep', '-q', 'ms1-green-i1', 'ms1-i1.txt'], protectedPaths: [] }] },
    caps: { cycles: 40, tokens: 2_000_000, moneyMicros: 500_000, wallMs: 12 * HOUR }, executor: { connectionId, model: 'fixture' },
    deadlineMs: 8 * HOUR, onDeadline: 'wrap_up', onCancel: 'cancel' }
  const started = await w.restartHomeWithLead(brief, 'Make the fixture project green', { projectCalls: [{ name: 'guanxi_project_read', arguments: { path: 'README.md' } }] })
  await w.home.wait('lead-first', 90_000)
  const events = w.agentEvents()
  assert.deepEqual(events.find(e => e.event === 'tool_list')!['tools'], ['guanxi_delegate'])
  const answer = events.find(e => e.event === 'project_answer')!
  assert.equal(answer['isError'], false); assert.equal(answer['error'], 'unknown_tool'); assert.equal(answer['text'], null)
  const audited = w.home.rows<{ payload: string }>("SELECT payload FROM session_events WHERE session_id=? AND type='agent.note'", started['runId']).filter(row => row.payload.includes('project_view'))
  assert.deepEqual(audited, [])
})
