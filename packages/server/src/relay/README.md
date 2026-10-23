# Relay executor (R2)

**Status:** implemented internal single-node service; validation is recorded in the
[R2 hand-off](../../../../docs/plans/evidence/R2.md).

`guanxi.relay` provides `agent.relay`, loaded after K3 in the default server. Loading it
starts no inference. A trusted execution host initializes an R1 attempt with an immutable
plan and delegation caps, then supplies `RelayInput`: a K3 connection/model, a runtime
meter, reserves, optional execution limits and a workspace. The additive public bridge below
has HTTP and CLI entry points; there is no relay UI.

## Partial trusted public bridge

`POST /api/relay` accepts an explicit owner plan/caps, project, connection, model, start key,
Full-access consent and allowed domains. The strict wire schema accepts no loaded window,
placement, tokenizer or source/confidence claims. Server project/workspace bindings supply roots;
the immutable run policy captures those roots and owner choices. The default server refuses
`runtime_meter_unavailable` before creating a run, attempt or start mapping. A configured runtime
without an owned-workspace allocator refuses `relay_workspace_unavailable` instead. This is a
partial R2 bridge, not an operational stock-Ollama executor or a full R2/MS1 gate.

The trusted `StartOptions.relay` port must supply an exact rendered-request counter bound to
installed digest/runtime identity and an owned isolated checkout allocator. There is no byte-count,
catalog-context or unsandboxed allocation fallback. Loaded W comes from current Ollama `/api/ps`,
matched to an installed artifact. The counter and loaded observation have explicit sources,
timestamps, high-confidence attestations and a host-selected maximum age. Status retains the
admission observations and their age; it does not claim the runtime is still live. Local zero-cost
accounting is an explicit trusted host-compute policy, not an observed provider bill. The counter
port remains responsible for proving local placement and renderer correctness; a loopback address
alone proves neither. Stock Ollama does not supply this port here.

`GET /api/relay/starts/:key` and `/result` return metadata-only status; `POST .../stop` cancels
preparation or its committed run and waits for resource cleanup acknowledgement. Run-id aliases
are available after admission. Identical start-key retries return the same run, changed choices
conflict, and restart reports interrupted work without dispatching inference. Events use the
existing `/api/sessions/:sessionId/stream`; disconnecting that observer does not cancel execution.
All routes require a loopback peer and mutation routes enforce JSON/origin checks. Stop cannot
force a noncooperative allocator to acknowledge cleanup; a known K4 quarantine is retained and
reported as `cleanup_unconfirmed`. Transport settlement is a separate prerequisite for treating
a canceled model call as released; this slice makes no backend-compute cessation claim.

Public start migration **39** uses `relay_start_migrations` and `relay_public_starts`, created
atomically with R1 attempt, K2 session and relay initialization. A failed transaction creates none
of them. Losing the home generation prevents publishing settled state. Rollback disables new
admission and retains additive history; no inference is resumed automatically.

See the [slice plan](../../../../docs/plans/lanes/R2-trusted-start.plan.md) for the bounded scope.

## Operational local runtime (R2-op)

`StartOptions.operationalRelay` is an immutable, explicit boot option of the trusted host. It is
not an HTTP setting and cannot be combined with `StartOptions.relay`. Without it, or when the
binary or model file is absent on this node, the stock refusals above are unchanged.

**Counter: a direct llama-server runtime, not an Ollama sidecar.** The server that is dispatched
to is also the renderer and tokenizer. `/apply-template` renders the one-message `think:false`
request (`enable_thinking:false`), `/tokenize` (`add_special`, `parse_special`) counts it, `/props`
supplies the loaded per-slot `n_ctx`, and dispatch is `POST /completion` of exactly the counted
string. An Ollama sidecar was rejected: Ollama renders with its Go template layer, not the GGUF
Jinja, so equality cannot be shown for an unknown model; the installed llama-server has no
vocab-only mode, so a sidecar means a second full model load; and a llama.cpp-only host has no
Ollama store at all. Stock Ollama therefore still refuses `runtime_meter_unavailable`.

