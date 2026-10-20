# Egress scrubber

**Status:** implemented (K2) · **Updated:** 2026-10-20 · **Owner:** lane K2

The egress scrubber removes known secret values by exact match wherever data leaves the node
process ([ADR-0017](../../../../docs/decisions/0017-model-access-connections-and-secrets.md)
§4, [ADR-0023](../../../../docs/decisions/0023-session-event-log-and-tracing.md), D-141).
Rule-based detection (secretlint/gitleaks) is a later layer on top; this core knows only the
values someone registered.

## Interface

The interface is stable; changes are additive only. Code against
[`types.ts`](types.ts):

```ts
export const EGRESS_SCRUBBER_SERVICE = 'egress.scrubber'
export type SecretRef = `secret://${string}`

export interface EgressScrubber {
  register(ref: SecretRef, value: string): void
  unregister(ref: SecretRef): boolean
  scrub<T>(value: T): T
  // Readiness (added for K3 review H3; additive)
  expect(sourceId: string): void
  ready(sourceId: string): void
  isReady(): boolean
  pendingSources(): readonly string[]
  whenReady(): Promise<void>
}

export interface EgressScrubberConfig {
  expectedSources?: readonly string[]
}
```

`types.ts` also exports `SECRET_REF_PATTERN`, `MIN_SECRET_LENGTH` (8), `MAX_SECRET_LENGTH`
(65,536), `redactionMarker(ref)`, `REDACTION_MARKER_PREFIX`, `REDACTION_MARKER_OPEN`,
`REDACTION_MARKER_CLOSE` and `EgressScrubberError` with its `code`. The three marker constants
are defined in `@guanxi/contract` (scrubbed payloads carry them) and re-exported here.

## Using it from a plugin

```ts
import { definePlugin, service } from '@guanxi/kernel'
import { EGRESS_SCRUBBER_SERVICE, type EgressScrubber } from '../egress/types.ts'

export const vaultPlugin = definePlugin({
  manifest: {
    id: 'guanxi.vault',
    engines: { guanxi: '^0.1.0' },
    provides: ['vault'],
    requires: [EGRESS_SCRUBBER_SERVICE],
    trust: 'T0',
  },
  apply(ctx) {
    const scrubber = service<EgressScrubber>(ctx, EGRESS_SCRUBBER_SERVICE)
    // Register every unlocked value here, in apply: a new scrubber starts empty.
    scrubber.register('secret://vault/openai/default', unlockedValue)
  },
})
```

The provider is `egressScrubberPlugin` in [`plugin.ts`](plugin.ts) (manifest id
`guanxi.egress-scrubber`, trust T0). It has no `requires`, so it loads first.

## Readiness

A new scrubber starts empty, and after a restart other plugins may write before every secret
source has registered. A source therefore declares itself, registers what it knows, and then
says it is ready:

```ts
// In the profile row of the scrubber, so the gate is closed from boot:
{ id: 'egress-scrubber', plugin: 'guanxi.egress-scrubber', config: { expectedSources: ['vault'] } }

// In the source's apply:
for (const [ref, value] of unlockedValues) scrubber.register(ref, value)
scrubber.ready('vault')
```

- `expect(sourceId)` declares a source; the scrubber is not ready while any declared source is
  not. Declaring a source that is already ready keeps it ready. A source declared at runtime
  closes the gate again until it calls `ready`.
- `ready(sourceId)` marks a source ready (declaring it if needed) and resolves every pending
  `whenReady()`.
- `isReady()` is true when every declared source is ready, and also when none is declared.
- `pendingSources()` lists the ids still pending, for diagnostics. Ids are not secret.
- `whenReady()` resolves at once when ready, or the next time every declared source is; it
  rejects with `closed` if the instance closes first.
- Source ids match `SECRET_SOURCE_PATTERN` (`[a-z][a-z0-9.-]{0,63}`); others throw
  `invalid_source`.
- Declare every source in `expectedSources`. An `expect` in the source's own `apply` comes too
  late for writes made by plugins that loaded before it.

**Consumers must not persist or send output while `isReady()` is false.** `scrub` itself still
works then, with whatever is registered; the gate is the consumer's duty. The session log
implements it as follows ([session-log README](../session-log/README.md)):

| Path while not ready | Behaviour |
| --- | --- |
| Legacy Chat trace (job store mirror) | held in a bounded in-memory buffer (1,000 writes, 8 MiB of data by default), written in order, scrubbed, as soon as the scrubber is ready; a full buffer refuses the write with `egress_buffer_full`, so the Job transaction rolls back and nothing is dropped silently |
| `SessionHandle` open and append | fail closed with `egress_not_ready` |
| Reads, inspector routes, export, query tool | fail closed: `egress_not_ready`, HTTP 503 with `details.pendingSources` |

Held-back writes live only in memory. If the process exits before the scrubber is ready, they
are lost like a crash before they were written; they are never written unscrubbed.

## Semantics

- **Exact match.** Matching is on UTF-16 code units, case-sensitive, with no Unicode
  normalisation and no trimming. For each value the scrubber also redacts two derived exact
  forms when they differ from the raw value:
  - the JSON-string-escaped form (`JSON.stringify(value)` without the quotes);
  - the `encodeURIComponent` form.

  Base64 and other encodings are not derived; see residuals.
- **Marker.** Each occurrence becomes `⟦REDACTED secret://…⟧` (U+27E6 and U+27E7), naming
  the ref. Overlapping occurrences of several refs become one marker per ref, side by side;
  when two refs share a value, the marker names the one registered first. Values may not
  contain `⟦` or `⟧`, so no occurrence can overlap a marker's edge, and
  a replacement can never re-form a registered value with the text around it, not even across
  two chunks scrubbed separately and then joined. As defence in depth, `scrub` checks its
  output and throws `self_check_failed` rather than return a value that still contains one.
