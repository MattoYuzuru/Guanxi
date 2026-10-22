# B1 trial binding: private process plus fenced K2 retention

**Status:** proposed, not authorized, not implemented. This file is the only artifact of the
current read-only audit. Do not edit product code or tests until the root coordinator approves
the exact plan below.
**Review-correction status (2026-10-22):** root reviewed this plan at `3bfb54c` and authorized
the corrected bounded vertical slice below. Section 12 is authoritative where it conflicts
with Sections 1–11; the earlier text stays as review history and is not an implementation claim.
**Base:** `6da20584d3ee774c720f24b3c60bb0468325f29c` (`docs: record reviewed B1 merge and next
integration checks`) on `codex/b1-trial-binding`.
**Date:** 2026-10-22.
**Trust:** T0 host code only. No REST route, CLI flag, plugin manifest, task-container endpoint
or generic K3 API is added. The stock paid executor stays OFF.

## 1. Outcome and explicit non-goals

The next bounded vertical slice connects the already-reviewed private completion protocol to:

1. a **real K2 session sink** with R1 attempt fencing, idempotent appends and a durable
   acknowledgement before any task-visible response;
2. one **owned local subprocess** reached through anonymous OS pipes inherited at `spawn`, not
   through a new TCP/Unix listener or a claimed peer credential;
3. an **executable synthetic fixture client** that speaks the existing private frame protocol
   over inherited file descriptors `3` and `4`;
4. **lifetime cleanup** with an explicit process group, a trusted supervisor, bounded
   kill/shutdown grace, and a private record that the next coordinator can reap;
5. adversarial tests for cancellation, nested descendants, startup failure, protocol EOF,
   output backpressure, idempotency, concurrent identities, K2 failure and restart refusal.

Explicit non-goals: no Harbor, Podman, Linux host, SSH, GPU, live model, provider credential,
real task corpus, real benchmark execution on this Mac (D-194 excludes it), paid dispatch,
five-seed experiment, container peer identity, Python mini-swe-agent bridge, Guanxi task image
or verified provider price/meter adapter. Those remain separate follow-ups. This slice does not
close B1 and does not activate ADR-0025.

## 2. Current-state audit (what this would build on)

| Area | Current source | Actual boundary |
| --- | --- | --- |
| Private frame codec and channel state machine | `packages/bench/src/private-channel.ts:26-171` | Strict v1 `complete` request; no selectors; one in-flight; `close()` aborts the gateway signal; `handle()` awaits `retain()` before encoding the response (`:152-159`). |
| Stream adapter | `packages/bench/src/private-stream.ts:26-126` | Binds one `Readable`/`Writable` pair; fixed reasons; `stop()` closes and destroys (`:40-47`); awaits `channel.settled()` (`:113-115`). It has no terminal callback and creates no process. |
| K3 trial gateway | `packages/bench/src/k3-gateway.ts:40-104` | Immutable account/connection/provider/model/output; K3 `singleAttempt`; durable request admission; rejects before provider dispatch on any mismatch. It does not fence the R1 attempt and K3 sees the budget/experiment ID as `runId`. |
| Request ledger | `packages/bench/src/budget.ts:61-119` | Per-trial request holds keyed by `(runId=experiment, requestId)`; in-flight/crash holds survive; unknown/breached usage halts the trial; no second dispatch. |
| R1 attempt fence | `packages/server/src/runs/store.ts:261-335` | `fenced()` checks attempt state, epoch, token, holder and lease expiry; `append()` commits the R1 fence and the K2 home append in one transaction. `native-agent/service.ts:263-278` shows the intended attempt+sink composition. |
| K2 append | `packages/server/src/session-log/log.ts:459-475, 1090-1160` | `appendFromHomeWithin` requires a transaction; every payload is scrubbed, identifiers are checked, idempotency and `expectedSeq` are enforced, and the event/commit is synchronous. `session()` exposes `lastSeq` but refuses while egress is not ready. |
| Canonical events | `packages/contract/src/events/session-events.ts:74-167, 207-220` | Existing `reasoning`, `assistant.message` and `tool.call` types are sufficient for completion retention. `reasoning.data` has only `{messageId, step, text}`; there is no signature field. No new event type or migration is needed. |
| Existing child process | `packages/bench/src/process.ts:3-28` | `processJson` uses stdin/stdout and a fixed env allowlist, but stdout is the wire and there is no fd capability, supervisor, process-group ownership or K2 retention. |
| Existing process-group pattern | `packages/server/src/external-agents/process.ts:49-156` | `detached` on POSIX, negative-PID group signals, bounded grace, close awaited. It is a useful pattern, not code to copy; this slice is independent and has a different trust model. |
| Python adapter | `packages/bench/python/guanxi_bench/agents.py:70-116` | `GuanxiExec` calls `guanxi agent exec --json` through a container environment; it is not a private K3 client and is unchanged. |

The gap is concrete: the current `retain` hook is a fake in fixtures, the channel is bound only
to in-memory streams, and no host-owned child can hold the capability. The current K3 gateway
also checks connection metadata before dispatch but not the live R1 attempt, so a restart could
reach a provider before K2 detects a stale attempt. Both gaps are addressed below.

## 3. Proposed vertical slice

### 3.1 Composition

```text
T0 coordinator
  ├─ creates R1 run + attempt and K2 session
  ├─ creates immutable TrialBinding (fresh nonce)
  ├─ createTrialGateway(... attemptFence, k3RunId=binding.runId ...)
  ├─ createK2TrialRetention(... real RunStore.append + SessionLog ...)
  └─ spawnPrivateTrial(...)
        └─ trusted supervisor (detached process-group leader)
              └─ fixture client (same group, fds 3/4 inherited)
```

