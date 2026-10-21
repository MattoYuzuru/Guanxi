# Native agent (K4)

**Status:** partial implementation; PID-namespace execution owners implemented; validation recorded in the [lane handoff](../../../../docs/plans/lanes/K4.handoff.md).

`guanxi.native-agent` provides the frozen `agent.native` facade. It requires K3's
`connections.registry`, K2's `session.log` and `egress.scrubber`. API-key models use K3
`complete`; local Ollama uses K3 `localChat` and its governor. Subscription agents and service
connections remain K5/provider work. There is no credential fallback or direct provider call.

## Policy and ownership

The session snapshots its connection, model, access mode, roots, protected paths and network
allowlist at creation. Later project-root edits affect new sessions. Native root overrides
reuse registered Workspaces and live in the private `native-projects.sqlite` sidecar, schema
v1 (`project_roots`); missing overrides use the legacy Project bindings. An empty override
means zero roots. No shared node migration is changed, so R1 can own its migrations. Removing
the sidecar restores legacy bindings for new sessions; existing session policies remain intact.

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
sockets and local binding. Container removal is confirmed before settlement, including after a
worker crash. Uncertain runtime cleanup retains the session's writer ownership while retrying.
Fixed trusted commands retain the Seatbelt fast path on macOS without a container runtime. No
unsandboxed fallback exists. Workers receive a small environment without inherited keys,
agent credentials, startup scripts or debug flags. Proxy sockets and CA files use a short
private directory outside writable roots; command HOME/TMPDIR remain scratch.
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
- Egress: exact host/optional-port allowlist, default empty. HTTPS is TLS-terminated using
  an ephemeral worker CA; Read-only allows GET/HEAD/OPTIONS. Opaque CONNECT/SOCKS tunnels,
  direct sockets, arbitrary Unix-socket connections and local binding are denied in both modes. Redirects are
  not followed by `fetch`; domain policy also applies to subsequent proxy requests.
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
  Commas in bind paths are refused. Absent protected paths conservatively make their nearest
  existing parent read-only. No runtime/image means arbitrary shell is disabled with a localized
  reason; fixed read commands remain available. Image provisioning is never done by a tool.
- Linux uses upstream bubblewrap/seccomp, the packaged apply-seccomp helper and util-linux
  `setpriv` with `--seccomp-filter` support. A workload-only BPF filter denies local binding
  after the trusted proxy bridges start; missing/degraded dependencies refuse execution.
  Windows refuses all sandbox execution. Platform validation scope and residuals are in the handoff.

## Session surface

`/agent` is an interim new-session screen; `/agent/:id` projects progress from the log, with
plan, queue, latest response, continuation and stop. Native folder overrides are separate from
legacy Chat bindings. Registered folder names can be selected and saved; an empty set is valid.
No DS1-b primitives are available at this baseline, so the screen reuses legacy primitives
with DS1-a semantic tokens. It has no component approval record or new shared primitive.

Loopback-peer-only `/api/agent` routes use the whole-server Host gate and same-origin mutation
checks. Creation returns 202; HTTP disconnection does not cancel the node-owned execution.
The caller cannot choose the query tool's audience: this conservative binding always excludes
reasoning. K2's inspector remains the person-facing detailed trace.

The light plan is explicitly off-ledger, agent-reported state: `verification_requested` never
means harness-verified completion. Queue entries are visible/removable and consumed once during
the live process. Explicit prompts can continue a completed/interrupted session. Overlapping Full-access roots have one live writer in this service. A process
restart never starts inference automatically. A stored running state with no live owner projects
as `interrupted`; R1 remains responsible for durable run scheduling and recovery.

Tools: `project_info`, `file_read`, `file_write`, `shell`, literal recursive `search`, `fetch`,
`attachments`, `plan`, `queue`, `note.add` (provider-safe wire alias `note_add`) and the
session-bound `session_log_query`. Search uses the OS tool locally; connected search providers
are not executed by this slice. Attachments reuse the existing scoped transfer policy, copy
selected project artifacts into read-only session storage, and expose text through file reads.
Images are sent only when the selected model declares image input. Other binary formats need
conversion, which requires an explicit converter adapter and provisioned format tools; no
format or modality is silently claimed.

Command stdout/stderr are bounded to 64 KiB per invocation with an explicit `truncated` flag.
Every tool result is scrubbed and bounded to 64 KiB. Larger state/query results are stored as
private, session-scoped SHA-256 artifacts under `native-output/`, with an explicit excerpt,
byte count, artifact ID and `tool_output_read` continuation. Pages contain at most 8 KiB of
UTF-8 content so JSON escaping fits the result budget. Artifacts are scrubbed again before
paging; neither artifacts nor launcher/CA files are writable roots. Artifact storage currently
keeps content with the session: automatic retention/deletion and an input-artifact policy remain
unfinished. Tool arguments and large prompts still use K2's inline input path. Image bytes are
inline in model requests; K2 stores policy references and attachment counts. Reading an output
artifact currently scrubs it in memory before paging; bounded memory streaming is not
claimed. Binary conversion remains a named residual. Images are referenced by policy, not
stored as base64 in events. Reasoning stays in K2's retention class, outside model/CLI output
and console logs.

The orientation is checked against a conservative 300 UTF-8-byte upper bound, independent of
path length/root count. Full paths, policies and instruction locations are obtained from
`project_info`. It invents no hardware fit, model capability or token budget.

## CLI

Start the node normally, then:

```bash
guanxi agent exec --json --project PROJECT_ID --connection CONNECTION_ID \
  --model MODEL_ID --prompt 'Inspect this project' --mode read-only
```

`--url` accepts a loopback HTTP node only (default `GUANXI_API_PORT` or 4310).
`--domains host,other:443` sets tool egress; `--context-tokens N` is required for local Ollama.
Stdout is exactly one JSON object: `{version:1, sessionId, status, text, error}`. Exit codes:
0 completed, 1 failed/interrupted, 130 cancelled. SIGINT requests server cancellation; an
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
