# External leads: delegation, hibernation and wake (LW)

**Status:** implemented as a trusted opt-in kernel service; fixture-validated, no real vendor CLI,
account, network or model · **Updated:** 2026-10-31 · Plan: [LW plan](../../../../docs/plans/lanes/LW.plan.md)

`guanxi.external-leads` provides `lead.external`. A lead is an ACP v1 agent run by K5
([external agents](../external-agents/README.md)) that decides to delegate through one tool,
`guanxi_delegate`, and then sleeps at zero cost while R1 ([runs](../runs/README.md)) keeps the promise,
the deadline and the wake. The server loads it only when `start({ externalAgents, leads })` is given; the
default server loads nothing, opens no listener and writes no ledger. It is not reachable over HTTP.

## Opt-in and boundary

`leads` carries either a `ChildStarter` (the executor of delegated work) or `relay: { consent, domains }`
(delegated plans run through this node's public relay start, with Full-access consent and allowed domains chosen
by the owner at boot, never by the lead), an optional `ChildReporter`, and the
literal `alwaysOn: true`, the host's explicit assertion that this node stays awake while leads sleep
(ADR-0019 decision 5). Nothing here proves or arranges power; without the assertion R1 refuses
`no_always_on_home` and the tool answers the lead before anything is stopped. Codex app-server leads are
refused with `lead_adapter_unsupported`: that protocol has no tool carrier here. Cross-node leads belong to F2.

## Flow

1. `startLead` resolves the `lead` role, creates the run, its first attempt and a `lead_sessions` row in one
   R1 transaction, retains a run-owned scratch resource and runs the first turn through `agent.external`.
2. The first model-produced update of the prompted turn (message, thought, plan, tool call or usage; not
   command or mode bookkeeping), or the delegate call itself, is the model-start observation
   (`runs.modelStarted`). A heartbeat renews the attempt. Cost reported by the agent is recorded with `recordCost`.
3. `guanxi_delegate` validates the brief, persists an immutable **delegation intent** under the fence, and
   holds the HTTP call unanswered. The lead gets no result and therefore spends no further tokens.
4. The turn is stopped cooperatively: `session/cancel`, a bounded wait for the cancelled response (final
   usage), then K5's process-group cleanup and admission release. Usage is recorded, then **one**
   `runs.delegate` commits the child run, promise, timer and `waiting_children`. The child is started with
   `runs.start` and the `ChildStarter`.
5. A resolution, deadline or signal creates one R1 wake. `pump` claims only leads with no live turn,
   `deliver`s a fresh fenced attempt, builds the wake packet **once** (immutable, stored) and resumes the lead.
   Acknowledgement is R1's: the first model-produced update of the resumed turn, or its delegate call.
6. A turn that ends while a child or wake is pending yields (`runs.hibernate`); otherwise it completes.

## Tool endpoint

One `node:http` server on `127.0.0.1:0`, created on first use, closed on unload. Streamable-HTTP MCP subset
in JSON mode (`initialize`, `ping`, notifications, `tools/list`, `tools/call`; GET is 405, batches are
refused, bodies are capped at 1 MiB). The capability is a random 256-bit bearer token per turn, bound to
run, attempt and wake sequence, passed in the ACP `mcpServers[].headers` (never in a URL, argv, log or
event) and revoked when the turn ends. A `Host` other than the bound loopback name, or any `Origin`, is
refused. One delegation per turn. The agent must advertise `mcpCapabilities.http`
(`mcp_http_unsupported` otherwise). ACP's unstable `acp` MCP transport is a possible later carrier.
The input is `leadDelegateInputSchema` in `packages/contract`: objective, definition of done, relay plan with
acceptance commands, caps, executor connection/model, relative `deadlineMs`, `onDeadline`, `onCancel`.
Identity, roots, network, judges and wake policy are node-owned and refused if sent. When the host configures
`executors`, `tools/list` appends `Allowed executors on this node: connectionId=<id> model=<model>` for each entry,
so the lead no longer guesses; MS1 passes the single executor its `validateExecutor` allows. The validation itself
is unchanged.

## Project view (LP-lead-project-view)