Identity is `{alias, SHA-256 of the GGUF file named by /props, llama-server/<build_info>, n_ctx}`;
the digest is computed once and recomputed when path, size, mtime or inode change. In `spawn` mode
the file's device, inode, size and mtime are also recorded when the child is started, so a file
renamed over the same path afterwards is `runtime_identity_unknown` instead of a silent swap, and a
split GGUF (`-00001-of-0000N`) is refused (`llama_server_model_unsupported`) because its shards are
not hashed. An `attach`ed server cannot be checked this way; shards, `--mmproj` and draft models
are outside its identity. The synchronous
`count` that the executor needs is served by one worker thread doing the two HTTP calls while the
calling thread blocks in `Atomics.wait` with a hard timeout (default 10 s plus 2 s); a timeout or
any invalid reply is `runtime_count_invalid`, never an estimate. The block is milliseconds for an
uncached count on a healthy server and up to the timeout when the server hangs, and it stalls the
whole event loop, so it suits one relay run at a time. Bind proves once per
served identity that the template adds framing, echoes the message once and agrees with the
bridge. Before each POST the transport re-renders, re-counts and compares with the executor's
synchronous count (`runtime_counter_mismatch`), refuses a window overrun, re-runs the final fence
check and issues the POST in the same synchronous stretch, and refuses a `truncated` reply. After
the reply the executor's existing `prompt_eval_count` comparison (`truncation_protocol`) is the
first real-dispatch cross-check; there is no fallback. `tokens_evaluated` is taken to be the whole
prompt including cached prefix tokens (`cache_prompt` is on); if a real binary reports otherwise,
every cached call fails closed and `cachePrompt: false` is the boot-level remedy. No request to a
real llama-server has been made yet: field names were only found as strings in the installed
build 10964.

Dispatch still goes through K3 `localChat` (`transport` option): scrubbing, unattended consent,
the single governor permit (provider `ollama`, model name prefixed `llama-server:`; widening the
governor vocabulary is open) and the usage receipt (`llama-server:/completion`) are unchanged.

**Boot modes.** `spawn` runs the owner-supplied binary with a fixed argv (`--host 127.0.0.1 -np 1
--jinja --no-context-shift --no-webui --alias`), an allow-listed environment and discarded
output, loads in the background (loading means `runtime_meter_unavailable`), never restarts, and
stops only the child it started on close. `attach` uses an existing loopback server (started with
`--alias` and `--jinja`; another host needs a tunnel) and never signals it. The model reference must
be a local one; no cloud name is accepted. The child gets a neutral working directory, and a child
that exits is recorded with its exit code or signal only, because its output is discarded. A crash
of the Guanxi process itself leaves the child running (residual).

**Owned checkout allocator.** `allocate` clones the project's committed history under
`<data>/relay-checkouts/r-*` (a marked directory), detaches at `plan.base`, removes the remote and
every ref, expires reflogs and repacks so no object newer than the base remains, and creates
`runtime/` and `runtime/scratch/`. The source worktree, uncommitted changes and the source
repository are only read. Files are never hardlinked (the K4 sandbox refuses writable hardlinks).
`close()` deletes only a marked directory directly under the allowed root, keeps everything when a
K4 quarantine exists, proves the removal and otherwise reports `cleanup_unconfirmed`, which an
abort cannot hide. A source that borrows objects through alternates is made self-contained and then
checked: the stored objects must equal exactly those `HEAD` reaches. Crash leftovers are not reaped
at boot and removal assumes the sandbox is stopped, which the quarantine check enforces (residual).

## ETA projection (R3-a)

The trusted host may additionally supply `RelayInput.eta`. It contains an exact
model/host/repository cohort, per-item **remaining** duration estimates, completed historical
estimate/actual observations with source and time, and an explicit sampling policy
(`simulations`, unsigned 32-bit `seed`, `minSamples`, `maxAgeMs`). The service refuses a model
that differs from the execution model. Configuration is copied at admission and sampled
synchronously at cycle start and after final gate observations, before handoff construction.
This avoids concurrent projection writes changing an in-flight seal hash. Fresh ledgers
without this configuration retain `null`; recovery retains the last timestamped observation
until the host supplies fresh configuration.