Data path: fixture client writes a v1 `complete` frame to fd 4 (its response pipe); host reads
it, calls K3 through the immutable gateway, scrubs and persists the completion through the
fenced K2 sink, then writes only the public assistant frame to fd 3. The child never sees the
K3 registry, account ID, connection ID, provider key, trial identity, nonce or retention data.

### 3.2 Immutable trial binding and fresh nonce

`createTrialBinding(input)` is called only by the T0 coordinator after it has created the R1
run/attempt and K2 session. It copies and freezes:

```ts
interface TrialBinding {
  experimentId: string      // Plan.id / Budget reservations.id
  taskId: string
  armId: string
  seed: number
  runId: string             // R1 durable_runs.id, passed to K3 as runId
  attemptId: string         // R1 run_attempts.id, used by the pre-dispatch and K2 fences
  sessionId: string         // K2 sessions.id belonging to the R1 run
  accountId: string         // engine-local account, never sent to the child
  connectionId: string      // K3 connection, never sent to the child
  provider: string
  model: string
  modelApi: string          // immutable pi-ai wire identity for historical messages
  outputTokenLimit: number
  toolSource: 'builtin' | 'mcp' // coordinator's arm/tool profile, never a request selector
  nonce: string             // generated here, 32 random bytes base64url; not caller input
}
```

`createTrialBinding` generates the nonce itself (`randomBytes(32).toString('base64url')`), so a
child or request cannot choose or replay it. It validates every string, the seed, the output
limit and `toolSource`, and refuses an R1 attempt whose `id`/`run_id` do not match the binding.
The T0 host factory also checks `runs.get(binding.runId).session_id === binding.sessionId`
before the first append; `RunStore.append` writes to the R1 run's session, so a mismatched
binding must refuse rather than read a head from another session. It returns a frozen copy;
later mutation of the caller's object has no effect (same discipline as `PrivateTrialChannel`,
`private-channel.ts:132-133`).

The nonce is a **correlation/freshness token, not an authentication credential**. It is used in
K2 idempotency keys and in the private process record hash. It is never sent to the child, never
written to a plain log and never returned in a task frame. The anonymous pipe itself is the
capability: a new spawn gets new pipes, so a stale child has no fd into a new trial.

Identity mapping is intentionally explicit:

| Identity | Used by | Never used by |
| --- | --- | --- |
| `experimentId` | `Budget.admitRequest` as its existing `runId` key; experiment reservation | child, K3 `runId` |
| `runId` | R1 run; K3 `ModelCall.runId`; K2 session owner | child, request frame |
| `attemptId` | `attemptFence`, `RunStore.append`, process registry | child, request frame |
| `accountId`, `connectionId`, `provider`, `model`, `outputTokenLimit` | gateway construction and checks | child env/argv/frames |
| `taskId`, `armId`, `seed` | admission trial key and report identity | child env/argv/frames |
| `nonce` | K2 idempotency and process-record hash | child env/argv/frames |

### 3.3 Pre-dispatch R1 attempt fence and K3 run identity

Add two fields to `TrialGatewayConfig` in `packages/bench/src/k3-gateway.ts`:

```ts
k3RunId: string
attemptFence?: { assert(): void } // required by the new T0 host; optional for old fixtures
```

`complete()` calls `attemptFence.assert()` before generating the request ID and again inside
`onPrepared` before `gate.onPrepared(prepared)`. It passes `runId: k3RunId` to
`k3.complete(...)`. The budget identity remains `trial.runId = experimentId`; the two IDs are
deliberately distinct. A stale attempt therefore refuses before any K3 transport call, not
only at K2 retention. The coordinator supplies `assert: () => runs.renew(attempt)` (the existing
sync R1 fence) or an equivalent `RunStore` assertion. `renew` has the side effect of extending
the lease, which is acceptable and is the same fence the executor relies on.

The trial gateway already pins `singleAttempt: true` and `maxTokens`; those remain unchanged.
`gateway_attempt_fenced` is a new fixed local code in `gatewayCodes`; it contains no raw error
text. Existing callers that omit `attemptFence` keep their current behavior; the new host
factory requires it.

### 3.4 Real K2 retention sink

`packages/bench/src/k2-retention.ts` defines a structural, production adapter around the actual
R1/K2 APIs (type-only imports, no server package dependency):

```ts
interface FencedTrialAppend<A extends { id: string; run_id: string }> {
  append(attempt: A, input: SessionEventInput,
    options: { idempotencyKey: string; expectedSeq: number }): unknown
}
interface SessionHead { session(id: string): { lastSeq: number } | null }

interface RetentionPolicy {
  maximumRetainedBytes: number
  maximumReasoningTextBytes: number
  maximumSignatureBytes: number
  maximumAssistantTextBytes: number
  maximumToolCalls: number
  maximumToolArgumentBytes: number
}

createK2TrialRetention({ binding, attempt, runs, session, scrubber, policy })
  -> { retain(requestId, result): Promise<void> }
```

The coordinator wires `runs` to the real `RunStore` and `session` to the real `SessionLog`.
`RunStore.append(attempt, input, { idempotencyKey, expectedSeq })` performs the R1 fence and the
K2 `appendFromHomeWithin` in one SQLite transaction. The sink reads `lastSeq + 1` immediately
before each append. `retain` is a `Promise` only to match the existing `PrivateChannelHost`
contract; the commit is synchronous, so returning means the events are durable.

Event mapping (existing canonical event types only):

