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

## Independent cross-check fixes

An independent Opus cross-check requested changes (no P1, two P2). Each item is its own commit with a test that failed
before the fix (new `stale-holder`, `limits`, `admission-reconcile` tests; mutants listed in the commit evidence).

- **P2-1, one node crash blocked the wake and the account** (`9aace231`, `8656d073`). K5 gains append-only v3
  (`k5_admission_process`: owner pid, machine boot time, spawn phase, group id and its start time) and a boot
  reconciliation every dispatch waits for. A dead previous owner's holder is released only on proof (rebooted machine, never
  spawned, group gone, or a live group whose pid start time matches the recorded spawn and is SIGKILLed until ESRCH);
  live owners, unrecorded spawns, mismatching start times and holders without v3 facts stay occupied
  (`cleanup_unconfirmed`), keeping the K5 cleanup-uncertainty rule. The K5 "no boot sweep" test and README were rewritten
  for this rule. In the lead service `deferWake` now has a ceiling (`wakeFailureLimit`, default 5): the lead moves to
  `input_required` with `admission_stuck`, `quota_exhausted` or `agent_unavailable` (P3-4), the wake and packet kept,
  and a person's `resume` continues it. Test: a seeded stale holder, restart, the wake is delivered once on the first try.
- **P2-2, the lead set the relay's limits** (`6da733fd`). Immutable owner `limits` (`maxCaps` with all four required,
  `maxDeadlineMs`, `allowDetach` default false), mandatory with `leads.relay`. `guanxi_delegate` refuses null or larger
  caps, a longer deadline and detach before hibernating with `delegation_exceeds_policy: <field>`; without `allowDetach`
  the owner's cancel always cancels the child; `validateExecutor` receives the whole brief. Tests for each field.
- **P3-1** token redaction: the per-turn bearer token is registered with the egress scrubber from the moment the agent
  holds it until the grant ends (registering earlier would redact the `Authorization` header of the very request that
  carries it). Test: an agent that echoes its MCP configuration leaves no token in any K2 event or table.
- **P3-2** test: an agent that ignores `session/cancel` is stopped after the grace period, `usage_unobserved` is noted, the
  ledger is unchanged and no process or holder remains.
- **P3-3** MS1 risk, named: a crashed node can leave a detached agent group running a billable turn (pre-existing K5
  behaviour) until the next start reconciles it; `leads` and K5 READMEs say so.

- **Final short round** (P3-a, P3-b, P3-c). The reboot proof is now a real boot identifier (macOS `kern.bootsessionuuid`, Linux
  `boot_id`, fixed executable, no shell) stored in the v3 facts, not `Date.now() - uptime()`; a clock jump with the same id
  releases nothing, a missing or unreadable id proves no reboot, and the reboot check runs before the owner-pid checks so a
  reused owner pid cannot keep a holder after a real reboot. `maxCaps` is validated by name (the four caps, finite
  non-negative safe integers, no extra or missing key).

Gates for this round at `eaa87468`: typecheck 0 errors, `lint:md` pass, vendor-credential scan pass; `test/leads` 99 tests
(10 new in `stale-holder`, 4 in `limits`, plus the token, cancel-ignored and boot additions) and K5 `test/external-agents` all pass; heavy
`npm test` exit 0 (test:core 2426 tests, 2424 pass, 0 fail, 2 skipped), receipt `check-22vzpm8y`; heavy `npm run build` exit 0,
receipt `check-3zz_b4dh`. Earlier receipts above are for `62ccf831`.

## Next slice

Wire `leads.relay` plus `operationalRelay` in a launcher with a real `validateExecutor`, run the MS1 six-hour scenario with
the owner's installed Claude Code bridge on the owner's machine, and settle the K5 holder break for crashed leads.