The lead runs in an empty private directory, so the node can serve the project it delegates. Three read-only tools join
`guanxi_delegate` on the same per-turn tool server (`mcp__guanxi`, the one server the lead pre-allows). **Opt-in** (lead default,
2026-10-31): they exist only when the host asks for them, with `home.lead.projectView: true` in the MS1 live configuration or
`leads.projectView: true | { policy, roots }` in `start()`. Otherwise `tools/list` shows `guanxi_delegate` alone and a call to a
project tool is an unknown tool. When enabled, `guanxi_delegate`'s description names the tools and the roots come from the same project
resolution the relay start uses (the project's single bound workspace). The plan facts in the lead's prompt stay: the view adds to them.

| Tool | Input | Result |
| --- | --- | --- |
| `guanxi_project_tree` | `path?`, `ref?`, `recursive?`, `cursor?` (or `offset?`), `limit?` | `commit`, `entries` (`path`, `type` file/dir/symlink/submodule, `size`), `total`, `withheld`, `more`, `nextCursor`, `bounds` |
| `guanxi_project_read` | `path`, `ref?`, `cursor?` (or `offset?`), `limit?` | `commit`, `size`, `totalBytes`, `text`, `more`, `nextCursor` (a byte position in the scrubbed text), `redacted`, `bounds` |
| `guanxi_project_search` | `text` (one line, literal, case-sensitive), `path?`, `ref?`, `cursor?` (or `offset?`), `limit?` | `commit`, `matches` (`path`, `line`, clipped `text`), `note`, `scan`, `more`, `nextCursor`, `bounds` |

- **What it reads.** Git objects of the project's source repository at `ref` (`HEAD` or a full commit id), never its working tree:
  untracked, ignored and uncommitted files, and symlinks on disk, are out of reach by construction. Only object plumbing runs
  (`rev-parse`, `ls-tree -z`, `cat-file`), never `grep`, `diff`, `status` or `show`, with an absolute binary, argv, a hard timeout
  and a kill on lead cancellation or node shutdown (`project_view_cancelled`). What is overridden, exactly: the relay's `gitEnv`/`gitFlags`
  (no system or global config, hooks path, fsmonitor and external protocols off, replace objects ignored), `GIT_NO_LAZY_FETCH=1`,
  `GIT_LITERAL_PATHSPECS=1`, and `-c` settings for submodule recursion, the attributes file and the untracked cache. The repository's own
  `.git/config` is still read by git; those commands do not consult filters, textconv, hooks or attributes, and a test sets such commands
  and proves none runs. **Partial clones:** a blob the repository does not hold is an error (`project_view_unavailable`), never a fetch and
  never the repository-configured transport command (`core.sshCommand` and the like); the tree shows such a file without a size. The relay's
  own `gitEnv` does not set `GIT_NO_LAZY_FETCH`; that is a residual of the relay checkout, not of this view. Every result names its
  `commit`, which is a valid `plan.base`: the relay clones the same commit for the executor. A project root that is not the top
  level of a repository, and anything but exactly one root, is `project_view_unavailable`. The project always comes from the stored
  lead session, never from tool input.
- **Cursors.** `nextCursor` is `<commit>:<offset>`; passing it as `cursor` keeps a continuation on the first page's commit while
  `HEAD` moves, so a listing or search neither skips nor repeats entries. It cannot be combined with `ref` or `offset`.
- **Policy, reported.** `ProjectViewPolicy` defaults: 200 tree entries per page (at most 2 000), 16 KiB per read page (at most 64 KiB),
  files up to 4 MiB, 100 search matches per page (at most 500), 400 characters per search line, 256 KiB per result, 15 s per git
  process, 4 096 bytes per path, 1 000 characters of search text, 64 MiB of blobs read by one search. Every result carries the
  `bounds` in force; a request above a maximum is clamped and the bound shows it; a cut result has `more: true` and a cursor; a bigger
  file answers `file_too_large: size N bytes, limit M`; a clipped search line is cut around the match and carries
  `…[line clipped, N more characters]`. One project call runs at a time per turn.
- **Search.** It reads each allowed blob of the commit through one `cat-file --batch`, scrubs the whole blob and matches lines of the
  scrubbed text, so a registered secret (also a multi-line one) can be neither found nor leaked line by line, and `line` counts lines of
  the scrubbed text. Blobs above `maxFileBytes` are never requested (a 300 MB line is never buffered); a pending record is capped; the scan budget
  (`maxScanBytes`, 64 MiB) is applied while listing, so blobs beyond it are only counted, not stored; and after about 8 MiB of blobs
  the process is paused so the event loop gets a turn (scrubbing one blob, at most `maxFileBytes`, is synchronous). `scan` reports
  `files`, `skippedTooLarge`, `skippedNotText` (visible files only: symlinks, submodules, empty, binary or unreadable), `unscanned` and
  `complete`. A listing record too long to parse is counted in no search figure.
- **Refusals** are fixed codes returned as the tool text with `isError`, like `guanxi_delegate`: `invalid_input: <field>: <issue>`,
  `path_invalid` (absolute, `..`, `.`, empty segment, backslash, control character, `~`, over the path bound), `path_denied`,
  `not_found`, `not_a_file`, `not_a_directory`, `symlink_denied`, `binary_file`, `file_too_large`, `invalid_offset`, `page_too_small`,
  `result_too_large`, `ref_invalid`, `ref_not_found`, `project_view_unavailable`, `project_view_timeout`, `project_view_output_limit`
  (a git process printed past its bound), `project_view_cancelled` (the lead was cancelled or the node is closing), `lead_not_found` (a call that belongs to no live lead turn). Messages from the OS or git never
  reach the lead.
- **Secrets.** A name rule decides `path_denied` for any path segment (case-insensitive) in read, tree and search alike: the index
  scanner's rule (dotenv files, `.git`, `node_modules`, shared from `indexing/snapshot.ts`) plus credential names: `.ssh`, `.aws`,
  `.gnupg`, `.kube`, `kubeconfig`, `.docker`, `.dockercfg`, `.azure`, `.gcloud`, `.npmrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `.pgpass`,
  `.htpasswd`, `.git-credentials`, `.s3cfg`, `.boto`, `.terraformrc`, `.vault*`, `id_rsa*`/`id_dsa*`/`id_ecdsa*`/`id_ed25519*`, `credentials*`,
  `client_secret*.json`, `*service-account*.json`, `secret(s).<data format>`, `*.secret(s)`, a `secret(s)` directory, `*.tfstate*`, `*.tfvars*`
  `.firebase*`, `.token`/`*.token`, `*.ovpn`, `.config/gh/hosts.yml`
  and the key extensions `pem key p8 p12 pfx ppk jks jceks keystore kdbx gpg asc pgp`. Hidden paths are omitted from tree
  listings and counted in the tree's `withheld` (a decision, 2026-10-31: that count says a hidden name exists, nothing about its content,
  size or kind, and an entry whose listing record is too long to parse is counted there too); they are **never opened by a search**, which reports nothing about them (only the
  constant `note`; its size, kind and count figures never include a hidden path), because any count or match derived from their content would be
  an oracle on a committed secret. A symlink is listed
  as a `symlink` without its target and never followed. The name rule is not a classifier: a secret inside an ordinary source file is
  redacted only when its value is registered with the egress scrubber, which scrubs the whole file before it is paged or searched, and every
  path, entry and search line.
- **Audit.** Each call, refused ones included, is one `agent.note` `{lead: {action: 'project_view', tool, outcome, path, commit, bytes,
  truncated, withheld}}` in the lead run's session log, written under the attempt's fence before the result is returned: if it cannot
  be written (stale lease, fenced out) the lead receives that code and no content. The note carries no file text and, for a search,
  only the length of the query. Notes are not coalesced: a turn that makes thousands of calls writes thousands of small notes.

## Resume (ADR-0019 decision 9)

`session/load` is used when the agent advertised `loadSession`, a session id was saved and the lead binding
is unchanged. Otherwise, or if the agent refuses the load, a new session is seeded with the stored lead
handoff (task, delegated objective, definition of done, plan items, the lead's last words) plus the packet.
History replayed by `session/load` is ignored. If the lead cannot start (quota, login, admission, unsupported
protocol) before any update, the wake and packet are kept, the attempt yields, a `lead_unavailable` notice is
emitted and a back-off applies. The run policy's named `fallback` binding, if any, is tried first, with a
seeded session; there is no automatic fallback otherwise. A failure after the acknowledgement moves the run
to `input_required` and is never replayed; `resume(runId, prompt)` is the explicit continuation, also for a
lead `interrupted` by a restart. A resolution wake for an accepted delegation of this lead whose child actually started (the packet records an
attempt) begins with one fixed English sentence saying the delegate call was accepted, the work ran while the lead
hibernated, and the interrupted tool call was hibernation, not a refusal; the packet follows it. Escalation and
quota wakes, a child cancelled before its start, and a lead that never delegated are not given that sentence, and
`guanxi.wake/v1` is unchanged.

## Wake packet

`packet.ts` is pure: structured fields whitelisted from the child report (outcome, item statuses, gate
results with clipped output, head, diffstat, handoff reference, child costs, open questions, drill-down ids)
and never a trace. The reporter hands over one gate result per item, the newest at the current head, in plan
order: the relay ledger's evidence is a log of gate runs and the relay re-proves every item when its plan closes. The budget is 4000 tokens counted as `ceil(utf8 bytes / 3)`, a conservative bound, not a
model tokenizer. Reductions run in a fixed order and each is listed in `truncated`. Text is scrubbed before
clipping and the finished packet is scrubbed and parsed again. `relayStartsChildReporter` reads the relay
ledger of the relay run started for a child through `RelayService.read` only. When the relay run stopped, the
narrative also carries its last fixed failure code and the last `call_failed_reason` note's fixed
`purpose`/`reason` (for example `relay run status: input_required; stopped: model_failed (work call:
runtime_meter_unavailable)`), read only from the relay run's own session-log events: relay events carry its run id
and `run.lifecycle` carries `data.runId`, so an `rc-*` child event that shares the session is never taken for the
relay's. `wrapping_up` is a working state, not a stop, and carries no stop facts. Messages, paths and other free
text are never copied.

## Relay adapter

`relayStartsChildStarter` uses only the public `RelayStarts` surface (`start`, `status`, `stop`). `RelayStarts.start`
always creates its own root run, so it cannot adopt the child that R1 `delegate` created and promised; that child
stays the lead's promise as a **mirror** kept in step with the relay run:

- The mirror's lease is renewed on an interval for the whole life of the start, including the unbounded
  preparation (checkout, runtime meter), so a healthy relay run is never orphaned by lease expiry.
- The mirror never records a model start: the relay run owns the work, and re-attaching to it by key is idempotent.
- It completes with the relay run's outcome. A run that settles without finishing its plan (`wrapping_up` or
  `input_required` after a cap, a wall limit or no progress: the executor has returned and the ledger is final) and
  an `interrupted` one end the mirror as `failed`; the lead is woken once, with the relay status in the packet.
- When R1's deadline puts the mirror into `wrapping_up`, the relay run is stopped (the default "cancel after
  wrap-up"); canceling the lead stops it once through the lead service. A detached child keeps running.
- The start key is the child id, so a lost mirror (an expired lease, a node restart) is re-attached by the lead
  service, at most `childStartLimit` times, to the same relay run. After a restart the relay reports its run
  `interrupted` (it never resumes inference) and the re-attached mirror ends `failed` at once; the lead is woken.
- A refused deadline stop is retried on the next poll; an unreadable status stops the relay run before the mirror
  fails; a node shutdown during preparation is not a failure. `pollMs` (default 5 s, at most 30 s) must stay well
  below the R1 attempt lease (default 60 s).
- A start refused for lack of a runtime meter or workspace (`runtime_meter_unavailable`,
  `relay_workspace_unavailable`) fails the child and wakes the lead with `failed`.

The lead chooses the plan, its acceptance commands, caps and the executor connection and model. Consent
(`full-access`) and allowed domains are the owner's, set at boot in `leads.relay`, and `leads.relay` refuses to load
without `validateExecutor`, the owner's allow-list of executors. The acceptance commands a lead writes run as the
relay's gates under that consent: trust in the lead is trust in those commands.

The owner also bounds what the lead may ask for. `leads.relay` requires `limits` (also available with a custom
child): `maxCaps` with all four caps required, `maxDeadlineMs`, and `allowDetach` (default false). Before the lead
is stopped, `guanxi_delegate` refuses a brief with a null or larger cap, a longer deadline, or `onCancel` or
`onDeadline` set to `detach` as `delegation_exceeds_policy: <field>` (field names only, never values); the lead can
correct it in the same turn. Without `allowDetach` the owner's cancel always cancels the child, whatever the
stored intent says. `validateExecutor(executor, owner, brief)` receives the whole brief.

## Cost and billing (D-142)

The lead's usage comes from ACP `PromptResponse.usage` and `usage_update.cost`, which are cumulative per ACP
session. The service records the delta per attempt under `lead-turn:<ordinal>:<hash of ACP session id and
binding>:<cumulative values it saw>`; the baseline is the most recent entry of the same session in the cost
ledger, so there is no second record to fall out of step. Within one agent session a kill can neither bill a
turn twice nor lose usage for good (the next turn catches up), and a counter reset restarts the baseline.
Usage a killed turn never recorded is unobserved if the next turn runs in a different agent session.
Tokens the agent did not report are not invented: a `usage_unobserved` note is written instead. Money is
recorded only for a known currency and a safe integer, otherwise `unknown`; a failing cost record is noted
and never blocks the turn. Each record carries the lead connection's `billing` fact (subscription, extra
usage or API) as data with its source and age; Guanxi does not classify the bill. Hibernation and the wake
packet add no cost; the resumed turn is billed to its own attempt after the wake. Tokens an agent never
reports, including a turn the node itself lost to a crash, are unobserved.

## Durability

| Killed at | State left | Recovery |
| --- | --- | --- |
| during `startLead` | run without a retained resource | the resource is ensured again before the lead first sleeps |
| before the intent commits | lead `interrupted`, no intent | none automatic; `resume` retries the first turn |
| intent committed, delegate not | intent row, lead `interrupted` | `runs.start`, the same keyed `delegate`; the lead is not re-prompted |
| delegate committed | promise exists, intent not marked | marked delegated, child started |
| child attempt exists | child `working`/`interrupted` | restarted only if no attempt reached a model call (the relay adapter never records one, so a lost mirror is re-attached); else notice and the deadline wakes the lead |
| resolution, wake delivered | R1 outbox | R1 redelivers; the stored packet is reused |
| after the acknowledgement | lead `interrupted` | never replayed; `resume` is explicit |

Shutting the service down mid-turn changes no run state: no fallback is started and no failure is recorded.
The attempt is left to R1's restart reconciliation: the next start completes a persisted intent and redelivers
an unacknowledged wake; an acknowledged turn becomes `interrupted` and needs `resume`. A person's `resume`
abandons any delegation intent the lead had only begun to request (never one R1 already committed); if it
arrives before the first pump after a restart it wins the race against recovering that intent. The pump reads only delegations that
still need it (an unfinished intent or child start of a live lead, a canceled child to stop, a child that lost
its executor, with at most `childStartLimit` attempts before a first model call, and never beside a still-unwinding
executor of this process; an executor handle that never settles keeps its child from being restarted, and the
deadline still wakes the lead).

A killed node leaves K5's admission holder and possibly a detached agent group still running a billable turn until
the next start: K5's boot reconciliation then releases the holder once its owner and group are proven gone (see the K5
README) and the wake is delivered. A holder that cannot be proven stays occupied; after `wakeFailureLimit` (default 5)
consecutive undeliverable wakes the lead moves to `input_required` with a typed code (`admission_stuck`,
`quota_exhausted` or `agent_unavailable`; the real code is in the run's notes), keeping the wake and packet, and
`resume` continues it. Neither is hidden by this service. Child executor stop is
at-least-once and idempotent; R1's chain cancel is exactly once.

## Storage

Migration **41** (`lead_migrations`, `lead_sessions`, `lead_delegations`, `lead_wakes`) in the node database,
additive, one transaction, no `user_version` change. The packet and the delegation intent are immutable by
trigger; a packet is never rebuilt. Rows hold scrubbed, bounded text and no secret, path or credential.
Removing the plugin keeps the tables. Rollback: stop the node, unload the plugin; pending wakes stay in R1.

## Evidence and limits

`test/leads/project-view.test.ts` covers the project view over real repositories (traversal, symlinks, secret names, scrubbing across
pages, bounds and cursors, audit, an unknown task) and through the loopback tool server with the fixture agent;
`test/ms1-live/lead-project-view.test.ts` does the same through the production boot.
`test/leads/*` use the K5 fixture ACP agent over real child processes and real HTTP, a fake child executor and
injected clocks (up to 24 h of simulated time), plus a `SIGKILL` worker that kills the process at every
transaction boundary of delegation, resolution/wake/acknowledgement and cancel with a scripted agent.
The MS1 local rehearsal (`test/ms1/`) composes this service with the public relay start, R1, F2-d and F2-c across two
loopback nodes and a real SIGKILL at 15 named home-side boundaries; see its [hand-off](../../../../docs/plans/lanes/MS1-rehearsal.handoff.md).
Fixture replay is local client validation; real Claude Code behaviour on `session/cancel`, `session/load`,
usage reporting and billing is unverified. The relay adapter is covered with a fake public relay start; a real
child additionally needs the operational relay (`operationalRelay`) to admit the start.
