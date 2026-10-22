# K3 transport settlement — implementation plan

**Status:** implemented (local candidate; root heavy gates pending) · **Updated:** 2026-10-22 ·
**Branch:** `codex/k3-transport-settlement` · **Base:**
`af0ccab0c7c3164539fe597aa55527e69fa0369a`

## Objective

A K3 local model POST (`Connections.localChat` → `OllamaClient.chat`) must abort the transport
signal immediately on external abort or deadline, but the client promise and the caller's
Resource Governor permit must remain owned until the actual transport has settled and its
response body / reader cleanup has acknowledged the cancellation. The fix is limited to the
`/api/chat` POST paths: non-streaming `chat`, streaming `chatStream`, `warm` and `unload`.

## Non-goals

- No claim that backend inference stopped or that a remote HTTP server cancelled work.
- No change to `connections/service.ts`, relay/model code, R2 dispatch authorization, package or
  lock files.
- No generic early-release policy for tools or every model/resource operation.
- No new timeout or retention ceiling that pretends cleanup finished.
- No retry, duplicate body consumption or changed message/usage semantics.

## Current behaviour (reproduced)

`withinDeadline` races the fetch/read operation against abort and deadline and rejects as soon
as control wins. `Connections.localChat` then releases the governor lease while the injected
fetch is still pending. The mandated probe against the old client prints
`{gets:1,posts:1,postAborted:true,fetchSettled:false,callSettled:true,governorHeld:false}`.

## Proposed behaviour

- Add a private, path-derived `awaitTransportSettlement` policy used only by the `/api/chat`
  POST call sites. It is never read from request JSON.
- On abort/deadline/observer failure for those paths: abort the controller immediately, then
  await the actual fetch promise (and `response.text()` / `reader.read()` where applicable).
  A late response is disposed with `body.cancel()` and that cleanup is awaited; late rejection
  is consumed. Only then surface the existing fixed outcome (AbortError, `OllamaTimeoutError`,
  or mapped HTTP/protocol error).
- Stream cleanup awaits `reader.cancel()` on `/api/chat`; non-chat streams keep their current
  non-blocking cleanup.
- A synchronous `onDispatched` throw keeps transport ownership until the started fetch settles
  and its body is disposed, then rethrows the observer failure.
- GET observations (`version`, `tags`, `ps`, `probe`) keep their current abort-race liveness;
  late outcomes are consumed without delaying the caller.
- If injected transport cleanup never acknowledges, the owning promise stays pending honestly.

## Risks and invariants

- One HTTP attempt per call; no second body read; no retry.
- Existing timeout phase/`timeoutMs`, external-abort authority, HTTP status and protocol error
  mapping stay unchanged.
- The governor is released exactly once by the existing `finally`, now after settlement.
- No raw exception or content logging.

## Tests and validation

- New `packages/server/test/connections/model-transport-settlement.test.ts` using real
  `Connections.localChat`, a real `ResourceGovernor` and an injected fetch: abort ownership,
  late resolve body-cancel ACK, late reject release, timeout without external abort, and
  synchronous `onStarted` throw; no unhandled rejection.
- `packages/server/test/ollama-client.test.ts`: update existing timeout/cancel fixtures to
  cooperative abort or explicit ACK, and add coverage for pending POST fetch/read/text/cancel,
  GET liveness, and dispatch observer failure.
- Exact commands: `nice -n 10 node --test <specific files>` and
  `nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json`.
- Full `npm test`/browser/build and shared-lock heavy gates remain with the root coordinator.

## Residuals

Provider adapters other than the local Ollama `/api/chat` path, backend cooperative
cancellation, and remote hardware cancellation guarantees are out of scope.

## Review-fix 3 (2026-10-22) — non-stream body cancellation

The P2 non-stream finding extends the same ownership rule to `awaitTransportSettlement` POST
bodies. The client owns their reader and UTF-8 decoding, exposes one memoized consumer cancel,
requests it before awaiting a pending read on abort/deadline, and awaits both the read and the
provider cancel acknowledgement before releasing the caller. `Response.text()` parity (BOM,
split multibyte, empty/null body, invalid JSON mapping) and the absence of a hidden body-size
ceiling are asserted. GET/observation paths keep their previous `response.text()` behavior. Test
and fix evidence is appended to the handoff (red at `5fc995d`, fix `3439a7f`).