The forecast bootstraps empirical estimate/actual ratios independently per unfinished item,
then sums their durations in serial plan order and reports nearest-rank P50/P80 remaining
milliseconds and finish timestamps. Verified `done` items contribute zero; dependency-blocked
items still contribute. The host supplies remaining estimates; the estimator never subtracts
run age or pretends to know when an item began. Recovery requires a fresh host configuration.
Missing estimates or insufficient recent untainted history return `unknown`, null quantiles
and a reason. A fully completed plan has zero remaining duration even without history.

Every projection includes its observation time, cohort, sample/exclusion counts, source list,
oldest/newest sample time, policy and the serial/independent-ratio assumption. Forecasts have
`low` confidence and `unvalidated` calibration. The optional runtime-counter observation
compares remaining tokens / observed throughput with the P80 duration: a fresh contradiction
is explicit, a stale or future observation is marked stale, and an unavailable forecast is
distinguished from agreement. The `minimumRemainingMs` / `below_runtime_floor` names describe
a constant-observed-throughput heuristic: observed throughput is a baseline, not a proven
maximum speed or guaranteed duration bound. This check does not silently rewrite the
distribution.

Projections use the existing R1-fenced transaction and scrubber, persist in the ledger and
sealed snapshot, and survive store reconstruction. No migration, public API, UI, model call,
judge, wake policy or routing change is added. The host still owns measurement collection and
cohort identity; there is no automatic historical timing collector or calibrated live ETA.
Fixture quantile assertions do **not** satisfy the R3/B3 gate requiring P80 coverage between
0.7 and 0.9 across at least 20 real runs. Judge replay precision/recall, night wake rates,
delegation policy and the six-hour MS1 envelope remain unfinished.

## Judge observations (R3 follow-up)

The trusted host may also supply `RelayInput.judgeSignals`: an explicit
`JudgeSignalPolicy` and a `collect` function. This is T0 data like the runtime meter and the
workspace, never parsed from model JSON or HTTP and not a public wire surface. Admission copies
and freezes the flat policy, checks that `collect` is a function without calling it, and rejects
invalid configuration with a fixed `judge_config_invalid` error. There are no policy defaults:
every threshold must come from the host.

When configured, the executor takes one observation at `cycle_start` immediately after
`store.begin` and the ETA update, before orient or any model call, and one at `pre_seal` after
the final ETA update and before the fresh narrative and handoff construction. The collector
receives a detached ledger copy, a detached attempt identity (`id`, `runId`, `epoch`, `token`)
and the actual run abort signal. It cannot mutate the authoritative ledger or the frozen policy.
There is no timer or background writer; sampling is synchronous with the cycle.

Only the reviewed `judge-signals.ts` pure module evaluates the observation. On success the
executor appends exactly one `agent.note` with
`{relay:'judge_signals', phase, cycle, signals, unknownFacts}` through the existing R1-fenced
transaction. `unknownFacts` names `heartbeat`, `lease`, `deadline`, `disk` and `tokenBudget` for
each missing observation field, so an empty `signals` array is not a health claim. The full
observation and the `protectedPathEdits` / `outOfScopeEdits` values are never persisted or
logged.

A collector rejection or an invalid observation fails the cycle closed with the fixed
`judge_observation_unavailable` or `judge_observation_invalid` code respectively; no judge note
is published and no follow-up model call is made. Cancellation and a revoked/stale fence keep
the existing loss/cancel semantics instead of being converted into an observer error. Signals
themselves do not stop, reroute or wake anything; J2/J3, verdicts, routing and the action
cascade remain separate opt-in work below. Pure observation waits race the run abort signal,
consume late outcomes and cannot hold disposal open; this adds no timer or new cancellation
authority. Resourceful checker/model ownership uses the distinct settlement contract below. Fixture tests prove wiring,
detached inputs, cancellation/fence behavior and seal consistency only; they are not real host
observations, a calibrated classifier, or the R3 precision/recall/night-wake gates.

