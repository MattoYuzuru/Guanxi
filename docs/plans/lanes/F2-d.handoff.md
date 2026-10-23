# F2-d — relay inference on another node: hand-off

**Status:** implemented and independently reviewed candidate; fixture-validated only (in-process nodes,
fake llama-server). **Date:** 2026-10-23 · **Branch:** `codex/f2d-remote-relay-inference`, lane clone
`/Users/yuzuru/Projects/Guanxi-lanes/f2d`, base `0d5dc746`, main `603ae3d7` merged. Ports 5217/4417, Node 26,
Mac only. No SSH, live model, paid call, Ollama store, `~/.guanxi` or secret was used. No migration, no
dependency, no third-party code. `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are untouched.

## Delivered

The R2 relay runs on the **home** node (lead, workspace, tools, acceptance gates) while every model call is
executed **and counted** by the **executor** node's operational llama-server, through signed F2 messages. See the
[plan](F2-d.plan.md) for the design and its reasons; the short form:

- **Protocol 1.4 / `remote-relay-runtime-v1`.** `POST /attempts/runtime/observe` and `/count` return
  executor-signed evidence echoing a binding (home, executor, model, relay run + R1 fence) and a fresh challenge. The model
  call is the existing F2-b dispatch with `counted` job evidence (content hash, rendered-prompt hash, token count, served
  digest, loaded window) that the executor re-verifies before `/completion` and echoes in the terminal event.
- **Counter.** Asynchronous pre-count plus an identity-tagged synchronous lookup, **not** the `Atomics.wait` bridge (it
  cannot reach the main-thread F2 client and would block the loop that renews the fence). `budget.request` is one
  generator driven synchronously (local meters, behaviour unchanged) or by `requestAsync`.
- **Home runtime.** `relay/remote-runtime.ts`: one session per start (observer, counter, `LocalChatTransport.remote`),
  per-call child run, fence checks before sending and after every answer, fence heartbeat while pending, cancel with ACK,
  executor-loss detection (`interrupted`, never `completed`).
- **Executor.** `LlamaServerRuntime.measure/expectedTransport`, `remote-attempts/relay-runtime.ts`, `Federation.receiveRelay*`,
  `dispatch.work` counted path. The executor never uses the synchronous bridge for a remote job.

## Commits

`0266b67c` plan · `d8a3a11f` feature · `5093aff2`, `a961a896` tests · `6dc32b08` docs/identity tag · `74ae5ca0` window test ·
review fixes `dda21413` (production) with tests `6fe46d78`, `1613b896`, `4da1d657` · merge of main `6e03f94c` · hand-off `c8b0d2f9`, `988ab23c` · cross-check fixes below.

## Gates (Mac, Node 26.9.0, shared lock resource `heavy`)

| Gate | Result |
| --- | --- |
| `npm run typecheck` (all workspaces) | pass, exit 0, after the main merge |
| ESLint on every changed `.ts` | pass, no output |
| `npm run lint:md` | pass, 267 files, 725 links |
| `npm run check:licenses` | pass, 675 packages, 0 not allowed |
| `agent-dev … npm run test`, receipt `check-g7btc327`, head `6e03f94c` | pass: core 2535 tests, 2533 pass, 0 fail, 2 skipped (the two pre-existing Linux-only tests); kernel, web, ui, ui-gates, bench and codemod suites 0 fail. The hand-off file was created while it ran, so the receipt reports `source_changed`; it is an observed result, not a reusable certificate |
| `agent-dev … npm run build`, receipt `check-rse4f65b` | pass, exit 0 |

**New: 58** (first round 48) = `remote-runtime.test.ts` 44, `remote-relay.test.ts` 9 (public start end to end), `budget-async.test.ts` 2,
`llama-server/expected-transport.test.ts` 3. **Regression envelope:** the rest of the core run, 2487 cases including the 224 relay and
llama-server cases, 242 federation, F2-a/b/c, K3 connections and R1 cases re-run directly (466/466, zero skips, before the merge of main).
Two earlier selected runs: 405/405 after the feature commit. The `Atomics.wait` probe and the mutation runs above are in the new files.

## Properties and their failing-when-violated probes

Each mutation was applied, the named file run, and the source restored. Caught unless noted.

- Synchronous stretch: an `await` between `beforeSend` and the transport call; the start observation deferred to a
  microtask; the final request equality check, the abort check and the session fence removed from `beforeSend`.
- Binding: challenge, signature, executor-id and binding echo checks removed from the channel; replayed, forged,
  re-signed, re-attributed and re-bound evidence refused at channel and relay layers.
- Counted chain: executor rendering hash, token count, digest, window and claimed-window checks; contents hash, model and
  parent shape checks on the grant; home terminal echo check (source, hash, tokens); each executor layer alone through
  `expected-transport.test.ts`.
- Fence: session fence before send, after the count answer, after the observe answer, in the heartbeat; the audit note.
- Cancel: not awaited, no ACK, unbounded, in-flight offer/dispatch not awaited, `cancelOffer` branch, window shorter than
  the holder TTL, call deadline, tick (executor loss).
- Pins: parent epoch, pinned-run-as-child, unknown parent. K3 permit for a remote transport. Over-budget strings. Atomics bridge
  in the executor path (`expected` branch and `measure` proof). Staleness, identity tag of remembered counts.
- Survivors judged redundant, not claims: the explicit self-parent clause (covered by the "parent is pinned" refusal, removed),
  the `cancelDispatch` non-ACK status set (unreachable: a cancel always leaves a terminal status).

## Independent verification

`sde-agent:implementation-reviewer` (read-only) reviewed `0d5dc746..` the feature and test commits. One P1, six P2 and
a P3 list; all P1/P2 were fixed in `dda21413` with tests in `6fe46d78`, `1613b896`, `4da1d657`:

- **P1** the executor did not enforce the loaded window itself (a home could claim `num_ctx` 1,000,000): fixed
  (`window === observed`), tested at transport and dispatch level.
- **P2** cancel window not tied to the holder TTL and unbounded requests (now refused at construction, every request raced
  against the window); executor still blocked on the synchronous bridge (removed for remote jobs, proven by an `Atomics.wait`
  probe); session relied on the caller's hook for the fence (own check in `beforeSend` and heartbeat); claim 3 largely untested
  (new tests, mutations above); child pin check compared the child's epoch (now `parent: {runId, epoch}`, counted jobs only,
  never a pinned run); 1 MiB message budget failed late (over-budget strings are reported above every ceiling and packed down).
- **P3 fixed:** orphaned reservation when an aborted offer lands late, heartbeat cadence 250 ms, content hash checked by the
  executor, dispatch no longer imports relay types, broken link.
- **P3 accepted, see residuals:** child ledger records executor-reported tokens before the home's echo check can refuse them;
  K3 collapses the executor's fixed `reason` into `provider_failed`; per-call durable rows are not pruned.

## Residual risk (named, not closed)

1. **No real two-host run.** The Fedora llama.cpp box has not been used; the R2-op caveat that `/props`, `/apply-template`,
   `/tokenize`, `/completion` field names were only seen as strings in a Mac build still applies. The transport is injected;
   F1 requires a private authenticated link (Tailscale/TLS) that this slice does not provide or test.
2. **No model residency lease.** The executor's llama-server stays resident; the F2 reservation is only a per-call process-local
   governor permit. Observe and count are authorized by owner-device trust plus the pinned relay run, not by a session grant.
3. **Pins** are made by the signed pin message (see the cross-check fixes below). A pin left behind when the executor cannot be
   reached at `release()` keeps serving no run of that home, is bounded by the per-peer cap and is not reaped at executor boot.
4. **Toolful remote steps are out of scope:** tools, workspace and gates stay on the home; the remote job is text-only.
5. **Transport budget.** One signed message is 1 MiB, so a prompt larger than about that is reported above every ceiling and
   packed down; a 128k-token window of dense text or code can hit it.
6. **Ledger shape.** The relay run keeps its own call accounting (cap enforcement) and each child holds the executor's report;
   no view aggregates them and they must never be summed together. Per-call child runs and offer rows grow without pruning.
7. The synchronous bridge still exists for the local R2-op path. The judge cascade refuses a meter that needs a runtime transport,
   so a remote relay has no judge model yet (superseded: [R3-remote](R3-remote.handoff.md) binds the judge to the meter's own transport). Governor vocabulary is unchanged (Ollama-only; the executor's llama-server takes its
   permit under a `llama-server:` model name).
8. B3 quality, the six-hour envelope and MS1 are not claimed. ADR-0020 stays `proposed`.

## Shared edits

Contract (`federation/index.ts`: minor 4, relay schemas, `counted`, `parent`, terminal fields); F1 (`channel`, `service`,
`routes`); F2-b `dispatch.ts` counted path; K3 `connections/service.ts` (`LocalChatTransport.remote`, no home permit for it);
R2 seams (`runtime.ts` session hook, `budget.ts` generator, `executor.ts` async measure, `model.ts`, `start.ts` bind/release,
`judge-model.ts` guard); R2-op `runtime/llama-server/runtime.ts` (`measure`, `expectedTransport`, window check). ADR-0020 appendix
and the two service READMEs.

## Next slice

Real-binary smoke of the executor path on the Mac with a tiny GGUF, then the Fedora two-host run over the real private
transport; pin propagation for relay runs; a residency lease for the resident model; pruning of finished child runs; then MS1
measurements on top.

## Independent cross-check fixes

An independent Opus cross-check accepted the lane with one P2 and P3 items. Each fix has its own commit and a test that failed
(or, where noted, was mutation-checked) before it.

- **P2 pin seam (commit "pin the relay run through a signed, awaited pin message").** `onBind` was synchronous, ran inside the
  home SQLite transaction and could only work because the fixture wrote the executor's replicas directly. Now the relay run id is
  allocated before the transaction and `RelayStarts` awaits `prepareBind`: a signed `POST /attempts/runtime/pin` (and `unpin`)
  whose executor-signed ack echoes the request. Creation then verifies the first attempt's epoch and makes no remote write.
  A refused pin refuses the start with no run, session or checkout; a failed creation or `release()` unpins. The fixture no
  longer writes any relay pin: the two-node tests prove the pin exists only through the message, is bound to the asking home, is
  removed on release, and that a completed e2e run leaves none. Pins live in a `relay:` namespace (`RELAY_PIN_PREFIX`), so an
  ordinary pinned run is never a relay parent (P3.3 "live relay run"). Limits are named policy, `DispatchPolicy.relayLimits`:
  `maxPinsPerPeer` 16 and `maxConcurrentCountsPerPeer` 4, refused with 429 (the concurrent-count cap has its own test).
- **P3.1 epoch wording.** R1 leases are always epoch 1, so the epoch recorded in a pin is a consistency check between pin and
  attempt, not a security boundary. The protection is the home's database fence plus the F2-b renewal chain of each child. Plan,
  READMEs and this hand-off now say so; the made-up-epoch-pin test became a pin/attempt consistency test (`bind` refuses a
  different epoch).
- **P3.2 TTL in the grant.** `holderTtlMs` is signed in the grant; the executor holder uses the smaller of it and its own TTL
  (test: home 300 ms, executor 3000 ms, the holder is lost at the home's TTL). The home's cancel wait stays its own TTL.
- **P3.4** An offer carrying `parent` is refused at offer time from a minor-3 peer or by an executor without the relay runtime
  (test mutation-checked; the check landed with the pin commit).
- **P3.5 ledgers.** There is no session-level total in R1, so none could sum them by accident. The sanctioned one is
  `AttemptDispatch.sessionCosts(sessionId)`: `own` excludes relay children, `relayChildren` is returned apart; asserted in the
  end-to-end test (a mutation that merges them fails it). Child runs are identified by their offer's `parent`, no schema change.
- **P3.6** The README names the field `parent: {runId, epoch}`.
- **P3.7 skew.** A test with the executor clock 2 s ahead and 2 s behind proves freshness uses the home's send time (mutation
  to the executor's stamp fails it). A larger skew breaks the existing F2-a reservation expiry (compared on the home's wall
  clock against a reservation capped by `maxReservationMs`), which predates F2-d.
- **P3.8 oversized terminal.** An undeliverable terminal result (about 1 MiB of content) was retried forever while the home waited
  out its 30-minute deadline. The executor now reports a failed terminal with reason `result_too_large` and the usage it spent;
  the call fails in milliseconds (the test hung before the fix). `FEDERATION_BODY_BYTES` moved to `federation/crypto.ts`
  (re-exported from `routes.ts`) to avoid an import cycle.

A mutation check applied during this round also caught a slip of mine: a `git checkout` restoring a mutated file erased an
uncommitted edit (`sessionCosts`); the next commit restores it and the typecheck and the test caught it before the gates.

Gates after the cross-check fixes, clean tree at the commit before this note: typecheck, ESLint on changed files, `lint:md`
(0 errors) and `check:licenses` pass; `agent-dev … npm run test` receipt `check-lrhaubwj` passes (core 2545 tests, 2543 pass, 0 fail,
2 skipped as before; other suites 0 fail); `agent-dev … npm run build` receipt `check-ndy1zwud` passes. New tests: 58 in total
(10 added this round); regression envelope: the other 2487 core cases. No merge of main was needed.
