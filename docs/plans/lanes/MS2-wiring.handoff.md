# MS2 backend wiring — hand-off

**Status:** slice implemented, independently reviewed, all gates green on code head `118b9d24` (later
commits are this hand-off only). No UI.
`PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` were not edited. · **Date:** 2026-10-23 ·
**Branch:** `codex/ms2-backend-wiring` · **Base:** main `38ff464c`, current main `2defd182` merged
(`118b9d24`) · **Plan:** [MS2-wiring.plan.md](MS2-wiring.plan.md)

## What exists

- **Plugins** `guanxi.notifications`, `guanxi.voice`, `guanxi.work` (T0, one service each). Each opens
  its own sidecar under the node data directory, closes it on unload and starts no timer or
  background work. `start()` loads them after connections, index, native agent and relay and
  mounts the routes before the `/api/*` catch-all.
- **Contract** `packages/contract/src/{notifications,voice,work}.ts`: request schemas with transport
  caps, uncapped read shapes, per-area error-code enums. The wire is narrower than the library:
  content-free notification action args (no `add_prompt`, `choose_action`, `raise_budget`), human-only
  work evidence with server-fixed `source` and `at`, glossary revisions always `user`.
- **Routes** `/api/notifications`, `/api/voice/glossary`, `/api/work/projects/:projectId/*`, behind the
  shared `http/local-guard.ts` (loopback peer, same-origin or dev origin, JSON on mutations,
  `no-store`, 2 MiB body budget). Errors are `{ code }` only. Per-area route tables are in the
  module READMEs (MS2 sections).
- **Web clients** in `packages/web/src/features/{notifications,voice,work}/api.ts` on
  `src/lib/local-api.ts`. They follow the connections and native-agent precedent (feature-local
  client with its own `{ code }` error schema) rather than `lib/api.ts`, whose `ApiError` enum is
  closed and tied to locale keys. Request bodies are validated before they leave the browser.
- **Notification ports.** `open` and `snooze` are built in; everything else answers
  `501 not_configured` before a reservation row exists. `wake_leads` is not wired: R1
  `RunStore.signal` needs a fenced child `Attempt` and the run store has no connection-to-run
  index, so no exact seam exists (the independent reviewer confirmed this).

## Evidence

Commands run on `118b9d24` with lane ports 5214 / 4414 and
`GUANXI_DATA_DIR=$PWD/.lane-data`:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 (kernel, server, ui, web, contract) |
| `npm run lint:md` | 0 errors, 246 files, 709 links |
| `npm run check:licenses` | 675 packages, 0 not allowed |
| `npm run ui:check` | exit 0 |
| `npm run lint:js` | 0 errors, 4 existing warnings; `lint:suppressions` ok |
| `npm test` (agent-dev, receipt `check-5n8dpjnz`) | exit 0: core 0 failed, 2 skipped, about 2200 passed; web 398 / 47 files; ui 49; kernel, bench, codemods and gates 0 failed |
| `npm run test:web:browser` (receipt `check-imxs_03_`) | 173 passed |
| `npm run build` (receipt `check-g5og9u7l`) | exit 0 |

The agent-dev log redacts some digit runs, so the core count is derived: 2290 passing lines are
about 2200 tests plus 90 suites.

### New / regression envelope

- **New: 97 tests** (git diff `38ff464c..HEAD` over `*test*`):
  - server, 75 in six files: `ms2-notifications-routes` 24, `ms2-work-routes` 16,
    `ms2-glossary-routes` 14, `ms2-plugins` 9, `ms2-contract` 9, `ms2-guard` 3;
  - web, 22 in `test/unit/local-clients.test.ts`.
- **Changed existing test:** `kernel-plugins.test.ts` counter assertions (fibers 9 to 12, services
  11 to 14) for the three new plugins; no assertion was weakened.
- **Regression envelope:** 298 server tests in `notifications/`, `voice/`, `work/`, `auth/`,
  `kernel-plugins` and `connections/host-allowlist`, all green, plus the full suites above.
- Not a test file: `packages/server/test/ms2-fixture.ts` (shared fixture).

### Mutation checks