## Runtime and context

The meter must observe the **actual loaded** context window (with source, observation time
and high confidence) and count the **rendered request**, including chat-template tokens.
The service refuses unknown/invalid windows. A catalog maximum or requested `num_ctx` is
not a loaded-window observation. K3 currently has no universal tokenizer/window observer;
an execution-host adapter must supply these observations before live relay admission.
Fixture meters are used in the tests; no live-model quality claim is made.

`H = W - R_turn - S`, `T_hard = H - R_ho - R_tool` and the soft/boundary rules come from
ADR-0020. Every call, including probes and the fresh writer, checks its scrubbed request
against H, including a final check after K3 scrubs immediately before dispatch. Local Ollama also compares `prompt_eval_count` with the meter's count; a mismatch or an input above H
is a protocol error. Output-length termination is separate: a limited narrative degrades the
handoff, a limited work reply is an invalid action, and any other purpose is a protocol error.
Output has the runtime/policy turn reserve. There is no fixed context or cycle ceiling.

### Execution limits

These are named policy settings, not hidden constants. `relayPlugin({ db, limits })` supplies
plugin defaults and `RelayInput.limits` overrides them for one execution; the built-in defaults
are below. There is no fixed blob limit: bundle objects and gate blobs stream through
`git cat-file --batch`. The remaining 32 MiB buffer is a guard for textual git metadata
commands only.

| Setting | Default | Effect |
| --- | --- | --- |
| `gateTimeoutMs` | `120000` | Timeout for one acceptance command in the clean gate checkout. |
| `goalBytes` | `512` | Upper bound on the plan goal injected into each work prompt. |
| `pageBytes` | `2048` | Page size for `work.query` and `notes.search`. |
| `invalidActions` | `3` | Invalid work turns before the cycle hands off. Valid tool, note, proposal, checkpoint and verify turns do not count. |

Local runtime calls are treated as zero cost: the adapter reports `moneyMicros: 0` because
the host meter quotes local compute rather than an observed bill. This is an assertion shared
with the host, not an observation. A loopback proxy in front of a paid API, or another billed
route hidden behind a local-runtime connection, would therefore count as free. An Ollama model
whose name ends with `:cloud` is reported as unknown (`moneyMicros: null`) instead; the host
must represent other paid routes as `model_api` or supply a priced meter.

The work strip is at most 300 UTF-8 bytes (a conservative token bound). `work.query` pages
the full run ledger; `notes.search` pages matching typed notes. Tool results remain in K2
and K4 output artifacts where applicable. Context turns stay in the current cycle until
wind-down; only the last three enter the fresh narrative writer. Previous narratives never
enter that writer. All calls use K3, all state events use K2, and all persisted/model-facing
values pass the scrubber. Structured provider reasoning is discarded. K3 observes dispatch start before awaiting
the response, so R1 can acknowledge a wake while inference is still in flight.

## Ledger, probes and sealing

The run ledger stores the planner's immutable revision and acceptance argv, dependencies,
protected paths, evidence, observed git state, counters and cap accounting. `verify` requests
harness acceptance; a claim alone cannot mark an item done. `propose` records an amendment
for the lead (D-158). Project boards and external tracker sync remain ADR-0032 later work.

Typed notes are append-only. Selection is stable by insertion order: links to unfinished
items, the last three decisions and unexpired dead ends, within the handoff budget.

`guanxi.handoff/v1` contains a hash/reference to the full immutable boundary snapshot,
a bounded work strip, selected notes and a fresh narrative. The full snapshot lives with
the sealed artifact, avoiding growth of the model context as the evidence ledger grows.
JSON and its deterministic Markdown rendering each fit within 15% of W. Writer failure
uses a ledger-built `degraded` narrative; verification evidence remains authoritative.

