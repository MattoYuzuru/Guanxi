import { createHash } from 'node:crypto'
import type { Handoff, Ledger, Note } from './types.ts'
import { invariant } from './types.ts'
import { bounded } from './budget.ts'

/** Stable object-key order, including the harness snapshot hashed at the boundary. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value)
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
export function byteHash(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
export function nextItem(l: Ledger): string | null {
  return l.plan.items.find(i => l.items[i.id] !== 'done' && i.dependsOn.every(d => l.items[d] === 'done'))?.id ?? null
}
export function strip(l: Ledger): string {
  const item = l.plan.items.find(i => i.id === nextItem(l))
  return bounded(canonical({ current: item?.id ?? null, title: item?.title, acceptance: item?.acceptance,
    next: l.plan.items.find(i => i.id !== item?.id && l.items[i.id] !== 'done')?.id ?? null,
    blocked: l.plan.items.filter(i => l.items[i.id] !== 'done' && i.dependsOn.some(d => l.items[d] !== 'done')).map(i => i.id), query: 'work.query' }), 300)
}
export function selectNotes(notes: Note[], ledger: Ledger, now: number, budget: number, lastK: number): Note[] {
  const decisions = new Set(notes.filter(n => n.kind === 'decision').slice(-lastK).map(n => n.id))
  const selected: Note[] = []
  for (const note of notes) {
    const linked = note.items.some(id => ledger.items[id] !== undefined && ledger.items[id] !== 'done')
    const liveDeadEnd = note.kind === 'dead_end' && (note.expiresAt === null || note.expiresAt > now)
    if (!linked && !decisions.has(note.id) && !liveDeadEnd) continue
    if (Buffer.byteLength(canonical([...selected, note])) <= budget) selected.push(note)
  }
  return selected
}
export function render(h: Handoff): string {
  return `# Guanxi handoff ${h.cycle}\n\nLedger: ${h.ledger.ref}\nSHA-256: ${h.ledgerHash}\nHEAD: ${h.ledger.head}\nRevision: ${h.ledger.revision}\nDegraded: ${h.degraded}\n\n${h.ledger.strip}\n\n${h.narrative}\n\n${canonical(h.notes)}\n`
}
export function probes(l: Ledger): Record<string, string | null> {
  return { ledgerHash: hash(l), head: l.head, revision: l.plan.revision, nextItem: nextItem(l), nextStatus: nextItem(l) ? l.items[nextItem(l)!]! : null }
}
export function validateHandoff(h: Handoff, ledger: Ledger, bundle: Uint8Array, max: number): void {
  invariant(h.format === 'guanxi.handoff/v1' && h.cycle === ledger.cycle && h.ledgerHash === hash(ledger), 'handoff_hash')
  invariant(h.ledger.head === ledger.head && h.ledger.revision === ledger.plan.revision && h.ledger.strip === strip(ledger), 'handoff_reference')
  invariant(h.notes.every(n => n.items.every(id => id in ledger.items)), 'handoff_reference')
  invariant(h.bundleHash === byteHash(bundle), 'bundle_hash')
  invariant(Buffer.byteLength(canonical(h)) <= max && Buffer.byteLength(render(h)) <= max, 'handoff_size')
}
