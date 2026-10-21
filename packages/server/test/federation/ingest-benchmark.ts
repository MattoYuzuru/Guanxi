/** Isolated timing fixture: the parent can terminate a regressed synchronous ingest. */
import { parentPort } from 'node:worker_threads'
import type { SignedConfigOperation } from '@guanxi/contract/federation'
import { signValue } from '../../src/federation/crypto.ts'
import { SimNode, identity } from './harness.ts'

export function history(author: SimNode, count: number): SignedConfigOperation[] {
  return Array.from({ length: count }, (_, index) => {
    const operation = { origin: author.keys.identity.id, accountId: author.keys.identity.accountId,
      counter: index + 1, context: { [author.keys.identity.id]: index },
      clock: { wall: author.time, logical: index }, key: `k${index}`,
      value: { kind: 'setting' as const, value: index } }
    return { operation, signature: signValue(author.keys.privateKey, operation) }
  })
}
if (parentPort) {
  const author = new SimNode(identity('author')); const receiver = new SimNode(identity('receiver'))
  try {
    receiver.trust(author)
    const operations = history(author, 1_000).reverse()
    parentPort.postMessage({ ready: true })
    const start = performance.now()
    const result = receiver.federation.config.ingest(operations)
    parentPort.postMessage({ elapsed: performance.now() - start, result })
  } finally { author.close(); receiver.close() }
}
