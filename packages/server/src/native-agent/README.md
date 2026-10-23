# Native agent (K4)

**Status:** partial implementation; PID-namespace execution owners implemented; validation recorded in the [K4 evidence](../../../../docs/plans/evidence/K4.md).

`guanxi.native-agent` provides the frozen `agent.native` facade. It requires R1's `runs.durable`, K3's `connections.registry`, K2's `session.log` and `egress.scrubber`. API-key models use K3
`complete`; local Ollama uses K3 `localChat` and its governor. Subscription agents and service
connections remain K5/provider work. There is no credential fallback or direct provider call.

## Policy and ownership

The session snapshots its connection, model, access mode, roots, protected paths and network
allowlist at creation. Later project-root edits affect new sessions. Native root overrides
reuse registered Workspaces and live in the private `native-projects.sqlite` sidecar, schema
v1 (`PRAGMA user_version = 1`, `project_roots`); missing overrides use the legacy Project
bindings. An empty override means zero roots. Root overrides do not change the shared node
schema. Native session lifecycle and R1 execution budgets use append-only node migration 32
(see below). Removing the sidecar restores legacy bindings for new sessions; existing session
policies remain intact.

Launcher bytes are captured at node boot and copied to a private directory outside writable
roots for each invocation. Editing a working checkout cannot replace the next launcher; the
installed dependency tree and Node executable directory are deny-write paths. A fresh
sandbox-runtime worker owns each command's runtime singleton and TLS proxy. All arbitrary
commands go through one `ExecutionOwner` interface. Linux requires the upstream bubblewrap
profile with `--unshare-pid --die-with-parent` and a fresh `/proc`; a weaker profile is refused.
macOS uses one local Linux container per arbitrary command, with `--rm --init`, read-only image,
no workload capabilities or inherited credentials, and `--network none`. The trusted runner
uses a distinct UID with only SETUID/GID, then clears workload capabilities. Its trusted stdio
bridge reaches only the host's sandbox-runtime method/domain proxy. A workload-only seccomp
filter denies arbitrary Unix
sockets and local binding. Successful execution requires confirmed container removal, including
after a worker crash. Stop allows one second for the worker, then forces termination; parent
container removal/inspection has a five-second deadline. Unconfirmed cleanup fails the session with
`cleanup_unconfirmed` and retains a private `native-cleanup/<owner-name>.json` root quarantine
across unload and restart. Interrupted container creation also retains quarantine unless the
worker acknowledged successful creation or confirmed no create was attempted. New sessions and
continuations cannot use overlapping quarantined roots. Healthy active writers still report
`root_busy`. Recovery requires checking the named container with the captured local runtime,
removing it, confirming absence, and only then removing its quarantine record; there is no
automatic quarantine expiry or implicit second writer.
Fixed trusted commands retain the Seatbelt fast path on macOS without a container runtime. No
unsandboxed fallback exists. Workers receive a small environment without inherited keys,
agent credentials, startup scripts or debug flags. Proxy sockets and CA files use a short
private directory outside writable roots; command HOME/TMPDIR remain scratch.
The network directory uses `/tmp` on Linux and `/private/tmp` on macOS, independently of
the parent's TMPDIR, so a valid long temporary path cannot overrun the runtime's Unix socket
pathname capacity. Worker staging still follows its configured runtime base.
The container runner drains stdout/stderr through stream close after shell exit, with a 100 ms
deadline for inherited open pipes; reaching that deadline explicitly reports `truncated`.
Runtime stdout/stderr never enter plain
logs; command output is returned over IPC and scrubbed before the model or session trace.

- Read-only: roots/attachments readable, scratch writable. Arbitrary shell commands require
  an execution owner. Plain `pwd`, `ls`, `cat`, `head`, `tail`, `wc` use fixed absolute binaries.
  The OS boundary also applies to trusted file/search/fetch implementations.
