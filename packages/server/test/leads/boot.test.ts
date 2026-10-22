import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { start } from '../../src/index.ts'
import { LEAD_SERVICE, type LeadHostService } from '../../src/leads/plugin.ts'
import { DURABLE_RUNS_SERVICE, type DurableRunsService } from '../../src/runs/plugin.ts'
import type { ChildStarter } from '../../src/leads/types.ts'

const child: ChildStarter = { start: () => ({ done: new Promise<void>(() => undefined) }), stop: () => undefined }
async function boot(t: { after(fn: () => unknown): void }, options: Parameters<typeof start>[0] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-lw-boot-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, devOrigins: [], ...options })
  t.after(() => server.close())
  return server
}

test('the default server loads no lead service, no tool endpoint and never asserts an always-on home', async t => {
  const server = await boot(t)
  assert.equal(server.kernel.node.service(LEAD_SERVICE), undefined)
  assert.equal(server.kernel.node.service<DurableRunsService>(DURABLE_RUNS_SERVICE)!.store.alwaysOnHome, false)
  assert.equal(server.context.db.prepare("SELECT name FROM sqlite_master WHERE name='lead_migrations'").get(), undefined, 'no ledger without opt-in')
})

test('leads are opt-in, need the external-agent policy and carry the explicit always-on assertion', async t => {
  await assert.rejects(boot(t, { leads: { alwaysOn: true, child } }), /leads require externalAgents/)
  const server = await boot(t, { externalAgents: { nodeId: 'boot-node', installations: [] }, leads: { alwaysOn: true, child, tickMs: 2_000_000_000 } })
  const lead = server.kernel.node.service<LeadHostService>(LEAD_SERVICE)!
  assert.deepEqual(lead.health(), { failure: null })
  assert.deepEqual(lead.sessions(), [])
  assert.equal(server.kernel.node.service<DurableRunsService>(DURABLE_RUNS_SERVICE)!.store.alwaysOnHome, true)
  assert.equal(server.context.db.prepare('SELECT version FROM lead_migrations').get()!.version, 40)
  // Loading starts no inference and no listener: a lead exists only after startLead.
  assert.throws(() => lead.startLead({ ownerAccountId: 'o', actorAccountId: 'o', projectId: 'p', prompt: 'x' }), /role_unassigned/)
})
