/**
 * The egress scrubber interface (K2; ADR-0017 §4, ADR-0023, D-141).
 *
 * This file is the stable contract other lanes code against. K3 consumes the
 * kernel service `egress.scrubber` at model-request construction and artifact
 * write and registers vault secrets with it; K2 scrubs at event write and
 * export. Changes are additive only. See `README.md` for the semantics.
 */

import { REDACTION_MARKER_CLOSE, REDACTION_MARKER_OPEN, REDACTION_MARKER_PREFIX } from '@guanxi/contract'

/** Kernel service name. A consumer lists it in `manifest.requires`. */
export const EGRESS_SCRUBBER_SERVICE = 'egress.scrubber'

/** A `secret://` reference. References are not secret; registered values are. */
export type SecretRef = `secret://${string}`

/**
 * Exact-match redaction of registered secret values, with a readiness gate:
 * a consumer that persists or sends output must not do so while `isReady()`
 * is false, because a declared source has not registered its values yet.
 *
 * Every method except `whenReady` is synchronous. Errors are
 * `EgressScrubberError` and never contain a registered value.
 */
export interface EgressScrubber {
  /**
   * Registers `value` under `ref`, replacing the value already registered under
   * the same ref (rotation). From the moment this returns, `scrub` redacts it.
   */
  register(ref: SecretRef, value: string): void
  /** Forgets `ref`. Idempotent; returns whether it was registered. */
  unregister(ref: SecretRef): boolean
  /**
   * Returns a copy of `value` in which every occurrence of every registered
   * value is replaced by its redaction marker. Supports strings, `Uint8Array`
   * (including `Buffer`), arrays, plain objects (keys and values), `Date` and
   * primitives; a number or bigint whose digits contain a registered value
   * becomes its marker string. Anything else, and two keys that scrub to the
   * same text, throw `unsupported_value` rather than pass through unscrubbed.
   */
  scrub<T>(value: T): T
  /**
   * Declares a secret source (for example `vault`) whose values must be
   * registered before scrubbed output is complete. The scrubber is not ready
   * while any declared source is not. Idempotent; declaring a source that is
   * already ready keeps it ready.
   */
  expect(sourceId: string): void
  /**
   * Marks a source ready, after it registered every value it knows. Declares
   * the source first if needed. Idempotent.
   */
  ready(sourceId: string): void
  /** True when every declared source is ready (also when none is declared). */
  isReady(): boolean
  /**
   * A copy of the registered ref/value pairs for a trusted local consumer that
   * must scrub inside a sandboxed child (the project index worker). The
   * consumer passes it only over its private IPC channel, never in process
   * arguments or environment. Optional for compatibility with read-only stubs.
   */
  snapshot?(): readonly { ref: SecretRef; value: string }[]
  /** Declared sources that are not ready yet, sorted; ids only, never values. */
  pendingSources(): readonly string[]
  /**
   * Resolves the next time every declared source is ready, at once if it
   * already is. Rejects with `closed` if the instance closes first, and with
   * the signal's reason if `signal` aborts first; an aborted wait is dropped,
   * so it retains nothing.
   */
  whenReady(signal?: AbortSignal): Promise<void>
}

/** Configuration of the `guanxi.egress-scrubber` kernel plugin (JSON, from the profile row). */
export interface EgressScrubberConfig {
  /**
   * Sources declared before any consumer loads, so the scrubber is not ready
   * from boot until each of them calls `ready`. Declare every source whose
   * values could appear in output (for example the vault) here, not only with
   * `expect` in the source's own `apply`, which runs after other consumers may
   * already have written.
   */
  expectedSources?: readonly string[]
}

/** A secret source id: lower-case letters, digits, dots and dashes, 1–64 characters. */
export const SECRET_SOURCE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/

/** What follows `secret://`: 1–240 URL-safe characters. */
export const SECRET_REF_PATTERN = /^secret:\/\/[A-Za-z0-9._~:@+\-/]{1,240}$/

/** Shorter values are refused: they would redact ordinary text. */
export const MIN_SECRET_LENGTH = 8

/** Longer values are refused (64 KiB of UTF-16 code units). */
export const MAX_SECRET_LENGTH = 65_536

/**
 * Markers are delimited by U+27E6 and U+27E7 (defined in the wire contract,
 * because scrubbed payloads carry them). A registered value may not contain
 * either, so no occurrence of a value can overlap a marker's edge, and a
 * replacement can never re-form a registered value with the text around it.
 * `REDACTION_MARKER_PREFIX` is shared by every marker.
 */
export { REDACTION_MARKER_CLOSE, REDACTION_MARKER_OPEN, REDACTION_MARKER_PREFIX }

/**
 * The text that replaces one occurrence of the value registered under `ref`:
 * `⟦REDACTED secret://a⟧`. Overlapping occurrences of several refs become one
 * marker per ref, side by side.
 */
export function redactionMarker(ref: SecretRef): string {
  return `${REDACTION_MARKER_PREFIX}${ref}${REDACTION_MARKER_CLOSE}`
}

export type EgressScrubberErrorCode =
  /** The ref does not match `SECRET_REF_PATTERN`. */
  | 'invalid_ref'
  /** The value is not a string, its length is outside the bounds, or it contains ⟦ or ⟧. */
  | 'invalid_value'
  /** The value occurs inside a redaction marker, or the new ref's marker contains a registered value. */
  | 'marker_collision'
  /** `scrub` met a value it cannot traverse (Map, class instance, cycle, …). */
  | 'unsupported_value'
  /** The scrubber instance was closed by its plugin's unload. */
  | 'closed'
  /** The source id does not match `SECRET_SOURCE_PATTERN`. */
  | 'invalid_source'
  /** Defence in depth: an output still contained a registered value, so nothing is returned. */
  | 'self_check_failed'

export class EgressScrubberError extends Error {
  readonly code: EgressScrubberErrorCode

  constructor(code: EgressScrubberErrorCode, message: string) {
    super(message)
    this.name = 'EgressScrubberError'
    this.code = code
  }
}
