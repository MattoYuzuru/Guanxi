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

## 13. Implementation status (2026-10-22)

**Status:** corrected bounded vertical slice implemented and locally fixture-checked; independent
root/GPT review and full integration gates remain pending. This does not close B1, does not
activate ADR-0025 and does not enable paid execution.

Implemented commits:

- `78b5fa3` — this authoritative review-correction section, recorded before code;
- `e294a9b` — immutable trial binding, pre-dispatch R1 attempt fence and K3 run identity, real
  structural K2 sink with explicit bounds/idempotency, versioned signature envelope, and the
  authoritative scrubbed public projection used by both K2 and the task frame;
- `b61c7f8` — owned supervised process group, trusted source-run supervisor/launcher assets,
  anonymous fd 3/4 transport, record/reaper ordering, `onTerminal` startup/shutdown hook and
  ACK-gated ownership with no acknowledgement timeout;
- a follow-up test commit asserting scrub-before-append, post-append bound recheck and exact
  reaper token identity (final handoff records its SHA);
- docs/handoff, including [PRIVATE_PROCESS.md](../../../packages/bench/PRIVATE_PROCESS.md), the
  appended lane handoff and the corrected channel/stream/bench READMEs.

The real K2 sink imports server APIs type-only; no server/contract/UI package, migration,
dependency or REST/CLI surface changed. Stock B1 paid execution remains OFF, the actual budget
hold/single-attempt/account binding is unchanged, and D-194 still prohibits real bench execution
on this Mac.

Residuals are recorded in the handoff: same-UID cleanup is not isolation, a `setsid` descendant
is outside the group proof, `/bin/ps` execution was blocked by this worker harness (the reaper
uses an injected observation seam in tests), the supervisor/launcher are source-run assets that
a future bundle must include, acknowledgement can leave the owning promise pending by design,
and per-event K2 appends can leave an idempotent private partial trace with no task response.
No real model, corpus, container, SSH, paid or quality evidence is claimed.

## 14. Review-fix plan for the three reproduced P2s (authorized after correction)

**Status:** prepared as a plan only at `1bbd034`; code is authorized by the root correction in
§14.10 after a separate short plan-correction commit. No production, test, dependency or status
file was edited by the preparation commit. Prepared after the reviewer freeze was released, against clean pin
`a00d53b22ae0ec13691534e7f65312134b3bddee` on `codex/b1-trial-binding`. The independent
review is `reviews/codex-b1-trial-binding-20261022.md`; its external probes are
`b1-process-independent-review.test.ts`, `b1-parent-death-worker.ts`,
`b1-process-review-header.ts` and `b1-k2-independent-review.test.ts` outside this checkout.
Root authorization is required before any code is written. This section appends to, and does
not erase, Sections 1–13.

The three reproduced P2s are:

1. the reaper's orphan-client fallback can kill a different live binding after PID reuse;
2. an empty completion gets no actual R1-fenced K2 acknowledgement;
3. `stopReason` is outside durable completion identity, and a partially written completion
   does not detect removed/reordered payload specifications.

The fix is deliberately two-part: a per-spawn cleanup generation for process ownership and a
private two-phase completion receipt in the existing K2 reasoning class. Neither adds a REST
route, SSE event, canonical event type, database migration or dependency. The no-ACK-timeout
rule (§12.1), record-removal ordering (§12.2), fd layout (§12.3), final scrubbed projection
(§12.5) and stock-paid OFF/D-194 boundaries remain unchanged.

### 14.1 P2-1: refuse a live mismatched supervisor and prove the client generation

**Current behaviour and root cause.** At the reviewed pin,
`packages/bench/src/private-process.ts:237-245` proves a supervisor only by its exact
`node`/supervisor/record/tag/nonce argv; `:243-245` proves a client only by numeric `pgid` plus
the common `node`/launcher/client-script argv. `:274-286` inspects the recorded supervisor; if
it is alive but does not match, the reaper falls through to `findClient`. The client argv has no
binding-specific identity, so a stale record whose PIDs were reused by a newer trial can match
the newer client, kill its group and unlink the stale record. The independent probe models this
with real owned fixture PIDs and observes `removed`, `liveSupervisorAlive=false` and
`staleRecordPresent=false` instead of quarantine.

**Proposed ownership proof (recommended: fresh cleanup generation token).** The supervisor
generates `clientToken = randomBytes(32).toString('base64url')` before spawning the client. It
records only `clientTokenHash = sha256(clientToken)` in a version-2 private record, passes the
token as the launcher/client's fourth argv element, and writes the record before the `ready`
control line. Before accepting the startup ACK the host validates the v2 record shape, the
token-hash field and the expected PIDs; the actual client token is verified at reap. The token
is generated in the supervisor, is **not** derived from the binding,
nonce, experiment, task, arm, run, attempt, account, connection, model, provider or trial, is
not written to the record, is not in the environment or private frames, and grants no
capability. It is a cleanup generation, not authentication.

