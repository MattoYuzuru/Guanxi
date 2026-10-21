import { parentPort, workerData } from 'node:worker_threads'
import { executeIndex } from './engine.ts'
import type { IndexWorkerData } from './types.ts'

let next = 0
const pending = new Map<number, (allowed: boolean) => void>()
const send = (message: unknown) => parentPort ? parentPort.postMessage(message) : process.send?.(message)
const allow = (text: string): Promise<boolean> => new Promise(resolve => { const id = next++; pending.set(id, resolve); send({ kind: 'check', id, text }) })
const receive = (message: { id: number; allowed: boolean }) => { pending.get(message.id)?.(message.allowed); pending.delete(message.id) }
async function run(data: IndexWorkerData) {
  try { send({ kind: 'result', result: await executeIndex(data, allow) }) }
  catch { send({ kind: 'error', code: 'index_unavailable' }) }
  finally { if (parentPort) parentPort.close(); else process.disconnect?.() }
}
if (parentPort) { parentPort.on('message', receive); await run(workerData) }
else {
  process.on('message', receive)
  process.once('message', (message: { data: IndexWorkerData }) => { void run(message.data) })
}
