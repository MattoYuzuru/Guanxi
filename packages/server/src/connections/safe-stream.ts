import type { EgressScrubber } from '../egress/types.ts'
import { formsOf } from '../egress/scrubber.ts'

/** Withhold every possible terminal secret prefix, including complete overlapping forms. */
export class SafeTextStream {
  private pending = ''
  private readonly scrubber: EgressScrubber
  constructor(scrubber: EgressScrubber) { this.scrubber = scrubber }
  push(delta: string): string {
    this.pending += delta
    const snapshot = this.scrubber.snapshot?.()
    if (!snapshot) return '' // Compatibility scrubbers release only the final scrubbed reply.
    const forms = snapshot.flatMap(({ value }) => formsOf(value))
    let cut = this.pending.length
    for (const form of forms) {
      for (let length = 1; length < form.length && length <= this.pending.length; length++) {
        if (this.pending.endsWith(form.slice(0, length))) cut = Math.min(cut, this.pending.length - length)
      }
    }
    let previous: number
    do {
      previous = cut
      for (const form of forms) {
        let start = this.pending.indexOf(form)
        while (start >= 0 && start < cut) {
          if (start + form.length > cut) cut = start
          start = this.pending.indexOf(form, start + 1)
        }
      }
    } while (cut !== previous)
    const safe = this.scrubber.scrub(this.pending.slice(0, cut))
    this.pending = this.pending.slice(cut)
    return safe
  }
  finish(): string { const safe = this.scrubber.scrub(this.pending); this.pending = ''; return safe }
}
