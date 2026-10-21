# Relay executor (R2)

**Status:** implemented internal single-node service; validation is recorded in the
[R2 hand-off](../../../../docs/plans/lanes/R2.handoff.md).

`guanxi.relay` provides `agent.relay`, loaded after K3 in the default server. Loading it
starts no inference. A trusted execution host initializes an R1 attempt with an immutable
plan and delegation caps, then supplies `RelayInput`: a K3 connection/model, a runtime
meter, reserves and a workspace. There is no HTTP or UI entry point in this slice.

## Runtime and context

The meter must observe the **actual loaded** context window (with source, observation time
and high confidence) and count the **rendered request**, including chat-template tokens.
The service refuses unknown/invalid windows. A catalog maximum or requested `num_ctx` is
not a loaded-window observation. K3 currently has no universal tokenizer/window observer;
an execution-host adapter must supply these observations before live relay admission.
Fixture meters are used in the tests; no live-model quality claim is made.

`H = W - R_turn - S`, `T_hard = H - R_ho - R_tool` and the soft/boundary rules come from
ADR-0020. Every call, including probes and the fresh writer, checks its scrubbed request
against H, including a final check after K3 scrubs immediately before dispatch. Local Ollama also compares `prompt_eval_count` with the meter's count; mismatch
or length termination is a protocol error, never a successful handoff. Output has the
runtime/policy turn reserve. There is no fixed context or cycle ceiling.

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
cannot upload or become last sealed. Reads of last sealed are scoped to the current token.
Explicit recovery under a newly admitted attempt uses the live ledger; it never replays a
pending model/tool call automatically.

Orient checks the artifact digest, ledger hash, references, size and bundle, then asks five
deterministic critical probes. Failure rebuilds a degraded handoff from the authoritative
snapshot and retries once. A second failure emits a J2 request and moves to escalation/input
required. R2 emits judge requests; R3 owns judge execution and verdict policy.

Progress counts verified item/gate changes or a nonempty committed diff. Notes, proposals
and verification requests are not progress. Two empty cycles request J2; three escalate.
Cycle, token, money, wall-time and J3 caps are normative. Calls reserve the full admissible input ceiling plus output reserve as their worst-case
tokens and a host-supplied monetary bound before dispatch. Unknown price with a money cap
refuses dispatch. Failed/crashed calls retain conservative reservations. Exhaustion enters
R1 `wrapping_up`; no new work/model calls run there. The retained ledger is the deterministic
report; a later lead decides completion/cancellation.

## Workspace boundary

`GitRelayWorkspace` uses K4's tools and ExecutionOwner with Full access, a dedicated root,
planner protected paths and harness-owned `.git`. Checkpoints use raw hash-object/update-index/commit-tree plumbing without filters,
hooks or inherited credential environment. Dirty checks also hash raw bytes. Tests/specs/CI paths are additionally rejected
at checkpoint and seal validation. A dirty checkout cannot seal or run a gate.

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
