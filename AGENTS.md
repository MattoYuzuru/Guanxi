# Instructions for agents

**Status:** implemented · **Updated:** 2026-11-01 · **Scope:** the whole repository

Guanxi is an early-alpha, local-first agent harness. The code in `packages/` combines the
retained Alamo-era Ollama workbench with merged re-foundation slices on the own plugin
kernel. [`PHASE_STATUS`](docs/plans/PHASE_STATUS.md) records their current scope and residuals;
the target architecture includes unfinished work. Never treat documents marked `proposed`
as implemented.

The owner may write to you in Russian. Repository documentation, code comments and commit
messages are in English (D-103). Raw research evidence keeps its original language (the
2026-10-19 lane reports are Russian); the English synthesis is canonical (D-120). User-facing
strings go through locale keys (English source, curated Russian).

## What to read

1. Start with [`docs/NAVIGATION.md`](docs/NAVIGATION.md).
2. For product questions: [`VISION`](docs/vision/VISION.md),
   [`REQUIREMENTS`](docs/vision/REQUIREMENTS.md) and the
   [owner decisions](docs/decisions/2026-10-19-owner-decisions.md).
3. For target design: [`TARGET_ARCHITECTURE`](docs/architecture/TARGET_ARCHITECTURE.md) and
   the ADR named for your area in the [ADR index](docs/decisions/README.md). For any UI work,
   load the [`guanxi-ui` skill](.agents/skills/guanxi-ui/SKILL.md) and follow
   [`docs/design/`](docs/design/README.md).
4. For changes to the retained legacy workbench: the legacy docs in
   [`docs/legacy/alamo/`](docs/legacy/README.md) (Russian) — `DEVELOPMENT.md`, `TESTING.md`,
   `architecture/HLD.md`, `architecture/LLD.md`, `architecture/RUNTIME_LIFECYCLE.md`.
   For newer subsystems, read their source README and the evidence linked from `PHASE_STATUS`.
5. For planned work: [`PHASE_STATUS`](docs/plans/PHASE_STATUS.md), then
   [`ROADMAP`](docs/plans/ROADMAP.md). Do not silently close open decisions; check
   [`OPEN_QUESTIONS`](docs/plans/OPEN_QUESTIONS.md) and record when you used a default.
6. **Read [`WORKFLOW`](docs/plans/WORKFLOW.md) — mandatory.** It is the canonical protocol of
   one slice: orientation, plan, vertical implementation, independent verification, docs and
   commits. A slice without it is incomplete.
7. Owner answers: the newest record wins
   ([2026-11-01 decisions](docs/decisions/2026-11-01-owner-decisions.md) over
   [2026-10-31 decisions](docs/decisions/2026-10-31-owner-decisions.md) over
   [2026-10-24 decisions](docs/decisions/2026-10-24-owner-decisions.md) over
   [2026-10-24 CI protocol](docs/decisions/2026-10-24-ci-protocol.md) over
   [2026-10-23 addendum](docs/decisions/2026-10-23-owner-decisions-addendum.md) over
   [2026-10-23](docs/decisions/2026-10-23-owner-decisions.md) over
   [2026-10-22](docs/decisions/2026-10-22-owner-decisions.md) over
   [2026-10-21](docs/decisions/2026-10-21-owner-decisions.md) over the
   [2026-10-20 addendum](docs/decisions/2026-10-20-owner-decisions-addendum.md) over
   [2026-10-20](docs/decisions/2026-10-20-owner-decisions.md) over the
   [2026-10-19 addendum](docs/decisions/2026-10-19-owner-decisions-addendum.md) over
   [2026-10-19](docs/decisions/2026-10-19-owner-decisions.md) over the legacy records of
   2026-08-18 and 2026-08-02).
8. Working in a parallel lane? Follow [`docs/plans/lanes/`](docs/plans/lanes/README.md): your
   own worktree and branch, your lane's ports, scoped local checks, final hosted CI, and a
   hand-off file instead of the status files below.
