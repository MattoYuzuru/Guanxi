/**
 * Structural sharing for live data (D-203). A fresh read that equals what is on screen returns
 * the previous object, and unchanged subtrees keep their identity, so React bails out of
 * re-rendering untouched rows instead of repainting the view on every quiet refresh.
 */
export function replaceEqualDeep<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous
  if (Array.isArray(previous) && Array.isArray(next)) {
    let equal = previous.length === next.length
    const merged = next.map((item, index) => {
      const value = index < previous.length ? replaceEqualDeep(previous[index], item) : item
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
