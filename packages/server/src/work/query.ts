import {
  parseDerivedStatus, WorkError,
  type DerivedItem, type DerivedStatus, type DerivedStatuses, type EvidenceEvent,
  type ItemSpec, type PlanRevision,
} from './types.ts'

export interface QueryOptions {
  status?: DerivedStatus
  /** Opaque cursor returned by a previous page; it never encodes an offset into event state. */
  cursor?: string
  /** Omitted means the full graph; there is no hidden cap. */
  limit?: number
}

export interface QueryItem extends ItemSpec {
  status: DerivedStatus
  reason: string
  evidence: EvidenceEvent[]
}

export interface QueryPage {
  items: QueryItem[]
  nextCursor: string | null
  total: number
}

interface CursorPayload {
  v: 2
  id: string
  /** Stable graph creation order when the derivation supplied it. */
  o: number
  /** Positional fallback for plain maps without stable orders. */
  i: number
  m: 'o' | 'i'
  status: DerivedStatus | null
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): CursorPayload {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new WorkError('invalid_cursor', 'cursor is not valid base64url JSON')
  }
  if (value === null || typeof value !== 'object') throw new WorkError('invalid_cursor', 'cursor is not an object')
  const input = value as Record<string, unknown>
  if (input.v !== 2 || typeof input.id !== 'string'
    || !Number.isSafeInteger(input.o) || Number(input.o) < 0
    || !Number.isSafeInteger(input.i) || Number(input.i) < 0
    || (input.m !== 'o' && input.m !== 'i')) {
    throw new WorkError('invalid_cursor', 'cursor has an unsupported shape')
  }
  let status: DerivedStatus | null = null
  if (input.status !== null && input.status !== undefined) {
    try {
      status = parseDerivedStatus(input.status)
    } catch {
      throw new WorkError('invalid_cursor', 'cursor has an unsupported status')
    }
  }
  return { v: 2, id: input.id, o: Number(input.o), i: Number(input.i), m: input.m, status }
}

interface GraphEntry {
  item: ItemSpec
  index: number
  order: number
}

function graphEntries(plan: PlanRevision, statuses: ReadonlyMap<string, DerivedItem>): {
  entries: GraphEntry[]
  stable: boolean
} {
  const items = (statuses as Partial<DerivedStatuses>).items
  const orders = (statuses as Partial<DerivedStatuses>).orders
  const source = items !== undefined ? items : plan.items
  return {
    stable: items !== undefined && orders !== undefined,
    entries: source.map((item, index) => ({ item, index, order: orders?.[index] ?? index })),
  }
}

/**
 * Stable paging over the full graph, including accepted proposals and pending proposals.
 * The cursor stores the immutable item id plus its stable graph creation order (from
 * `deriveStatuses`) and a positional fallback. Rejected proposals disappear from the graph but
 * leave gaps in the order, so rejecting the cursor item or any earlier proposal cannot shift or
 * skip a later page. Appending evidence does not change any order.
 */
export function query(
  statuses: ReadonlyMap<string, DerivedItem>,
  plan: PlanRevision,
  options: QueryOptions = {},
): QueryPage {
  const filter = options.status === undefined ? null : parseDerivedStatus(options.status)
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new WorkError('invalid_paging', 'limit must be a positive integer')
  }
  const graph = graphEntries(plan, statuses)
  const decorated = graph.entries
    .map(entry => ({ ...entry, derived: statuses.get(entry.item.id) }))
    .filter((entry): entry is GraphEntry & { derived: DerivedItem } => entry.derived !== undefined)
  const matching = decorated.filter(entry => filter === null || entry.derived.status === filter)
  let remaining = matching
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor)
    if (cursor.status !== filter) throw new WorkError('cursor_mismatch', 'cursor belongs to a different status filter')
    if (cursor.m === 'o' && graph.stable) {
      remaining = matching.filter(entry => entry.order > cursor.o)
    } else {
      const at = graph.entries.findIndex(entry => entry.item.id === cursor.id)
      const start = at >= 0 ? at + 1 : Math.min(cursor.i, graph.entries.length)
      remaining = matching.filter(entry => entry.index >= start)
    }
  }
  const page = remaining.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = remaining.length > page.length && last !== undefined
    ? encodeCursor({
      v: 2, id: last.item.id, o: last.order, i: last.index,
      m: graph.stable ? 'o' : 'i', status: filter,
    })
    : null
  return {
    items: page.map(entry => ({
      ...entry.item,
      status: entry.derived.status,
      reason: entry.derived.reason,
      evidence: entry.derived.evidence,
    })),
    nextCursor,
    total: matching.length,
  }
}