| Completion field | K2 event | Payload | Retention |
| --- | --- | --- | --- |
| each `thinking.thinking` | `reasoning` | `{ messageId: requestId, step: ordinal, text }` | K2 reasoning class; 7-day default or shorter parent TTL; scrubbed |
| each `thinking.thinkingSignature` | `reasoning` | `{ messageId, step, text: SIGNATURE_PREFIX + JSON.stringify({ signature, redacted }) }` | same class/retention; private K2 only |
| joined `text` blocks (non-empty) | `assistant.message` | `{ messageId: requestId, step: ordinal, text }` | standard; scrubbed |
| each `toolCall` | `tool.call` | `{ toolCallId, name, arguments, source: binding.toolSource, parsedFrom: 'native', diffPath: null }` | standard; arguments scrubbed |
| `usage`, cost, provider error text, raw request transcript | none | — | never stored; verified billing stays in the budget ledger |

`requestId` is generated by the gateway; `ordinal` is assigned by the sink on first retention
for that request (0, 1, ...). `messageId` is the request UUID; `spanId` is the request UUID for
all events of that completion. Extract a small `publicAssistantMessage(result)` helper (used by
the channel and the sink) so K2's text/tool calls are exactly what the task stream receives;
the helper returns only `{ text, toolCalls, stopReason }`.

`SIGNATURE_PREFIX` is a versioned private-retention marker, for example
`guanxi.bench.thinking-signature/v1\n`. This keeps the canonical `reasoning` schema unchanged
and makes old code able to read the event after a rollback (it sees a reasoning text). The
signature is therefore inside the existing reasoning class: never exported, never returned to
a remote agent, never sent to a provider, never written to a plain log. The inspector may show
the opaque signature in a reasoning block; that is local, person-audience data. If the root
prefers an additive optional `signature`/`redacted` field on the canonical reasoning data, that
is an alternative (see §10), not part of this recommended no-contract-change plan.

Idempotency and scrubbing:

- `retain` first checks `scrubber.isReady()`, then calls `scrubber.scrub(result)` on the full
  completion and validates every explicit retention bound **before the first append**. The
  `SessionLog` scrubs every payload again at write. A spy test asserts both calls happen.
- Keys are `bench:<nonce>:<requestId>:reasoning:<i>`,
  `...:reasoning-signature:<i>`, `...:assistant`, and
  `...:tool:<sha256(scrubbedToolCallId)>`. A duplicate retain with the same payload returns
  `duplicate` and emits no second event; a changed payload under the same key becomes
  `retention_idempotency_conflict` and no response.
- The sink asserts `attempt.id === binding.attemptId` and `attempt.run_id === binding.runId`
  before every append. `RunStore.append` additionally checks the live attempt epoch/token and
  throws `stale_lease`; the sink maps that to `retention_fenced` without exporting the raw
  message. A closed log, missing session, egress not ready or K2 sequence/idempotency error
  closes the capability with a fixed code.
- A multi-event completion is committed one event per transaction. A failure after an earlier
  event leaves an idempotent partial private trace but returns no task response; a retry under
  the same live attempt resumes/deduplicates, and a stale attempt cannot append. Atomic
  all-or-nothing retention would require a new R1 batch API; that is a follow-up, not silently
  claimed here.
- `toolCall.id` must satisfy the canonical `id` bound (1–200 characters). A longer or empty ID
  fails `retention_id_invalid` before append rather than being truncated into a colliding ID.
  The private protocol has no MCP marker; the coordinator's immutable `toolSource` is the only
  source, and a request cannot override it.

## 4. Owned subprocess and lifetime

### 4.1 Why a supervisor

A child spawned directly can be killed as a process group on normal cancellation. It cannot be
killed after its parent is gone: macOS has no parent-death signal, and a `SIGKILL`ed parent
leaves the child and its descendants. A small trusted supervisor solves the crash case without
a listener, container or native addon:

- The host spawns `private-supervisor.mjs` with `detached: true` on POSIX, making it a process
  group leader. Windows is refused with `process_policy_invalid`; no untested job-object path
  is claimed.
- The supervisor writes a private record, spawns the fixture client in the same group with
  **fd 3 and fd 4 inherited**, closes its own copies of 3/4, and reports `ready` on fd 6.
- The supervisor holds fd 5 as a lifetime pipe (parent → supervisor). If the coordinator dies,
  fd 5 reaches EOF and the supervisor sends SIGTERM to its own process group, handles the
  signal itself, waits `killGraceMs`, removes the record, then sends SIGKILL to the group if
  members remain. Its own SIGKILL ends the supervisor; the parent or next reaper verifies the
  group is gone.
- On normal completion the coordinator closes fd 5; the supervisor performs the same group
  shutdown, removes the record and exits. The coordinator also snapshots the supervisor
  PID/group and verifies `kill(-pgid, 0)` is ESRCH.

The supervisor is trusted host code and is not in the child's address space. The child can
still be malicious within the same OS user (it can signal same-user processes); this is a
cleanup mechanism, **not** a container security boundary. The actual untrusted compute boundary
remains rootless Podman under `guanxi-bench` (D-194), separately.

### 4.2 Exact FD layout

Parent spawns the supervisor with:

```ts
if (process.platform === 'win32') throw new Error('process_policy_invalid')
spawn(process.execPath, [supervisor, clientScript, recordPath, String(killGraceMs)], {
  detached: true,
  cwd: privateCwd,
  env: allowlistedEnv,
  stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
})
```

| FD | Child side | Parent side | Use |
| --- | --- | --- | --- |
| 0,1,2 | ignored | null | no stdin, no task/credential/log channel |
| 3 | read | `child.stdio[3]` writable | host → child completion requests (private frames) |
| 4 | write | `child.stdio[4]` readable | child → host completion responses (private frames) |
| 5 | read | `child.stdio[5]` writable | lifetime pipe; parent close/EOF means shut down the group |
| 6 | write | `child.stdio[6]` readable | one bounded `ready`/`start_error` line before serving |

