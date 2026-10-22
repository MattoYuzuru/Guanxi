# Private trial process binding

**Status:** implemented and locally fixture-checked; independent review pending. This is a
local T0 host capability, not a container boundary, remote endpoint or public REST/CLI
surface. Stock B1 paid execution remains OFF; D-194 still excludes real benchmark execution on
this Mac.

`runPrivateTrial` owns one supervised local child for one immutable
[trial binding](src/trial-binding.ts). The child has only the inherited anonymous fd 3/4
capability and a strict public completion protocol. It receives no provider credential,
K3 registry, account/connection/model/trial identifier, nonce or retention handle.

## Composition and file descriptors

```text
T0 coordinator
  ├─ R1 run/attempt + K2 session
  ├─ immutable TrialBinding (fresh host nonce)
  ├─ createBoundTrialHost:
  │    fenced gateway (k3RunId = R1 run, budget run = experiment id)
  │    real K2 retention sink (retainAndProject)
  └─ runPrivateTrial:
       trusted private-supervisor.mjs (detached process-group leader)
         └─ trusted private-client-launcher.mjs
              └─ fixture/untrusted client, same group
```

| FD | Child side | Host side | Use |
| --- | --- | --- | --- |
| 3 | read | writable | host → child **public completion response** |
| 4 | write | readable | child → host **completion request** |
| 5 | read | writable | lifetime pipe; EOF means terminate the group |
| 6 | write | readable | one bounded `ready`/`start_error` control line |

The supervisor passes only fds 3/4 to the launcher. The launcher closes any inherited fds 5/6
before importing the client, so the client has no lifetime or control capability. The
supervisor closes its own copies of 3/4 after spawn. The host never writes a private completion
result to fd 3; `PrivateTrialChannel` rebuilds the frame from the public projection only. The
OS fixture test observes the full public key set, two sequential requests, ignored
stdout/stderr, no fd 5/6 pipe in the client and no account/model/provider/trial reference in
argv, environment or frames.

The nonce is a host correlation/freshness value used in K2 keys and the process-record hash.
It is not authentication. A new spawn receives new anonymous pipes; a stale child has no
descriptor into a later trial.

## ACK ownership

A task response is written only after the gateway completion and the actual K2 retention
acknowledgement. There is **no acknowledgement timeout**. An external abort, EOF, output
failure or child exit may start process-group shutdown immediately, but the
`runPrivateTrial` promise stays pending and the active-binding map stays owned until the real
gateway/retention work settles. A timer may bound process startup, output delivery or process
shutdown; it never claims that pending inference or retention stopped, and never releases the
active map, R1 permission or budget hold.

If no acknowledgement arrives, the owning promise stays pending. Tests hold an explicit
retention gate, abort the signal, assert the process group is gone and the run is still not
settled, then release the gate. Both late fulfilment and late rejection are consumed with zero
unhandled rejections. No distributed/backend cessation is claimed.

`cleanupConfirmed` means the supervisor was observed closed, the recorded process group is
ESRCH, and the record was removed **after** those observations. It covers the owned process
group only. A descendant that calls `setsid` leaves the group and is outside the proof; the
fixture test cleans that escaped PID explicitly and never claims full-tree cleanup.

## Supervisor record and reaper

The supervisor writes a private record under a `0700` directory with mode `0600`. New spawns
write version 2; a version-1 record is legacy and remains readable:

```json
{ "version": 2, "bindingTag": "<sha256>", "nonceHash": "<sha256>",
  "supervisorPid": 123, "pgid": 123, "clientPid": 124, "clientExitCode": 0,
  "clientTokenHash": "<sha256 of the fresh cleanup generation>",
  "clientScript": "/absolute/path", "startedAt": 0 }
```

The supervisor generates a fresh 256-bit `clientToken` before spawning the launcher, writes only
`clientTokenHash` to the record **before** the `ready` control line, and passes the token as the
launcher/client's fourth argv element. The token is not derived from the binding, nonce, task,
arm, run, attempt, account, connection, model, provider or trial. It is not in the record,
environment or private frames, is never logged, and grants no authentication or capability. It
is a cleanup generation, not an identity or secret. The record never contains task text,
prompts, tool results, reasoning, signatures, credentials, account/model IDs or the nonce
itself. The record directory must not be a symlink and is re-read with an explicit size bound,
mode check and version-specific shape validation.

The supervisor **never unlinks the record**. It cannot verify `ESRCH` for its own group after
signalling `SIGKILL` to that group, because the signal also kills the supervisor. On lifetime
EOF it terminates the group and leaves the record. Only the live parent or the next reaper may
remove the record, and only after the recorded identity is validated and the recorded group is
actually `ESRCH`; removal is last. If the parent dies, the record persists for the next reaper.

The reaper never scans all processes and never treats a numeric group, shared launcher argv, a
zombie, a missing observer row or a timeout as proof of death:

