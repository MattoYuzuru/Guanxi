import {
  DERIVED_STATUSES,
  type DerivedItem, type DerivedStatus, type DerivedStatuses, type EvidenceEvent,
  type ItemSpec, type PlanRevision,
} from './types.ts'

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

function inlineCode(value: string): string {
  const clean = oneLine(value)
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${clean}${fence}`
}

function eventSummary(event: EvidenceEvent): string {
  switch (event.type) {
    case 'acceptance_result':
      return `passed=${String(event.passed)} cleanCheckout=${String(event.cleanCheckout)} commit=${inlineCode(event.commit)} command=${inlineCode(event.command)}`
    case 'commit_accepted':
      return `commit=${inlineCode(event.commit)}`
    case 'judge_verdict':
      return `verdict=${event.verdict}`
    case 'human_decision':
      return `decision=${event.decision}`
    case 'proposed':
      return `item=${inlineCode(event.item.id)}`
    default:
      return ''
  }
}

function itemSection(
  item: ItemSpec,
  derived: DerivedItem,
): string[] {
  const lines = [
    `### [${derived.status}] ${inlineCode(item.id)} — ${oneLine(item.title)}`,
    '',
    `- Acceptance: ${item.acceptance === null ? 'none (human decision only)' : inlineCode(item.acceptance)}`,
    `- Depends on: ${item.dependsOn.length === 0 ? 'none' : item.dependsOn.map(inlineCode).join(', ')}`,
    `- Estimate: ${item.estimateMinutes === null ? 'not estimated' : `${item.estimateMinutes} min`}`,
    `- Owner role: ${item.ownerRole ?? 'unassigned'}`,
    `- Protected paths: ${item.protectedPaths.length === 0 ? 'none' : item.protectedPaths.map(inlineCode).join(', ')}`,
    `- Reason: ${inlineCode(derived.reason)}`,
  ]
  if (derived.evidence.length === 0) {
    lines.push('- Evidence: none')
  } else {
    lines.push('- Evidence:')
    for (const event of derived.evidence) {
      const detail = eventSummary(event)
      lines.push(`  - ${inlineCode(event.type)} at ${inlineCode(String(event.at))} from ${inlineCode(event.source)}${detail === '' ? '' : `: ${detail}`}`)
    }
  }
  lines.push('')
  return lines
}

/**
 * Markdown projection for `.guanxi/work/*.md` (D-174). Pure string construction: the caller
 * decides whether and where to write it; this function never touches the filesystem.
 */
export function exportMarkdown(plan: PlanRevision, statuses: ReadonlyMap<string, DerivedItem>): string {
  const graph = (statuses as Partial<DerivedStatuses>).items ?? plan.items
  const items = graph
    .map(item => ({ item, derived: statuses.get(item.id) }))
    .filter((entry): entry is { item: ItemSpec; derived: DerivedItem } => entry.derived !== undefined)
  const counts = new Map<DerivedStatus, number>(DERIVED_STATUSES.map(status => [status, 0]))
  for (const entry of items) counts.set(entry.derived.status, (counts.get(entry.derived.status) ?? 0) + 1)
  const lines = [
    `# Work ledger — ${oneLine(plan.projectId)}`,
    '',
    `Revision ${plan.revision} · ${plan.author} · ${oneLine(plan.createdAt)}`,
    '',
    'Status is derived from evidence; an agent request is not completion.',
    '',
    '## Summary',
    '',
    ...DERIVED_STATUSES.map(status => `- ${status}: ${counts.get(status) ?? 0}`),
    '',
    '## Items',
    '',
  ]
  if (items.length === 0) {
    lines.push('No items in this revision.', '')
  } else {
    for (const entry of items) lines.push(...itemSection(entry.item, entry.derived))
  }
  const warnings = (statuses as Partial<DerivedStatuses>).warnings ?? []
  if (warnings.length > 0) {
    lines.push('## Warnings', '')
    for (const warning of warnings) {
      lines.push(`- ${inlineCode(warning.itemId)}: ${warning.reason} (${inlineCode(warning.type)})`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
