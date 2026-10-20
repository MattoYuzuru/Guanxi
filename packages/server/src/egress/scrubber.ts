/**
 * Exact-match egress scrubber (K2). The semantics are documented in README.md;
 * `types.ts` is the stable interface.
 *
 * Soundness rests on two registration rules: values may not contain the marker
 * delimiters, and no form of a value may occur inside any marker. The output of
 * a pass is then original text that contained no occurrence, interleaved with
 * single-ref markers, so it cannot contain a registered form; `scrub` still
 * checks that before returning.
 */
import {
  EgressScrubberError,
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  REDACTION_MARKER_CLOSE,
  REDACTION_MARKER_OPEN,
  SECRET_REF_PATTERN,
  redactionMarker,
  type EgressScrubber,
  type SecretRef,
} from './types.ts'

interface Form {
  readonly text: string
  readonly bytes: Buffer
  /** Refs whose value has this form, in registration order. */
  readonly refs: SecretRef[]
}

interface Occurrence {
  start: number
  end: number
  ref: SecretRef
}

/** The exact forms of one value that scrubbing redacts. */
export function formsOf(value: string): string[] {
  const forms = new Set<string>([value])
  forms.add(JSON.stringify(value).slice(1, -1))
  try {
    forms.add(encodeURIComponent(value))
  } catch {
    // A lone surrogate has no URI form, so it cannot occur URI-encoded either.
  }
  return [...forms]
}

function markerInterior(ref: SecretRef): string {
  return redactionMarker(ref).slice(REDACTION_MARKER_OPEN.length, -REDACTION_MARKER_CLOSE.length)
}

export class SecretScrubber implements EgressScrubber {
  private readonly values = new Map<SecretRef, string>()
  private forms: Form[] = []
  private closed = false

  register(ref: SecretRef, value: string): void {
    this.assertOpen()
    if (typeof ref !== 'string' || !SECRET_REF_PATTERN.test(ref)) {
      throw new EgressScrubberError('invalid_ref', 'A secret ref must match secret://<1-240 URL-safe characters>')
    }
    if (
      typeof value !== 'string' ||
      value.length < MIN_SECRET_LENGTH ||
      value.length > MAX_SECRET_LENGTH ||
      value.includes(REDACTION_MARKER_OPEN) ||
      value.includes(REDACTION_MARKER_CLOSE)
    ) {
      throw new EgressScrubberError(
        'invalid_value',
        `The value for ${ref} must be a string of ${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH} characters without marker delimiters`,
      )
    }

    const next = new Map(this.values)
    next.set(ref, value)
    const interiors = [...next.keys()].map(markerInterior)
    const newForms = formsOf(value)
    if (newForms.some((form) => interiors.some((interior) => interior.includes(form)))) {
      throw new EgressScrubberError('marker_collision', `The value for ${ref} occurs inside a redaction marker`)
    }
    const newInterior = markerInterior(ref)
    for (const [otherRef, other] of this.values) {
      if (otherRef === ref) continue
      if (formsOf(other).some((form) => newInterior.includes(form))) {
        throw new EgressScrubberError('marker_collision', `The marker for ${ref} contains a registered value`)
      }
    }

    this.values.set(ref, value)
    this.rebuild()
  }

  unregister(ref: SecretRef): boolean {
    this.assertOpen()
    const removed = this.values.delete(ref)
    if (removed) this.rebuild()
    return removed
  }

  scrub<T>(value: T): T {
    this.assertOpen()
    return this.scrubAny(value, new Set()) as T
  }

  /** Number of registered refs; diagnostics only. */
  get size(): number {
    return this.values.size
  }

  /** Called by the provider plugin's unload. Every later call throws `closed`. */
  close(): void {
    this.closed = true
    this.values.clear()
    this.forms = []
  }