The supervisor spawns the client with `stdio: ['ignore','ignore','ignore', 3, 4]` and then
`fs.closeSync(3); fs.closeSync(4)` in its own process. The client reads/writes raw fds with
`fs.readSync`/`fs.writeSync` (the fixture may import the production codec; it does not copy the
protocol). The supervisor never passes fd 5 or 6 to the client. No `net`, `http`, Unix socket,
port, listener or peer-credential claim is added.

### 4.3 Process policy (explicit, no invented defaults)

```ts
interface PrivateProcessPolicy {
  clientScript: string       // absolute, regular file; host-configured
  cwd: string                // private directory; host-configured
  env: Readonly<Record<string,string>> // explicit allowlist, no provider/account/model keys
  recordDirectory: string    // private 0700 directory
  startupTimeoutMs: number
  shutdownGraceMs: number
  killGraceMs: number
  ackTimeoutMs: number
  maximumControlBytes: number
  maximumRecordBytes: number
  channel: PrivateStreamPolicy // existing explicit payload/request/time/chunk/output bounds
}
```

Every field is required and validated as a positive safe integer or non-empty path; the code
does not substitute a hidden default. Missing/zero values refuse `process_policy_invalid`.
The record directory is created/validated as `0700`, not a symlink; the client script is
`realpath`ed, `lstat`ed as a regular file, and executed without a shell. The environment is
built by the host, never passed from a request. The fixture needs at most `PATH`, `HOME`,
`TMPDIR`, `LANG` and a private scratch; no `NODE_OPTIONS`, no `GUANXI_*`, no `*KEY*`,
`*TOKEN*`, `*SECRET*`, account, connection, model or trial ID.

### 4.4 Record, reaping and tamper limits

The record path is derived from `sha256(nonce)` under `recordDirectory`; it contains only:

```json
{ "version": 1, "bindingTag": "<sha256 of experiment/task/arm/seed/run/attempt>",
  "nonceHash": "<sha256(nonce)>", "supervisorPid": 123, "pgid": 123,
  "clientPid": 124, "clientScript": "/absolute/path", "startedAt": 0 }
```

It never contains task text, prompts, tool results, reasoning, credentials, account/model IDs or
the nonce itself. Mode `0600`; reads are bounded by `maximumRecordBytes` and the shape is
validated before any PID is used. On startup the coordinator calls `reapPrivateProcessRecord`
for this binding before spawning:

1. Validate the record shape and tags.
2. If the supervisor PID is alive and `/bin/ps -p <pid> -o command=` contains the exact
   supervisor path and record path, send SIGTERM to `-pgid`; wait `killGraceMs`; SIGKILL; verify
   the group is ESRCH; remove the record.
3. Else if `clientPid` is alive and its `ps -p <clientPid> -o pgid=` equals the record `pgid`
   and its command contains `clientScript`, SIGKILL `-pgid`, verify, remove the record.
4. Else if `kill(-pgid, 0)` still succeeds but no process matches, return
   `cleanup_unconfirmed` and do **not** kill an unrelated PID. The host refuses to spawn for
   that binding; ownership is not released.
5. Else remove the stale record.

`ps` is invoked with `execFile('/bin/ps', [...])`, no shell, a short fixed timeout and a bounded
buffer. This is a local OS query, not an external service. The record directory is same-UID
writable, so a malicious child can tamper with records; this reaper is not a security boundary
against the child. It prevents accidental reuse and handles the cooperative supervisor crash;
it never authorizes paid execution.

### 4.5 Result and ownership contract

The only change to the existing adapter API is an optional sixth argument:

```ts
servePrivateTrialStreams(input, output, host, policy, signal,
  hooks?: { onTerminal?(): void })
```

`onTerminal` is called once, synchronously, when the adapter commits its first fixed terminal
reason (abort, input/output error, protocol failure, timeout, clean EOF after the retained
write, or channel close). It is not called for a clean input half-close while a retained
response is still being written; it fires when that write completes or fails. The adapter
wraps the hook in `try/catch` so a host callback cannot change the protocol reason. Existing
five-argument callers are unchanged.

`runPrivateTrial(...)` returns:

```ts
interface PrivateTrialResult {
  reason: PrivateStreamReason | 'binding_invalid' | 'binding_attempt_mismatch'
    | 'process_policy_invalid' | 'child_start_failed' | 'child_exit_failed'
    | 'retention_fenced' | 'retention_not_ready' | 'retention_idempotency_conflict'
    | 'retention_too_large' | 'retention_unsupported_content' | 'retention_id_invalid'
    | 'retention_failed' | 'retention_unconfirmed' | 'cleanup_unconfirmed' | 'binding_busy'
  responsesDelivered: number
  childExitCode: number | null
  retentionConfirmed: boolean
  cleanupConfirmed: boolean
}
```

- A task response is written only after `retain` resolves. The existing channel already awaits
  `retain` before encoding (`private-channel.ts:152-159`); the new sink makes that await a real
  durable append. The process binder wraps `retain` and records the sink's fixed local code
  (for example `retention_fenced`) on the result; the task frame still receives only the
  channel's fixed `channel_failed` code, never raw K2/DB text.
- On external abort, channel terminal, EOF, output timeout or input error, the adapter calls an
  optional new `onTerminal` hook before settling ownership. The hook is set by the process
  binder and starts process-group shutdown immediately. The channel's `settled()` still waits
  for the active gateway/retention work; the process binder's `run()` promise does not resolve
  until both the process cleanup and the retention acknowledgement settle.
- `ackTimeoutMs` is an operational bound only. If retention does not acknowledge in time, the
  result has `retentionConfirmed:false`; the caller must not call `RunStore.complete`, must not
  release the trial/attempt and must not start a new paid attempt. There is no timer-based claim
  that uncooperative work stopped.