Record v2 (private file, mode `0600`, under the existing `0700` directory):

```json
{ "version": 2, "bindingTag": "<sha256>", "nonceHash": "<sha256>",
  "supervisorPid": 123, "pgid": 123, "clientPid": 124, "clientExitCode": null,
  "clientTokenHash": "<sha256 of the fresh cleanup token>",
  "clientScript": "/absolute/path", "startedAt": 0 }
```

**Reap decision table (no fallback from a live mismatched supervisor):**

| Observation | Required action |
| --- | --- |
| record absent | `absent` |
| record invalid, tags or `clientScript` mismatch | `cleanup_unconfirmed`; preserve |
| process group is `gone` | unlink the record only; no signal; `removed` |
| process group status `unknown` | `cleanup_unconfirmed`; preserve |
| supervisor observed live and exact tokenised argv | SIGTERM `-pgid`, grace, SIGKILL, verify `ESRCH`, then unlink |
| supervisor observed live but mismatched | `cleanup_unconfirmed`; **never** inspect/kill the client |
| supervisor not observed (dead or zombie), v2 `clientPid` observed with exact launcher argv **and** `sha256(token) === clientTokenHash` and same `pgid` | SIGKILL `-pgid`, verify `ESRCH`, then unlink |
| supervisor not observed and client absent, mismatched, or token missing | `cleanup_unconfirmed` if the group is alive |
| v1 record, exact supervisor observed | allow the existing supervisor cleanup path |
| v1 record, no exact supervisor | never use the client fallback; unlink only when the group is already gone |

`isClient` becomes an exact four-token argv comparison (`node`, launcher, client script, token)
plus `pgid`, followed by hash equality. No substring match, no `ps -ax` scan and no
numeric-group-only proof remain. The `ps` observer gains the process state
(`pid=,pgid=,state=,command=`) so a zombie/defunct PID is not treated as a live mismatched
supervisor; it falls through only to an exact client proof. The test seam keeps its existing
injected-observer shape. If the state is unavailable, treat the process as live and fail closed.

**Why this is precise, and its trade-offs.** The token is a 256-bit fresh generation bound to
one supervisor spawn and one client; a reused PID or a newer binding cannot present the same
hash, and the record is durable before the startup ACK. The token is visible in the client
argv and `ps`; a same-UID child can read or spoof it. That is acceptable only because this is
accidental/crash cleanup, not hostile isolation, and it grants nothing. If the child overwrites
its argv, the reaper cannot prove the client and quarantines. Legacy v1 records have no token
and therefore cannot use the client fallback. The prior doc boundary "no binding/account/model/
provider/trial identity in child argv" is preserved; the token is non-identifying and the
existing isolation assertions must continue to assert absence of the binding sentinels and
nonce.

**Alternatives rejected.** `/bin/ps` `lstart` uses `%c` and only one-second resolution, and is
locale/format-sensitive; a same-second PID reuse could still collide, so it is not a sole
ownership proof. macOS `proc_pidinfo` birth microseconds need a native addon/build, which this
source-run slice does not add. A timestamp written by the supervisor is self-asserted, not an
OS birth observation. In-memory or PID-uniqueness proofs do not survive restart. Putting
`bindingTag`, the nonce, trial/account/model/provider identity in child argv is forbidden by
the earlier isolation tests. Removing all client fallback is safe but loses the actual forced
supervisor-death cleanup that the review asks to preserve; the exact token keeps that path.

**Exact files (implementation, not this commit):**

- `packages/bench/src/private-supervisor.mjs` — generate the cleanup token, write v2 record
  with its hash before `ready`, pass the token only to the launcher/client argv, preserve it
  on `clientExitCode` updates.
- `packages/bench/src/private-process.ts` — v1/v2 record union and validation; exact client
  token hash; fail-closed mismatched-supervisor branch; zombie handling; group-gone-first
  unlink; v2 startup validation; no broad process scan.
- `packages/bench/test/private-process.test.ts` — v2 fixtures/token, fail-closed live
  mismatched supervisor, legacy v1 live quarantine and gone-record unlink, preserved
  forced-supervisor-death/parent-death/ESRCH assertions, real-process probe owned by
  root/reviewer.
- `packages/bench/PRIVATE_PROCESS.md` — record v2/token/legacy rules.
- External probes under `reviews/` are read-only inputs; root/reviewer updates them for v2 and
  runs the real `/bin/ps` observation. They are not committed from this checkout.

