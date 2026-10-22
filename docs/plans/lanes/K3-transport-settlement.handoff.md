# K3 transport settlement — lane handoff

**Status:** implemented and locally validated; root full gates and independent GPT review pending ·
**Updated:** 2026-10-22 · **Branch:** `codex/k3-transport-settlement` · **Base:**
`af0ccab0c7c3164539fe597aa55527e69fa0369a` · **Code/test candidate:** `13881c7` (handoff and
plan-status commit follow)

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

**New:** 14 tests.

- `packages/server/test/connections/model-transport-settlement.test.ts` — 5 real
  `Connections.localChat` + `ResourceGovernor` tests with injected fetch:
  abort keeps call and permit owned until fetch settlement; late response body cancel ACK;
  deadline ownership without external abort (runtime failure, not cancellation); synchronous
  `onStarted` throw ownership; no unhandled rejection after a late failure.
- `packages/server/test/ollama-client.test.ts` — 9 new client tests: uncooperative POST fetch,
  late POST body disposal, non-stream `response.text()` settlement, error-body cancel ACK, load
  timeout after settlement, GET observation liveness with consumed late failure, synchronous
  dispatch observer throw with late body disposal, aborted `warm`, and pending `reader.read()` /
  `reader.cancel()` ownership.

**Regression envelope:** 99 pre-existing tests across five files (the 11 pre-existing
`ollama-client` tests, 50 `model-access`, 7 `relay/review`, 22 `inference-concurrency` and 9
`model-service` tests). Total executed with new tests: 113 over six files. Three
`ollama-client` tests were strengthened, not weakened: the two timeout classification fixtures
now acknowledge abort, and the stuck-cancel test asserts cleanup stays blocked until the
provider cancel promise settles instead of expecting an early release.

## Exact commands and results (local candidate `13881c7`)

```text
nice -n 10 node --test --test-timeout=5000 packages/server/test/ollama-client.test.ts
# tests 20, pass 20, fail 0

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
# tests 82, pass 82, fail 0

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
- **Regression coverage:** `13881c7 test(ollama): prove model POST settlement before release`.
- **Verification:** adapted probe tests failed before `6cc95c1` (4 of 5 settlement tests) and
  pass after it; the list above is the post-fix run.

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