- Full access: scratch and all project roots writable, attachments immutable. Zero roots
  means scratch only. Protected paths deny writes in both modes, retaining both lexical
  names and canonical targets (including absent children beneath linked parents).
  Unresolved/dangling protected links refuse session creation. Sessions created by earlier
  development commits of this unmerged lane must be recreated; there is no deployed K4 policy migration.
- Egress: exact host/optional-port allowlist, default empty. Every IP literal (IPv4/IPv6,
  including numeric aliases and unspecified addresses) and localhost entry requires an
  explicit valid port. The request filter rechecks that service port for both backends,
  including old/internal policies with port-less IP grants. The node's actual API and configured web ports are reserved on every
  destination, including loopback, local interfaces and DNS aliases; checking the port before
  resolution also prevents a DNS re-resolution bypass. Continuation refreshes these reserved
  ports after restart. HTTPS is TLS-terminated using
  an ephemeral worker CA; Read-only allows GET/HEAD/OPTIONS. Opaque CONNECT/SOCKS tunnels,
  direct sockets, arbitrary Unix-socket connections and local binding are denied in both modes. Redirects are
  not followed by `fetch`; domain policy also applies to subsequent proxy requests. Each parsed
  request asks the trusted parent to compare its URL and headers with the live egress scrubber.
  Any change, absent/not-ready scrubber or IPC failure denies the request. Registered values
  are never copied into worker policies. Only exactly registered forms are covered:
  encoding, splitting across requests or headers, and case changes remain
  **K4-EGRESS-ENCODINGS**. Request bodies are not inspected (**K4-EGRESS-BODIES**).
- Upstream convenience write grants are explicitly denied. OS executable/library/config
  reads and stdio devices are necessary exceptions to project-only file access. Roots that
  overlap the node data directory are refused; use a separate data directory for a checkout
  that would otherwise contain `.lane-data`.
- Before each write grant, writable trees containing hardlinked regular files are refused.
  A pre-existing hardlink can otherwise modify an inode with another name outside the roots.
  This includes package-manager trees built from hardlinks; use an ordinary copy. The check
  reads metadata only. Root ownership excludes another native writer while this check runs;
  uncooperative external processes changing the same filesystem are outside that ownership.
- macOS arbitrary shell requires a reachable local Unix-socket Docker endpoint (Colima/Lima
  or Docker Desktop) and the execution image. It never mounts the whole home directory and adds
  no dedicated Docker-socket mount. Selected roots may contain sockets; workload Unix-socket
  connections are denied. The image uses a digest-pinned Node 26 Debian slim base; run
  `DOCKER_CONTEXT=colima sh packages/server/scripts/prepare-native-execution.sh` to provision it.
  Commands select the inspected content-addressed image ID, not a mutable tag at execution.
  The absolute Docker CLI is captured and canonicalized at node boot; writable trees containing
  its replacement points refuse both arbitrary and fixed invocations. Installing Docker after
  node boot requires restarting the node to capture it. Trusted Node/dependency/helper deny-write
  grants cover both backends, including roots nested inside a protected runtime directory.
  Colima must share the selected roots and node data directory; an unshared path fails closed.
  The default Colima profile shares only the home directory and `/tmp/colima`: run container
  fixtures from a checkout under home, not `/private/tmp`. The macOS network assertion checks
  that `/sys/class/net` contains exactly `lo` and denies a raw connection to a non-loopback
  fixture that an ordinary bridge-network container first proves reachable. Host-created Unix
  sockets alone cannot prove this property across the Colima VM filesystem boundary.
  Commas in bind paths are refused. Absent protected paths conservatively make their nearest
  existing parent read-only. No runtime/image means arbitrary shell is disabled with a localized
  reason; fixed read commands remain available. Image provisioning is never done by a tool.
- Linux requires `bwrap`, `socat` and `rg` on the worker PATH, plus the packaged apply-seccomp
  helper and util-linux
  `setpriv` with `--seccomp-filter` support. After trusted proxy bridges start, a workload-only
  BPF filter denies bind, listen, ptrace, process_vm_writev, unshare, setns, mount, socketpair
  and non-INET sockets. x64/arm64 audit ABIs and unknown/x32 syscall numbers are checked;
  missing/degraded dependencies refuse execution.
  Windows refuses all sandbox execution. Platform validation scope and residuals are in the handoff.