### 14.2 P2-2: every completion gets an actual fenced durable acknowledgement

**Current behaviour and root cause.** `packages/bench/src/k2-retention.ts:170-179` checks
attempt/run/session structure, but the live attempt lease is only checked by
`runs.append` at `:203-207`. An empty completion builds zero event specifications, skips every
append, and returns `storedPublicMessage(..., clean.stopReason)` at `:220`. A run/session still
matches after cancellation, so a canceled/deposed attempt can receive a false retention
success. `runs.renew(attempt)` in the gateway is a pre-dispatch liveness check; it is not a
durable retention acknowledgement.

**Inspect `turn.done` and reject it for this purpose.** The canonical `turn.done` event is
`{ messageId, outcome, stopReason, steps }`, a standard audience event. `native-agent/service.ts`
appends it exactly once after the whole agent turn returns (`:358`) or in the terminal failure
path (`:364`); `external-agents/service.ts` appends it on completion/cancellation/failure
(`:293`, `:303`). A private completion can be an intermediate `toolUse` step, not a whole turn,
and `turn.done` is visible to standard/export/remote reads. Emitting it per completion would
falsely close a turn and add a lifecycle fact this slice was not authorized to create.

**Proposed event: a private two-phase receipt inside the existing `reasoning` class.** Use the
existing `reasoning` event type/data (`{ messageId, step, text }`), no new event type or
schema. A versioned private envelope in `text` carries only hashes, counts and the already
public `stopReason`:

```text
guanxi.bench.completion-receipt/v1
{ "version": 1, "phase": "begin" | "done", "requestId": "...",
  "stopReason": "...", "specs": [{ "role": "...", "type": "...", "key": "...",
  "sha256": "..." }], "specCount": 4, "manifestSha256": "...",
  "publicSha256": "...", "contentSeqs": [ ... ] }
```

The begin receipt is keyed `bench:<nonce>:<requestId>:receipt:begin`; the done receipt is keyed
`...:receipt:done`. Both use `reasoning` data with `messageId: requestId`, `step: null` and
`spanId: requestId`, so a receipt is never mistaken for a content step. Both are appended
through `runs.append(attempt, ..., { idempotencyKey, expectedSeq })`, so the real R1 fence, K2
authorisation, scrubbing, idempotency key uniqueness and durable commit are the existing ones.
The begin append is the first durable acknowledgement;
the done append is the final acknowledgement. An empty completion still writes both, so the
empty path has a real lease check and durable commit. A canceled/deposed attempt throws
`stale_lease` on the begin append and maps to `retention_fenced`; no event and no success frame.

The receipt is in the reasoning retention class because reasoning is already local-only,
excluded from remote/export, scrub-before-write, and purged under the existing 7-day/parent
TTL (D-113). This is the smallest no-schema option and keeps the private task boundary. Its
trade-off is stated explicitly: after a reasoning purge the receipt text is unavailable, so a
same-key retry must refuse rather than reconstruct `stopReason`; the idempotency row/hash still
exists, but the sink fails closed. No plaintext receipt, reasoning or signature is logged.

**Exact files (implementation, not this commit):**

- `packages/bench/src/k2-retention.ts` — receipt envelope, begin/done append sequence, empty
  completion path, `retention_fenced` mapping.
- `packages/bench/test/k2-retention.test.ts` — empty valid/canceled/deposed, append-count and
  no-response assertions, retained-receipt shape.
- `packages/bench/src/trial-host.ts` — only if the existing `SessionLog.readAll` method is added
  to the structural `session` type (see 14.3); no server code change.
- `packages/bench/PRIVATE_CHANNEL.md` / `PRIVATE_PROCESS.md` / `README.md` — acknowledge the
  receipt and empty completion.

### 14.3 P2-3: bind full public identity and reconcile partial writes

**Current behaviour and root cause.** The sink builds content specifications, appends each with
a key, then returns `storedPublicMessage(assistantText, toolCalls, clean.stopReason)` at
`k2-retention.ts:220`. `stopReason` is not in any retained specification, so the same
binding/request key with the same text/tools but a different `stopReason` (for example `stop`
then `length`) deduplicates every event and returns a changed public projection. A partial
earlier write also leaves content events with no manifest that proves the full ordered set; a
retry that removes a specification or reorders tool calls can append/deduplicate the remaining
keys and still return a result. An in-memory cache would not survive sink recreation/restart.

**Receipt identity.** Build the ordered content specifications first, from the fully scrubbed
completion, exactly as today (reasoning, versioned signature, joined assistant text, tool calls
in content order). Then:

- `specs` records the ordered `{ role, type, key, sha256(canonical(event data)) }` list; it
  never contains reasoning text, signature text, tool arguments or usage.