- `cleanupConfirmed` is host-observed: supervisor close plus `kill(-pgid, 0)` ESRCH plus record
  removal. It is never a child claim. It proves the **owned process group** only; a descendant
  that called `setsid` leaves the group and is outside this proof. The result contract and docs
  say "process-group cleanup", never "all descendants cleaned"; stronger containment is the
  rootless-Podman/cgroup follow-up. The negative test demonstrates the group scope and cleans
  up the escaped test process itself.
- The binder never creates, completes or cancels the R1 run; the T0 coordinator owns that.
  The binder never settles the budget; the gateway/ledger does.

## 5. Threat boundary and non-claims

- **Asset:** one trial's K3 capability, its provider spend, its private completion (text, tool
  calls, reasoning, signature) and the host process tree.
- **Actor:** a synthetic fixture client in this slice; a future benchmark agent under test.
  It is untrusted for content but is not given a different OS user here.
- **Capability:** only the inherited fd 3/4 pair and the protocol operations on it. There is no
  listener, URL, token file, account selector or K3 registry in the child.
- **Identity:** the OS-issued supervisor PID from `spawn` and the process group are used for
  cleanup. The supervisor records the client PID from its own `spawn` return, not from a child
  message. Any PID/UID string sent by the child is ignored. Anonymous pipes on macOS expose no
  peer credential; the plan does not claim `SO_PEERCRED`, socket peer identity or container
  impersonation. The nonce is not authentication.
- **Same-user limitation:** the child can signal same-user processes and can read same-user
  files. The supervisor and reaper improve accidental/crash cleanup, not isolation. A hostile
  child that escapes its process group (for example with `setsid`) is outside the process-group
  proof; it is never described as cleaned. Rootless Podman/Linux cgroups are the separate real
  boundary.
- **Credentials:** K3 vault/API keys never enter the child env, argv, fds, stdout/stderr,
  process record or K2 events. The child's stdout/stderr are `/dev/null`; the private frame
  stream is the only protocol channel. No additional plaintext trajectory or log file is
  created; the scrubbed completion lives only in K2 SQLite.
- **Reasoning/signature:** only the real K2 sink receives the full completion. The task frame
  gets only `{ text, toolCalls, stopReason }`; reasoning, signature, usage and request selectors
  are absent. K2 reasoning is classed for retention, excluded from exports and remote audiences.
- **Paid path:** nothing here sets `Executor.boundedBilling`, changes `runBench`'s paid refusal,
  adds a CLI/REST selector or lets a child declare `boundedBilling`, `cleanupConfirmed` or a
  peer identity. Those are host-computed/trusted-only facts.
- **Access modes:** ADR-0027's read-only/full-access and remote security profile are unchanged.
  This is a local T0 capability, not a network service, account boundary or remote endpoint.

## 6. Failure and lifecycle matrix

| Scenario | Required behavior | Assertion that fails if removed |
| --- | --- | --- |
| Happy path | Two sequential fixture completions; text/tool calls only; K2 has reasoning/signature; exit 0 | Frame key set; K2 event count/prefix; child exit 0 |
| Foreign request selector | Close before gateway/K2; no dispatch | K3 calls 0, K2 events 0, fixed `channel_request_invalid` |
| External abort while provider/retain is pending | `onTerminal` starts group shutdown immediately; signal aborted; run not settled until ACK | `signal.aborted` true before ACK; process group ESRCH; `retentionConfirmed` false until release |
| EOF during inference/retention | Abort, suppress response, wait for ACK | No frames; `settled` false until release; process gone |
| Clean half-close during response write | Finish the already-retained write under `outputTimeoutMs` | One frame delivered; no premature kill |
| Output backpressure/timeout | Fixed `channel_output_timeout`; kill group; hold ownership until ACK | `responsesDelivered` 0; group ESRCH; settle flag |
| Startup failure (bad script/supervisor) | Fixed `child_start_failed`; no gateway/K2; no orphan | K3 calls 0; record absent; group ESRCH |
| Protocol truncated/oversized | Fixed frame reason; no dispatch; kill group | K3 calls 0; no K2 event; group ESRCH |
| Nested descendants in group | Group kill removes child and grandchild | Grandchild `kill(pid,0)` ESRCH; `cleanupConfirmed` true |
| Detached descendant | Group cleanup is verified; escaped descendant is outside the claim | Detached PID may survive the group ESRCH; docs/tests never report full-descendant cleanup |
| Duplicate retain same payload | Idempotent; one set of events | Event count unchanged; duplicate true |
| Duplicate retain changed payload | `retention_idempotency_conflict`; no task frame | Event count unchanged; fixed code |
| Concurrent same binding | Second `run()` refuses `binding_busy`; no second spawn | Spawn count 1; active map size 1 |
| Concurrent coalesced requests | First accepted; second closes; no queued dispatch | Gateway calls 1; K2 events one completion |
| K2 egress not ready / closed / missing | Fixed retention failure; no task frame; caller holds ownership | No events; no frame; `retentionConfirmed` false |
| R1 attempt stale | `attemptFence` refuses before K3; K2 append also refuses | K3 transport calls 0; K2 events 0; `gateway_attempt_fenced` |
| Budget in-flight/crash hold | No new request dispatch; no retry | `admitRequest` throws; transport calls 0 |
| K2 partial append then failure | No task frame; idempotent retry resumes/does not duplicate; stale attempt cannot append | Event count/keys; fixed code |
| Coordinator restart | New host reaps record or refuses `cleanup_unconfirmed`; new attempt does not auto-start; paid dispatch 0 | Record/group state; `attemptFence`/budget; K3 calls 0 |
| Host SIGKILL after admission | Existing hold survives; K2/R1 stale; orphan fixture reaped; no paid redispatch | Reopened ledger rows; stale append; reaper group ESRCH; K3 calls 0 |

## 7. Tests: red-first, new assertions and regression envelope

