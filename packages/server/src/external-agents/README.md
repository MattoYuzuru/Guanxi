# External agents and role routing (K5)

**Status:** kernel implementation; offline fixture validation · **Updated:** 2026-10-21

## Implementation plan

Authorized by the K5 lane task; no external account, CLI or credential is used during development.
This is a kernel-service slice. Existing HTTP/SSE schemas and native-agent execution remain
unchanged. F1, R2 and DS1-c own their respective areas.

- Add an isolated `agent.external` T0 service with five ACP v1 profiles and Codex app-server.
  Reuse wire types/constants from the exact Apache-2.0 ACP SDK 0.29.0 (verified from its upstream license and package); keep RPC framing/correlation quiet because SDK error paths log raw frames.
  Claude's SDK-dependent ACP bridge is an operator-installed separate process, never a dependency.
- K3 authorizes every dispatch, binds CLI subscription connections to the originating account,
  and injects API keys only at process launch. Roles select session overrides before project
  defaults; an invalid explicit choice refuses rather than silently spending elsewhere.
- Persist project roles, dated quota observations and concurrency learning in a private K5
  SQLite sidecar with append-only migrations. Vendor configuration directories are private to
  node/owner/connection. Only the unmodified vendor CLI reads its login there.
- Project/role APIs are trusted kernel APIs. No caller-supplied identity is accepted over HTTP.
  Remote execution transport and authenticated peer reports belong to F1; every local adapter
  checks its configured node identity. Account grouping is explicit operator metadata.
- Refuse unsupported parameters, permission requests and client filesystem/terminal RPCs.
  External CLIs are trusted installed programs with their own tools; K4's `ExecutionOwner`
  is not claimed as their sandbox. They are never relay executors.
- Scrub requests before serialization and responses/events before persistence. Drop reasoning
  and stderr. Detect Claude bare/login state without touching vendor files. Preserve unknown
  billing/quota facts and source/time/confidence; do not invent subscription balances.
- Offline fixture processes exercise handshake, model choice, output, quota, malformed frames,
  cancellation, crash/unload and owner denial. Golden role tests and static/runtime credential
  read traps have negative controls. Mutations remove each exit guard and must fail assertions.
- Validate typecheck, Markdown, licenses and fast UI gates directly. Run full tests, browser,
  catalog browser and build sequentially through Node 26 `agent-dev`'s shared heavy lock.
  Fresh-context review covers the whole diff; fixes have separate conventional commits.

Rollback removes the K5 plugin/configuration while retaining the sidecar and vendor directories.
It never deletes vendor state. No legacy/node/K3 migration is rewritten. Risks are protocol drift,
black-box vendor tools, unknown billing and process descendants; evidence will delimit each.

## Kernel API and setup

`externalAgentPlugin` provides the frozen `agent.external` service. It requires K3
`connections.registry`, K2 `session.log` and `egress.scrubber`. The server loads it only when
`start({ externalAgents: { nodeId, installations } })` is configured by its trusted caller.
The shipped launcher does not discover programs or silently install/enable agents. No new
HTTP endpoint, SSE event or client contract is added; existing Connections can display K5's
provenance-bearing facts. A role editor and external-agent screen belong to later UI work.

Create the payment connection through K3, then configure an installation with its
`connectionId`, `ownerAccountId`, this `nodeId`, opaque `billingAccount` grouping key, absolute
`executable`, exact expected `version`, and optional operator concurrency. Claude additionally
requires `claudeExecutable`, the owner's installed unmodified CLI. Its `executable` is the
separately user-installed ACP bridge, whose Agent SDK dependency stays outside Guanxi.
Neither proprietary package is a Guanxi dependency, bundle or copied source.