- `manifestSha256` is the canonical hash of the ordered specification digest list.
- `publicSha256` is the canonical hash of `{ text, toolCalls, stopReason }`, where `text` and
  `toolCalls` are the public values and `toolCalls` preserve order. A small local canonical JSON
  function sorts object keys recursively, preserves array order, and refuses non-JSON values
  before the first append.
- `stopReason` is scrubbed and stored in the begin receipt. The returned stop reason always
  comes from the **stored** begin receipt, never from fresh `clean.stopReason`.
- The done receipt repeats `manifestSha256`, stores the actual `publicSha256` derived from the
  acknowledged stored content, and stores the ordered `contentSeqs` of the acknowledged content
  events. It contains no private completion text.

The begin receipt is checked for `maximumReasoningTextBytes` and the planned content-plus-begin
bytes are checked against `maximumRetainedBytes` before the first append; the done receipt is
checked before its own append and the cumulative retained total is checked before the done
append. An oversized receipt fails `retention_too_large` with no success frame; a failure after
the begin or a content prefix may leave the allowed private partial trace. The receipt is
scrubbed by the sink and again by `SessionLog`; `runs.append` performs the actual fence. The
`specs` digests are local reasoning-class evidence only; they are not returned to the child,
exported or logged, and a digest is not the reasoning/signature value. Incoming `clean` is never
mutated and no reasoning/signature value is returned.

**Reconciliation before appending.** Use the existing `SessionLog.readAll(sessionId, 'person')`
and filter events with `spanId === requestId` (all private completion events set it). This is an
existing read API; `TrialHostConfig.session` / the sink's structural type widens from
`Pick<SessionLog, 'session'>` to include `readAll`; no server edit is needed. The read occurs
after `scrubber.isReady()` and before the first append.

1. No request-scoped event: a new completion; append the new begin receipt as the first durable
   acknowledgement, then continue.
2. Events exist but no valid begin receipt: this is a pre-fix/legacy partial trace. Refuse
   `retention_idempotency_conflict` **before any append or success frame**; preserve the rows.
   This is the compatibility boundary for already-partial local fixture records.
3. Begin receipt exists: append the begin receipt with the same key and `expectedSeq` **before**
   comparing identity. The existing `runs.append` idempotency check is authoritative: a changed
   begin payload throws `idempotency_conflict` (mapped to `retention_idempotency_conflict`) and a
   stale/deposed attempt throws `stale_lease` (mapped to `retention_fenced`), both before any
   content or success frame. The duplicate returns the stored receipt; parse and validate it and
   compare the version, phase, request id, stopReason, ordered specs, `manifestSha256` and
   `publicSha256`. A malformed or purged stored receipt is a conflict.
4. Filter stored content events (exclude both receipts) in `seq` order and compare them with
   `specs`. Every content `seq` must be greater than the begin receipt `seq`; content before the
   begin is a conflict. With no done receipt the content list must be an exact prefix of `specs`;
   with a done receipt it must be exactly the full list and every content `seq` must be less than
   the done receipt `seq`. Any extra, gap, reorder or digest mismatch is a conflict.
5. If the done receipt exists, verify its `manifestSha256`, `publicSha256`, `contentSeqs` and
   stored content; re-append the done receipt as an idempotent duplicate so its R1 fence is also
   checked; return the stored projection. If it does not exist, append only the missing content
   specifications in manifest order, verify the stored events, append the done receipt, and only
   then return.
6. Purged/unreadable receipt data: refuse; never reconstruct `stopReason` or guess a projection.

**Append sequence, first/final acknowledgement and failure behaviour.**

- New completion: scrub/validate → begin receipt append (first durable ACK) → each content
  event append (durable per-event ACK) → done receipt append (final durable ACK) → derive and
  return the public projection from the stored assistant/tool events and the stored begin
  `stopReason`. The channel emits no `status:'ok'` frame before the done append settles.
- Empty completion: the same sequence with zero content events; begin and done are both
  written, and the projection is `{ text: '', toolCalls: [], stopReason: <stored> }`. The
  existing channel may emit its fixed error frame on a retention rejection; that is not a
  public completion success frame.
- Failure before begin: no events; retry starts clean.
- Failure after begin and before done: no success; the begin and any content prefix remain.
  Retry with the unchanged manifest revalidates the prefix, appends missing content, appends
  done, and returns. Retry with a changed manifest conflicts at the begin receipt before
  content.
- Failure after done: no success may have been delivered; a retry revalidates and returns the
  stored projection without duplicating rows. A same-key retry with changed evidence is
  refused.
- Sink recreation/restart: no in-memory receipt cache is used; all decisions come from K2 rows
  and the R1 append fence. A new sink sees the same begin/done rows.