### 7.1 Red-first sequence (implementation follow-up, not this commit)

1. Add `packages/bench/test/k2-retention.test.ts`,
   `packages/bench/test/private-process.test.ts` and fixtures **without** production changes.
   Run the two files: expect failure because `private-process.ts`/`k2-retention.ts`/the
   `onTerminal` hook do not exist. Record the exact failing output in the handoff; do not commit
   a knowingly red test unless root asks for a red commit.
2. Add the `onTerminal` hook to `private-stream.ts`; test that it fires before ACK and does not
   release ownership. The existing 10 private-stream cases must stay green.
3. Add `k2-retention.ts`, the `attemptFence`/`k3RunId` fields and the real R1/K2 sink test.
4. Add `private-supervisor.mjs`, `private-process.ts` and the process fixtures.
5. Add docs, then hand off for independent review. Each review finding gets a separate fix
   commit; no test is weakened or deleted.

### 7.2 New files and planned cases

`packages/bench/test/k2-retention.test.ts` (target 8 cases):

- durable fenced retention of text/reasoning/signature/tool calls with exact event payloads;
- duplicate/changed-payload idempotency;
- stale R1 attempt and missing session/egress/closed log;
- scrubber spy plus a planted fake secret absent from K2 and request transcript absent;
- oversized/unsupported/long tool-call ID refusal before append;
- concurrent retain ordering;
- attempt/run/binding mismatch refusal;
- restart/budget in-flight refusal (with a reopened file-backed ledger).

`packages/bench/test/private-process.test.ts` (target 10 cases):

- executable fixture over real fds 3/4; public-only frames; K2 retention;
- child env/argv/frames contain no account/model/trial/provider key; fixture reports booleans
  only, never values;
- external abort with blocked retain: immediate signal/process kill, ACK-gated ownership;
- EOF during inference and clean half-close during delivery;
- output backpressure/timeout;
- startup failure and malformed/truncated/oversized/selector input;
- nested descendant group cleanup and a detached-descendant test that documents the group-only
  scope and cleans up its own escaped process;
- same-binding concurrency and coalesced request IDs;
- supervisor SIGKILL/reaper safety (does not kill an unrelated process);
- host SIGKILL/restart helper: budget hold, stale attempt, reaped orphan, zero K3 dispatch.

Fixtures: `test/fixtures/private-client.mjs`, `private-client-blocked.mjs`,
`private-client-descendant.mjs`, `private-host-crash.ts`. They use only Node built-ins plus the
production codec; they write boolean/PID observability files under `mkdtemp`, never secret
values or task text.

### 7.3 Regression envelope (run in full; separate from new counts)

- `packages/bench/test/private-channel.test.ts` — 10 existing.
- `packages/bench/test/private-stream.test.ts` — 10 existing.
- `packages/bench/test/k3-gateway.test.ts` — 7 existing cases; their fixtures add the new
  `k3RunId` and (where relevant) `attemptFence` fields, and one new attempt-fence case is
  added. No existing assertion is removed or weakened.
- `packages/bench/test/request-admission.test.ts` — 10 existing.
- `packages/bench/test/budget.test.ts` — 8 existing.
- `packages/bench/test/plugin.test.ts` — 3 existing.
- `packages/bench/test/k3-admission.test.ts` — 1 existing real K3 prepared-hook case.
- `packages/server/test/session-log.test.ts`, `durable-run-followup.test.ts`,
  `session-log-readiness.test.ts` — K2/R1 fence/retention regression.

Final counts will be recorded as `N new / M envelope` from the actual commands; the headline
number is not evidence. No browser/build/Storybook/full-suite claim is made by this slice.

### 7.4 Mutation anchors (root-owned mutation run, not this plan)

The new assertions should die when these guards are removed: `attemptFence.assert()` before
K3; `scrubber.scrub` in the sink; `attempt.id/run_id` binding check; idempotency key; retention
bounds; `onTerminal` shutdown; `stdio[1/2]='ignore'`; process-group kill/ESRCH verification;
reaper `ps` command check; budget in-flight/attempt fence. The existing mutation tool copies the
package to a temp directory and runs one exact test; it is a heavy-ish local check for root.

## 8. Scoped validation commands (worker envelope; root runs heavy gates)

```bash
export GUANXI_WEB_PORT=5212 GUANXI_API_PORT=4412 GUANXI_DATA_DIR="$PWD/.lane-data"
node -e "console.log(require.resolve('@guanxi/contract'))"   # must resolve inside this clone

nice -n 10 node --test packages/bench/test/k2-retention.test.ts packages/bench/test/private-process.test.ts
nice -n 10 node --test packages/bench/test/private-channel.test.ts packages/bench/test/private-stream.test.ts \
  packages/bench/test/k3-gateway.test.ts packages/bench/test/request-admission.test.ts \
  packages/bench/test/budget.test.ts packages/bench/test/plugin.test.ts packages/bench/test/k3-admission.test.ts
nice -n 10 node --test packages/server/test/session-log.test.ts \
  packages/server/test/durable-run-followup.test.ts packages/server/test/session-log-readiness.test.ts

nice -n 10 npx tsc --noEmit -p packages/bench/tsconfig.json
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
```

No `npm test`, build, browser, Storybook, `agent-dev`, nested sandbox/container, SSH, Fedora,
live model or paid request. Root owns full gates and integration. If a command fails, stop and
fix that failure before continuing; do not chain past a failure.

## 9. Ownership, paths, migration, rollback, licence

- **Owned paths:** `packages/bench/src/*`, `packages/bench/test/*`, `packages/bench/*.md`, this
  lane plan. No `packages/server`, `packages/contract`, `packages/web`, `packages/ui`,
  `packages/cli`, `docs/plans/PHASE_STATUS.md`, `docs/plans/NEXT_AGENT_PROMPT.md` or
  shared migration 33/38/39 edit.
