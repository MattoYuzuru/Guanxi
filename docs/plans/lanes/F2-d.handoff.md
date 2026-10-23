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
review fixes `dda21413` (production) with tests `6fe46d78`, `1613b896`, `4da1d657` · merge of main `6e03f94c` · this hand-off.

## Gates (Mac, Node 26.9.0, shared lock resource `heavy`)

| Gate | Result |
| --- | --- |
| `npm run typecheck` (all workspaces) | pass, exit 0, after the main merge |
| ESLint on every changed `.ts` | pass, no output |
| `npm run lint:md` | pass, 267 files, 725 links |
| `npm run check:licenses` | pass, 675 packages, 0 not allowed |
| `agent-dev … npm run test`, receipt `check-g7btc327`, head `6e03f94c` | pass: core 2535 tests, 2533 pass, 0 fail, 2 skipped (the two pre-existing Linux-only tests); kernel, web, ui, ui-gates, bench and codemod suites 0 fail. The hand-off file was created while it ran, so the receipt reports `source_changed`; it is an observed result, not a reusable certificate |
| `agent-dev … npm run build`, receipt `check-rse4f65b` | pass, exit 0 |

**New: 48** = `remote-runtime.test.ts` 36, `remote-relay.test.ts` 7 (public start end to end), `budget-async.test.ts` 2,
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
3. **The executor-side run pin is host-provisioned.** `RemoteRelayRuntimeOptions.onBind` must create the explicit F1 pin;
   propagation of run pins between nodes is not built. Without it every bound request is refused.
4. **Toolful remote steps are out of scope:** tools, workspace and gates stay on the home; the remote job is text-only.
5. **Transport budget.** One signed message is 1 MiB, so a prompt larger than about that is reported above every ceiling and
   packed down; a 128k-token window of dense text or code can hit it.
6. **Ledger shape.** The relay run keeps its own call accounting (cap enforcement) and each child holds the executor's report;
   no view aggregates them and they must never be summed together. Per-call child runs and offer rows grow without pruning.
7. The synchronous bridge still exists for the local R2-op path. The judge cascade refuses a meter that needs a runtime transport,
   so a remote relay has no judge model yet. Governor vocabulary is unchanged (Ollama-only; the executor's llama-server takes its
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