- **Bounds.** `register` refuses with `EgressScrubberError`:
  - `invalid_ref` for a ref that does not match `SECRET_REF_PATTERN`;
  - `invalid_value` for a non-string, a value shorter than 8 or longer than 65,536 code units,
    or a value containing `⟦` or `⟧`. A short value would redact ordinary text, so the caller
    must decide what to do instead of being silently unprotected;
  - `marker_collision` when the value occurs inside a registered ref's marker (including its
    own), or the new ref's marker contains a registered value.
- **Rotation.** `register` with a ref that is already registered replaces its value. The old
  value is no longer redacted; register it under its own ref if it must stay redacted.
  Two refs may share a value; the value stays redacted until both are unregistered.
- **Types.** `scrub` returns a copy and never mutates its input:
  - strings;
  - `Uint8Array` and `Buffer`, matched on the UTF-8 bytes of each form, with the same class
    returned;
  - arrays and plain objects (prototype `Object.prototype` or `null`), keys included;
  - numbers and bigints, unchanged unless their digits contain a registered value; then they
    become the marker string (a card number or PIN registered as a secret);
  - `Date`, booleans, `null` and `undefined`, returned unchanged.

  Anything else (Map, Set, class instances, functions, symbols, cycles) throws
  `unsupported_value`, so nothing passes through unscrubbed; so do two keys of one object that
  scrub to the same text. An own `__proto__` key stays a plain key.
- **Joined output.** `scrub` works on the value it is given. A consumer that joins or
  serialises scrubbed parts must scrub the result again: two parts can form a value across the
  join. The session log scrubs each serialised payload and each joined search text again and
  refuses a payload that would still change.
- **Errors never contain a registered value**, a fragment of it or its length. Value errors
  leave out the ref as well, because in a collision the ref may contain the value.
- **Lifetime.** Registrations belong to one scrubber instance. When the provider plugin
  unloads, the instance closes and every later call throws `closed` (fail closed). The kernel
  unloads every plugin that `requires` the service first and starts it again with the new
  instance, so consumers must register in their own `apply`.
- **Cost.** One `scrub` is `O(text length × registered forms)` through `indexOf`. That is enough
  for vault-sized registries; an automaton is the upgrade if registries grow past hundreds.

## Where it runs

| Boundary | Owner | Status |
| --- | --- | --- |
| Session-log event write | K2 session log | implemented, gated on readiness |
| Session-log export and query tool | K2 inspector | implemented, gated on readiness |
| Model-request construction (including tool results) | K3 | K3 |
| Artifact write before hashing | K3 | K3 |
| Log write | K3 and later stages | not yet |

## Stub for consumers before K2 merges

A consumer that cannot import this directory yet can code against a local copy of the
interface and this stub. The stub must fail closed: it refuses to scrub instead of passing data
through.

```ts
const stub: EgressScrubber = {
  register() {},
  unregister() { return false },
  scrub() { throw new Error('egress.scrubber is not available before K2 merges') },
  expect() {},
  ready() {},
  isReady() { return false },
  pendingSources() { return ['egress.stub'] },
  whenReady() { return new Promise(() => {}) },
}
```

Delete the stub and the copied interface after merging `main`.

## Residuals

- Base64, hex and other encodings of a value are not derived, so a value inside a Basic-auth
  header built before scrubbing is not caught. Build auth headers after scrubbing (JIT
  injection, ADR-0017).
- A value split across two separately scrubbed chunks (for example two stream deltas) is not
  caught, because neither chunk contains it. The session log therefore stores whole messages,
  not token deltas; a streaming consumer must scrub a boundary that holds the whole value.
- Rule-based detection of unregistered secrets is not part of this core.
