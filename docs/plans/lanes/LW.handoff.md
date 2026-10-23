# LW hand-off — external lead delegation, hibernation and exactly-once wake

**Status:** implemented, fixture-validated, reviewed (four independent rounds) · **Date:** 2026-10-23 ·
Branch `codex/lead-hibernation`, gated at `62ccf831` (this hand-off is the only later, docs-only commit).
Plan: [LW.plan.md](LW.plan.md). Design and operations: [leads README](../../../packages/server/src/leads/README.md).

## What exists

`guanxi.external-leads` (`lead.external`), a T0 opt-in kernel service (`start({ externalAgents, leads })`).

- `guanxi_delegate` is exposed to an ACP lead over a loopback, per-turn capability HTTP MCP endpoint. The call is
  held unanswered, the turn is stopped cooperatively (`session/cancel`, final usage, process-group cleanup, admission
  release), usage is recorded, and one R1 `delegate` commits. Hibernation holds nothing but the retained scratch resource.
- Wake: one R1 wake, an immutable stored scrubbed packet (4000 conservative tokens), resume by `session/load` or a
  seeded new session, acknowledged by R1 on the first model-produced update or the delegate call.
- Crash safety through a durable delegation intent, keyed idempotent `delegate`, R1 fences and migration 41.
- `lead_unavailable` path (kept wake and packet, back-off, notice, optional named fallback), explicit `resume`.
- Children run through the public `RelayStarts` surface as a mirror of the R1 child (`leads.relay`), or a pluggable `ChildStarter`.
- Cost: ACP cumulative usage becomes ledger deltas keyed by the observed cumulative values; billing fact as data (D-142).

## Evidence (new / regression envelope)

New: **89** tests in `packages/server/test/leads/*` (10 files; the SIGKILL property is 5 generated tests over 47, 47,
32, 32 and 8 boundaries: delegate, delegate with a silent lead, resolve+wake+ack, escalation, cancel).
Envelope: full `npm test` at `62ccf831`: test:core 2410 tests, 2408 pass, 0 fail, 2 skipped (pre-existing opt-ins);
ui:check, codemods, ui gates, kernel, web, ui and bench stages all 0 failures.

| Gate | Result |
| --- | --- |
| `npm run typecheck` (all workspaces) | pass |
| `npm run lint:md`, `check:licenses`, `lint:js` (0 errors; 4 pre-existing web warnings), vendor-credential scan | pass |
| `agent-dev run --resource heavy -- npm test` | exit 0, receipt `~/.local/state/agent-dev/check-af51tdmi/result.json` (HEAD `62ccf831`) |
| `agent-dev run --resource heavy -- npm run build` | exit 0, receipt `~/.local/state/agent-dev/check-7flctcar/result.json` |

Earlier full runs failed twice on `llama-server/process.test.ts` (never-ready window of 600 ms shorter than a node
start under the parallel suite; passes alone and on main) and once on `relay/operational-relay.test.ts` (stop during
checkout allocation; passes alone 3/3 and in the green run). Both are R2-op tests unrelated to this lane. The first got
a minimal window fix (`04a0a357`, shared edit); the second was not edited and is a residual flake to watch.

## Independent verification

Four read-only reviews of pinned diffs; fixes are separate commits: `aa5d88d8` (double billing after a kill, wake
redelivery when the lead delegates before any update, shutdown starting the fallback, absurd cost stranding a turn,
unbounded packet fields, scrub-before-clip task, pump rescans, stale activity semantics), `da15ffe0`/`707f210d`
(counter reset over-billing, executor restart storms, abandoned intents, cost-less turns, failed acknowledgement),
`c78455ca` (relay mirror: capped runs never ended it, deadline never reached the relay run, lease during preparation,
cancel during preparation), `1088095b` (no model start on the mirror, retried deadline stop, stop before failing, shutdown
during preparation). Final reviewer: no blocking defect. Mutation evidence: about 65 source mutants, each guard removed
fails an assertion; surviving ones are equivalent (rebuilding a packet that is read back from the immutable row, an
idempotent flag write, history replay that is already ignored by two other guards).

## Shared edits (outside `leads/`)

K5 `acp.ts`, `service.ts`, `types.ts` (opt-in `RolePrompt.lead`; unchanged without it), K5 fixture process and test helper,
`RunStore.alwaysOnHome` and read-only `costEntries`, `src/index.ts` (`leads` option), `contract/src/lead.ts` and its export,
ADR-0019 implementation note, runs and K5 READMEs, `test/resource-governor.test.ts` (K1 pin allows extra kernel options),
`test/llama-server/process.test.ts` (window 600 ms to 4 s). Migration **41** (Q0 took 40 before merge).

## Residual risks and not done

- No real Claude Code, account, network or model. `session/cancel`, `session/load` with a pending tool call, unstable usage
  fields, `mcpCapabilities.http` and billing behaviour of the real bridge are unverified; fixtures are reconstructions.
- A node killed while a real lead turn is live leaves K5's admission holder occupied (no sweep until an audited break) and may
  leave an orphan agent group; the redelivered wake then fails as `lead_unavailable`. The SIGKILL tests use a scripted agent.
- The ≥ 6 h MS1 gate is shown with a simulated 24 h clock and fakes; no real child or relay run was driven end to end here.
- Acceptance commands a lead writes run as relay gates under the owner's consent; `validateExecutor` is the only guard (required with `leads.relay`).
- Codex leads are refused; `acp` MCP transport, power assertions, F2 handover and UI are out of scope. Notices (`notify`) are a hook; NC1 wiring is later.
- Not promoted: ADR-0019, 0021 and D-142 stay as they are; no PHASE_STATUS or NEXT_AGENT_PROMPT edits.

## Next slice

Wire `leads.relay` plus `operationalRelay` in a launcher with a real `validateExecutor`, run the MS1 six-hour scenario with
the owner's installed Claude Code bridge on the owner's machine, and settle the K5 holder break for crashed leads.
