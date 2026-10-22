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

The supervisor writes a private record under a `0700` directory with mode `0600`:

```json
{ "version": 1, "bindingTag": "<sha256>", "nonceHash": "<sha256>",
  "supervisorPid": 123, "pgid": 123, "clientPid": 124, "clientExitCode": 0,
  "clientScript": "/absolute/path", "startedAt": 0 }
```

It never contains task text, prompts, tool results, reasoning, signatures, credentials,
account/model IDs or the nonce itself. The record directory must not be a symlink and is
re-read with an explicit size bound and shape validation.

The supervisor **never unlinks the record**. It cannot verify `ESRCH` for its own group after
signalling `SIGKILL` to that group, because the signal also kills the supervisor. On lifetime
EOF it terminates the group and leaves the record. Only the live parent or the next reaper may
remove the record, and only after:

- the parent observes supervisor close and the group is ESRCH; or
- the reaper validates the exact recorded identity, signals the group, observes ESRCH, and
  only then unlinks.

If the parent dies, the record persists for the next reaper. A reaper never unlinks on a merely
issued signal, a timeout, an unvalidated PID or an identity mismatch; it returns
`cleanup_unconfirmed` and preserves the record/quarantine. A crash between record removal and a
kill therefore cannot leave an untracked process: removal is last.

Identity is compared as exact tokenised argv for the expected supervisor or launcher
invocation plus the recorded PID/process-group relation, never a substring. The test includes a
near-miss supervisor path (`private-supervisor.mjs.bak`) and asserts that the reaper refuses to
signal/unlink. `/bin/ps` is invoked through `execFile` with no shell, a fixed timeout and a
bounded buffer. The reaper accepts an explicit process-table observation seam for tests because
the worker sandbox blocks `/bin/ps`; production defaults to `/bin/ps`. The exact `/bin/ps`
invocation itself is therefore **not exercised in this harness** (residual).

Same-UID cleanup is best-effort fixture foundation only. The child can signal/read same-UID
processes and can tamper with a same-UID record; this is not a security boundary. Rootless
Podman/Linux cgroups remain the separate untrusted-compute boundary and are not implemented
here.

## K2 retention and the public projection

`createK2TrialRetention` is a structural adapter around the real `RunStore.append` and
`SessionLog`. It imports only types from the server package; the coordinator wires the actual
instances. `createBoundTrialHost` checks the R1 run's session, uses the actual R1 run id for K3,
keeps the experiment id in the budget ledger, and supplies `attemptFence.assert =
runs.renew(attempt)`.

`retainAndProject(requestId, result)`:

1. checks the immutable binding, attempt/run identity and session;
2. refuses while the egress scrubber is not ready;
3. scrubs the full completion, validates explicit bounds, and rejects unsupported content,
   invalid/long tool IDs and duplicate tool IDs before the first append;
4. writes each existing canonical event (`reasoning`, `assistant.message`, `tool.call`) in its
   own fenced, idempotent transaction with an explicit `expectedSeq`;
5. rechecks the stored event after K2 write-time scrubbing and derives the public projection
   from the **stored scrubbed** assistant/tool events;
6. returns exactly that projection, which the channel writes to the task.

The caller's full result is not mutated. Reasoning and signature text, usage, provider error
text and request transcript never enter the public frame. A fake value registered between
gateway return and retention is scrubbed in both K2 and the frame; the retained public event
equals the frame. Readiness withdrawal yields an error frame, not a successful task completion,
and no K2 event. A late secret that enlarges stored text is caught by the post-append bound.

A thinking signature is stored inside the existing `reasoning` class as the versioned text
envelope `guanxi.bench.thinking-signature/v1\n{...}`. No wire contract or schema migration is
added. Actual `SessionLog` `remote_agent` reads and the export route omit both reasoning and
the signature envelope; tests exercise both.

A multi-event completion is not atomic. A failure after an earlier append can leave an
idempotent partial private trace, but no task response is emitted until every append has
acknowledged. Retrying the same payload under a live attempt resumes/deduplicates; a same-key
changed payload refuses with `retention_idempotency_conflict`; a stale attempt is fenced.
There is no automatic redispatch or retry. Atomic all-or-nothing retention would need a new R1
batch API and is not claimed.

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
[lane handoff](../../docs/plans/lanes/B1-trial-binding.handoff.md). New tests cover the real K2
sink and projection, the fenced gateway, two sequential OS-executed requests, public-key
exactness, fd isolation, ACK-gated pending ownership with late fulfilment/rejection, forced
supervisor death and reaper identity/ESRCH ordering, nested and escaped descendants, startup
failure, malformed/selector input, binding concurrency, symlinked/permissive policy and
environment refusal. The server K2/R1 envelope is run separately. No browser, build, full
`npm test`, Storybook, mutation tool, container or remote gate is claimed by this slice.
