# MS1 local rehearsal — hand-off

**Status:** implemented and independently reviewed candidate; fixture-validated on loopback only. **Date:** 2026-10-23 ·
**Branch:** `codex/ms1-local-rehearsal`, lane clone `/Users/yuzuru/Projects/Guanxi-lanes/ms1r`, base `055d8037`, ports
5219/4419, Node 26.9, macOS only. No SSH, live model, paid call, network beyond loopback, `~/.guanxi` or secret was used.
`PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are untouched. No migration, no dependency, no third-party code.

## What was built

One suite, `packages/server/test/ms1/rehearsal.test.ts`, with helpers beside it. It composes the pieces that MS1 needs and
that were each validated alone (LW, K5, R1, R2/R2-op, F2-b/c/d), and proves that the composition holds the *shape* of the MS1
gate: lead token totals unchanged between delegate and wake, exactly one wake, all items green in a clean checkout, at least
six simulated hours with an injected clock, and a SIGKILL at 15 named home-side boundaries
(no kill during a gate, tool or model call; the executor is never killed).

| File | Role |
| --- | --- |
| `test/ms1/world.ts` | Test process: the **executor** node (a `SimNode`, the real `LlamaServerRuntime` over HTTP to a fake llama-server, an HTTP port), the **home** node as a killable child process, read-only SQLite views, the clean-checkout verifier. |
| `test/ms1/home-process.ts` | The **home** node, a real child process composed from production classes (below). |
| `test/ms1/llama-script.ts` | The fake model: a pure function of the prompt (per cycle: write a file, checkpoint, re-verify items, hand off; probes and narratives answered from the prompt). |
| `test/ms1/invariants.ts` | Cross-table facts that must hold after any kill and at rest (LW's, plus relay and F2-c rows). |
| `test/ms1/rehearsal.test.ts` | 20 tests. |

How the nodes are composed (real unless stated):

- **Home:** `bootServerKernel` with federation and durable runs; connections; K5 `externalAgentPlugin` running the K5 **ACP
  fixture agent** (the one the K5 and LW suites use) as `claude-code`; `RelayStore`, `RelayStarts` (the *public* start),
  `OwnedCheckoutAllocator`, `GitRelayWorkspace` and `RemoteRelayRuntime`; `createLeadPlugin` with `relayStartsChildStarter` and
  `relayStartsChildReporter`, the owner's `limits` and a `validateExecutor` allow-list. Acceptance gates run in the K4 sandbox
  (Docker/Colima on macOS). It listens on a loopback port for the federation routes (renewals, dispatch events).
- **Executor:** its own `Federation` with `AttemptDispatch` and the F2-d relay runtime, `LlamaServerRuntime` talking HTTP to a
  fake llama-server (`test/fixtures/fake-llama-server.ts`, a worker thread; tokens are words, the template is fixed).
- **Link:** the real signed F2 protocol (`FederationChannel`) over plain loopback HTTP between two processes.
- **Time:** an injected clock (`clock`, which is also R1's lease clock) that moves only at a **gap**: the first runtime
  observation of a relay cycle after the first, wrapped around the remote session. Nothing is in flight there, so no F2 holder
  lease can lapse and the executor can be told the new time before anything is signed. Each gap adds 75 simulated minutes; R1
  leases are 100 simulated minutes.
- **Kills:** the home sends itself `SIGKILL` at a named label. Labels come from the existing hooks (R1 `fault`
  `<operation>:<point>`, LeadService `fault`, `RelayStore` `fault`) plus labels in the loopback transport and route and around
  the mirror's `complete`. A new process then starts on the same data directory; the clock continues from the last time the
  parent was told.

## What the rehearsal proves

Numbers refer to the steps of the brief. Each bullet names an assertion that fails when the property is violated; the mutation
list below shows which ones were actually broken to check.

1. **Delegation within limits.** The ACP fixture lead calls `guanxi_delegate` over the per-turn bearer endpoint with a
   six-item plan, every item with an acceptance command and a cap on every axis. Five briefs the owner's policy forbids (a
   larger money cap, a null wall cap, a longer deadline, `detach`, an executor not on the allow-list) are refused inside the
   composed node; the lead is not hibernated, no relay starts, the executor is never contacted.
2. **Hibernation.** After the delegating turn: no agent process (`ps` by the world's unique executable path, plus the recorded
   pid), no live attempt, no execution lease, state `waiting_children`; the lead's cost ledger is snapshotted. A positive
   control finds the agent process during the resumed turn, so the zero checks can fail.
3. **Remote inference.** The plan runs through the public `RelayStarts`. The executor receives exactly one signed `pin` and one
   `unpin`, observe and count requests for every call, and one dispatch grant per fake-llama completion; the loaded window and
   the meter come from the executor (`REMOTE_RELAY_*` sources). F2-c: one child run per call, each with exactly one
   `remote-dispatch:` cost row, and the multiset of their input tokens equals the token counts of the strings the fake
   llama-server evaluated, call for call. The relay run's own cap accounting and the child ledgers agree and are never summed.
   The lead's ledger holds `lead-turn:` rows only.
4. **Gates.** Items end `done` in the relay ledger with a passing gate at the final head, and again in an independent clean
   checkout (a fresh clone at the plan base plus the stored git bundle) whose head equals the ledger head; the same commands
   fail in a control clone that never received the work. During the run the model's files exist in the owned checkout and the
   project clone's working tree and HEAD never move. A gate prints a **canary** registered with the egress scrubber; the
   redaction marker is in the evidence and the canary is in no packet, prompt, executor prompt or file of the home node.
5. **Six simulated hours.** Five gaps of exactly 75 minutes (6.25 h) in about 30 real seconds. At each gap: the lead sleeps, was
   not woken, its cost ledger is byte-equal to the snapshot, no agent process, no live lead attempt, the lead's 8 h deadline
   timer is still pending, the mirror and relay runs are `working` with leases beyond the new time, the ledger has no pending
   call, no remote call is open, the cross-table invariants hold, and the executor pins exactly the relay run.
6. **One wake.** One `outbox` row, acknowledged; one `lead_wakes` packet, built once (one `wake_packet` note); the agent was
   prompted once; the promise resolved by completion, not by the deadline. At the moment the wake prompt reached the agent the
   lead's ledger was deep-equal to the snapshot of step 2; afterwards it gained exactly its own resumed turn. The packet lists
   each of the six items once as `done`, one newest gate per item, the final head, the relay's own metrics, fits 4000 tokens and
   carries no path, bearer, reasoning or model file. The home shuts down cleanly (exit 0).
7. **Kills.** Fifteen `SIGKILL`s, each followed by a restart on the same data (`atKill` checks the disk at the instant of the
   kill, so the name of each case is proven, not assumed):

   | Boundary | Label | After restart |
   | --- | --- | --- |
   | delegate, promise not committed | `hibernate:before_commit` #1 | intent completed, plan runs, wake, green |
   | delegate, promise committed | `lead:delegate:committed` #1 | child started by recovery, green |
   | relay start, before the run | `create_started:before_commit` #2 | same key re-attached, a fresh relay run, green |
   | relay start, run committed | `create_started:committed` #2 | relay `interrupted`, lead woken once `failed`, all items `open` |
   | remote pin acknowledged | `net:pin:acked` #1 | fresh run, green |
   | between cycles | `gap:2` | `failed`, `i1 i2` done, `i3` open |
   | terminal ingest, before / inside / after the transaction | `net:terminal:before_ingest`, `complete:before_commit`, `complete:committed`, `net:terminal:after_ingest` #7 | `failed`; the remote call is billed exactly when it completed (one row or none, never two) |
   | relay finished, mirror not ended | `mirror:complete:completed:before` #1 | mirror ends, one wake, green |
   | wake delivery, claimed / packet stored | `lead:wake:claimed`, `lead:wake:packet_built` #1 | one wake; a stored packet is delivered unchanged |
   | ack, agent running before it | `lead:turn:before_ack` #2 | wake prompt may start twice, same packet, completes once |
   | ack committed, agent running | `lead:turn:acked` #2 | never replayed by the node; one explicit `resume` finishes it |

   Every case ends with exactly one acknowledged wake, one packet whose items are the plan's ids once each and equal the relay
   ledger, `PRAGMA integrity_check`, foreign keys, contiguous session replay and lease/attempt coherence, no live attempt and no
   agent process. In the K5 case the killed home leaves a live agent whose owner process is dead; boot reconciliation releases
   it and the wake is delivered.

Also covered: a lead deadline of 3 h passing across two gaps stops the relay (cancel after wrap-up), releases the pin and the
checkout and wakes the lead once with `deadline`; an owner cancel between cycles cancels lead, mirror and relay, unpins, wakes
nobody and no model call follows.

## What it cannot prove

- **Real models.** The model is a pure function of the prompt; the "tokenizer" counts words; no quality, no latency, no
  llama-server binary. R2-op's residual 1 (field names of a real `/props`, `/tokenize`, `/completion`) is untouched.
- **A real Claude Code.** The lead is the ACP fixture. `session/cancel` on a live tool call, `session/load`, unstable usage
  fields, `mcpCapabilities.http` and the billing behaviour of the real bridge are as unverified as in LW.
- **Two real hosts.** Both nodes run on one Mac and one OS clock source; no latency, partition, skew beyond what F2-d tests, no
  second filesystem; the executor is never killed; the F1 private authenticated link (Tailscale/TLS) is not provided or tested.
  The link is plain loopback HTTP; the keys are per-test.
- **A real six hours.** The clock moves only at quiescent gaps and R1 leases are 100 simulated minutes, whereas production uses
  30 s and 60 s on real time. Lease renewal through hours, a call that outlives a lease, laptop sleep and wall-clock steps are
  not exercised. A real run still has to show the node surviving six hours.
- **R3/B3 quality.** No judge, no ETA calibration, no bench, no replay corpus (see the blocker below).
- **TLS, accounts, remote security profile.** Out of scope as in F1/F2.
- **The production host.** `start()` is not used: the home hand-composes the same classes (`RelayStore`, `RelayStarts`, the lead
  plugin) because `start()` has no injectable clock and no wiring for `RemoteRelayRuntime`, `relay.runtime.observer` being a
  library seam only. The legacy app context, HTTP app, `nodePorts` protection (empty here), notifications and the UI are absent.
- **Linux/Fedora.** The gates need the container runtime on macOS; Linux paths are untested here.
- **Kills during a gate, a tool call or a model call on the executor.** Not injected. After a kill, leftover owned checkouts and
  sandbox containers are not asserted (R2-op residual 5).

## Integration bugs and findings

1. **Fixed (`4e2c370c`): the wake packet listed every item's gate several times.** `relayStartsChildReporter` took all evidence
   at the current head, but the relay appends a row for each gate run and re-verifies every item when its plan closes, so a
   six-item plan sent twelve gate rows (after a retry, more) and spent packet budget on repeats. The reporter now hands over one
   result per item: the newest at the current head, in plan order. A failure after a pass stays visible. The new unit test failed
   before the change with the raw log rows. Found by the first complete run of the happy path.
2. **Not fixed, measured: a stale pin per kill.** Every kill after the executor acknowledged the pin (8 of the 15 kill points,
   the cases flagged `stalePin`) leaves one `relay:<run>` pin on the executor for a run that died with the home. F2-d records
   this (residual 3: not reaped); the rehearsal shows the rate: one per crash, the live run's pin is never confused with it,
   and `maxPinsPerPeer` is 16, beyond which a new relay on that executor is refused (the cap itself was not exercised).
   Closing it needs a home-side reconciliation at boot (unpin the relay runs whose start row is `running` without a live start)
   or an executor-side lifetime. The `stalePin` expectation is a tripwire: it turns red when this is fixed.
3. **By design, now quantified: a relay run does not survive its node.** Six of the fifteen kill points (everything after the
   relay run exists and before it ends) end with a `failed` wake and the ledger as it stood; the run never resumes inference
   (R2, ADR-0020). For MS1 that means a six-hour run is lost by any node restart in those hours and the lead must re-delegate.
4. **Observation (no failing case): units.** `AttemptDispatch.prepare` takes the minimum of the job deadline, `clock()+reservation`
   and an R1 lease expiry (`Number(lease.expires_at)`), mixing the wall clock with R1's lease clock. They share a scale only while
   `leaseClock` tracks the wall clock; production's default is monotonic and excludes suspend, so after a host sleep the offer
   would already be expired. The always-on assertion makes this moot on the intended home. The rehearsal moves both together.
5. **Observation: K5 recovery in a real second process.** A kill during a live lead turn is recovered by K5's boot reconciliation
   (owner pid dead, group proven gone or killed) with no manual break. An in-process "restart" would not show this (the owner pid would still be alive), which is why the
   home is a child process.

## The R3 judge gap: recorded, not closed

> **Update (R3-remote, 2026-10-23): seam implemented, fixture-validated; production wiring open.** The public start now takes a
> per-start judge source and the judge model runs on the transport that counts
> ([`R3-remote.handoff.md`](R3-remote.handoff.md)); the rehearsal runs with the judge on and the two tripwires below were replaced
> by assertions. What is **not** closed: the production host passes no judge source (`ms1-live-host` owns `index.ts`), and nothing
> maps the lead's delegation to the `RelayDelegationBrief` the cascade needs, so a relay started by the real host still has no judge
> until that is written. The text below is the record as of the lane's base.

The rehearsal runs **without a judge** and asserts it (no `judge` event in the relay session; a test that the judge model
refuses a transport-carrying or async-counting meter and accepts a local one). Two separate gaps stand behind it:

- `RelayStarts` builds its `RelayExecutor` without `judgeSignals` or `cascade` ("integration seam ... when that module merges"),
  so a relay started through the public start, local or remote, has no judge at all.
- `ConnectionJudgeModel` refuses any meter with a `transport` or `countAsync` (`judge_config_invalid`), because the judge
  dispatches through K3's Ollama path and a remote or llama-server meter would be counted by one runtime and run on another.

A minimal seam is not small: it needs a per-start host option carrying the judge input, and judge dispatch through the meter's
transport (F2-d's `LocalChatTransport.remote`), then a rerun of this suite with the judge on. **MS1 blocker:** no judge observes a
remote relay; R3's gates (loop and premature-done detection, night wake rate, ETA coverage) cannot be claimed for MS1 until it does.
Both tripwires fail loudly when closed.

## Gates

Mac, Node 26.9.0, shared lock resource `heavy`, clean tree at `971f364c` (this section is the only later, docs-only change).

| Gate | Result |
| --- | --- |
| `npm run typecheck` (all workspaces) | pass |
| `npm run lint:md` | pass, 272 files |
| `npm run check:licenses` | pass, 675 packages, 0 not allowed |
| `npm run lint:js` | 0 errors, 4 pre-existing web warnings; ESLint on every changed file is clean |
| `agent-dev … npm run test`, receipt `check-mgq_8cxn` | exit 0: `test:core` 2698 tests, 2696 pass, 0 fail, 2 skipped (the two pre-existing Linux-only opt-ins); kernel, web, ui, ui-gates, bench and codemod suites 0 fail |
| `agent-dev … npm run build`, receipt `check-i8149b1f` | exit 0 |
| `node --test test/ms1/rehearsal.test.ts` alone, three runs | 20/20 each, about 3 minutes (the full run above was 20/20 too, while other lanes were using the machine) |

**New: 21** = `rehearsal.test.ts` 20 (happy path 1, deadline 1, cancel 1, refused briefs 1, judge blocker 1, kills 15) and
`leads/children.test.ts` 1. **Regression envelope:** the other 2677 core cases plus the non-core suites. Main moved to
`e2b3a50c` (the NC1 notification-center UI, web files and one server README line) after this branch was cut; it was not merged
into the branch, nothing in it overlaps the files changed here.

## Independent verification

A separate read-only reviewer (`sde-agent:implementation-reviewer`) examined `055d8037..d383d2a1` with the claims above. No P1.
Nine P2 findings were fixed in the commit after the review (each is visible in the history): missing hand-off; no positive
control for the process check and only the first turn's pid checked; quiescence at the gap not asserted outside one crash test
(now pending call, open remote calls, invariants and leases at every gap); "gates run in the owned checkout" proven only by
cleanup (now files present during the run and the project untouched); lease validity not asserted; a performance assertion on real
time and tight waits (loosened); no container-runtime precondition (now a loud preflight); "scrubbed" without a canary (now a
registered canary); no kill inside the F2-c transaction (two added). P3 items fixed: snapshot race at the first gap, cancel test
wording, `invariants.ts` wording, unguarded cleanup, restart loop not failing, weaker report test. P3 noted, not changed: output
tokens are not compared call for call with the executor; the crash cases compare items, not gates or metrics; `resumeDelayMs`
(1.5 s) bounds a timing window in the cost-at-wake check; the blocker test builds its meter by hand.

## Mutation evidence

A source mutation was applied, the named test run, and the source restored. Caught: F2-c ingest without the cost; a crashed
relay reported `completed`; the mirror lease renewal removed (the 6 h gaps expire it: this shows the simulated time is not
decorative); the delegating turn not hibernated; the packet rebuilt at redelivery (needed the `wake_packet` note count; the packet
immutability trigger alone hid it); the executor never unpinned on cancel; the canary not registered; the old duplicate-gate shape.
Survivors, judged equivalent: an acknowledged wake redelivered by `RunStore.deliver` alone (`dispatch` filters them in SQL).

## Shared edits

Production: `packages/server/src/leads/children.ts` (finding 1) and one paragraph in `packages/server/src/leads/README.md`.
Tests: `packages/server/test/leads/children.test.ts`. Everything else is new under `packages/server/test/ms1/`.

## Residual risk and next slice

- **Blockers for MS1 before the owner-present run:** the judge seam (above); a boot option that wires `RemoteRelayRuntime` into a
  host (there is none; the rehearsal builds it by hand); the stale-pin reaping (finding 2); an injectable clock in `start()` if a
  rehearsal is to use the production boot.
- **Owner-present:** restore `ssh fedora`; an integration envelope for a first real llama-server smoke run and a real Claude Code
  lead; then the six-hour run on the Fedora node with R3/B3 evidence, as in `NEXT_AGENT_PROMPT`.
- The suite takes about three minutes on the Mac (about 30 s for the six-hour case, 3 to 14 s per kill) and needs the container
  runtime; it fails at once with a clear message when that is missing.

## Independent cross-check (Opus, 2026-10-23)

Accepted, no P1. P2 fixed by the integrator: wording now says "a SIGKILL at 15 named home-side
boundaries" instead of "every boundary" (here, in the leads README and in the test header). P3s
recorded, not changed: counting-before-dispatch is asserted in total, not per request; "completes
once" is asserted as at most once in one case; the lead-billing prefix check is trivial in the
`hibernate:before_commit` case; K5 orphan release is asserted by end state only; the no-call
windows after stop/cancel are 800 ms.
