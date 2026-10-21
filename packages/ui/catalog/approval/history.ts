/**
 * The owner's decisions for one component as a ledger checked across committed history
 * (GPT N1, N8, N9). Node only. Every committed version of the record is validated like the
 * working tree is: signatures, status, and the chain between its decisions. Across versions:
 * - every signed decision roots in a null `previous` through decisions some committed version
 *   held (no unknown predecessor);
 * - a version keeps the owner's current decision (the ledger head) or replaces it with one
 *   that descends from it through `previous` links, so a review cycle of any length verifies
 *   and an older decision can never come back as the head;
 * - a deprecation stays until a newer signed decision supersedes it;
 * - removing the record, or the whole component folder, while it holds a decision or a
 *   deprecation fails.
 * A break in a committed version fails G12 for good: history cannot be repaired by restoring a
 * later version (recovery needs an owner-signed mechanism; DS2). Unsigned edits to `status`
 * (draft, review), `requests` and new deprecations stay allowed.
 */
import type { TrustedKey } from './keys.ts'
import type { ReviewDeprecation, ReviewRecord } from './record.ts'
import { decisionChain, signedDecisions, verifyRecordApproval, verifyRecordRevocation, type SignedDecision } from './verify.ts'

export type HistoryEntry =
  | { label: string; state: 'absent' }
  | { label: string; state: 'unreadable' }
  | { label: string; state: 'record'; record: ReviewRecord; trustedKeys: readonly TrustedKey[] }

/** What G12 reports for one version of a record, history or working tree alike. */
export function recordProblems(record: ReviewRecord, trustedKeys: readonly TrustedKey[]): string[] {
  const problems: string[] = []
  const verdict = verifyRecordApproval(record, trustedKeys)
  if (verdict.state === 'invalid') problems.push(`approval is invalid: ${verdict.reason}`)
  if (verifyRecordRevocation(record, trustedKeys).state === 'invalid') problems.push('revocation is invalid: bad_signature or untrusted_key')
  if ((record.deprecated ?? null) !== null && record.status !== 'deprecated') {
    problems.push(`a deprecated record must keep status "deprecated" (found "${record.status}")`)
  }
  return problems
}

const describe = (decision: SignedDecision) => `the signed ${decision.kind} of ${decision.at}`

/** One committed version in a record's history graph; `parents` name earlier nodes. */
export interface HistoryNode {
  id: string
  parents: string[]
  entry: HistoryEntry
}

interface LedgerState {
  head: { decision: SignedDecision; label: string } | null
  deprecation: { value: ReviewDeprecation; label: string } | null
}

/**
 * Checks each history graph (nodes in topological order: parents first) against the ledger
 * it builds. A node is checked against the merged state of all its parents, so decisions
 * committed on a merged side branch count exactly like those on the first-parent line (N8/N1):
 * a merge must keep or descend from every parent's current decision, and parents whose decision
 * histories diverge fail. Callers append the working tree as a node whose parents are the
 * graph's leaves. `skipOwnProblems` names the label whose record problems the caller reports
 * itself.
 */