`prepareLogin(owner, owner, connectionId)` returns only the local CLI argv and isolated
configuration environment. Run that unmodified CLI on **each node** to sign in there; do not
copy a login from another node. Codex also supports
`signInWithChatGPT(owner, owner, connectionId, onAuthUrl, signal)`: the official app-server
owns the browser callback, credential persistence and refresh. The caller receives an auth
URL transiently; it must not log it. Only ChatGPT Plus/Pro is admitted. Business, API-key mode
on a subscription connection and externally supplied token mode are refused.

`setProjectRoles(owner, owner, projectId, roles)` persists manual defaults. `resolve` chooses
an explicit session role first, then the project role; explicit null or an invalid override
refuses instead of falling through. Bindings contain connection, backend, model and params.
`native` bindings resolve for a K4 consumer; `run` executes only external bindings. ACP model
selection uses an advertised config option and verifies its result. The explicit `default`
model means the CLI's own default. Unsupported parameters refuse before launch. R3's automatic
routing and relay execution are not implemented here.

The originating human's account ID must be supplied by the trusted caller and preserved
through delegation. It must never be taken from a prompt/body. K3 refuses a different author
on every `cli_login` connection regardless of sharing grants. API/local editor payment needs
`setEditorAllowed`, an owner-only persisted grant. Gemini uses a Google API-key connection
only. OpenCode/Goose use API-key payment connections; they do not route
Claude/ChatGPT subscriptions through unofficial provider implementations.

A subscription adapter is limited to one owner per node and adapter;
`adapter_owner_conflict` refuses a second owner at configuration time. OS credential stores such
as the macOS login keychain may not be namespaceable by `HOME`, `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` or `COPILOT_HOME`, so a second owner could share or overwrite the first login.
API-key adapters are not affected: they receive per-invocation config directories and API-key
environment references.

## Isolation, lifecycle and evidence limits

All launch environments are allowlisted. HOME, XDG config/data/cache, temp and scratch cwd
are private under `external-agent-config/<hash(node,owner,connection)>`. No vendor directory
or credential is imported. Existing directory symlinks or group/other permissions refuse.
API agents receive a fresh directory set per invocation, with an explicit provider/model and
API-key environment reference; Goose also disables keyring fallback. External local-runtime
dispatch is refused until exact runtime/context and governor integration is implemented; K4
continues to own local inference. No default model can select a different OpenCode payment
provider. The CLI owns all contents; Guanxi checks directory/executable metadata only. The parent has
no implementation that reads, copies or moves vendor token files. Vendor filesystem and
terminal requests over ACP, permission requests, Codex token refresh requests and unknown
server requests are denied. Stderr and thought notifications are discarded; JSON framing
errors carry only stable codes. Assistant chunks are aggregated and scrubbed before K2 writes
one answer, including when a registered value spans chunks.

External agents are trusted user-installed programs with their own internal tools and network
clients. They are **not contained by K4's ExecutionOwner**. Their private scratch cwd and
protocol denials do not provide a host-filesystem sandbox. Guanxi scrubs data at process input
and output, and cannot intercept a vendor CLI's internal model/tool requests. Do not present
that boundary as K4 access-mode enforcement. Project roots are not handed to these processes
by this service. Escaped/detached descendants of a vendor program are outside its process-group
cleanup guarantee; these adapters must not execute untrusted arbitrary agent programs.

Calls have an explicit `runDeadlineMs` operator setting (default 300 seconds) and an 8-MiB
JSON-frame safety policy, configurable in `ExternalPolicy`. A run that reaches its deadline ends
with the `timeout` error code, not `cancelled`, and the deadline is recorded in the run's events
as a fact. `requestTimeoutMs` bounds sign-in and authentication probes. Neither is a model
context/output limit. Cancellation, unload and timeout terminate the subprocess group and await
child close before releasing this service's admission. Responses are node-owned kernel calls;
no HTTP subscriber owns them. There is no automatic resume, durable inference continuation or
retry. K2 holds the transcript; R1/R2 integration is a later consumer, not a second run state
machine.