| Observation | Action |
| --- | --- |
| record absent | `absent` |
| invalid record, tag/hash/client-script mismatch | `cleanup_unconfirmed`; preserve |
| group is actually `ESRCH` | unlink the validated record only; no signal |
| group status or process state is unknown | `cleanup_unconfirmed`; preserve |
| live supervisor with exact tokenised argv | SIGTERM `-pgid`, grace, SIGKILL, verify `ESRCH`, unlink |
| live supervisor with mismatched argv | `cleanup_unconfirmed`; never inspect or signal the client |
| zombie/absent supervisor, v2 `clientPid` with exact four-token launcher argv and matching token hash in the recorded group | SIGKILL `-pgid`, verify `ESRCH`, unlink |
| zombie/absent supervisor, v2 client absent/mismatched/wrong token | `cleanup_unconfirmed` if the group is alive |
| v1 record, exact live supervisor | existing supervisor cleanup path |
| v1 record, no exact supervisor | no client fallback; unlink only when the group is already `ESRCH` |

`ps -ww -p PID -o pid=,pgid=,state=,command=` is invoked through `execFile` with no shell, a
fixed timeout and bounded output. The state parser distinguishes a live state, a `Z` zombie and
an unknown/failed observation. A missing PID is first checked with a same-UID `kill(pid, 0)`; a
failed or ambiguous query is `unknown`, not dead. The client proof is exactly
`[node, launcher, client-script, client-token]` plus the recorded `pgid`, followed by
`sha256(token) === clientTokenHash`; there is no substring, `ps -ax` or numeric-group-only
fallback. The test injection seam still exists because this worker sandbox blocks `/bin/ps`;
seam observations are not real process-table proof and root/reviewer owns the unsandboxed run.

Same-UID cleanup is best-effort fixture foundation only. The child can signal/read same-UID
processes and can tamper with a same-UID record; this is not a security boundary. A descendant
that calls `setsid` leaves the group and is outside the proof; the fixture cleans that explicit
PID and never claims full-tree cleanup. Rootless Podman/Linux cgroups remain the separate
untrusted-compute boundary and are not implemented here.

A version-1 record has no generation token, so its client fallback is intentionally disabled.
An unconfirmed v1 group is left in quarantine for root/reviewer reconciliation; there is no file
migration and no automatic deletion. A new spawn writes v2. Old code sees a v2 record as invalid
and fails closed without signalling.

## K2 retention and the public projection

`createK2TrialRetention` is a structural adapter around the real `RunStore.append`,
`RunStore.mutate` and `SessionLog`. It imports only types from the server package; the
coordinator wires the actual instances. `createBoundTrialHost` checks the R1 run's session,
uses the actual R1 run id for K3, keeps the experiment id in the budget ledger, and supplies
`attemptFence.assert = runs.renew(attempt)`. The structural picks include the existing
`readAll` and `mutate` methods; no server code changed.

Every completion, including an empty one, is retained inside the existing `reasoning` class as
a bounded versioned two-phase receipt. No new event type, wire field, schema, migration,
dependency or `turn.done` is added. New receipts and content events use one opaque correlation
span:

```text
span = sha256("guanxi.bench.completion-span/v1\n" + binding.nonce + "\n" + requestId)
```

The receipt stores bounded `bindingHash`/`requestHash` values, never the nonce, and the span is
used consistently for reconciliation. Another binding in the same session with the same raw
request id therefore cannot collide with or be rejected by this completion. The per-content
idempotency keys stay `bench:<nonce>:<requestId>:<spec-key>`; public message ids are unchanged.

`retainAndProject(requestId, result)`:

1. checks the immutable binding, attempt/run identity and session;
2. refuses while the egress scrubber is not ready;
3. scrubs the full completion, builds the complete ordered specification manifest, validates the
   explicit content/receipt bounds and rejects unsupported content, invalid/long tool IDs and
   duplicate tool IDs **before** the first append;
4. reads the person-audience session events once and classifies the opaque-span content and
   receipts. It then uses the existing fenced `RunStore.mutate` callback for a synchronous
   metadata-only existence read: same `session_id`, old raw `span_id` and the exact bounded
   `bench:<nonce>:<requestId>:` prefix compared with `substr` (no payload selection, no
   `LIKE`/`GLOB`). A match refuses a pre-fix trace before the first append; a failed fence is
   `retention_fenced` and a SQL read fault is `retention_failed`. A genuinely new binding is not
   rejected by another binding's raw-span rows;
5. appends the begin receipt (`receipt:begin`) through `runs.append`; this is the first durable
   R1-fenced acknowledgement. A duplicate begin is the authoritative check for a same-key changed
   receipt payload;
6. appends each missing canonical content event (`reasoning`, the versioned signature envelope,
   joined assistant text, tool calls in content order) with its deterministic key and
   `expectedSeq`. Each stored event is digest-checked against the ordered manifest; a late scrub
   or stored-data change fails closed with an allowed partial trace;
