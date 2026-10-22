import type { StripBlockingIssue, StripView, StripWorkItem } from './types.ts'

/**
 * Conservative default: UTF-8 bytes. For common BPE/byte-level tokenizers a token is never
 * larger than its UTF-8 representation, so a byte budget does not overflow a token budget.
 * The injected counter remains authoritative; this is only a safe fallback.
 */
export function utf8ByteCounter(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

interface State {
  header: string
  current: StripWorkItem | null
  currentTitle: string | null
  acceptance: string | null
  next: StripWorkItem | null
  nextTitle: string | null
  blocking: StripBlockingIssue[]
}

function render(state: State): string {
  const lines = [state.header]
  if (state.current !== null && state.currentTitle !== null) lines.push(`current: ${state.currentTitle}`)
  if (state.current !== null && state.acceptance !== null) lines.push(`acceptance: ${state.acceptance}`)
  if (state.next !== null) {
    lines.push(state.nextTitle === null ? `next: ${state.next.id}` : `next: ${state.next.id} ${state.nextTitle}`)
  }
  for (const issue of state.blocking) {
    const blockedBy = issue.blockedBy.length > 0 ? issue.blockedBy.join(', ') : 'unknown'
    lines.push(`blocked: ${issue.id} (${issue.title}) <- ${blockedBy}`)
  }
  return lines.join('\n')
}

/** Longest prefix (in code points) of `value` whose rendered form, with an ellipsis, fits. */
function longestFitting(
  value: string,
  renderWith: (candidate: string) => string,
  count: (text: string) => number,
  budget: number,
): string | null {
  if (count(renderWith(value)) <= budget) return value
  const points = Array.from(value)
  let best: string | null = null
  let low = 0
  let high = points.length
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = mid === points.length ? value : `${points.slice(0, mid).join('')}\u2026`
    if (count(renderWith(candidate)) <= budget) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function emergencyCut(text: string, count: (value: string) => number, budget: number): string {
  if (count(text) <= budget) return text
  const points = Array.from(text)
  let low = 0
  let high = points.length
  let best = ''
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = points.slice(0, mid).join('')
    if (count(candidate) <= budget) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

/**
 * Build the bounded context strip (ADR-0032 §4).
 *
 * Format: `work: <id> <status>`, current title, acceptance command, next ready item and one
 * `blocked:` line per blocking issue. Truncation priority, least important first:
 * 1. blocking entries from the end;
 * 2. next-ready title, then the next line; the id-only line is retained when it fits alongside
 *    a truncated current title;
 * 3. current title (id/status stay, shortened to keep the next id when possible);
 * 4. acceptance command (definition of done is more important than a title);
 * 5. the `work:` header, which is returned truncated if even it does not fit.
 *
 * Every truncated field ends with an ellipsis. The postcondition is
 * `count(result) <= budget`; budget zero yields an empty string.
 */
export function buildStrip(
  view: StripView,
  count: (text: string) => number = utf8ByteCounter,
  budget = 300,
): string {
  const limit = Number.isFinite(budget) ? Math.max(0, budget) : 0
  const current = view.current
  const state: State = {
    header: current === null ? 'work: idle' : `work: ${current.id} ${current.status}`,
    current,
    currentTitle: current?.title ?? null,
    acceptance: current?.acceptance ?? null,
    next: view.next,
    nextTitle: view.next?.title ?? null,
    blocking: [...view.blocking],
  }
  let text = render(state)
  if (count(text) <= limit) return text

  // 1. Blocking entries are the least important; drop them from the end.
  while (state.blocking.length > 0) {
    state.blocking.pop()
    text = render(state)
    if (count(text) <= limit) return text
  }

  // 2. Next-ready title, then the whole next line.
  let droppedNext: StripWorkItem | null = null
  if (state.next !== null && state.nextTitle !== null) {
    const fitted = longestFitting(
      state.next.title,
      candidate => render({ ...state, nextTitle: candidate }),
      count,
      limit,
    )
    if (fitted !== null) {
      state.nextTitle = fitted
      return render(state)
    }
    droppedNext = state.next
    state.next = null
    state.nextTitle = null
    text = render(state)
    if (count(text) <= limit) return text
  }

  // 3. Current title. The id and status header remain. If the next title was dropped,
  // shorten the current title enough to keep the next id instead of losing the line too.
  if (state.currentTitle !== null) {
    if (droppedNext !== null) {
      const fittedWithNext = longestFitting(
        state.currentTitle,
        candidate => render({ ...state, currentTitle: candidate, next: droppedNext, nextTitle: null }),
        count,
        limit,
      )
      if (fittedWithNext !== null) {
        state.currentTitle = fittedWithNext
        state.next = droppedNext
        state.nextTitle = null
        return render(state)
      }
    }
    const fitted = longestFitting(
      state.currentTitle,
      candidate => render({ ...state, currentTitle: candidate }),
      count,
      limit,
    )
    if (fitted !== null) {
      state.currentTitle = fitted
      return render(state)
    }
    state.currentTitle = null
    text = render(state)
    if (count(text) <= limit) return text
  }

  // 4. Acceptance command. The definition of done outranks the display title above.
  if (state.acceptance !== null) {
    const fitted = longestFitting(
      state.acceptance,
      candidate => render({ ...state, acceptance: candidate }),
      count,
      limit,
    )
    if (fitted !== null) {
      state.acceptance = fitted
      return render(state)
    }
    state.acceptance = null
    text = render(state)
    if (count(text) <= limit) return text
  }

  // 5. Minimal header, then truncate the header itself. Nothing else is left.
  for (const header of current === null ? ['work: idle', 'work'] : [`work: ${current.id}`, 'work']) {
    state.header = header
    text = render(state)
    if (count(text) <= limit) return text
  }
  const fittedHeader = longestFitting(state.header, candidate => candidate, count, limit)
  if (fittedHeader !== null) {
    state.header = fittedHeader
    text = render(state)
    if (count(text) <= limit) return text
  }
  // No ellipsis fits (or a non-monotonic injected counter is outside the contract). A raw
  // cut of the minimal header still honours "truncated to fit" whenever count('') is zero.
  return emergencyCut(render(state), count, limit)
}