Claude `auth status` is invoked on the configured unmodified binary, with the isolated
environment; only login/auth-method facts are retained. Explicit `claudeBare: true` refuses a
subscription launch and records why. Unspecified bare state remains unknown: probing the
stored login cannot prove a bridge's implicit flags or a future CLI default. Unknown billing
is not converted to subscription billing merely because a login exists. Anthropic API-key
fallback uses K3's native API connection, selected explicitly; it is never an automatic spend.

## Limits and concurrency

Codex reads `account/rateLimits/read` and consumes `account/rateLimits/updated`. Claude's
`rate_limits.five_hour` and `seven_day` come from its documented statusline JSON. ACP v1 has
no standard statusline carrier. An owner-installed statusline integration can forward that
payload to the trusted `observeClaudeStatusline` kernel method; this slice does not edit
vendor settings, install such a bridge or fabricate an ACP quota extension. Without that
integration Claude quota remains unknown. Sources are the
[official statusline](https://code.claude.com/docs/en/statusline) and
[bare-mode/authentication docs](https://code.claude.com/docs/en/headless).

Observations carry source, time and confidence. Account grouping is operator-supplied metadata,
not inferred vendor identity. Authenticated F1 code may call `observeQuota` after verifying
owner/node; K5 exposes no unauthenticated ingress or mesh transport. Reports are pooled by
owner, billing account, adapter, limit name and reset period. Same-period device percentages
use the conservative maximum, never a sum. Different reset periods stay separate. Missing
values remain null; reports older than the configured 5-minute freshness policy do not supply
current limit facts. The original reports remain visible as dated evidence.

Completed dispatches teach successful parallelism. Explicit classified concurrency observations
teach rejection ceilings; generic 429/quota failures do not. Learning has low confidence and
survives reload. Admission starts at the explained operator policy (default 1); a learned
rejection tightens it. This is **per-process, per-account admission**, not a distributed lease
or a promise of available vendor concurrency across all machines. It does not account for
concurrent web/desktop use except as reflected in vendor quota reports.

## Storage, checks and rollback

`external-agents.sqlite` has its own `k5_migrations` table (v1), private database/WAL/SHM files,
project role defaults, editor grants, latest node quota reports and concurrency observations.
No shared migration or stable wire schema changes. Removing the plugin leaves both this
sidecar and vendor directories intact; it never logs out a user or deletes vendor data.

`node packages/server/scripts/check-vendor-credentials.ts` scans every `.ts`, `.tsx`, `.js`,
`.mjs`, `.cjs`, `.mts` and `.cts` file under `packages/*/src`, `packages/*/scripts` and
`packages/kernel/bin`. It refuses vendor-path text in string and template literals; refuses
content reads and `rename`/`link`/`symlink` moves of vendor paths; resolves `.call`/`.apply`/
`.bind`, namespace destructuring and import aliases; and refuses `createRequire` in K5. In K5
it refuses every `child_process` import except `spawn` in `process.ts`, and every execution API
other than that `spawn`; in other packages a `child_process` execution is flagged when the
module contains vendor-path text. Manifests still refuse process-only Claude packages. The
runtime trap watches `<HOME>/.claude`, `.codex`, `.copilot`, `.gemini` and `.config` plus the
`child_process` spawn/exec helpers while a fixture adapter runs.

This is a conservative text-level regression gate, not a whole-language security proof. It
cannot prove the absence of a path computed entirely at runtime with no vendor-path text in
the module (for example `join(home, parts[0], parts[1])`), a vendor CLI's own internal file
access, or dynamic code loaded from outside the scanned tree. Tests seed every rule and
demonstrate a runtime parent read trap with a child-only dummy credential positive control.

The six versioned recordings are documentation reconstructions, not real CLI captures. See
[fixture provenance](../../test/external-agents/fixtures/README.md). No real vendor CLI, owner
config/keychain, network or model is used in tests. Fixture replay is local client validation;
live-release compatibility and operational billing remain unverified. The lane hand-off
records gate commands, mutation evidence and fresh-context review.
