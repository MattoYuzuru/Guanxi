/** Operator-only live smoke. Never included in automated tests. */
import { randomUUID } from 'node:crypto'
import { start } from '../src/index.ts'
import { chatModelsResponse, parseChatModelSelection, providerCatalog, threadSchema, connectionSnapshotSchema } from '@guanxi/contract'

let node: Awaited<ReturnType<typeof start>> | undefined
try {
  const file = process.argv[2]
  const provider = process.argv[3] ?? 'deepseek'
  if (!file || !process.env.GUANXI_DATA_DIR) throw new Error('Explicit file and isolated data directory required')
  node = await start({ providerKeysFile: file })
  const signal = AbortSignal.timeout(120_000)
  const json = async (path: string, body?: unknown) => {
    const response = await fetch(`${node!.url}${path}`, { signal, ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) })
    if (!response.ok) throw new Error('Smoke request failed')
    return response.json()
  }
  const groups = chatModelsResponse.parse(await json('/api/threads/models')).groups
  const label = providerCatalog.find(item => item.provider === provider)?.label ?? provider
  const group = groups.find(item => item.label === label)
  const model = group?.models.find(item => item.modelId === 'deepseek-chat') ?? group?.models[0]
  if (!model) throw new Error('Imported provider has no usable model')
  const thread = threadSchema.parse(await json('/api/threads', { mode: 'chat', model: model.selection }))
  const response = await fetch(`${node.url}/api/threads/${thread.id}/messages`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Name the harness you run inside in one short sentence.', idempotencyKey: randomUUID() }) })
  const stream = await response.text()
  if (!response.ok || !stream.includes('"outcome":"completed"')) throw new Error('Provider turn failed')
  const costs = connectionSnapshotSchema.parse(await json('/api/connections')).costs
  const receipt = costs.find(item => item.connectionId === parseChatModelSelection(model.selection)!.connectionId)
  if (!receipt) throw new Error('Usage receipt missing')
  console.log(JSON.stringify({ ok: true, threadId: thread.id, connectionId: receipt.connectionId,
    inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, costUsd: receipt.costUsd, source: receipt.source }))
} catch {
  console.error('Provider Chat live smoke failed; check the isolated node and Connections settings')
  process.exitCode = 1
} finally { await node?.close() }
