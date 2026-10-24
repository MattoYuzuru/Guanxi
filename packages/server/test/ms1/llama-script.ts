import { reply } from '../fixtures/fake-llama-server.ts'

/** The fake model of the MS1 rehearsal. It answers every relay prompt from the prompt text alone (the
 * function is serialised into the fake llama-server thread and cannot capture anything), so a replayed
 * or reordered call gets the same answer and no counter can drift between cycles.
 *
 * Per plan item and cycle: write `ms1-<item>.txt`, checkpoint it, re-verify every item up to it (a new head
 * reopens them all), hand off. After the first cycle the executor opens each cycle with five ledger probes;
 * the answer is read back from the handoff in the prompt. A narrative request gets a short fixed sentence. */
export const ms1Script = reply((prompt: string) => {
  // R3 J2: a strict, valid verdict that cites an evidence id every packet carries.
  if (prompt.startsWith('<|user|>\nAssess harness evidence only')) return '{"taxonomy":"progress","verdict":"consistent","evidenceRefs":["plan"],"diagnosisHint":"Evidence agrees."}'
  if (prompt.startsWith('<|user|>\nWrite a fresh')) return 'Continue with the next open item.'
  if (prompt.startsWith('<|user|>\nAnswer these five')) {
    const hash = /"ledgerHash":"([0-9a-f]{64})"/.exec(prompt)![1]
    const head = /"head":"([0-9a-f]{40,64})"/.exec(prompt)![1]
    const revision = /"revision":"([^"]+)"/.exec(prompt)![1]
    const strip = JSON.parse(prompt.split('\n').find(line => line.startsWith('{') && line.includes('"currentStatus"'))!) as { current: string | null; currentStatus: string | null }
    return JSON.stringify({ ledgerHash: hash, head, nextItem: strip.current, nextStatus: strip.currentStatus, revision })
  }
  if (!prompt.includes('"name":"file_write"')) {
    const current = /"current":"([^"]+)"/.exec(prompt)![1]!
    return JSON.stringify({ action: 'tool', name: 'file_write', args: { path: `ms1-${current}.txt`, content: `ms1-green-${current}` } })
  }
  if (!prompt.includes('"action":"checkpoint"')) return '{"action":"checkpoint"}'
  // A new head reopens every item, so each cycle re-proves all items up to the one it wrote, in plan order.
  const written = Number(/"path":"ms1-i(\d+)\.txt"/.exec(prompt)![1])
  const verified = new Set([...prompt.matchAll(/\{"action":"verify","item":"(i\d+)"\}/g)].map(m => m[1]))
  for (let n = 1; n <= written; n++) if (!verified.has(`i${n}`)) return JSON.stringify({ action: 'verify', item: `i${n}` })
  return '{"action":"handoff"}'
})
