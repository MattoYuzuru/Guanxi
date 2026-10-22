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
  whenReady(signal?: AbortSignal): Promise<void>
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
- `whenReady(signal?)` resolves at once when ready, or the next time every declared source is;
  it rejects with `closed` if the instance closes first, and with the signal's reason if the
  signal aborts first. An aborted wait leaves the waiter list, so a consumer that unloads while a
  source stays pending is not retained.
- Source ids match `SECRET_SOURCE_PATTERN` (`[a-z][a-z0-9.-]{0,63}`); others throw
  `invalid_source`.
- Declare every source in `expectedSources`. An `expect` in the source's own `apply` comes too
  late for writes made by plugins that loaded before it.

**Consumers must not persist or send output while `isReady()` is false.** `scrub` itself still
works then, with whatever is registered; the gate is the consumer's duty. The session log
implements it as follows ([session-log README](../session-log/README.md)):

| Path while not ready | Behaviour |
| --- | --- |
| Legacy Chat trace (job store mirror) | writes no trace; inside the Job transaction it records only the Job id in `session_mirror_backlog` (no payload). Once the scrubber is ready, at the session's next Job event or at the next start, the trace is reconstructed from the durable Job store, scrubbed, in durable chat order, before anything newer of that session, and with the source times. Until a session's backlog is empty its reads answer `session_catching_up` (HTTP 503, `details.failure` naming the last failed attempt's code) and the list counts it instead of listing it; a failed attempt is retried after a bounded growing delay. Nothing secret-bearing is queued, and a crash before readiness loses nothing |
| `SessionHandle` open and append | fail closed with `egress_not_ready` |
| Reads, inspector routes, export, query tool | fail closed: `egress_not_ready`, HTTP 503 with `details.pendingSources` |

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
  whenReady() { return Promise.reject(new Error('egress.scrubber is not available before K2 merges')) },
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

## Known right-truncated prefixes

The optional synchronous `scrubTruncatedPrefix(text)` capability uses the actual private raw,
JSON-escaped and URI-encoded forms. Alongside complete matches it replaces every nonempty
terminal proper prefix, including one character. Cached KMP failure links scan each form in
linear time in the input length; overlap merging and marker semantics match exact scrubbing.
Registration, rotation and unregister rebuild the private cache; no registry is exposed.
This is a conservative operation for a known truncation boundary, not the meaning of ordinary
`scrub`: ordinary text ending in an unrelated matching character remains ordinary text.
Readiness and stale-facade closure rules are unchanged.

Session-log v2 input excerpts establish original truncation from stored byte metadata before
applying this capability. Stored markers can make that original boundary ambiguous after
append-time expansion; the excerpt consumer conservatively protects that boundary too. A consumer of an older port without the capability must withhold
the affected truncated text. It cannot pass that text through or reconstruct full artifacts
to obtain the missing redaction guarantee. Arbitrarily interrupted messages without a known
truncation boundary remain outside this additional guarantee.