## Session surface

`/agent` is an interim new-session screen; `/agent/:id` projects progress from the log, with
plan, queue, latest response, continuation and stop. Native folder overrides are separate from
legacy Chat bindings. Registered folder names can be selected and saved; an empty set is valid.
The session action controls use the shared `@guanxi/ui` Button (in review) and semantic tokens.
The rest of this interim screen still includes legacy form primitives; no new shared primitive or owner approval is claimed.

Loopback-peer-only `/api/agent` routes use the whole-server Host gate and same-origin mutation
checks. Creation returns 202; HTTP disconnection does not cancel the node-owned execution.
The caller cannot choose the query tool's audience: this conservative binding always excludes
reasoning. K2's inspector remains the person-facing detailed trace.

The light plan is explicitly off-ledger, agent-reported state: `verification_requested` never
means harness-verified completion. Queue entries are visible/removable and consumed once during
the live process. Explicit prompts can continue a completed/interrupted session or answer `input_required`.
Overlapping Full-access roots have one live writer in this service. Each typed or consumed queued
prompt creates its own R1 run/attempt. Startup reconciliation turns unfinished native runs into
`input_required`; no inference or report resumes automatically. A policy committed before run
admission projects as interrupted. Terminal R1 state takes precedence over old native state events.

Tools: `project_info`, `file_read`, `file_write`, `shell`, `repo.map` (wire alias `repo_map`), indexed literal `search`, `fetch`,
`attachments`, `plan`, `queue`, `note.add` (provider-safe wire alias `note_add`) and the
session-bound `session_log_query`. Repository navigation uses the [X1 project index](../indexing/README.md), with Node grep fallback,
content verification and index provenance. Connected search providers are not executed. Attachments reuse the existing scoped transfer policy, copy
selected project artifacts into read-only session storage, and expose text through file reads.
Images are sent only when the selected model declares image input. Other binary formats need
conversion, which requires an explicit converter adapter and provisioned format tools; no
format or modality is silently claimed.

`file_read` takes an optional byte `offset` and returns `more` and `nextOffset` with the file text, so a large file is read page by page;
without a caller-supplied page budget (the relay passes one) the page is the sandbox's own 64 KiB result and an oversized result
still becomes an output artifact read with `tool_output_read`.

Command stdout/stderr are bounded to 64 KiB per invocation with an explicit `truncated` flag.
Every tool result is scrubbed and bounded to 64 KiB. Larger state/query results are stored as
private, session-scoped SHA-256 artifacts under `native-output/`, with an explicit excerpt,
byte count, artifact ID and `tool_output_read` continuation. Pages contain at most 8 KiB of
UTF-8 content so JSON escaping fits the result budget. Artifacts are scrubbed again before
paging; neither artifacts nor launcher/CA files are writable roots. Artifact storage follows the native session's coordinated retention/deletion below.
Native typed prompts and `tool.call` arguments above the published 16 KiB scrubbed UTF-8
representation threshold are stored as session-owned SHA-256 input artifacts. The v2 event
carries only a scrubbed excerpt of at most 8 KiB, a reference and the byte size; the full
bytes never enter SQLite, FTS, titles, logs or exports. Replay resolves the reference through
the pinned session store, verifies session/size/SHA-256 and re-scrubs the full bytes before
the next model request. A secret registered after the write is therefore redacted on the next
read and replay; the excerpt is never used as execution input. Image bytes are inline in
model requests; K2 stores policy references and attachment counts. Reading an output artifact
currently scrubs it in memory before paging; bounded memory streaming is not claimed. Binary
conversion remains a named residual. Images are referenced by policy, not stored as base64 in
events. Reasoning stays in K2's retention class, outside model/CLI output and console logs.