- Abort/readiness withdrawal/late scrub: a withdrawn scrubber yields `retention_not_ready`
  before the next append; a late registered value that changes a stored payload makes the
  digest comparison fail before success; a partial private trace may remain, as before. No
  response is emitted until the final acknowledgement.

**Exact contradictory retries that must refuse before any success frame:** changed `stopReason`;
changed text or tool arguments; removed or added specification; reordered tool calls or reasoning
specifications; identical public projection but changed private reasoning/signature; a
pre-fix/legacy partial trace with no begin receipt; an extra/gapped/reordered stored content
list; a done receipt whose content sequence/public digest does not match; a purged receipt; a
canceled/deposed attempt (through the begin append's `stale_lease`); and a late scrub that
changes an acknowledged digest. The fixed code is `retention_idempotency_conflict` for identity
contradictions, `retention_fenced` for the lease, `retention_not_ready` for readiness, and
`retention_failed` for other storage failures. The channel exposes only its existing fixed
`channel_failed` code to the child, never raw K2 text.

**Exact files (implementation, not this commit):**

- `packages/bench/src/k2-retention.ts` — canonical hashes, receipt construction, readAll
  reconciliation, begin/content/done ordering, stored stopReason, receipt bounds.
- `packages/bench/src/trial-host.ts` — widen `session` to `Pick<SessionLog, 'session' | 'readAll'>`.
- `packages/bench/test/k2-retention.test.ts` — changed stopReason/content/reorder, sink
  recreation, partial-trace retry, legacy no-receipt refusal, empty paths, late scrub/withdrawal,
  export/remote omission and append counts.
- `packages/bench/test/trial-host.test.ts` / `trial-binding.test.ts` — type/composition only if
  their fixtures need the widened session type.
- `packages/bench/PRIVATE_CHANNEL.md`, `PRIVATE_PROCESS.md`, `README.md` — receipt semantics and
  the stored-stopReason rule.

### 14.4 Red/green matrix and observable proof

`red` is an assertion expected to fail at pin `a00d53b`; `green` is the required post-fix
observation. Real process-table rows are root/reviewer-owned; worker seam results alone are not
acceptance evidence.

| Case | Red at the pin | Green expected |
| --- | --- | --- |
| Reused PIDs, stale record, live newer supervisor | reaper removes stale record and kills newer group | `cleanup_unconfirmed`; record preserved; newer supervisor/client alive; no signal |
| Live mismatched supervisor but no matching client | may fall through to client/group logic | fail closed before client lookup; record preserved |
| Unknown live group, no exact supervisor/client token | already quarantines | still quarantines; record preserved |
| v1 record with live group | weak client fallback can kill | no client fallback; quarantine; unlink only when group gone |
| v2 forced supervisor death with exact client token | current test uses v1/no token | reaper removes only after actual group `ESRCH`; client/grandchild gone; record absent |
| Parent death, record left behind | current path passes | record persists, group `ESRCH`, default reaper removes; assertions unchanged |
| Near-miss supervisor argv | already refuses | still refuses; no substring or numeric-only match |
| Real `/bin/ps` observation | worker cannot run it | root/reviewer observes actual supervisor/client identity and `ESRCH`; no fake-seam green |
| Empty valid completion | no append; returns success | begin+done receipts; empty projection; stored stopReason; no assistant/tool rows |
| Empty canceled attempt | resolves success | rejects `retention_fenced`; no receipt/content; no success frame |
| Empty deposed attempt | resolves success | rejects `retention_fenced`; no success frame |
| Changed stopReason (`stop` → `length`), same key | resolves with changed projection | `retention_idempotency_conflict`; retained count unchanged; original stopReason |
| Removed content spec after partial append | may return a shorter result | begin manifest conflict before content/response |
| Reordered tool calls, same key | per-key dedupe may return changed order | manifest/public conflict before content/response |
| Same public projection, changed reasoning/signature | may dedupe private rows | manifest digest conflict; no response |
| Sink recreation between attempts | fresh `clean.stopReason` returned | new sink validates stored begin/done; same projection; no duplicates |
| Partial begin+content, same payload retry | no receipt today | begin duplicate, missing content, done; no duplicate rows |
| Legacy no-receipt partial trace | may be adopted | `retention_idempotency_conflict`; rows preserved; no append |
| Late scrub/registered value after begin | may project/store different evidence | digest mismatch or `retention_not_ready`; no success; partial trace allowed |
| Oversized receipt | no receipt today | `retention_too_large` before the first append |
| Export/remote reads | receipts do not exist | receipts stay in reasoning class; remote/export omit both reasoning and receipt envelope |

The existing assertions for supervisor death, parent death, group `ESRCH` before unlink, record
preservation on uncertainty, no unlink after an unissued/unvalidated kill, fd 3/4 isolation,
no private identity in child argv/env/frames, and no success before retention settlement are
retained and must not be weakened. New guard mutations for acceptance: remove the live-mismatch
early return, remove token-hash comparison, remove the begin receipt, remove the stored-stopReason
read, remove the ordered manifest comparison, and remove the readAll legacy refusal; the named
tests must fail with an assertion.

### 14.5 Validation and ownership

Worker-targeted commands after root authorizes code (from this clone, `nice -n 10`):

```bash
export GUANXI_WEB_PORT=5212 GUANXI_API_PORT=4412 GUANXI_DATA_DIR="$PWD/.lane-data"
node -e "console.log(require.resolve('@guanxi/contract'))"

nice -n 10 node --test packages/bench/test/k2-retention.test.ts \
  packages/bench/test/private-process.test.ts packages/bench/test/trial-host.test.ts \
  packages/bench/test/trial-binding.test.ts packages/bench/test/private-channel.test.ts \
  packages/bench/test/private-stream.test.ts packages/bench/test/k3-gateway.test.ts \
  packages/bench/test/request-admission.test.ts packages/bench/test/budget.test.ts \
  packages/bench/test/plugin.test.ts packages/bench/test/k3-admission.test.ts

nice -n 10 node --test packages/server/test/session-log.test.ts \
  packages/server/test/durable-run-followup.test.ts packages/server/test/session-log-readiness.test.ts

nice -n 10 npx tsc --noEmit -p packages/bench/tsconfig.json
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
```

The real `/bin/ps` process-table probe is **not** a worker check: this DSH sandbox blocks it.
Root/reviewer runs the external process probe unsandboxed on the same Mac/Node26 and records
the actual observation. This worker does not run `npm test`, the browser gate, build,
Storybook, mutation tooling, `agent-dev`, a nested sandbox/container, SSH, a live model, a paid
call or the full gates. No check is run for this plan-only commit.

### 14.6 Migration, compatibility, rollback

- **Database:** no migration. The receipt uses existing `reasoning` rows; existing K2/R1 schema,
  indexes and retention remain. No new event type or REST/SSE field.
- **Already-partial K2 fixture records:** a request with content rows but no begin receipt is
  a legacy/uncertain trace. It is never auto-adopted: the sink returns
  `retention_idempotency_conflict` before append/response and preserves the rows for local
  inspection. A new request id/binding works normally. If a begin receipt exists, the ordered
  prefix is reconciled as described; a changed retry conflicts.
- **Already-partial process records:** v1 records remain readable for exact supervisor cleanup
  and group-gone unlink, but their client fallback is disabled. A live v1 group with no exact
  supervisor is quarantined; `runPrivateTrial` refuses to spawn for that binding until the
  record is resolved. There is no file migration; v1 records are ephemeral private state. New
  spawns write v2 with a fresh token.
- **Rollback:** old code sees a v2 process record as invalid and returns `cleanup_unconfirmed`
  (fail closed, no kill); old retention code ignores receipt rows and can again return fresh
  `stopReason` on a same-key retry. Therefore rollback with live v2 records/receipts is not
  safe without root reconciliation; forward-fix is preferred. No user data or database schema
  is changed by rollback.
- **Retention expiry:** after the reasoning TTL, receipt data is purged but the idempotency
  row/hash remains. A same-key retry fails closed rather than reconstructing `stopReason` or
  returning fresh evidence.

### 14.7 Risks, residuals and non-claims

- The cleanup token is visible to the client and `ps`; same-UID tampering/spoofing remains
  outside the proof. This is cleanup, not isolation; the rootless-Podman/cgroup boundary is
  unchanged.
- The real `/bin/ps` path and exact macOS argv/state parsing remain root/reviewer-owned; the
  worker seam is not production evidence.
- `readAll` reconciliation is O(session) per completion. No new index/query API or hidden cap
  is added; the cost is a residual for long sessions, and a future optimization is separate.
  It uses the existing person-audience read and only in-memory comparison; it does not export
  reasoning or write it to a log.
- The two receipts add private reasoning rows per completion and increase the
  `excluded.reasoning` export count; they do not enter public frames. A reasoning purge can
  make a very late retry fail closed.
- Per-event appends remain non-atomic; an allowed private partial trace can remain after a
  failure. No response is emitted until the done acknowledgement. There is no automatic
  redispatch/retry and no distributed inference-cessation claim.
- No server, contract, UI, dependency, migration, paid path, real model/provider call, Harbor,
  Podman/container, SSH, GPU, public corpus, five-seed experiment or B1 quality result is
  included. Stock paid execution remains OFF; D-194 remains in force.

### 14.8 Root choices

1. **Ownership proof:** approve the fresh non-identifying cleanup token in the client argv
   (stored only as a hash, exact-match at reap) as the recommended precise generation proof, or
   require a different platform-supported proof. The token preserves actual forced-supervisor
   death cleanup and makes live mismatch/uncertainty quarantine; it does not use PID uniqueness
   or binding identity in child argv.
2. **Receipt:** approve the private two-phase `reasoning` envelope with begin/done keys and
   stored-stopReason return, rather than `turn.done` (whole-turn, standard/exported) or a new
   schema.
3. **Legacy state:** approve fail-closed refusal of no-receipt partial K2 traces and of v1
   process records that cannot prove an exact supervisor (no client fallback, no auto-adoption
   or file migration), with root/reviewer reconciliation. A v1 record with an exact live
   supervisor keeps its existing supervisor-cleanup path; v1 forced-supervisor-death cleanup is
   not proved and quarantines.
4. **Authorization:** this section authorizes no code. Root reviews it and explicitly authorizes
   implementation before any production, test, dependency or status edit; then the worker
   implements, runs the scoped checks, records evidence and stops for independent review.

### 14.9 File list for the authorized implementation

- Production: `packages/bench/src/private-process.ts`,
  `packages/bench/src/private-supervisor.mjs`, `packages/bench/src/k2-retention.ts`,
  `packages/bench/src/trial-host.ts` (structural `session` type only).
- Tests/fixtures: `packages/bench/test/private-process.test.ts`,
  `packages/bench/test/k2-retention.test.ts`, `packages/bench/test/trial-host.test.ts`,
  `packages/bench/test/trial-binding.test.ts` if its fixture type changes, and
  `packages/bench/test/fixtures/private-client.mjs` only if the token observability needs an
  explicit assertion.
- Docs: `packages/bench/PRIVATE_PROCESS.md`, `packages/bench/PRIVATE_CHANNEL.md`,
  `packages/bench/README.md`, and the lane handoff after implementation.
- Not touched: `packages/server`, `packages/contract`, `packages/web`, `packages/ui`,
  `packages/cli`, migrations, `docs/plans/PHASE_STATUS.md`, `docs/plans/NEXT_AGENT_PROMPT.md`,
  approval/status files, `main`, dependencies and third-party notices.
- External: `/Users/yuzuru/Projects/Guanxi-lanes/reviews/*` probes are read-only inputs; root
  updates/runs them. No external file is committed from this checkout.

### 14.10 Root authorization and binding corrections (2026-10-22)

The root reviewed `1bbd034` and authorized code after this separate short plan-correction commit,
then completion without another plan-only stop. The approved choices are the fresh independent
256-bit cleanup generation (only its hash in a durable v2 record), immediate quarantine of a live
mismatched supervisor with no fallback, v1 cleanup only by an exact supervisor or an already-gone
group, v2 exact-token proof for an actual forced-supervisor death, and same-UID accidental cleanup
only. The token grants no auth/capability and stays separate from every host correlation. The fd
3/4 layout, launcher close of 5/6, private frames and public keys are unchanged. The plan's receipt
approval is: a bounded two-phase versioned envelope in the existing reasoning class, never
`turn.done` for intermediate completions, no new wire/schema/migration/dependency, actual fenced
durable begin+done ACK for every valid empty completion, `retention_fenced` for canceled/deposed
attempts, ordered manifest plus public digest and stored stop reason binding same-key retries
across sink recreation, no in-memory-only identity, exact-prefix reconciliation, and done ACK
before any frame. Legacy no-receipt traces fail closed and preserve rows; after the reasoning TTL
a same-key retry also fails closed. Rollback limitations remain as in §14.6.

Three corrections are binding before code:

1. **Correlation span.** The old `readAll` filter `spanId === requestId` conflates distinct
   bindings/attempts sharing a session and request id. Every new receipt and content event gets a
   stable opaque span `sha256("guanxi.bench.completion-span/v1\n" + binding.nonce + "\n" +
   requestId)`. Receipts store only bounded binding/request namespace hashes, never the nonce.
   Reconciliation filters on that span, so another binding's event is never rejected merely
   because the raw request id matches. Deterministic per-event idempotency keys and unrelated
   public message ids stay unchanged. Pre-fix rows with the raw request id as span from *this*
   binding must still refuse an attempted retry; the sink proves same-binding evidence through
   the existing fenced `runs.append` idempotency lookup with `expectedSeq` at the current head
   (a refused probe writes no event), or conservatively refuses an ambiguous legacy trace. A
   genuinely new binding is not rejected just because another binding left raw-span rows. A
   dedicated cross-binding same-session identical-request-id regression and a legacy-refusal
   regression are required. No shared server change is needed; the existing `readAll` and append
   APIs are used. (§14.12 replaces this append-probe detail with a fenced metadata-authority
   query; the refusal and cross-binding requirements are unchanged.)
2. **Process truth.** The reaper must not describe a zombie or a missing observer result as proven
   death. The real `ps` observation parses state and distinguishes an observed zombie from an
   unknown observation; unknown or a live mismatched supervisor preserves the record and never
   signals a PID/argv commonality. A fallback kill still requires the exact v2 client generation
   in the recorded group. A group-gone unlink happens only after record identity validation and an
   actual `ESRCH`. Existing forced-death, parent-death, held-record and group-cleanup assertions
   stay intact. Scoped DSH seam observations are not real process-table proof; independent GPT
   owns the unsandboxed `/bin/ps` probe.
3. **Pre-write validation and stored truth.** Build and bound the full manifest plus both receipt
   payloads before the first write where determinable. A re-scrub or stored-data change between
   begin/content/done may only fail closed with an allowed partial trace; it never returns a
   projection from stale incoming fields. The returned stop reason is parsed from the
   acknowledged stored begin receipt. Existing final scrub, export, remote and private-payload
   guards remain real assertions; receipts are reasoning-TTL metadata with no rationale, private
   content, signature or tool-argument plaintext in logs/exports.

Implementation is one coherent reaper fix commit, one coherent K2 receipt/fence/idempotency fix
commit (jointly resolving the two reproduced receipt P2s), then docs/handoff. The writer owns only
the §14.9 files, adds the required regressions and guard-mutation evidence, preserves old
assertions except explained receipt-count/span/version updates, and runs only the scoped bench
files, the three server K2/R1 files, bench/server type checks and scoped lint/markdown/diff
checks. No shared server, contract, UI, CLI, migration, dependency, status-file, main, merge,
push, rebase, full gate or live execution is included.

### 14.11 Implementation status (2026-10-22)

**Status:** the three reproduced P2s are implemented and locally fixture-checked; independent
re-review and full integration gates remain pending. This does not close B1, activate ADR-0025
or enable paid execution.

- `40fab84` — plan correction recording §14.10 before code.
- `65d96c1` — fresh v2 cleanup generation, fail-closed live-mismatch/unknown/zombie handling and
  v1 compatibility.
- `ef51113` — bounded two-phase K2 receipts, opaque completion span, ordered manifest/public
  digest, stored stop reason, empty/canceled/fenced/legacy reconciliation.
- docs/handoff — `PRIVATE_PROCESS.md`, `PRIVATE_CHANNEL.md`, `README.md` and the appended lane
  handoff.

Scoped evidence is **19 new / 77 bench regression-envelope cases + 38 server envelope cases**
(134 executed), plus bench/server type checks. The worker did not execute `/bin/ps`; the
unsandboxed real process-table probe and parent-death probe remain independent root/GPT checks.
No full gate, browser, build, live execution, provider call or B1 quality claim is included.

### 14.12 Legacy metadata authority correction (2026-10-22)

Root rejected the late-redaction residual recorded after §14.11. A legacy stored `toolCallId`
registered as a secret after its append is hidden by `readAll`, so the append-probe workaround
could no longer derive the stored tool key and the promised same-binding no-receipt refusal
failed. Guessing private keys from redacted output is not authority.

The authorized minimal fix extends only the structural bench `RunStore` pick with the existing
`RunStore.mutate` method. After scoped classification and before any append,
`retainAndProject` uses the actual `runs.mutate(attempt, db => ...)` fence for a synchronous
metadata existence query. It binds `session_id`, the old raw `span_id` and the exact bounded
`bench:<nonce>:<requestId>:` prefix compared with `substr`; it selects no payload, reads no
private content and uses no `LIKE`/`GLOB`. A matching row refuses with
`retention_idempotency_conflict` before begin/content. Another binding's identical
session/request/raw-span row does not match. A failed fence is `retention_fenced`; an
open-database query fault is `retention_failed` with no false clear. `SessionLog.readAll`
remains for receipt/content reconciliation only. New receipt spans, ordered manifest, digest,
stored stop reason and final projection behavior are unchanged.

Implementation `9d3c836` is the code/test fix; the docs/handoff commit follows it. New K2 cases:
late-redacted legacy tool-row refusal; fresh different-binding acceptance without adopting the
old row; SQLite metadata-read denial; and stale-fence mapping. Envelope evidence is **4 new /
96 inherited bench cases (100 in the eleven files) + 38 server K2/R1 cases**, with bench and
server type checks green. The external `/bin/ps` and parent-death probes remain pending
root/GPT checks, not worker claims.
