import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, chmod, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { connectionsPlugin, CONNECTIONS_SERVICE } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { bootServerKernel } from '../../src/runtime/kernel.ts'
import { openDb } from '../../src/store/db.ts'
import { externalAgentPlugin, EXTERNAL_AGENT_SERVICE, type ExternalAgentService } from '../../src/external-agents/plugin.ts'
import { ADAPTERS } from '../../src/external-agents/profiles.ts'
import { isolatedEnvironment } from '../../src/external-agents/process.ts'
import type { AgentInstallation, AdapterId, ExternalPolicy, RoleBinding } from '../../src/external-agents/types.ts'
import type { VaultKeychain } from '../../src/vault/keychain.ts'

export const owner = 'fixture-owner'
export const nodeId = 'fixture-node'
export const versions = { 'claude-code': '0.94.0', copilot: '1.0.101', 'gemini-cli': '0.65.0', opencode: '1.19.3', goose: '1.55.0', codex: '0.163.0' } as const
export async function fixture(t: TestContext, adapters: AdapterId[] = ['codex'], policy: Partial<ExternalPolicy> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k5-'))
  const db = openDb(join(dir, 'node.sqlite'))
  const kernel = await bootServerKernel(undefined, { db })
  const keychain: VaultKeychain = { key: () => Buffer.alloc(32, 7) }
  await kernel.node.plugin(connectionsPlugin, { databasePath: join(dir, 'connections.sqlite'), keychain: async () => keychain,
    localHost: () => 'http://127.0.0.1:11434', transport: async () => { throw new Error('Network forbidden') } })
  const connections = kernel.node.service<Connections>(CONNECTIONS_SERVICE)!
  const secret = `fixture_${randomBytes(24).toString('hex')}`
  kernel.scrubber.register('secret://fixture/registered', secret)
  const installations: AgentInstallation[] = []
  const bindings: RoleBinding[] = []
  const tapes = new Map<AdapterId, Record<string, unknown>>()
  for (const adapter of adapters) {
    const binaryDir = join(dir, adapter)
    await mkdir(binaryDir)
    const executable = join(binaryDir, 'fixture-agent.mjs')
    await writeFile(executable, `#!${process.execPath}\n` + await readFile(new URL('./fixture-process.mjs', import.meta.url), 'utf8'))
    await chmod(executable, 0o700)
    const tape = JSON.parse(await readFile(new URL(`./fixtures/${adapter}-${versions[adapter]}.json`, import.meta.url), 'utf8'))
    tapes.set(adapter, tape)
    const subscription = ADAPTERS[adapter].payment === 'subscription'
    const row = connections.create(owner, subscription ? { name: adapter, kind: 'agent', provider: adapter as 'codex', auth: 'cli_login' }
      : { name: adapter, kind: 'model_api', provider: adapter === 'gemini-cli' ? 'google' : 'openai', auth: 'api_key' })
    if (!subscription) { await connections.unlockVault(owner); connections.saveSecret(owner, row.id, secret) }
    const install: AgentInstallation = { adapter, connectionId: row.id, ownerAccountId: owner, nodeId, billingAccount: `${adapter}-account`,
      executable, version: versions[adapter], ...(adapter === 'claude-code' ? { claudeExecutable: executable } : {}) }
    installations.push(install)
    bindings.push({ backend: adapter, connectionId: row.id, model: adapter === 'opencode' ? 'openai/model-fixture' : 'model-fixture', params: {} })
    await writeFile(join(binaryDir, 'scenario.json'), JSON.stringify({ tape, secret }))
  }
  let plugin = await kernel.node.plugin(externalAgentPlugin, { dataDir: dir, policy: { nodeId, installations, ...policy } })
  let closed = false
  const close = async () => { if (closed) return; closed = true; await kernel.node.dispose(); db.close(); await rm(dir, { recursive: true, force: true }) }
  t.after(close)
  return { dir, kernel, connections, installations, bindings, secret, tapes, close,
    service: () => kernel.node.service<ExternalAgentService>(EXTERNAL_AGENT_SERVICE)!,
    async scenario(adapter: AdapterId, extra: Record<string, unknown>) {
      await rm(join(dir, adapter, 'trace.json'), { force: true })
      await writeFile(join(dir, adapter, 'scenario.json'), JSON.stringify({ tape: tapes.get(adapter), secret, ...extra }))
    },
    async trace(adapter: AdapterId) { return JSON.parse(await readFile(join(dir, adapter, 'trace.json'), 'utf8')) as Record<string, any>[] },
    async reload(changes: Partial<ExternalPolicy> = {}) {
      await plugin.dispose()
      plugin = await kernel.node.plugin(externalAgentPlugin, { dataDir: dir, policy: { nodeId, installations, ...policy, ...changes } })
    },
    async environment(adapter: AdapterId) { return JSON.parse(await readFile(join(dir, adapter, 'environment.json'), 'utf8')) },
    async config(adapter: AdapterId) { return isolatedEnvironment(dir, installations.find(i => i.adapter === adapter)!) },
  }
}