`RunStore.mutate` is a trusted synchronous extension seam. It checks the R1 home and attempt
fence inside the same `BEGIN IMMEDIATE` as extension SQL and K2 appends. A seal uploads
JSON, Markdown, its SHA-256, the ledger snapshot and git bundle as one immutable row in the
home database; it updates the live ledger to `sealed` in that transaction. A stale attempt
cannot upload or become last sealed. Reads of last sealed take the run's latest accepted
seal, whichever admitted attempt wrote it; the current attempt still owns the fence. A value
registered after evidence was stored makes the live-ledger read a redacted copy marked
`withheld: true`; the next mutation persists it so the run continues instead of failing every
read. Earlier immutable seals and bundles cannot be rewritten, so their historical bytes are
a retained residual rather than a live-context source.
Explicit recovery under a newly admitted attempt uses the live ledger; it never replays a
pending model/tool call automatically.

Orient checks the artifact digest, ledger hash, references, size and bundle, then asks five
deterministic critical probes. Failure rebuilds a degraded handoff from the authoritative
snapshot and retries once. A second failure emits a J2 request and moves to escalation/input
required. R2 emits judge requests; R3 owns judge execution and verdict policy.

Progress counts a verified item becoming `done`, a gate becoming passing, or a nonempty
committed diff. The first observation of a failing gate, notes, proposals and verification
requests are not progress. Two empty cycles request J2; three escalate.
Cycle, token, money and wall-time caps are normative; J3 review execution belongs to R3, so the relay has no J3 counter to enforce. Calls reserve the full admissible input ceiling plus output reserve as their worst-case
tokens and a host-supplied monetary bound before dispatch. Unknown price with a money cap
refuses dispatch. Failed/crashed calls retain conservative reservations. Exhaustion enters
R1 `wrapping_up`; no new work/model calls run there. The retained ledger is the deterministic
report; a later lead decides completion/cancellation.

## Workspace boundary

