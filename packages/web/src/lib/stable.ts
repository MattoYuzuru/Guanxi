/**
 * Structural sharing for live data (D-203). A fresh read that equals what is on screen returns
 * the previous object, and unchanged subtrees keep their identity, so React bails out of
 * re-rendering untouched rows instead of repainting the view on every quiet refresh.
 */
export function replaceEqualDeep<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous
  if (Array.isArray(previous) && Array.isArray(next)) {
    // Rows with an id are matched by it, so an insert or a reorder keeps every unchanged row (P3).
    const key = rowKey(previous) ?? undefined
    const byKey = key && rowKey(next) === key
      ? new Map(previous.map(item => [(item as Record<string, unknown>)[key], item])) : null
    let equal = previous.length === next.length
    const merged = next.map((item, index) => {
      const match = byKey ? byKey.get((item as Record<string, unknown>)[key!]) : previous[index]
      const value = match !== undefined && (byKey || index < previous.length) ? replaceEqualDeep(match, item) : item
      if (value !== previous[index]) equal = false
      return value
    })
    return (equal ? previous : merged) as T
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousKeys = Object.keys(previous), nextKeys = Object.keys(next)
    let equal = previousKeys.length === nextKeys.length
    const merged: Record<string, unknown> = {}
    for (const key of nextKeys) {
      const value = key in previous ? replaceEqualDeep(previous[key], next[key]) : next[key]
      merged[key] = value
      if (!(key in previous) || value !== previous[key]) equal = false
    }
    return (equal ? previous : merged) as T
  }
  return next
}

const ROW_KEYS = ['id', 'sessionId', 'chatId', 'threadId', 'jobId'] as const

/** The id field every row carries with a unique string or number value, if there is one. */
function rowKey(rows: readonly unknown[]): string | null {
  if (rows.length === 0 || !rows.every(isPlainObject)) return null
  for (const key of ROW_KEYS) {
    const values = rows.map(row => (row as Record<string, unknown>)[key])
    if (values.every(value => typeof value === 'string' || typeof value === 'number') && new Set(values).size === values.length) return key
  }
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
