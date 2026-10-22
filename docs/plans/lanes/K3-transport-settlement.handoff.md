# K3 transport settlement — lane handoff

**Status:** implemented and locally validated; root full gates and independent GPT review pending ·
**Updated:** 2026-10-22 · **Branch:** `codex/k3-transport-settlement` · **Base:**
`af0ccab0c7c3164539fe597aa55527e69fa0369a` · **Code/test candidate:** `da3ffa0` (docs snapshot
follows)

## Finding

`Connections.localChat` released its Resource Governor permit as soon as an external abort or
deadline won the `withinDeadline` race. The actual `/api/chat` fetch could still be pending, so
the client promise settled and the permit became reusable before transport ownership ended. The
mandated independent probe
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/r3-k3-post-settlement-probe-20261022.ts` reproduced
the old pure-local state at this base:

```json
{"gets":1,"posts":1,"postAborted":true,"fetchSettled":false,"callSettled":true,"governorHeld":false}
```

The probe was run read-only and was not edited. Its fixture was adapted into this clone as
`packages/server/test/connections/model-transport-settlement.test.ts`; the adapted ownership
assertions failed on the pre-fix client and pass after the fix.

## Fix (commit `6cc95c1`)

- `withinDeadline` now takes a private `TransportSettlement` policy. On abort/deadline it aborts
  the transport immediately, then awaits the actual operation. A late response is disposed with
  `body.cancel()` and that acknowledgement is awaited; a late rejection is consumed. Only then
  is the existing fixed outcome surfaced.
- The policy is enabled only by the `/api/chat` POST paths: non-stream `chat`, streaming
  `chatStream`, `warm`, and `unload`. It is client-private and never read from request JSON.
- `/api/chat` streaming now awaits settlement of `reader.read()` and its `reader.cancel()`
  cleanup. Non-chat stream paths (`pull`, `create`) keep their previous non-blocking cleanup.
- A synchronous `onDispatched` throw after fetch start keeps the started transport owned until
  it settles and any late response body is disposed, then surfaces the existing observer
  failure. The pre-existing wrapper/identity split is preserved: raw observer error when the
  caller signal is aborted, `OllamaUnavailableError` otherwise.
- GET/observation paths (`version`, `tags`, `ps`, probes, `show`) keep their abort-race
  responsiveness; late outcomes are consumed and late response bodies are disposed.
- No retry, no second body consumption, no new timeout or retention ceiling, no raw error or
  content logging. Existing timeout phase/`timeoutMs`, external-abort authority, HTTP status and
  protocol mappings are unchanged.

## Tests

**New:** 15 tests.

- `packages/server/test/connections/model-transport-settlement.test.ts` — 5 real
  `Connections.localChat` + `ResourceGovernor` tests with injected fetch:
  abort keeps call and permit owned until fetch settlement; late response body cancel ACK;
  deadline ownership without external abort (runtime failure, not cancellation); synchronous
  `onStarted` throw ownership; no unhandled rejection after a late failure.
- `packages/server/test/ollama-client.test.ts` — 10 new client tests: uncooperative POST fetch,
  late POST body disposal, non-stream `response.text()` settlement, error-body cancel ACK, load
  timeout after settlement, GET observation liveness with consumed late failure, late GET
  response-body disposal, synchronous dispatch observer throw with late body disposal, aborted
  `warm`, and pending `reader.read()` / `reader.cancel()` ownership.

**Regression envelope:** 99 pre-existing tests across five files (the 11 pre-existing
`ollama-client` tests, 50 `model-access`, 7 `relay/review`, 22 `inference-concurrency` and 9
`model-service` tests). Total executed with new tests: 114 over six files. Three
`ollama-client` tests were strengthened, not weakened: the two timeout classification fixtures
now acknowledge abort, and the stuck-cancel test asserts cleanup stays blocked until the
provider cancel promise settles instead of expecting an early release.

## Exact commands and results (local candidate `da3ffa0`)

```text
nice -n 10 node --test --test-timeout=5000 packages/server/test/ollama-client.test.ts
# tests 21, pass 21, fail 0

nice -n 10 node --test --test-timeout=30000 packages/server/test/connections/model-transport-settlement.test.ts
# tests 5, pass 5, fail 0

nice -n 10 node --test --test-timeout=30000 packages/server/test/connections/model-access.test.ts
# tests 50, pass 50, fail 0

nice -n 10 node --test --test-timeout=30000 packages/server/test/relay/review.test.ts
# tests 7, pass 7, fail 0

nice -n 10 node --test --test-timeout=30000 packages/server/test/inference-concurrency.test.ts
# tests 22, pass 22, fail 0

nice -n 10 node --test --test-timeout=30000 packages/server/test/model-service.test.ts
# tests 9, pass 9, fail 0

nice -n 10 node --test --test-timeout=30000 \
  packages/server/test/ollama-client.test.ts \
  packages/server/test/connections/model-transport-settlement.test.ts \
  packages/server/test/connections/model-access.test.ts \
  packages/server/test/relay/review.test.ts
# tests 83, pass 83, fail 0

nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
# exit 0, no output
```

No `npm test`, browser, build, Storybook, container, nested sandbox or `agent-dev` command was
run. No live server, port or owner data was used. No network, paid provider, SSH or workspace
cleanup was touched.

## Review-fix section (2026-10-22)

- **Finding:** K3 model POST released client/governor ownership before the actual transport
  settled (independently reproduced; confirmed bug).
- **Behaviour fix:** `6cc95c1 fix(ollama): hold model POST ownership until transport settlement`.
- **Regression coverage:** `13881c7 test(ollama): prove model POST settlement before release`
  and `da3ffa0 test(ollama): assert late GET response disposal`.
- **Verification:** adapted probe tests failed before `6cc95c1` (4 of 5 settlement tests) and
  pass after it; the list above is the post-fix run. An exact temp-only copy of the mandated
  probe with only its import prefixes repointed at this clone then ran at `da3ffa0` and
  printed `{"gets":1,"posts":1,"postAborted":true,"fetchSettled":false,"callSettled":false,"governorHeld":true}`
  with `tests 1, pass 1, fail 0`.

## Residual risk and claims boundary

- This proves local client/permit ownership, not that backend inference ceased or that a remote
  HTTP server cancelled the request.
- Provider adapters other than local Ollama `/api/chat`, backend cooperative-cancellation policy
  and remote hardware cancellation remain explicit residuals.
- If an injected transport never acknowledges abort/cleanup, the owning promise and permit stay
  pending honestly; there is deliberately no new wall clock escape hatch.
- The pre-existing mapping of an HTTP error response after its body-cancel ACK is preserved even
  if the caller signal aborts during that cleanup.
- Root owns full gates, merge/rebase/push, `PHASE_STATUS` and `NEXT_AGENT_PROMPT`.

## Review-fix section 2 (2026-10-22) — P2 cancel-driven reader liveness

**Finding:** the settlement policy awaited a pending `/api/chat` `reader.read()` on abort/deadline,
but `reader.cancel()` still ran only in the later `finally`. A real `ReadableStream` whose read
resolves only when its consumer requests cancel therefore deadlocked: read waited for cancel and
cancel waited for the read. The independent read-only probe
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/k3-cancel-driven-reader-probe-20261022.ts` reproduced
it unchanged against `c65c629`:

```json
{"cancelRequested":false,"settled":false,"bodyLocked":true}
```

The pre-existing pending-read test supplied a chunk before expecting cancel and could not falsify
this case. The probe was not edited.

**Behaviour fix (`39189e2`)** — `fix(ollama): cancel a stream reader before awaiting its pending read`:

- `withinDeadline`'s private settlement policy can now start path-owned cleanup synchronously when
  abort/deadline wins, before the pending operation is awaited.
- `/api/chat` streaming passes a memoized `reader.cancel()` starter. The control path requests
  cancellation immediately and then awaits **both** the pending read settlement and the actual
  cancel acknowledgement before surfacing the existing abort/timeout mapping. The outer `finally`
  reuses the same promise, so there is exactly one cancel request and no double cancel.
- Cancel rejection is consumed (it cannot replace the control outcome); the reader lock is never
  released while a read is pending; no late chunk is yielded after abort; no timer, retry, second
  body read or early fake ACK was added.
- Non-chat stream paths, GET observation liveness, normal stream completion, abort/error priority,
  R2 dispatch seams and `connections/service.ts` are unchanged.

**New review-fix tests (4):**

- `packages/server/test/ollama-client.test.ts` — 3: cancel-driven pending read on external abort
  (`cancelRequested`, cancel ACK holds the call, reader stays locked, exactly one cancel); the same
  on an internal load deadline without an external signal; a rejected late cancel is consumed with
  no unhandled rejection while the abort outcome is preserved.
- `packages/server/test/connections/model-transport-settlement.test.ts` — 1: a real
  `ResourceGovernor` lease around `chatStream(...).next()` stays held while the cancel ACK is
  withheld, then is released exactly once after the fixed abort outcome.

Total candidate evidence is now **19 new / 99 regression = 118 scoped**, without weakening the
15 earlier new tests or the 99 regression cases.

**Exact commands and results at `39189e2`:**

```text
nice -n 10 node --test --test-timeout=30000 \
  packages/server/test/ollama-client.test.ts \
  packages/server/test/connections/model-transport-settlement.test.ts \
  packages/server/test/connections/model-access.test.ts \
  packages/server/test/relay/review.test.ts \
  packages/server/test/inference-concurrency.test.ts \
  packages/server/test/model-service.test.ts
# tests 118, pass 118, fail 0

nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
# exit 0, no output

nice -n 10 node --test --test-timeout=5000 \
  /Users/yuzuru/Projects/Guanxi-lanes/reviews/k3-cancel-driven-reader-probe-20261022.ts
# {"cancelRequested":true,"settled":false,"bodyLocked":true}
# tests 1, pass 1, fail 0
```

Red evidence before the production edit: the unmodified probe failed with
`cancelRequested=false`; the new abort test failed `0 !== 1` for cancel requests; the new
deadline, late-cancel-reject and governor tests timed out at a 2000 ms test timeout because the
read never settled. No `npm test`, browser, build, Storybook, container, nested sandbox,
`agent-dev`, live server/model, network, SSH or owner-data operation was run. `@guanxi/contract`
resolved to this clone and `require.resolve` was confirmed.

**Residuals:** a provider that requests neither abort nor cancel acknowledgement still leaves the
owning promise/permit pending honestly; this proves local client/permit ownership, not backend
inference termination. The R2 fourth-argument seam still needs the separately owned reconciliation,
and root owns full gates, merge/rebase/push and status files.
