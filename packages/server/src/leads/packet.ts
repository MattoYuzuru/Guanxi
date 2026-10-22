import { LEAD_WAKE_FORMAT, leadWakePacketSchema, type LeadWakePacket } from '@guanxi/contract'
import type { EgressScrubber } from '../egress/types.ts'
import { LeadError, type ChildReport } from './types.ts'

/** ADR-0019 decision 8: about 4k tokens. The count is a deliberately conservative upper
 * bound (three UTF-8 bytes per token), not a tokenizer of any particular lead model. */
export const DEFAULT_PACKET_TOKENS = 4_000
export const tokensOf = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 3)

export interface PacketInput {
  runId: string
  wakeSeq: number
  kind: LeadWakePacket['kind']
  outcome: LeadWakePacket['outcome']
  child: LeadWakePacket['child']
  report: ChildReport | null
  /** Other unresolved children of this lead, for drill-down only. */
  pendingChildren: readonly string[]
}

const clip = (text: string, max: number): string => {
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, Math.max(0, max - 1)).join('') + '…'
}
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function renderWakePacket(packet: LeadWakePacket): string {
  const lines = [`${packet.format} wake=${packet.wakeSeq} kind=${packet.kind} run=${packet.runId}`,
    `outcome: ${packet.outcome}`,
    `child: ${packet.child.runId} state=${packet.child.state} attempts=${packet.child.attempts}`]
  for (const cost of packet.child.costs) lines.push(`child cost: ${cost.currency} in=${cost.inputTokens} out=${cost.outputTokens} microunits=${cost.costMicrounits ?? 'unknown'}`)
  lines.push(`metrics: cycles=${packet.metrics.cycles ?? 'unknown'} tokens=${packet.metrics.tokens ?? 'unknown'} microunits=${packet.metrics.moneyMicros ?? 'unknown'}`)
  if (packet.head) lines.push(`head: ${packet.head}`)
  if (packet.handoff) lines.push(`handoff: ${packet.handoff.ref}${packet.handoff.cycle === null ? '' : ` cycle=${packet.handoff.cycle}`}`)
  if (packet.items.length) lines.push('items:', ...packet.items.map(item => `- ${item.id} [${item.status}] ${item.title}`))
  if (packet.gates.length) lines.push('gates:', ...packet.gates.map(gate => `- ${gate.item} ok=${gate.ok} @${gate.head}${gate.output ? ` ${gate.output}` : ''}`))
  if (packet.diffstat) lines.push(`diffstat: ${packet.diffstat}`)
  if (packet.narrative) lines.push(`narrative: ${packet.narrative}`)
  if (packet.openQuestions.length) lines.push('open questions:', ...packet.openQuestions.map(question => `- ${question}`))
  if (packet.drilldown.length) lines.push(`drill-down: ${packet.drilldown.map(ref => `${ref.kind}:${ref.id}`).join(' ')}`)
  if (packet.truncated.length) lines.push(`truncated: ${packet.truncated.join(',')}`)
  return lines.join('\n')
}

/** Builds the only thing a hibernated lead learns about its child. Report fields are scrubbed
 * BEFORE any clipping, so a cut can never leave a prefix of a registered value; the finished
 * packet is scrubbed and parsed again. Reductions are ordered, recorded and deterministic. */
export function buildWakePacket(input: PacketInput, scrubber: EgressScrubber, maxTokens = DEFAULT_PACKET_TOKENS): { packet: LeadWakePacket; text: string; tokens: number } {
  const report = scrubber.scrub(input.report)
  const truncated: string[] = []
  const draft: LeadWakePacket = {
    format: LEAD_WAKE_FORMAT, runId: input.runId, wakeSeq: input.wakeSeq, kind: input.kind, outcome: input.outcome, child: input.child,
    items: (report?.items ?? []).map(item => ({ id: item.id, title: oneLine(clip(item.title, 200)), status: item.status })),
    gates: (report?.gates ?? []).map(gate => ({ item: gate.item, ok: gate.ok, head: clip(gate.head, 12), output: oneLine(clip(gate.output, 400)) })),
    head: report?.head ?? null, diffstat: oneLine(clip(report?.diffstat ?? '', 800)),
    handoff: report?.handoff ?? null, narrative: oneLine(clip(report?.narrative ?? '', 1_500)),
    openQuestions: (report?.openQuestions ?? []).slice(0, 10).map(question => oneLine(clip(question, 300))),
    metrics: report?.metrics ?? { cycles: null, tokens: null, moneyMicros: null },
    drilldown: [{ kind: 'run' as const, id: input.child.runId }, ...input.pendingChildren.filter(id => id !== input.child.runId).map(id => ({ kind: 'run' as const, id })),
      ...(report?.handoff ? [{ kind: 'handoff' as const, id: report.handoff.ref }] : [])],
    truncated,
  }
  if ((report?.openQuestions.length ?? 0) > 10) truncated.push(`openQuestions:+${report!.openQuestions.length - 10}`)
  const fits = () => tokensOf(renderWakePacket(scrubber.scrub(draft))) <= maxTokens
  const steps: [string, () => void][] = [
    ['gates.output:120', () => { for (const gate of draft.gates) gate.output = clip(gate.output, 120) }],
    ['gates.output:0', () => { for (const gate of draft.gates) gate.output = '' }],
    ['narrative:400', () => { draft.narrative = clip(draft.narrative, 400) }],
    ['diffstat:300', () => { draft.diffstat = clip(draft.diffstat, 300) }],
    ['openQuestions:3', () => { draft.openQuestions = draft.openQuestions.slice(0, 3).map(question => clip(question, 120)) }],
    ['items.title:80', () => { for (const item of draft.items) item.title = clip(item.title, 80) }],
    ['narrative:0', () => { draft.narrative = '' }],
    ['diffstat:0', () => { draft.diffstat = '' }],
    ['openQuestions:0', () => { draft.openQuestions = [] }],
    ['gates:failed-only', () => { draft.gates = draft.gates.filter(gate => !gate.ok) }],
    ['drilldown:2', () => { draft.drilldown = draft.drilldown.slice(0, 2) }],
  ]
  for (const [label, apply] of steps) {
    if (fits()) break
    apply(); truncated.push(label)
  }
  // Last resort keeps outcome and status counts: halve the item and gate lists until it fits.
  while (!fits() && (draft.items.length > 1 || draft.gates.length > 0)) {
    const dropped = Math.ceil(draft.items.length / 2)
    truncated.push(`items:-${dropped}`)
    draft.items = draft.items.slice(0, draft.items.length - dropped)
    draft.gates = draft.gates.filter(gate => draft.items.some(item => item.id === gate.item)).slice(0, draft.items.length)
  }
  const packet = leadWakePacketSchema.parse(scrubber.scrub(draft))
  const text = renderWakePacket(packet)
  if (tokensOf(text) > maxTokens) throw new LeadError('wake_packet_too_large')
  return { packet, text, tokens: tokensOf(text) }
}