Queued prompts still use the v1 `agent.queue` representation in this lane state: full queued
text inline, even after consumption, with no new cap. Q0 has added the v3 contract, independent
ledger 40 and session-log reader/privacy/export support, but the native producer, native
routes/UI and CLI remain v1 until Q1/Q2; progress itself stays the legacy v1 body. If a v3
snapshot is present, legacy progress refuses with the existing content-free `agent_unavailable`
(HTTP 503) instead of silently retaining an older v1 queue; this is a compatibility boundary,
not a v3 consumer and not the Q1 progress2 contract. This README does not claim queue
artifactization or a native v3 rollback floor. Consuming a queued prompt may artifactize its
own later `prompt` event, while the earlier queue event stays inline. A published input blob
left by a failed append is an orphan until the whole session is deleted; no per-blob GC runs in
this slice. The full input is buffered for replay and re-scrubbing; a bounded-memory streaming
reader is not claimed.

The orientation is checked against a conservative 300 UTF-8-byte upper bound, independent of
path length/root count. Full paths, policies and instruction locations are obtained from
`project_info`. It invents no hardware fit, model capability or token budget.

## Durable execution and retention (K4F2)

Every native append during execution uses R1's atomic attempt/home fence and an explicit K2
`expectedSeq`, read from the current session head so R1 lifecycle writes are included. One
append queue per active attempt serializes service- and tool-owned trace writes; `seq` is
computed when an operation executes, not when it is queued. `pi-agent-core` awaits listener
promises, and the tool wrapper additionally awaits the exact `toolCallId` durable `tool.call`
acknowledgment before any tool body effect; a missing or failed acknowledgment aborts the turn
with zero tool bodies. A failed append is latched once and writes at most one content-free
`error` plus terminal. Tools check the fence before dispatch and after completion; the existing
ExecutionOwner still owns shell cleanup and quarantine. Native attempts renew once per second
while pending. A stale attempt cannot append or complete. Model-start acknowledgment follows
an API response observation or local `/api/chat` dispatch, after Ollama's version preflight.
Stop enqueues its intervention before aborting and never waits for artifact I/O. Close seals
and drains the queue before handles close.

An optional immutable `budget` supplies model-call, observed-token, observed-USD-cost and wall-time
caps. R1 stores the policy/counters, cost observations and terminal reason. A cap cancels with
`budget_exhausted`; an observed HTTP 429 or typed quota refusal cancels with `quota_exhausted`.
No balance is inferred from these observations. Tokens/costs are checked after each observed call
and before the next; one already dispatched call can exceed an observation cap. Unknown monetary
cost blocks further calls when a money cap is configured. No ordinary call/token cap is invented.
`wrapping_up` forbids tools and has an explicit default report budget of one further call and
10 seconds, configurable through `reportMaxCalls`/`reportMaxDurationMs`. Exhaustion cancels with
`report_budget_exhausted`. Successfully finishing a requested report cancels with
`wrap_up_requested`. Provider calls and tools are aborted on the next one-second control pass
when a time cap or fence is lost; cleanup confirmation still governs root reuse.

Migration **32** adds `run_execution` and `native_sessions`, adopts existing native sessions
under a Thread owner, and leaves migrations 1–31 byte-identical. Migration **33** adds the
session-owned `session_input_artifacts` table and replaces only the event-policy trigger; it
leaves migrations 1–32 byte-identical and leaves the independently owned ledgers 34–39
untouched. Q0 adds no global migration: its independent `session_queue_migrations` ledger 40
replaces only `session_events_policy_insert` and leaves main `user_version` at 33 and ledgers
34–39 untouched. Rollback is a stopped, consistent pre-upgrade SQLite/WAL backup restore; an older
binary does not understand v2 events and must not reuse a v2-bearing database. The supported
read compatibility for older clients is the new server's explicit v1 negotiation: a max-1
page, export or already-open stream refuses at the first unread v2 event with a content-free
406 / `guanxi-error` without advancing the cursor. The private owning Thread is
agent-mode/projectless to preserve the existing legacy Project→Chat ownership invariant; the
immutable native policy retains the logical Project. These private owners are excluded from
legacy Chat projections and admission, so that API cannot start inference on a native session. Owner, session, policy and registration
commit together. Keep a stopped pre-upgrade SQLite/WAL backup; rollback requires that backup.
Prefer a forward fix; no production down migration is provided.