  /** The frozen, method-only facade the plugin provides as the service. */
  facade(): EgressScrubber {
    return Object.freeze({
      register: (ref: SecretRef, value: string) => this.register(ref, value),
      unregister: (ref: SecretRef) => this.unregister(ref),
      scrub: <T>(value: T): T => this.scrub(value),
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new EgressScrubberError('closed', 'The egress scrubber was closed')
  }

  private rebuild(): void {
    const byText = new Map<string, Form>()
    for (const [ref, value] of this.values) {
      for (const text of formsOf(value)) {
        const existing = byText.get(text)
        if (existing) existing.refs.push(ref)
        else byText.set(text, { text, bytes: Buffer.from(text, 'utf8'), refs: [ref] })
      }
    }
    this.forms = [...byText.values()]
  }

  private scrubAny(value: unknown, ancestors: Set<object>): unknown {
    if (typeof value === 'string') return this.scrubString(value)
    if (
      value === null ||
      value === undefined ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return value
    }
    if (typeof value !== 'object') {
      throw new EgressScrubberError('unsupported_value', `Cannot scrub a value of type ${typeof value}`)
    }
    if (value instanceof Uint8Array && (value.constructor === Uint8Array || Buffer.isBuffer(value))) {
      return this.scrubBytes(value)
    }
    if (value instanceof Date) return new Date(value.getTime())
    if (ancestors.has(value)) {
      throw new EgressScrubberError('unsupported_value', 'Cannot scrub a cyclic value')
    }
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        return Array.from(value, (item) => this.scrubAny(item, ancestors))
      }
      const prototype = Object.getPrototypeOf(value) as unknown
      if (prototype !== Object.prototype && prototype !== null) {
        throw new EgressScrubberError('unsupported_value', 'Cannot scrub a non-plain object')
      }
      const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {}
      for (const key of Object.keys(value)) {
        copy[this.scrubString(key)] = this.scrubAny((value as Record<string, unknown>)[key], ancestors)
      }
      return copy
    } finally {
      ancestors.delete(value)
    }
  }

  private occurrences(find: (form: Form, from: number) => number, lengthOf: (form: Form) => number): Occurrence[] {
    const found: Occurrence[] = []
    for (const form of this.forms) {
      const length = lengthOf(form)
      for (let index = find(form, 0); index >= 0; index = find(form, index + 1)) {
        found.push({ start: index, end: index + length, ref: form.refs[0]! })
      }
    }
    return found.sort((a, b) => a.start - b.start || b.end - a.end)
  }

  /** Merges overlapping occurrences; each run keeps its distinct refs in order. */
  private runs(found: Occurrence[]): { start: number; end: number; refs: SecretRef[] }[] {
    const runs: { start: number; end: number; refs: SecretRef[] }[] = []
    for (const occurrence of found) {
      const last = runs.at(-1)
      if (last && occurrence.start < last.end) {
        last.end = Math.max(last.end, occurrence.end)
        if (!last.refs.includes(occurrence.ref)) last.refs.push(occurrence.ref)
      } else {
        runs.push({ start: occurrence.start, end: occurrence.end, refs: [occurrence.ref] })
      }
    }
    return runs
  }

  private scrubString(text: string): string {
    if (this.forms.length === 0) return text
    const runs = this.runs(
      this.occurrences((form, from) => text.indexOf(form.text, from), (form) => form.text.length),
    )
    if (runs.length === 0) return text
    let output = ''
    let cursor = 0
    for (const run of runs) {
      output += text.slice(cursor, run.start) + run.refs.map((ref) => redactionMarker(ref)).join('')
      cursor = run.end
    }
    output += text.slice(cursor)
    for (const form of this.forms) {
      if (output.includes(form.text)) {
        throw new EgressScrubberError('self_check_failed', 'A scrubbed string still contained a registered value')
      }
    }
    return output
  }

  private scrubBytes(input: Uint8Array): Uint8Array {
    const view = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    const runs = this.forms.length === 0
      ? []
      : this.runs(this.occurrences((form, from) => view.indexOf(form.bytes, from), (form) => form.bytes.length))
    const parts: Buffer[] = []
    let cursor = 0
    for (const run of runs) {
      parts.push(view.subarray(cursor, run.start))
      for (const ref of run.refs) parts.push(Buffer.from(redactionMarker(ref), 'utf8'))
      cursor = run.end
    }
    parts.push(view.subarray(cursor))
    const output = Buffer.concat(parts)
    for (const form of this.forms) {
      if (output.includes(form.bytes)) {
        throw new EgressScrubberError('self_check_failed', 'Scrubbed bytes still contained a registered value')
      }
    }
    return Buffer.isBuffer(input) ? output : new Uint8Array(output)
  }
}