9. After every bounded slice, update `PHASE_STATUS.md` and rewrite `NEXT_AGENT_PROMPT.md` for
   the next unfinished slice. If blocked, leave the prompt on the current slice with the
   blocker and recovery steps.

## Knowledge statuses

- `proposed` — suggested, not approved, not implemented;
- `accepted` — explicitly approved, maybe not implemented;
- `implemented` — exists in code;
- `locally validated` — checked by local tests or observation;
- `validated` — confirmed by operational or user data;
- `superseded` — replaced by another decision.

On conflict, code describes current behaviour, an accepted ADR describes the target, and the
roadmap describes the order of transition. Fix the contradicting document in the same task.

## Invariants

- `packages/contract` is the single client↔node wire contract (REST and SSE, Zod). Change
  contract, server, web and tests together. Plugin-internal calls use kernel services.
- The node (server) owns SQLite, the filesystem, shell, runtimes and secrets; clients never
  touch them directly.
- The server binds to loopback by default. Never expose agent/tool APIs to the network
  without the remote security profile: accounts, TLS, scoped credentials and allowed roots.
- SQLite migrations are append-only; never rewrite a migration a user database may have
  applied. Prefer expand/contract for schema changes.
- ESM everywhere, with explicit `.js` suffixes in TypeScript imports where the existing style
  requires them.
- Sessions, runs, attempt streams and hardware/local leases have exactly one writer (session
  home, run home, the executor under a fencing token, the machine that owns the resource).
  Shared configuration is multi-writer with defined merge rules (D-116, ADR-0018).
- Lease ownership changes only by a transaction on the granting node: grant, release, expiry,
  fenced handover or an audited admin break. Timeouts never create a second active holder.
- Chat POST+SSE reads durable job events; a subscriber disconnect does not cancel execution;
  a process restart reconciles state and does not continue inference. Model pulls, HF
  downloads/imports and other connection-owned POST+SSE streams are not durable or
  replayable — do not describe them as background jobs unless a stage converts them.
- The legacy Resource Governor serialises known work with one process-local permit; it does
  not own external clients or other processes. Any model-lifecycle change must consider the
  whole host.
- Never present capability, hardware fit, balance or runtime status as fact without a
  source, an observation time and a confidence level.
- No arbitrary UI ceilings on context, thinking, output, media size or device counts. Limits
  come from the adapter, runtime or policy and are explained; a safe default is never a
  hidden cap.
- Product name, icons and storage prefixes come from the central brand module; do not
  hardcode new brand strings.
- MCP and skills are off by default in the legacy code. Agent autonomy acts only inside an
  immutable project/run policy and never equals unrestricted host access.
- User-facing strings go through locale keys: English source and fallback, curated Russian.
  Do not hardcode bilingual text in components.

## Secrets, reasoning and logs

- Never put secret values in prompts, events, logs, traces, test fixtures or docs. Agents get
  `secret://` references and derived facts only.
- Reasoning/thinking may be stored in the local session log under its retention policy
  (D-113); never write it to plain-text logs and never export it.
- Do not log contents of private workspaces.
- Do not add new plaintext secret fields; the legacy plaintext settings storage in SQLite is
  known debt, not a precedent.

## Third-party code

- [ADR-0016](docs/decisions/0016-licensing-and-third-party-reuse.md) is the single list of
  licenses you may copy from, those usable only as separate processes, and those never used.
  Record every copy in `THIRD_PARTY_NOTICES.md` in the same commit.
- Never copy code without a license or with a license you cannot verify.
- `npm run check:licenses` must stay green.
- Never bundle proprietary agents or SDKs (Claude Code, Claude Agent SDK, LM Studio).

## Commands

```bash
npm install
npm run dev:server
npm run dev:web
npm run typecheck
npm test
npm run test:web:browser
npm run build
npm run lint:md
npm run check:licenses
```