- **Shared edits:** none planned. `@guanxi/server` is imported as type-only/structural, as
  `k3-gateway.ts` already does; no package dependency is added. If root chooses the additive
  reasoning field, `packages/contract/src/events/session-events.ts` becomes a shared edit and
  requires contract/K2/web regression checks.
- **No new package/dependency/copied code.** The supervisor and fixtures are original; the
  client reuses the production codec by import. ADR-0016 is unaffected; no
  `THIRD_PARTY_NOTICES.md` entry is needed. `@earendil-works/pi-ai` types are already a server
  dependency; no new license surface.
- **No database migration.** K2 tables, R1 tables, the bench ledger and canonical event types
  are unchanged. `reasoning` signature retention uses the existing `reasoning` JSON payload;
  process records are private files. Rollback is a code checkout: old code reads a reasoning
  text event normally; no schema/version bump is required. Existing rows remain valid.
- **Rollback risk:** a code rollback cannot undo a process record or partial K2 events already
  written; the next coordinator reaps the record and K2 events are private/idempotent. No user
  data or workspace cleanup is touched. If root later adds the optional signature field, a
  code rollback would make old strict schemas reject new events; that is why the recommended
  envelope avoids it.
- **Docs:** new `packages/bench/PRIVATE_PROCESS.md`; update `PRIVATE_CHANNEL.md`,
  `PRIVATE_STREAM.md`, `README.md` residual/status and this lane plan. Do not mark proposed work
  implemented; do not edit PHASE_STATUS/NEXT_AGENT_PROMPT. Root folds the handoff.

## 10. Unresolved facts requiring root authorization

1. **Signature retention format.** Recommended: versioned text envelope inside the existing
   `reasoning` event (no contract/migration; rollback-safe; inspector shows opaque text).
   Alternative: additive optional `reasoning.signature`/`redacted` fields (cleaner semantics;
   changes the canonical contract and old strict readers cannot parse new events after a
   rollback). Root must choose before implementation.
2. **Supervisor asset.** The recommended supervisor is a trusted `src/private-supervisor.mjs`
   spawned by absolute path. The bench package is run from source and has no build step; a
   future bundle must include this asset. Root must confirm the packaging assumption or accept
   a direct-spawn fallback (no crash reaping; parent-crash orphan documented).
3. **K3 identity mapping.** Adding `k3RunId` is a bench-owned API change (no external callers
   found). Root must confirm that K3 `ModelCall.runId` should be the R1 run, while the budget
   ledger keeps `experimentId` under its existing `runId` column.
4. **Pre-dispatch fence.** `attemptFence` is optional for old fixtures and required by the new
   host. Root must confirm using `runs.renew(attempt)` as the fence (it extends the lease) or
   add a read-only `RunStore.assertAttempt` instead (shared R1 edit).
5. **Multi-event atomicity.** Per-event fenced idempotent appends are proposed; a mid-completion
   failure can leave a private partial trace. Atomic all-or-nothing retention needs a new R1
   batch API. Root must accept the residual or authorize the batch API.
6. **Orphan reaping trust.** The private record directory is same-UID writable and `/bin/ps`
   command matching is best-effort. Root must accept this as cleanup, not a security boundary,
   or require the rootless-Podman/cgroup path for stronger claims.
7. **Tool-call provenance.** `toolSource` is coordinator-supplied because the private v1 schema
   has no MCP marker. B1 arms are treated as `builtin`; a future MCP arm needs a separate
   binding/transport decision. Long tool IDs fail closed rather than being truncated.

## 11. Handoff / exact pin

Base pin: `6da20584d3ee774c720f24b3c60bb0468325f29c`.
This run produced exactly one plan commit on `codex/b1-trial-binding`; the final commit SHA and
the clean-tree check are reported by the worker after the commit. No product code, test, config
or status file was edited. Root must independently review this plan before authorizing
implementation; the author does not claim any code, test, operational, paid or real-benchmark
evidence in this run.

## 12. Root review corrections and resolved design choices (authoritative)

The root reviewed the 607-line plan at `3bfb54c` and authorized a corrected bounded slice in
`/Users/yuzuru/Projects/Guanxi-lanes/b1-trial-binding` on `codex/b1-trial-binding`. This section
records the binding corrections before code. Where it contradicts Sections 1–11, this section
wins; the earlier text remains for review history.

### 12.1 No acknowledgement timeout escape

Delete the `ackTimeoutMs` field and the `retentionConfirmed:false` early-return path from the
slice. A resource-owning `run()`/active-binding promise remains pending and owned until the
actual gateway completion **and** the actual K2 retention acknowledgement have settled, even if
the external signal was aborted immediately and process-group shutdown was requested. No timer,
ESRCH observation, child exit or channel terminal state may release the active-binding map, an
R1 permit, a budget hold or trial ownership, or may claim that pending inference stopped.

Timers may bound process startup, process shutdown, input and output delivery. They never
establish settlement of pending inference or retention. If no acknowledgement ever arrives,
the owning promise stays pending honestly. Tests must hold a controlled gate, assert the run is
not settled while the gate is held, then release it. Both a late fulfilment and a late rejection
are covered and must be consumed with zero unhandled rejections. A separate observer wake-up is
unnecessary and is not added. No distributed or backend inference-cessation claim is made.

### 12.2 Supervisor record removal belongs to the live parent or reaper only

The supervisor must not remove the private process record. It cannot verify `ESRCH` for its own
process group after it sends `SIGKILL` to that group because the signal kills the supervisor
too. The supervisor writes and updates the record, terminates its group on lifetime EOF, and
leaves the record in place. Only a live parent or the next reaper removes the record, and only
after the supervisor close is observed (parent) or the recorded identity is validated, the
group is signalled, and the group is actually `ESRCH` (reaper).

