import { parentPort, workerData } from 'node:worker_threads'
import { executeIndex } from './engine.ts'
import type { IndexWorkerData } from './types.ts'

let next = 0
const pending = new Map<number, (allowed: boolean) => void>()
const send = (message: unknown) => parentPort ? parentPort.postMessage(message) : process.send?.(message)
/** The server sends the registered values over IPC at build start, so this
 * hot loop never scrubs secret values on the server's main thread. */
const formsOf = (value: string): string[] => {
  const forms = new Set<string>([value])
  forms.add(JSON.stringify(value).slice(1, -1))
  try { forms.add(encodeURIComponent(value)) } catch { /* lone surrogate */ }
  return [...forms].filter(form => form.length > 0)
}
const marker = (ref: string) => `\u27E6REDACTED ${ref}\u27E7`
function scrubber(secrets: IndexWorkerData['secrets'] = []) {
  const forms = secrets.flatMap(({ ref, value }) => formsOf(value).map(text => ({ text, ref })))
  // Longest form first; the trusted parent re-scrubs the final result with the
  // canonical K2 implementation.
  forms.sort((a, b) => b.text.length - a.text.length)
  const text = (value: string) => {
    let output = value
    for (const form of forms) if (output.includes(form.text)) output = output.split(form.text).join(marker(form.ref))
    return output
  }
  const any = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(any)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), any(item)]))
    return value
  }
  return { text, any }
}
const check = (): Promise<boolean> => new Promise(resolve => { const id = next++; pending.set(id, resolve); send({ kind: 'check', id }) })
const receive = (message: { id: number; allowed: boolean }) => { pending.get(message.id)?.(message.allowed); pending.delete(message.id) }
async function run(data: IndexWorkerData) {
  const scrub = scrubber(data.secrets)
  const allow = async (value: string): Promise<boolean> => {
    if (data.request.kind === 'build' && !(await check())) throw new Error('index_secret_changed')
    return scrub.text(value) === value
  }
  const checkpoint = async () => { if (data.request.kind === 'build' && !(await check())) throw new Error('index_secret_changed') }
  try { send({ kind: 'result', result: scrub.any(await executeIndex(data, allow, checkpoint)) }) }
  catch (error) { send({ kind: 'error', code: error instanceof Error && /^index_[a-z_]+$/.test(error.message) ? error.message : 'index_unavailable' }) }
  finally { if (parentPort) parentPort.close(); else process.disconnect?.() }
}
if (parentPort) { parentPort.on('message', receive); await run(workerData) }
else {
  process.on('message', receive)
  process.once('message', (message: { data: IndexWorkerData }) => { void run(message.data) })
}
