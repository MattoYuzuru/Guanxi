# Instructions for agents

**Status:** implemented · **Updated:** 2026-10-19 · **Scope:** the whole repository

Guanxi is an early-alpha, local-first agent harness. The code in `packages/` today is the
Alamo-era Ollama workbench; the target architecture is being re-founded on an own plugin
kernel. Never treat documents marked `proposed` as implemented.

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
   the ADR named for your area in the [ADR index](docs/decisions/README.md).
4. For changes to the code that exists today: the legacy docs in
   [`docs/legacy/alamo/`](docs/legacy/README.md) (Russian) — `DEVELOPMENT.md`, `TESTING.md`,
   `architecture/HLD.md`, `architecture/LLD.md`, `architecture/RUNTIME_LIFECYCLE.md`.
5. For planned work: [`PHASE_STATUS`](docs/plans/PHASE_STATUS.md), then
   [`ROADMAP`](docs/plans/ROADMAP.md). Do not silently close open decisions; check
   [`OPEN_QUESTIONS`](docs/plans/OPEN_QUESTIONS.md) and record when you used a default.
6. **Read [`WORKFLOW`](docs/plans/WORKFLOW.md) — mandatory.** It is the canonical protocol of
   one slice: orientation, plan, vertical implementation, independent verification, docs and
   commits. A slice without it is incomplete.
7. Owner answers: the newest record wins
   ([2026-10-20](docs/decisions/2026-10-20-owner-decisions.md) over the
   [2026-10-19 addendum](docs/decisions/2026-10-19-owner-decisions-addendum.md) over
   [2026-10-19](docs/decisions/2026-10-19-owner-decisions.md) over the legacy records of
   2026-08-18 and 2026-08-02).
8. After every bounded slice, update `PHASE_STATUS.md` and rewrite `NEXT_AGENT_PROMPT.md` for
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

`npm test` runs server, CLI and web component regression tests. Deterministic Chromium tests
run separately with `npm run test:web:browser`: 40 mocked tests covering legacy slices
P0-A–P3-P. Last local baseline after the 2026-10-19 rename: 40/40 in 5 of 7 full runs; the
other two runs had one failure each (one in `catalog-variant-install.spec.ts`, which passes
in isolation; one unidentified), recorded as a residual in `PHASE_STATUS`. It is a mocked gate without live Ollama, GPU or network; never call it a full
regression suite or production validation.

The browser gate needs Chromium installed first: `npx playwright install chromium` from
`packages/web` (no postinstall hook). Run the gate only from the repository root or
`packages/web`; a bare `npx playwright` from the root lacks the workspace `baseURL` and fails
with an invalid URL.

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
6. **the browser gate `npm run test:web:browser` passed** for any slice that changes web code;
7. documentation reflects the new current state;
8. residual risk is named, and `proposed` is never presented as `implemented`;
9. `PHASE_STATUS.md` holds evidence split into **new / regression envelope**, and
   `NEXT_AGENT_PROMPT.md` is ready for the next session.