`GitRelayWorkspace` uses K4's tools and ExecutionOwner with Full access, a dedicated root,
planner protected paths and harness-owned `.git`. Checkpoints use raw hash-object/update-index/commit-tree plumbing without filters,
hooks or inherited credential environment. Dirty checks use one filter-neutral `git status --porcelain=v2`; object reads are
streamed through one `git cat-file --batch`. Tests/specs/CI paths are additionally rejected at checkpoint and seal validation;
the default heuristic covers `test`/`tests`/`spec`/`specs`/`__tests__`, `*.test.*`/`*.spec.*`, `*_test.go`, `*_test.py`/
`test_*.py`/`conftest.py`, manifests and lockfiles (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`),
jest/vitest/playwright/pytest configuration, CircleCI/Travis/Azure/Buildkite/GitLab/Jenkins and `Makefile`. **The planner must
list any other file the acceptance command depends on**; the default is a heuristic, not a proof of isolation. A dirty checkout
cannot seal or run a gate.

Gates materialize raw objects without archive attributes, `.git` or untracked files, restore planner-owned
protected paths from the base revision and run acceptance argv in K4 Read-only mode.
Linked/gitlink trees are refused before preparation. All done evidence is invalidated
when HEAD changes, and final acceptance rechecks every item at the final HEAD.
A bundle is refused if reachable objects contain a registered secret; compressed bundles
are never scrubbed in place. The host must assign an isolated worktree/root and immutable
sandbox policy; external processes changing that tree are outside the single-writer model.

## Schema and recovery

Relay migration **35** uses its independent `relay_migrations` ledger in the node database;
F1 owns **34** in its federation ledger. The global migrations 1–31 and `user_version`
remain unchanged. Additive tables are `relay_runs`, `relay_notes`, `relay_seals`; notes and
seals have append-only triggers. Failed DDL rolls back. Keep SQLite and WAL in the stopped
node backup. Prefer a forward fix; rollback uses the pre-upgrade backup, without deleting
run evidence. No owner data, installed models, provider network or third-party source copies
are used by R2 tests.

## Opt-in judge cascade and delegation brief (R3 foundation)

A trusted internal host may supply `RelayInput.cascade` (executor optional argument nine, after
`judgeSignals`). Absence creates no R3 tables and preserves prior execution. This is an opt-in
fixture foundation, not an activated product judge/routing policy: real ADR-0025 paired benchmark
evidence is still required. No public route accepts callbacks, inventory facts or model authority.

The immutable version-one brief binds the exact plan and caps to a run and its current attempt
fence before cycle work. It records objective/DoD, estimates, constraints, resources, model roles
and fallback/quota policy, checker pin, judge limits, requested wake policy and report shape.
The brief is copied and deeply frozen; it does not authorize filesystem/network/model effects
by itself. Exact replay is idempotent; changed plan/caps/brief conflicts. Session choice precedes
project choice and policy selection. Hard local-placement/consent filters cannot fall through
a denied explicit selection. Automatic selection requires fresh host-supplied validated calibration,
never a fabricated success probability or fixture prior. Live inventory collection is not included.

Independent ledger 38 shares SQLite with R1/K2 without changing main user_version or existing
ledgers. Each request binds run/attempt/epoch/token/cycle/phase/layer/reason/brief hash and a
harness-evidence digest. Prepare, dispatch reservation and outcome are separate fenced atomic
commits. Exact duplicates never dispatch again; conflicting evidence refuses. Failed/unknown
dispatches retain their worst-case token/money debit. R3 reservations also count in relay caps.
J3 has per-run and account/local-night call/token/money limits, normally at most three strong
reviews; an explicit recorded policy override is required to exceed three. An account's persisted
timezone/night-start anchor prevents another run selecting a different night namespace. This is
accounting, not a real price/usage or calibrated quality claim. Lost-attempt pending requests are
abandoned on reconstruction; no checker/inference automatically resumes after restart.

At cycle start and before sealing, optional J1.5 verifies a lead-owned base/path/content digest
and passes copied verified bytes to a T0 read-only supervisor with explicit timeout/output policy.
No concrete production checker supervisor is included; the host must enforce its declared sandbox
and confirm actual process settlement. A mismatched pin invokes zero checker bodies. J2 uses
exactly two or three fresh tool-free samples with strict taxonomy/verdict/existing-evidence refs
and a non-authoritative diagnosis. Executor claims are quoted untrusted data. Disagreement,
invalid output and missing facts remain explicit; no calibrated confidence is inferred. J3 is
requested only for flagged/probe/final cases and cannot pass an item or override a failing gate.
Three unavailable cycles request one existing R1 parent escalation; multiple phases/samples in
one cycle count once, and a valid J2 resets the streak. Existing hard/probe/no-progress guards stay.

Read-only observation/admission waits may abort-race with late outcomes consumed. Active checker
and model adapters must abort and await actual owned-resource settlement, rather than treating
timeout as cleanup. Every callback boundary has pre/post R1 checks; stale results cannot update
a later cycle or wake a newer attempt. Judge refs enter the next safe ledger snapshot, preserving
sealed ledger/handoff hashes. Completion wake intent may say defer-until-08:00, but current R1
completion still wakes immediately: durable night scheduling is explicitly unfinished.

`ConnectionJudgeModel` uses public K3 with the actual T0 owner account, an exact rendered token
meter and a fresh trusted installed-local digest/consent observation. Local_runtime alone and
model suffixes are insufficient; no API/cloud fallback exists. It does not discover an installed
model or enable inference at plugin load. **Activation dependency:** the current K3 client may
settle an aborted model POST before its injected fetch settles and release its governor permit
early; a separately owned client fix must prove POST/body local settlement and preserve the
after-version final-preparation fence. This adapter has positive fake K3 construction/account/
scrub checks, but active-transport cancellation is not earned until that fix merges. Awaited
local fetch settlement also cannot prove a backend stopped inference.

No real model, paid provider, remote host, toolful F2 workspace bridge or live policy activation
is included. Monthly owner-labelled judge calibration, precision >=0.8/recall >=0.9, >=20-run
ETA P80 coverage 0.7–0.9, B3 quality gates, operational night wake and the >=6-hour MS1 envelope
remain unearned.

## Remote relay runtime (F2-d)

`RemoteRelayRuntime` (`remote-runtime.ts`) is a `RelayRuntimeObserver` factory for a llama-server on
**another owned node**. `RelayRuntimeSource` asks it for one session per start (`open()`); the
session is the observer, the exact counter and the chat transport, and it binds every request to the
relay run and its fence: `prepareBind` (awaited before the run is created) asks the executor to pin the relay run with a
signed message, and `bind` (inside the creation transaction) attaches the attempt without any remote write. Facts come only from the executor's signed evidence (see the
[remote attempts README](../remote-attempts/README.md#relay-inference-on-another-node-f2-d)). There
is no byte count, catalog value or local-runtime fallback: an unreachable, unsigned, unpinned or
mismatching executor is `runtime_meter_unavailable`, `runtime_identity_unknown`,
`runtime_identity_changed` or `runtime_counter_mismatch`, and the home never evaluates a request.

**Pin lifetime (F2-reap).** The executor's `relay:<run>` pin must not outlive its run, including when the home dies. Four rules
keep that true without a second holder of anything (ADR-0018): (1) the home writes its own durable journal row
(`federation_relay_pin_journal`) *before* the signed pin leaves, and deletes it when the executor acknowledges the signed
`unpin`; (2) `Federation.reconcileRelayPins()` sends a signed, fenced `unpin` for every journal row that no session of this
process still needs (after a crash that is every row; a live session is registered in memory in the same synchronous step as
its journal write, so a fresh start cannot be mistaken for an old row), at construction and then every
`dispatch.relayPinMaintenanceMs` (60 s; `0` disables), and a session whose `close()` could not reach the executor leaves its row
to the same reconciliation; (3) the unpin is fenced by the run id and epoch: a pin bound at another epoch is not removed; (4) the
executor leases each pin (`relayLimits.pinTtlMs`, 10 minutes by default), renewed by every valid observe/count and by the live
session's heartbeat (`pinRenewMs`, 60 s, the same idempotent signed pin). A lapsed or lease-less relay pin is deleted on the
executor's own transaction, lazily before every relay request and by its maintenance timer. A lapsed pin only removes a
permission, so a home that is alive but partitioned for longer than the TTL simply re-pins with its next heartbeat, if the
cap allows. Federation **1.5** gates this: an executor refuses (`426`) pin and unpin messages from a home that declares an older
minor, because such a home never renews. A released run id is tombstoned on the executor for one TTL, so a pin or heartbeat that is
slower than the home's own 5 s bound cannot re-create a pin after its unpin. Leases run on the lease clock (the monotonic-anchored
`dispatch.leaseClock`), and an executor restart grants every relay pin one fresh TTL before anything can be swept. The home cannot see the executor's TTL: keep `pinRenewMs` well under `pinTtlMs`, and note that an executor clock jump
or suspend longer than the TTL lapses a live run's pin (the run's next call is `runtime_identity_unknown`, the next heartbeat
re-pins). A journal row for an executor that refuses permanently (another model, no relay runtime, no longer trusted) is retried
every pass and never given up; the executor's lease still frees its pin. Tests: `test/relay/pin-reaping.test.ts` and the pin lines of `test/ms1/rehearsal.test.ts`.

**Asynchronous exact count.** The R2-op `Atomics.wait` bridge is not used over F2: the signing key
and transport live on the main thread, and blocking the home event loop for a network round trip
would also stop the lease renewals that keep the fence alive. The meter gains `countAsync`;
`budget.request` is one generator driven synchronously (local meters, identical behaviour) or by
`requestAsync` (remote). The synchronous `count` K3 needs in `onPrepared` is a lookup of exact answers
already obtained for the identical bytes and refuses on a miss. The answers belong to one served
identity and are dropped when it changes.

**Dispatch.** `LocalChatTransport.remote` (K3) lifts the loopback requirement and the home permit:
the executor's own governor admits the call through its F2 reservation. The final scrub, fence check,
fenced start observation and the signed dispatch request share one synchronous stretch
(`FederationChannel.dispatch(grant, beforeSend)`); while a call is pending the transport heartbeats the
fence so a lost relay attempt aborts and cancels it. `ConnectionJudgeModel` refuses a meter that needs
a runtime transport, so a judge call can never be counted by one runtime and run on another.
