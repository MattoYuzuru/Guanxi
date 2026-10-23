# MS2 backend wiring — implementation plan

**Status:** accepted bounded plan · **Updated:** 2026-10-23 · **Base:** main `38ff464c`,
branch `codex/ms2-backend-wiring`, ports 5214 / 4414.

## Outcome and non-goals

Make three independently reviewed pure modules reachable through the product boundary: NC1
(`notifications/`), V1 (`voice/`) and WG1-a (`work/`). Deliver plugins, contract schemas, REST
routes, a typed web client and tests. Non-goals: any UI, U3 `can()` wiring, OS/push delivery,
quota producers, real `switch_connection`/`pause_runs` ports, STT adapters, tracker sync.

## Design decisions

1. **Plugins** `guanxi.notifications`, `guanxi.voice`, `guanxi.work` (T0, no `requires`, each
   `provides` one service). Each opens its own sidecar under the node data directory
   (`notifications.sqlite`, `voice.sqlite`, `work.sqlite`) and closes it through `ctx.effect`.
   Loading starts no timer, interval or background work. They load in `start()` after the
   connections, index, native agent and relay plugins and before routes are mounted.
2. **Contract** (`packages/contract/src/{notifications,voice,work}.ts`) holds Zod wire schemas and
   per-area error-code enums. Server-internal types stay where they are; `wire.ts` files map at
   the route boundary and drop `accountId` and idempotency internals.
3. **Routes** `/api/notifications`, `/api/voice/glossary`, `/api/work/projects/:projectId`, built
   by `(resolve, accountId, devOrigins)` like the connection routes; `start()` passes `'local'`.
   Every handler takes the account and project as plain values so a future `can()` check is one
   call per handler. A shared `http/local-guard.ts` enforces loopback peer, same-origin or
   allowed dev origin, `application/json` on mutations, `Cache-Control: no-store` and a
   transport body budget. Errors are `{ code }` only; no message, id list or content is echoed.
4. **Wire is narrower than the library on purpose.**
   - Notification action args are content-free: ids, enums and integers only. `add_prompt`,
     `choose_action` and `raise_budget` carry prompts, free text or money intent and are not
     exposed. `accept_recommendation` carries an enum, not free text.
   - Work evidence over HTTP is limited to the human events (`accepted`, `rejected`,
     `human_decision`). The server fixes `source` to `user:local` and stamps `at`, so HTTP can
     never forge `harness:` acceptance results or `agent:` claims (ADR-0032, D-172).
   - Glossary revision `source` is always `user` over HTTP; `import` and `candidate` belong to
     later adapters.
5. **Action ports.** `open` and `snooze` are built in: their only effect is the inbox state the
   store already commits. Every other action is refused with `501 not_configured` before a
   reservation row is written, unless the host supplies a port. `wake_leads` is not wired: R1
   `RunStore.signal` needs a fenced child `Attempt` and the run store keeps no
   connection-to-run dependency index, so no exact, safe seam exists. Nothing returns fake success.
6. **Lazy snooze expiry.** No timer exists, so list/get/execute call `expireSnoozed(now)` first.
7. **Account isolation.** Notifications and glossary are account-scoped in their stores; the
   routes pass the fixed local account. The work ledger is keyed by project id only (WG1-a has no
   account column); that is a documented residual for U3.
8. **Web client** in feature-local `api.ts` files (`features/{notifications,voice,work}`) on a
   shared `lib/local-api.ts` transport, following the connections and native-agent precedent.
   Responses are parsed with the contract schemas; errors are `{ status, code }`.

## Failure and security risks

Cross-site POST (origin guard), DNS rebinding (existing host allowlist), non-loopback peers,
oversized bodies, idempotent retry of actions, partial failure (stored `port_failed`), content
in error bodies, forged evidence, double-load of a plugin leaking a database handle.

## Test matrix

- Contract: every schema accepts a valid sample, rejects unknown keys and content-bearing
  actions; enum drift test against the server constants.
- Routes (`packages/server/test/ms2-*.test.ts`): happy paths, validation, guard refusals
  (non-JSON, cross-origin, non-loopback, oversized), not-found, state conflicts, idempotent
  duplicate execute, `not_configured` refusal without a row, account isolation (second account
  on the same stores), forged-evidence refusal, error bodies carry only `code`.
- Plugins: sidecar files created, unload closes databases (use after unload throws), reload
  leaves one open handle, no timers (kernel counters), boot with all three through `start()`.
- Web: request path, method, headers and body for each function; response and error parsing.

## Gates and commits

`typecheck`, `lint:md`, `check:licenses`, `ui:check`, then heavy `test`, `test:web:browser`,
`build` through the shared lock, one per call. Commits: plan, contract, then one per module
(notifications, voice, work), shared guard and boot, web client, tests, docs and hand-off.
Hand-off: `docs/plans/lanes/MS2-wiring.handoff.md` with new and envelope counts and residuals.