Retention defaults to the canonical rolling seven days of user activity. Model/tool activity
does not extend it. TTL expiry moves native metadata to Trash and retains recoverable bytes.
`keep` retains until explicit deletion. `session` needs explicit `POST /api/agent/:id/leave`;
maintenance starts its 24-hour recovery window after active work finishes, then uses coordinated deletion. Changing
retention with `PATCH /api/agent/:id/retention` can restore before that Session recovery deadline.
A one-minute maintenance pass also retries persisted deletion intents after restart and cleans
private pre-admission directories under the R1 home fence. It rechecks each policy after cleanup waits.

`DELETE /api/agent/:id` is the explicit immediate, irreversible delete action. It refuses an
active native attempt or held K2 writer and refuses quarantined roots. Scratch, copied attachments
and private output artifacts are removed before deleting R1 rows and the owning Thread (which
cascades K2 events, writer and FTS rows). A durable intent blocks continuation across partial
cleanup/restart; failures retain that intent. Deletion binds to the admitting R1 home
generation: a home deposed during an await stops before later filesystem steps and cannot
commit the final metadata transaction; the successor's maintenance retry finishes the same
intent. An already-issued filesystem action cannot be undone. Quarantine files are never a cleanup target and
have no automatic expiry. Cross-session delegation references refuse deletion rather than
silently dropping another run's promise. Reasoning uses only K2 reasoning rows, with its seven-day
maximum and the sooner parent TTL; it never enters provider history, outputs or cost metadata.

## Ephemeral side chat (U1)

**Status:** implemented and locally validated (2026-10-23); native sessions only. Decision:
D-135, [ADR-0036](../../../../docs/decisions/0036-workspace-layout-and-experience-modes.md),
screen W4. Code: [`side-chat.ts`](side-chat.ts), the `sideChat*` methods of `NativeAgents`, the three
routes below and `packages/contract/src/side-chat.ts`. Tests: `test/native-agent/side-chat.test.ts`,
`test/side-chat-contract.test.ts`.

| Route | Effect on the session log |
| --- | --- |
| `POST /api/agent/:id/side-chat/respond` | none: stateless, tool-free, answers through the session's own K3 connection and model |
| `POST /api/agent/:id/side-chat/save` | exactly one `agent.note` carrying the encoded transcript (history only), idempotent per `operationId` |
| `POST /api/agent/:id/side-chat/send` | exactly one queued or started prompt whose id is derived from the `operationId`, idempotent across retries and restarts |

- **Context.** Rendered from the `remote_agent` view of the log (prompts and assistant messages only; never
  reasoning, tool calls, tool results or notes), up to the log head, declared untrusted data (a closing marker
  inside session text is escaped; prompts read as excerpts are announced to the model). The caller chooses
  none, the whole session or the last N turns.
- **Fit proof.** The total UTF-8 bytes of the instructions, the transcript and the whole draft conversation,
  plus 16 bytes of framing per message, must be at most `window - maxTokens` for a hosted model (a byte is at
  least one token). A local runtime has no separate output limit, so its bound is the whole context setting and
  a `length` stop is returned with `truncated: true`. An unprovable request is refused with `context_too_large`
  and its numbers before dispatch, never cut. The framing allowance is a conservative constant, not a measured
  per-template figure.
- **Writes.** `respond` adds no row and no file. The test opens every `*.sqlite` file under the data directory
  read-only (the node database, `connections.sqlite`, `native-projects.sqlite` and any file that appears) and
  compares per-table row counts, plus the file list (sqlite files by name, others with sizes), before and after
  completed, failed and canceled requests and after a restart. The one intended exception is the K3 receipt
  (`connections.sqlite:costs`), checked apart: exactly one row per completed request. The native fixture does
  not load the sidecars production boot adds (`notifications`, `voice`, `work`, project index); the side-chat code
  imports none of them, but that is argued from the code, not asserted by a test that boots `start()`.
