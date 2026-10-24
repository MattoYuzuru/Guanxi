# External leads: delegation, hibernation and wake (LW)

**Status:** implemented as a trusted opt-in kernel service; fixture-validated, no real vendor CLI,
account, network or model · **Updated:** 2026-10-24 · Plan: [LW plan](../../../../docs/plans/lanes/LW.plan.md)

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

## Resume (ADR-0019 decision 9)

`session/load` is used when the agent advertised `loadSession`, a session id was saved and the lead binding
is unchanged. Otherwise, or if the agent refuses the load, a new session is seeded with the stored lead
handoff (task, delegated objective, definition of done, plan items, the lead's last words) plus the packet.
History replayed by `session/load` is ignored. If the lead cannot start (quota, login, admission, unsupported
protocol) before any update, the wake and packet are kept, the attempt yields, a `lead_unavailable` notice is
emitted and a back-off applies. The run policy's named `fallback` binding, if any, is tried first, with a
seeded session; there is no automatic fallback otherwise. A failure after the acknowledgement moves the run
to `input_required` and is never replayed; `resume(runId, prompt)` is the explicit continuation, also for a
lead `interrupted` by a restart. A wake after an accepted delegation of this lead starts with one fixed English
sentence saying the delegate call was accepted, the work ran while the lead hibernated, and the interrupted
tool call was hibernation, not a refusal; the packet follows it. A lead that never delegated is not given that
sentence, and `guanxi.wake/v1` is unchanged.

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
runtime_meter_unavailable)`), read only from its session-log events; messages, paths and other free text are
never copied.

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

`test/leads/*` use the K5 fixture ACP agent over real child processes and real HTTP, a fake child executor and
injected clocks (up to 24 h of simulated time), plus a `SIGKILL` worker that kills the process at every
transaction boundary of delegation, resolution/wake/acknowledgement and cancel with a scripted agent.
The MS1 local rehearsal (`test/ms1/`) composes this service with the public relay start, R1, F2-d and F2-c across two
loopback nodes and a real SIGKILL at 15 named home-side boundaries; see its [hand-off](../../../../docs/plans/lanes/MS1-rehearsal.handoff.md).
Fixture replay is local client validation; real Claude Code behaviour on `session/cancel`, `session/load`,
usage reporting and billing is unverified. The relay adapter is covered with a fake public relay start; a real
child additionally needs the operational relay (`operationalRelay`) to admit the start.
