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
  SECRET_SOURCE_PATTERN,
  REDACTION_MARKER_OPEN,
  SECRET_REF_PATTERN,
  redactionMarker,
  type EgressScrubber,
  type SecretRef,
} from './types.ts'

interface Form {
  readonly text: string
  readonly bytes: Buffer
  /** Private cached KMP failure links, rebuilt on registration/rotation. */
  readonly prefix: Uint32Array
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

function prefixTable(text: string): Uint32Array {
  const prefix = new Uint32Array(text.length)
  for (let index = 1, matched = 0; index < text.length; index++) {
    while (matched > 0 && text[index] !== text[matched]) matched = prefix[matched - 1]!
    if (text[index] === text[matched]) matched++
    prefix[index] = matched
  }
  return prefix
}

function markerInterior(ref: SecretRef): string {
  return redactionMarker(ref).slice(REDACTION_MARKER_OPEN.length, -REDACTION_MARKER_CLOSE.length)
}

export class SecretScrubber implements EgressScrubber {
  private readonly values = new Map<SecretRef, string>()
  private forms: Form[] = []
  private closed = false
  /** Declared sources and whether each is ready. */
  private readonly sources = new Map<string, boolean>()
  private waiters: { resolve: () => void; reject: (error: unknown) => void }[] = []

  constructor(options: { expectedSources?: readonly string[] } = {}) {
    for (const sourceId of options.expectedSources ?? []) this.expect(sourceId)
  }

  expect(sourceId: string): void {
    this.assertOpen()
    this.assertSource(sourceId)
    if (!this.sources.has(sourceId)) this.sources.set(sourceId, false)
  }

  ready(sourceId: string): void {
    this.assertOpen()
    this.assertSource(sourceId)
    this.sources.set(sourceId, true)
    if (!this.isReady()) return
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  isReady(): boolean {
    this.assertOpen()
    for (const ready of this.sources.values()) if (!ready) return false
    return true
  }

  pendingSources(): readonly string[] {
    this.assertOpen()
    return [...this.sources].filter(([, ready]) => !ready).map(([sourceId]) => sourceId).sort()
  }

  whenReady(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new EgressScrubberError('closed', 'The egress scrubber was closed'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.isReady()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        reject: (error: unknown) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      // An aborted wait leaves the list, so the scrubber holds no reference to its owner.
      const onAbort = () => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter)
        reject(signal!.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

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
        // The ref is left out on purpose: in a collision or bounds error it may contain the value.
        `A secret value must be a string of ${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH} characters without marker delimiters`,
      )
    }

    const next = new Map(this.values)
    next.set(ref, value)
    const interiors = [...next.keys()].map(markerInterior)
    const newForms = formsOf(value)
    if (newForms.some((form) => interiors.some((interior) => interior.includes(form)))) {
      throw new EgressScrubberError('marker_collision', 'The value occurs inside a redaction marker')
    }
    const newInterior = markerInterior(ref)
    for (const [otherRef, other] of this.values) {
      if (otherRef === ref) continue
      if (formsOf(other).some((form) => newInterior.includes(form))) {
        throw new EgressScrubberError('marker_collision', 'The new marker would contain a registered value')
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

  /** Complete matches plus a terminal proper prefix, in linear time per form. */
  scrubTruncatedPrefix(text: string): string {
    this.assertOpen()
    if (typeof text !== 'string') throw new EgressScrubberError('unsupported_value', 'Expected truncated text')
    const found: Occurrence[] = []
    for (const form of this.forms) {
      let matched = 0
      for (let index = 0; index < text.length; index++) {
        while (matched > 0 && text[index] !== form.text[matched]) matched = form.prefix[matched - 1]!
        if (text[index] === form.text[matched]) matched++
        if (matched === form.text.length) {
          found.push({ start: index + 1 - matched, end: index + 1, ref: form.refs[0]! })
          matched = form.prefix[matched - 1]!
        }
      }
      // The longest suffix covers every shorter prefix of this same form.
      // There is deliberately no minimum fragment, including a one-code-unit suffix.
      if (matched > 0) found.push({ start: text.length - matched, end: text.length, ref: form.refs[0]! })
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end)
    return this.renderString(text, this.runs(found))
  }

  /** Called by the provider plugin's unload. Every later call throws `closed`. */
  close(): void {
    this.closed = true
    this.values.clear()
    this.forms = []
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.reject(new EgressScrubberError('closed', 'The egress scrubber was closed'))
  }

  /** The frozen, method-only facade the plugin provides as the service. */
  facade(): EgressScrubber {
    return Object.freeze({
      register: (ref: SecretRef, value: string) => this.register(ref, value),
      unregister: (ref: SecretRef) => this.unregister(ref),
      scrub: <T>(value: T): T => this.scrub(value),
      scrubTruncatedPrefix: (text: string) => this.scrubTruncatedPrefix(text),
      expect: (sourceId: string) => this.expect(sourceId),
      ready: (sourceId: string) => this.ready(sourceId),
      isReady: () => this.isReady(),
      pendingSources: () => this.pendingSources(),
      whenReady: (signal?: AbortSignal) => this.whenReady(signal),
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new EgressScrubberError('closed', 'The egress scrubber was closed')
  }

  private assertSource(sourceId: string): void {
    if (typeof sourceId !== 'string' || !SECRET_SOURCE_PATTERN.test(sourceId)) {
      throw new EgressScrubberError('invalid_source', 'A secret source id must match [a-z][a-z0-9.-]{0,63}')
    }
  }

  private rebuild(): void {
    const byText = new Map<string, Form>()
    for (const [ref, value] of this.values) {
      for (const text of formsOf(value)) {
        const existing = byText.get(text)
        if (existing) existing.refs.push(ref)
        else byText.set(text, { text, bytes: Buffer.from(text, 'utf8'), prefix: prefixTable(text), refs: [ref] })
      }
    }
    this.forms = [...byText.values()]
  }

  private scrubAny(value: unknown, ancestors: Set<object>): unknown {
    if (typeof value === 'string') return this.scrubString(value)
    if (typeof value === 'number' || typeof value === 'bigint') {
      // A number whose digits hold a registered value (a card number, a PIN) becomes its marker string.
      const digits = String(value)
      const scrubbed = this.scrubString(digits)
      return scrubbed === digits ? value : scrubbed
    }
    if (value === null || value === undefined || typeof value === 'boolean') {
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
        const scrubbedKey = this.scrubString(key)
        if (Object.hasOwn(copy, scrubbedKey)) {
          throw new EgressScrubberError('unsupported_value', 'Two keys scrub to the same text')
        }
        // defineProperty keeps an own "__proto__" key a plain key instead of a prototype change.
        Object.defineProperty(copy, scrubbedKey, {
          value: this.scrubAny((value as Record<string, unknown>)[key], ancestors),
          enumerable: true,
          writable: true,
          configurable: true,
        })
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
    return this.renderString(text, runs)
  }

  private renderString(text: string, runs: { start: number; end: number; refs: SecretRef[] }[]): string {
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