On parent death the record stays persisted for the next reaper. A reaper never unlinks on a
merely issued kill, a timeout, an unvalidated PID or an inability to validate identity; it
returns `cleanup_unconfirmed` and preserves the record/quarantine. A crash between record
removal and a kill therefore cannot leave an untracked process: removal is last. The test suite
asserts that the record exists while the client and grandchild are alive and after a forced
supervisor death, then exercises the reaper.

Identity checks use exact tokenised argv for the expected supervisor or client invocation,
plus the recorded PID/process-group relation, never a substring match. A process that does not
match exactly is not signalled. Same-UID cleanup is a best-effort fixture-foundation mechanism,
not a security boundary; the plan and docs must not claim container isolation or proof over a
descendant that leaves the process group with `setsid`. An escaped test descendant is cleaned
up by its explicitly owned PID, and the test never claims full descendant cleanup.

### 12.3 File-descriptor direction

The corrected layout is:

| FD | Child side | Host side | Use |
| --- | --- | --- | --- |
| 3 | read | writable | host → child **public completion response** |
| 4 | write | readable | child → host **completion request** |
| 5 | read | writable | lifetime pipe |
| 6 | write | readable | one bounded ready/start-error control line |

The plan text and table that inverted request/response words are corrected here. The private
full completion result, reasoning, signature, usage and provider/account/model/trial identifiers
are never written to the child. Only strict public response frames are written on fd 3. A test
runs an actual OS fixture for two sequential requests and asserts the full public response key
set, stdout/stderr ignored, and no account/model/trial/provider reference in the child argv,
environment or request frames. The nonce is host correlation only, not authentication; a new
spawn receives a genuinely fresh anonymous FD capability.

### 12.4 Red-first evidence and guard mutations

A red run that fails only because a module or import is missing is recorded as a setup failure,
not as behavioural proof. The new tests assert observable violated properties: no task-visible
success frame before retention, exact event/payload counts, fixed codes, process-group `ESRCH`,
record preservation/removal order, immutable binding copies and the active-binding map.

Before acceptance, each production guard named below is exercised by a temporary no-guard
mutation and the corresponding test must fail with an assertion: pre-dispatch attempt fence,
sink scrub, attempt/run binding check, idempotency key/conflict, retention bounds, projection
equality, `onTerminal` shutdown, child stdout/stderr suppression, group kill/ESRCH verification,
reaper exact identity, active-map duplicate guard and budget in-flight/attempt refusal. Mutation
copies are temporary and are not committed. Test counts are reported as explicit `new` and
`regression envelope` numbers, never a single inflated headline.

### 12.5 One final scrubbed public projection

K3 already scrubs the completion, but the scrubber readiness/value registry can change before
K2 retention and the task response. The current channel would retain a second-scrubbed result
while projecting the original result. That is a correctness gap.

The private channel gets an internal optional trusted `retainAndProject(requestId, result)`
port. The existing pure fixture host API (`retain`) remains supported. The new production host
factory requires `retainAndProject`; the K2 sink scrubs the full completion, validates every
bound, durably appends the private events, derives the public projection from the stored
assistant/tool events and returns exactly that projection. The channel writes that returned
projection, so the task response and the K2-acknowledged public content are the same object
shape and values. The caller's result is not mutated; reasoning, signatures, usage and request
selectors are not returned.

Tests register a fake value between gateway return and retention: no success task frame and no
unscrubbed value in K2; the retained public event equals the frame; readiness withdrawal yields
no successful task response. No private payload export is added.

### 12.6 Resolved choices

- **Signature format:** versioned private text envelope in the existing `reasoning` class
  (`guanxi.bench.thinking-signature/v1\n` plus JSON). No wire-contract or schema migration.
- **Audience/export:** actual `SessionLog` `remote_agent` reads and export assertions must omit
  both reasoning and the signature envelope.
- **Supervisor asset:** the original `src/private-supervisor.mjs` is an allowed trusted asset
  for the source-run bench package. A missing asset fails closed; there is no direct-spawn
  fallback. Its packaging/distribution limitation is documented as a residual.
- **K3 identity:** `k3RunId` is optional on the existing gateway config for old internal
  fixtures and defaults to the current `trial.runId`; the new host factory supplies the actual
  R1 `runId` and keeps `experimentId` as the separate budget-ledger identity.
- **Pre-dispatch fence:** `attemptFence.assert = () => runs.renew(attempt)` is the trusted T0
  synchronous side effect. No new server method is added.
- **Partial private trace:** per-event idempotent partial private traces are accepted only if no
  task response is emitted until **all** appends acknowledge, and a same-key changed payload
  refuses. Tests assert actual retry counts and sequence behaviour. There is no automatic
  redispatch or retry.
- **Tool provenance:** `toolSource` is fixed to coordinator-supplied `builtin` for this arm.
  Unknown/MCP future arms are not invented, and tool IDs are never silently truncated.
- **Process trust:** same-UID best-effort process-group cleanup is honest fixture foundation
  only, not untrusted-container isolation or all-descendants proof.
- **Private paths:** the binding directory is `0700`, records are `0600`, symlinks are refused,
  record inspection is bounded and safe-rooted, and no arbitrary environment is spread to the
  child. All scalar policy ceilings are explicit trusted-host values; there are no hidden
  token/media caps and no secret in argv, environment or plain logs.
- **Unchanged boundaries:** stock B1 paid execution stays OFF; the real budget hold,
  single-attempt request and T0 account binding remain. The child cannot declare
  `boundedBilling`, cleanup or peer facts. D-194 still prohibits real bench execution on this
  Mac; no B1 quality claim is made.
