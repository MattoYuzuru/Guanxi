import { parentPort, workerData } from 'node:worker_threads'
import { executeIndex } from './engine.ts'
import type { IndexWorkerData } from './types.ts'

const port = parentPort!
let next = 0
const pending = new Map<number, (allowed: boolean) => void>()
port.on('message', (message: { id: number; allowed: boolean }) => { pending.get(message.id)?.(message.allowed); pending.delete(message.id) })
const allow = (text: string): Promise<boolean> => new Promise(resolve => { const id = next++; pending.set(id, resolve); port.postMessage({ kind: 'check', id, text }) })
try {
  const result = await executeIndex(workerData as IndexWorkerData, allow)
  port.postMessage({ kind: 'result', result })
} catch {
  // File contents, root names and SQL errors must not enter worker diagnostics.
  port.postMessage({ kind: 'error', code: 'index_unavailable' })
} finally { port.close() }