export function verifyHistoryGraphs(graphs: HistoryNode[][], skipOwnProblems = 'the working tree'): string[] {
  const problems = new Set<string>()
  // Every validly signed decision any version holds: the graph `previous` links walk through.
  const known = new Map<string, SignedDecision>()
  for (const node of graphs.flat()) {
    const entry = node.entry
    if (entry.state === 'record') for (const decision of signedDecisions(entry.record, entry.trustedKeys)) known.set(decision.digest, decision)
  }
  const descends = (from: SignedDecision, target: string | null): boolean => {
    const seen = new Set<string>()
    for (let decision: SignedDecision | undefined = from; decision && !seen.has(decision.digest); decision = decision.previous ? known.get(decision.previous) : undefined) {
      if (decision.digest === target) return true
      seen.add(decision.digest)
      if (decision.previous === null) return target === null
    }
    return false
  }
  const combine = (states: LedgerState[], label: string): LedgerState => {
    const heads = states.flatMap((state) => (state.head ? [state.head] : []))
    let head = heads.find((candidate) => heads.every((other) => other.decision.digest === candidate.decision.digest || descends(candidate.decision, other.decision.digest))) ?? null
    if (!head && heads.length > 0) {
      problems.add(`${label} merges decision histories that diverge: ${heads.map((other) => `${describe(other.decision)} (${other.label})`).join(', ')}`)
      head = heads[0]!
    }
    const deprecations = states.flatMap((state) => (state.deprecation ? [state.deprecation] : []))
    const deprecation = deprecations.sort((a, b) => Date.parse(b.value.at) - Date.parse(a.value.at))[0] ?? null
    return { head, deprecation }
  }

  for (const nodes of graphs) {
    const states = new Map<string, LedgerState>()
    for (const node of nodes) {
      const parents = node.parents.flatMap((parent) => states.get(parent) ?? [])
      const state = combine(parents, node.entry.label)
      states.set(node.id, step(state, node.entry))
    }
  }
  return [...problems]

  /** The state after one version, recording its problems; a violation never resets the state. */
  function step(state: LedgerState, entry: HistoryEntry): LedgerState {
    let { head, deprecation } = state
    const holding = () => (head ? `${describe(head.decision)} (${head.label})` : `the deprecation of ${deprecation!.value.at} (${deprecation!.label})`)
    if (entry.state === 'absent') {
      if (head || deprecation) problems.add(`${entry.label} removes the review record, which holds ${holding()}`)
      return state
    }
    if (entry.state === 'unreadable') {
      if (head || deprecation) problems.add(`${entry.label} has an unreadable review record, which held ${holding()}`)
      return state
    }
    const { label, record, trustedKeys } = entry
    if (label !== skipOwnProblems) for (const problem of recordProblems(record, trustedKeys)) problems.add(`${label}: ${problem}`)
    const chain = decisionChain(record, trustedKeys)
    if (chain.state === 'unchained') {
      problems.add(`${label} holds signed decisions that do not chain to each other`)
      return state
    }
    const own = chain.state === 'chained' ? chain.head : null
    if (own && !descends(own, null)) {
      problems.add(`${label}: ${describe(own)} names a predecessor that no committed record holds`)
      return state
    }
    const before = head?.decision.digest ?? null
    if (head) {
      if (!own) problems.add(`${label} drops ${describe(head.decision)} (${head.label})`)
      else if (own.digest !== head.decision.digest && !descends(own, head.decision.digest)) {
        problems.add(`${label}: ${describe(own)} does not descend from the owner's current decision, ${describe(head.decision)} (${head.label})`)
      } else if (own.digest !== head.decision.digest) head = { decision: own, label }
    } else if (own) head = { decision: own, label }
    const current = record.deprecated ?? null
    if (deprecation && JSON.stringify(current) !== JSON.stringify(deprecation.value)) {
      const superseded = head !== null && head.decision.digest !== before && head.label === label && Date.parse(head.decision.at) > Date.parse(deprecation.value.at)
      if (superseded) deprecation = current ? { value: current, label } : null
      else problems.add(`${label} removes the deprecation of ${deprecation.value.at} (${deprecation.label}) without a newer signed decision`)
    } else if (!deprecation && current) deprecation = { value: current, label }
    return { head, deprecation }
  }
}

/** Linear sequences (oldest first): each version's parent is the one before it. */
export function verifyHistory(sequences: HistoryEntry[][], skipOwnProblems = 'the working tree'): string[] {
  return verifyHistoryGraphs(
    sequences.map((sequence) => sequence.map((entry, index) => ({ id: String(index), parents: index === 0 ? [] : [String(index - 1)], entry }))),
    skipOwnProblems,
  )
}