About thirty deliberate breakages of the production code and the web clients (guards, the
`not_configured` check, provenance, account passing, close effects, a leaked interval, enum drift,
response caps, the lazy-expiry lock, snooze replay, request validation) were each caught by at least
one test, except five in the first pass: two were redundant defence in depth (the library repeats
the check), one mutation was itself flawed (an unref'd timer), and two exposed test gaps
(provenance at the ledger level, the writable-event subset in the contract test). Tests for those
were added and the mutations re-run.

### Independent verification and fixes

A separate read-only reviewer (`sde-agent:implementation-reviewer`) tried to break nine claimed
properties. It found no blocking issue and these should-fix and nit items, all fixed in
`1441fb29` with tests in `942fcc5e`:

1. Read schemas were as strict as request schemas, so a kernel-written long title or glossary term
   would turn read routes into 500. Read shapes are now uncapped; requests keep the caps.
2. `GlossaryStore` leaked its handle when the first `exec` failed on a non-database file
   (shared edit, below). A garbage-file test now covers all three plugins.
3. Replaying a finished `snooze` key after its time passed returned 422; it now answers `duplicate`.
4. Every GET took the write lock; reads now check for due rows first (a test holds the write lock).
5. README accuracy: host ports are kernel-embedder only, unknown paths keep the old 404 shape,
   work writes are not idempotent.

The first full `npm test` run failed one existing test, `indexing/service.test.ts`
(`fixture_timeout`, a 20 s wait) while the machine load average was about 9 from other lanes. That
file passed three times in isolation on this branch and passed in the full rerun on the final head;
this slice does not touch indexing. It is recorded as an observation, not dismissed.

## Shared edits

- `packages/server/src/index.ts`: load three plugins, mount three routes.
- `packages/contract/src/index.ts`: three re-exports.
- `packages/server/src/voice/store.ts`: constructor closes the handle when the first `exec` fails.
- `packages/server/test/kernel-plugins.test.ts`: counters for the three new fibers and services.
- Module READMEs (notifications, voice, work): MS2 sections, and the stale "not wired" statements
  corrected. The notifications README conflict with NC1-c was resolved by keeping both sections.

## Residual risk and not done

- **UI:** no notification center, glossary editor or board; the clients have no component.
- **U3 `can()`:** not wired. Every handler takes the account and project as plain values, ready for one
  call each. The work ledger is keyed by project id with no account column, so project isolation
  between accounts is a U3 concern.
- **Delivery:** OS and push adapters, NC1-c delivery planning has no route or contract, quota
  producers calling `inbox.ingest`, settings persistence.
- **Ports:** real `wake_leads`, `switch_connection`, `pause_runs`, `resume_runs` and
  `accept_recommendation`. `start()` exposes no host ports, so in the shipped node they answer 501.
- **Cross-process actions:** a live `started` row in another process is indistinguishable from a
  crash; an unprobed host effect then answers `action_outcome_unknown` (the NC1-b contract).
- **Voice:** STT adapters, backend biasing, `voice.flag_term`, candidate learning; `import` and
  `candidate` revision sources have no HTTP path.
- **Work:** `POST /revisions` and repeated human decisions are not idempotent and have no base
  revision. `acceptance` is stored as text a harness may later run; the harness needs its own
  execution policy before running it.
- **Lazy snooze expiry** writes on a GET when a row is due, by design (no timer).
- The unknown-path 404 in `start()` keeps its older `{ code, message, details }` body.

## Next slice

The UI lane builds the notification center, glossary editor and board on the U1 shell using these
clients and contract types, then maps each error `code` to locale keys. Independently, wire a quota
producer (K3 connection probes into `inbox.ingest`) and the first real action port.

## Independent review (Opus, 2026-10-23) and integrator fixes

Verdict accept. Fixed: a damaged sidecar database no longer fails the whole boot (each MS2 plugin
loads in its own guard; its routes answer 503 `*_unavailable`; new `start()` test with a garbage
`work.sqlite`); the in-process action de-duplication key now includes the account. Recorded
residuals: loopback `human_decision` is unauthenticated (see `work/README.md`); glossary
mutations have no base revision (two tabs can overwrite); `hasCompleted` lookups are not
account-filtered; the kernel counter test does not assert the three services by name.