- **Spend attribution and budget.** The receipt is keyed `side-chat:<sessionId>:<uuid>` (the client's
  `requestId` only correlates the response). Native run budgets are per run and a side chat has no run, so each
  limit (`maxModelCalls`, `maxTokens`, `maxCostMicrounits`) applies to the session's cumulative side-chat spend,
  counted from those receipts before dispatch; reaching one refuses with the content-free `budget_exhausted`
  (HTTP 429). A receipt with an unknown cost cannot be proven inside a money limit, as for runs. Receipts are
  written when a request completes, so a request canceled after the provider billed it leaves none: K3
  under-accounting on cancel, a known residual not changed here.
- **Concurrency.** At most `GUANXI_SIDE_CHAT_MAX_CONCURRENT` `respond` requests per session run at once
  (positive integer up to 999, default 1, strictly parsed); more are refused with `too_many_requests` (429)
  before the provider is called. The slot is released on completion, failure and client abort.
- **Save** goes through the running turn's append FIFO when a turn is active (a failure there is returned, never
  thrown into the FIFO, so it cannot abort the turn) and through the R1 home transaction otherwise. When the
  session has no live writer the log may also record its own `writer.acquired` handover event; the note itself is
  always exactly one event. The native replay ignores `agent.note`, so a saved side chat is never agent context.
  A transcript whose encoded note exceeds `SIDE_CHAT_SAVE_MAX_BYTES` (256 KiB) is refused with `too_large` and its
  numbers; nothing is truncated or appended.
- **Send** reuses the existing FIFO. A caller-chosen queue item id is queued at most once, and a prompt event
  with the derived message id is the durable receipt: a retry after a lost response or a restart reports
  `already_sent`. A pending queue item is reported as `queued` (duplicate) only while a turn is running; with
  nothing running (the turn stopped, failed or the node restarted) a retry starts a fresh turn with the same
  prompt id, which also settles the stranded item. Changed text under the same operation id is
  `operation_conflict` (a long text, stored as an artifact, is compared by its stored checksum, not by the excerpt).
  The answer (`queued`, `started`, `already_sent`) is what `prompt()` actually did, not what an earlier check saw.
  Concurrent sends to an idle session start one turn; the loser gets `already_sent` or a
  retryable `session_busy`, and a request that lands between turns gets `session_busy`. The pre-checks inside the
  FIFO return their errors instead of throwing, so they cannot abort the main turn. Origin is recorded as `queued`.
- **Not covered.** Legacy Chat Jobs have no side-chat route (the web panel is mounted on native sessions only);
  the answer is not streamed; the opened-in-browser transcript is not durable by design.

## CLI

Start the node normally, then:

```bash
guanxi agent exec --json --project PROJECT_ID --connection CONNECTION_ID \
  --model MODEL_ID --prompt 'Inspect this project' --mode read-only
```

`--url` accepts a loopback HTTP node only (default `GUANXI_API_PORT` or 4310).
`--domains host,other:443` sets tool egress; `--context-tokens N` is required for local Ollama.
Stdout is exactly one JSON object: `{version:1, sessionId, status, text, error}`. Exit codes:
0 completed, 1 failed/interrupted/input-required, 130 cancelled. SIGINT requests server cancellation; an
unconfirmed stop returns `interrupted` with `cancellation_unconfirmed`.

## Reuse and license

Exact dependencies, verified against upstream tagged license files on 2026-10-21:

- [`@earendil-works/pi-agent-core` 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE), MIT;
- [`@anthropic-ai/sandbox-runtime` 0.0.81](https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/LICENSE), Apache-2.0;
- `typebox` 1.3.27, MIT, shared with pi-agent-core.

No upstream source, prompt or asset was copied; no new THIRD_PARTY_NOTICES entry is required.
The sandbox package stays external to bundles, preserving its upstream license and platform
helpers; server and CLI build a separate `sandbox-worker.js` entry. The npm license gate does
not constitute a native binary audit or validation of unsupported platforms.