7. appends the done receipt (`receipt:done`) only after the full stored content matches the
   manifest and public digest. The done receipt records `beginSeq`, ordered `contentSeqs`,
   `specCount`, `manifestSha256`, `publicSha256` and the stored public stop reason. Only after
   this final acknowledgement does the channel write a task frame;
8. derives the public projection from the **stored scrubbed** assistant/tool events and the
   stored begin `stopReason`; the caller's full result is not mutated. Reasoning, signature,
   usage, provider error text, tool arguments and transcripts never enter a receipt or the
   public frame.

The begin receipt is bounded by `maximumReasoningTextBytes` and the planned content-plus-begin
bytes by `maximumRetainedBytes` before the first write. The done receipt is bounded before its
append and the cumulative retained bytes are rechecked. An oversized receipt fails
`retention_too_large` before its append. A canceled/deposed attempt throws `stale_lease` on the
begin append and maps to `retention_fenced`; no receipt/content row and no success frame are
produced.

An empty completion has `specCount: 0` and still writes both begin and done receipts; its
projection is `{ text: "", toolCalls: [], stopReason: <stored> }`. A partial begin/content
prefix is reconciled by a recreated sink, which appends only the missing suffix and the done
receipt. A done receipt makes a retry idempotent with no duplicate rows. A changed stop reason,
text, tool argument, removed/added/reordered tool or private reasoning/signature specification
conflicts at the begin receipt before content or success. A pre-fix no-receipt trace fails
`retention_idempotency_conflict` and preserves its rows; after the reasoning TTL purges receipt
data, a same-key retry also fails closed rather than reconstructing `stopReason` or a projection
from fresh evidence. No in-memory receipt cache is used.

A thinking signature is stored inside the existing `reasoning` class as the versioned text
envelope `guanxi.bench.thinking-signature/v1\n{...}`. Actual `SessionLog` `remote_agent` reads and
the export route omit both reasoning and the signature/receipt envelopes; tests exercise both.
Receipts are reasoning-TTL metadata: they carry hashes, counts and the already-public stop
reason, never rationale, private content, signature text or tool-argument plaintext.

A multi-event completion is not atomic. A failure after an earlier append can leave an
idempotent partial private trace, but no task response is emitted until the done append
acknowledges. There is no automatic redispatch or retry. Atomic all-or-nothing retention would
need a new R1 batch API and is not claimed. Rolling back to old code with live v2 process records
or receipt rows is not safe without root reconciliation; forward-fix is preferred.

## Policy and trust boundary

`PrivateProcessPolicy` requires explicit scalar values: client script, private cwd, explicit
environment allowlist, `0700` record directory, startup/shutdown/kill bounds, control/record
byte bounds, and the existing channel payload/request/time/chunk/output bounds. There is no
`ackTimeoutMs` and no hidden default. Missing/zero values refuse `process_policy_invalid`.

The environment is built by the host, not spread from a request. Dangerous keys
(`NODE_OPTIONS`, loader/preload variables, `GUANXI_*`, key/token/secret/account/connection/
model/trial/provider names) are refused. The client script is `realpath`ed and checked as a
regular file; paths containing whitespace, NUL or newlines are refused; the record directory
must be a real `0700` directory, not a symlink. The supervisor/launcher are trusted source-run
assets. A missing asset fails closed; there is no direct-spawn fallback. A future bundle must
include these `.mjs` assets (distribution residual).

The child-facing API cannot declare `boundedBilling`, `cleanupConfirmed`, peer identity or
trial facts. The result fields are host-computed. Stock real/paid execution remains disabled;
no live model, provider key, Harbor/Podman/container, SSH, GPU, public corpus or real B1
benchmark was used. D-194 remains in force and no B1 quality claim is made.

## Verification scope

Local fixture commands are in the
[lane handoff](../../docs/plans/lanes/B1-trial-binding.handoff.md). The P2 review-fix continuation
adds 19 new cases (6 process, 13 K2) to the scoped 96-case bench envelope. They cover fresh v2
generation/token-hash records, live-mismatch/unknown/zombie quarantine, v1 group-gone cleanup,
forced-supervisor-death ESRCH ordering, two sequential OS-executed requests, public-key
exactness, fd isolation, ACK-gated pending ownership with late fulfilment/rejection, nested and
escaped descendants, startup/policy refusal, empty two-phase receipts, canceled/deposed
`retention_fenced`, changed reason/manifest/private specs, cross-binding same-session/request-id
separation, legacy refusal, partial-prefix sink recreation, TTL purge, readiness and late scrub.
The server K2/R1 envelope is run separately. The worker did not execute `/bin/ps`; the real
process-table probe, full `npm test`, browser, build, Storybook, container and remote gates are
not claimed by this slice.
