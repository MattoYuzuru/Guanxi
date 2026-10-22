# External leads: delegation, hibernation and wake (LW)

**Status:** implemented as a trusted opt-in kernel service; fixture-validated, no real vendor CLI,
account, network or model · **Updated:** 2026-10-23 · Plan: [LW plan](../../../../docs/plans/lanes/LW.plan.md)

`guanxi.external-leads` provides `lead.external`. A lead is an ACP v1 agent run by K5
([external agents](../external-agents/README.md)) that decides to delegate through one tool,
`guanxi_delegate`, and then sleeps at zero cost while R1 ([runs](../runs/README.md)) keeps the promise,
the deadline and the wake. The server loads it only when `start({ externalAgents, leads })` is given; the
default server loads nothing, opens no listener and writes no ledger. It is not reachable over HTTP.

## Opt-in and boundary

`leads` carries a `ChildStarter` (the executor of delegated work), an optional `ChildReporter`, and the
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
Identity, roots, network, judges and wake policy are node-owned and refused if sent.

## Resume (ADR-0019 decision 9)

`session/load` is used when the agent advertised `loadSession`, a session id was saved and the lead binding
is unchanged. Otherwise, or if the agent refuses the load, a new session is seeded with the stored lead
handoff (task, delegated objective, definition of done, plan items, the lead's last words) plus the packet.
History replayed by `session/load` is ignored. If the lead cannot start (quota, login, admission, unsupported
protocol) before any update, the wake and packet are kept, the attempt yields, a `lead_unavailable` notice is
emitted and a back-off applies. The run policy's named `fallback` binding, if any, is tried first, with a
seeded session; there is no automatic fallback otherwise. A failure after the acknowledgement moves the run
to `input_required` and is never replayed; `resume(runId, prompt)` is the explicit continuation, also for a
lead `interrupted` by a restart.

## Wake packet

`packet.ts` is pure: structured fields whitelisted from the child report (outcome, item statuses, gate
results with clipped output, head, diffstat, handoff reference, child costs, open questions, drill-down ids)
and never a trace. The budget is 4000 tokens counted as `ceil(utf8 bytes / 3)`, a conservative bound, not a
model tokenizer. Reductions run in a fixed order and each is listed in `truncated`. Text is scrubbed before
clipping and the finished packet is scrubbed and parsed again. `relayChildReporter` reads the relay ledger
through `RelayService.read` only.

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
| child attempt exists | child `working`/`interrupted` | restarted only if no attempt reached a model call; else notice and the deadline wakes the lead |
| resolution, wake delivered | R1 outbox | R1 redelivers; the stored packet is reused |
| after the acknowledgement | lead `interrupted` | never replayed; `resume` is explicit |

Shutting the service down mid-turn changes no run state: no fallback is started and no failure is recorded.
The attempt is left to R1's restart reconciliation: the next start completes a persisted intent and redelivers
an unacknowledged wake; an acknowledged turn becomes `interrupted` and needs `resume`. A person's `resume`
abandons any delegation intent the lead had only begun to request. The pump reads only delegations that
still need it (an unfinished intent or child start of a live lead, a canceled child to stop, a child that lost
its executor, with at most `childStartLimit` attempts before a first model call, and never beside a still-unwinding
executor of this process).

A killed node can leave K5's admission holder for that account occupied (K5 keeps it until an audited break
exists) and an orphaned detached agent group; neither is hidden by this service. Child executor stop is
at-least-once and idempotent; R1's chain cancel is exactly once.

## Storage

Migration **40** (`lead_migrations`, `lead_sessions`, `lead_delegations`, `lead_wakes`) in the node database,
additive, one transaction, no `user_version` change. The packet and the delegation intent are immutable by
trigger; a packet is never rebuilt. Rows hold scrubbed, bounded text and no secret, path or credential.
Removing the plugin keeps the tables. Rollback: stop the node, unload the plugin; pending wakes stay in R1.

## Evidence and limits

`test/leads/*` use the K5 fixture ACP agent over real child processes and real HTTP, a fake child executor and
injected clocks (up to 24 h of simulated time), plus a `SIGKILL` worker that kills the process at every
transaction boundary of delegation, resolution/wake/acknowledgement and cancel with a scripted agent.
Fixture replay is local client validation; real Claude Code behaviour on `session/cancel`, `session/load`,
usage reporting and billing is unverified. The relay-backed starter needs the R2-op checkout allocator and
runtime meter for a real child; it is covered with a fake `RelayService` only.