The validation protocol is [CI and local checks](docs/operations/ci.md). During iteration,
run the changed module's tests and affected consumers, not the full gate. `npm run
check:affected -- <base-ref>` prints guidance; it does not execute checks or prove coverage.
Commit at coherent checkpoints; push a draft PR at review/handoff, not after each edit.
A ready PR runs the full parallel hosted matrix. Before declaring the slice complete, run
`npm run ci:finish -- <PR-number> --wait` from its clean, reviewed HEAD and fix required
failures. Record the run URL and tested revision. CI completion is a separate condition from
independent review. Changes to the final candidate require fresh CI.

`npm test` remains available for explicitly justified full local diagnosis. Full CI covers its
leaf suites, browser gates and builds; it is an offline regression envelope, not proof of live
models, paid providers, owner hardware or Secure Enclave. Historical test counts are not
current coverage. Do not retry failures until green or lower assertions to satisfy CI.

The browser gate needs Chromium installed first: `npx playwright install chromium` from
`packages/web` (no postinstall hook). Run the gate only from the repository root or
`packages/web`; a bare `npx playwright` from the root lacks the workspace `baseURL` and fails
with an invalid URL.

Parallel worktrees set three variables:

- `GUANXI_WEB_PORT`: Vite, the browser gate and the server's dev origins; default 5173.
- `GUANXI_API_PORT`: the server and the Vite `/api` proxy; default 4310. It wins over the
  legacy `PORT`.
- `GUANXI_DATA_DIR`: the server's data directory; default `~/.guanxi`.

Ports are parsed strictly (digits, 1–65535) and a busy port fails loudly (`strictPort`), so a
worktree never silently tests another worktree's server. Each worktree needs its own `npm ci`;
see [lanes](docs/plans/lanes/README.md).

## Change boundaries

- Do not edit `node_modules`, `dist`, `build` or `*.tsbuildinfo`.
- Do not modify user data in `~/.guanxi`, the Ollama model store or real workspace files in
  ordinary unit/integration tests.
- Do not use a live installed model in tests without an explicit integration envelope; such
  tests are expensive, hardware-dependent and may load memory.
- Do not delete or rename public APIs, DB fields, localStorage keys, package names or data
  paths without a compatibility/migration plan (the 2026-10-19 rename was a one-time clean
  rename with no existing installs, D-101).

## Change routing

| Change | Minimum to check and update |
| --- | --- |
| REST/SSE schema | contract, server route, web client, route tests, docs |
| DB schema | append-only migration, store tests, recovery/rollback note |
| Run/model lifecycle | ADR-0019/0020, legacy RUNTIME_LIFECYCLE, concurrency tests, UI states |
| Fleet, leases, replication | ADR-0018, simulation/property tests, fault injection |
| Capability, catalog, fit | provenance, cache/staleness, unknown state, provider policy |
| Agent, tool, MCP, plugin | permissions, sandbox, audit, cancellation, trust tier |
| Prompt, tool set, routing, compaction | bench result per ADR-0025 (once B1 exists) |
| UI flow | loading/empty/error/offline states, keyboard, reduced motion, mobile, design tokens |
| CLI/service lifecycle | non-interactive command, exit codes, JSON mode, TUI wrapper |
| Third-party code | license check, THIRD_PARTY_NOTICES entry |

## Definition of done

A change is ready when:

1. behaviour and failure states are observable;
2. types and boundaries are consistent;
3. tests are proportional to risk and their real scope is stated;
4. **every property claimed in docs or a roadmap exit gate has an assertion that fails when
   the property is violated.** `toBeVisible` does not prove absence of duplicates; "does not
   duplicate" needs an explicit count. A claimed but unchecked property is debt, not done;
5. **independent verification was performed as a separate action** (see WORKFLOW), its
   findings fixed, and the fix visible as a separate commit;
6. **the full hosted gate passed for the current ready candidate**, including browser gates
   for web changes; `ci:finish` records exact evidence (see the CI protocol for platform limits);
7. documentation reflects the new current state;
8. residual risk is named, and `proposed` is never presented as `implemented`;
9. `PHASE_STATUS.md` holds evidence split into **new / regression envelope**, and
   `NEXT_AGENT_PROMPT.md` is ready for the next session.
