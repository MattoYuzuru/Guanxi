/**
 * The egress scrubber interface (K2; ADR-0017 §4, ADR-0023, D-141).
 *
 * This file is the stable contract other lanes code against. K3 consumes the
 * kernel service `egress.scrubber` at model-request construction and artifact
 * write and registers vault secrets with it; K2 scrubs at event write and
 * export. Changes are additive only. See `README.md` for the semantics.
 */

/** Kernel service name. A consumer lists it in `manifest.requires`. */
export const EGRESS_SCRUBBER_SERVICE = 'egress.scrubber'

/** A `secret://` reference. References are not secret; registered values are. */
export type SecretRef = `secret://${string}`

/**
 * Exact-match redaction of registered secret values.
 *
 * Every method is synchronous. Errors are `EgressScrubberError` and never
 * contain a registered value.
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
   * primitives; anything else throws `unsupported_value` rather than pass
   * through unscrubbed.
   */
  scrub<T>(value: T): T
}

/** What follows `secret://`: 1–240 URL-safe characters. */
export const SECRET_REF_PATTERN = /^secret:\/\/[A-Za-z0-9._~:@+\-/]{1,240}$/

/** Shorter values are refused: they would redact ordinary text. */
export const MIN_SECRET_LENGTH = 8

/** Longer values are refused (64 KiB of UTF-16 code units). */
export const MAX_SECRET_LENGTH = 65_536

/**
 * Markers are delimited by U+27E6 and U+27E7. A registered value may not contain
 * either, so no occurrence of a value can overlap a marker's edge, and a
 * replacement can never re-form a registered value with the text around it.
 */
export const REDACTION_MARKER_OPEN = '\u27E6'
export const REDACTION_MARKER_CLOSE = '\u27E7'

/** Prefix shared by every marker; the inspector renders markers by it. */
export const REDACTION_MARKER_PREFIX = `${REDACTION_MARKER_OPEN}REDACTED `

/**
 * The text that replaces an occurrence of the values registered under `refs`
 * (one ref, or several when occurrences overlap): `⟦REDACTED secret://a⟧`.
 */
export function redactionMarker(...refs: readonly SecretRef[]): string {
  return `${REDACTION_MARKER_PREFIX}${refs.join(', ')}${REDACTION_MARKER_CLOSE}`
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
