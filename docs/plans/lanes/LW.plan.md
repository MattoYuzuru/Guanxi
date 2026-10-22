# LW — external lead delegation, hibernation and exactly-once wake: plan

**Status:** plan before code · **Date:** 2026-10-23 · Base `f4a51b8c`, branch `codex/lead-hibernation`,
Node 26, ports 5213/4413, checkout-local `.lane-data`. Brief: `Guanxi-lanes/prompts/w2-lead-hibernation-20261023.md`.
Design sources: ADR-0019 decisions 5, 8, 9 and invariants, ADR-0021 decision 5, D-142, R1 `runs/store.ts`, K5 `external-agents/`.

## Outcome and non-goals

An ACP external lead (Claude Code through its operator-installed bridge, or any ACP v1 agent that
advertises HTTP MCP) calls `guanxi_delegate` once with an ADR-0021 brief, its turn is stopped, its
process is released, and R1 holds `waiting_children` at zero lead cost. A resolution, deadline or signal
creates one R1 wake; the node builds a scrubbed packet and resumes the lead by `session/load` or by a
seeded new session. The wake is acknowledged when the resumed turn shows its first activity.
Non-goals: Codex app-server leads (`lead_adapter_unsupported`, no tool carrier); any real
account, network or model; relay checkout allocator and runtime meter (R2-op); UI; routing (R3);
cross-node leads (F2); a power assertion (`alwaysOn` stays a host assertion). `proposed` stays proposed.

## Components (new directory `packages/server/src/leads/`, kernel plugin `guanxi.external-leads`)

- **Tool endpoint** (`tool-server.ts`). One loopback `node:http` server on `127.0.0.1:0`, created
  lazily, closed on unload. Streamable-HTTP MCP subset in JSON mode (`initialize`, `ping`,
  `notifications/*`, `tools/list`, `tools/call`; GET 405, batches refused, 1 MiB body cap).
  Capability = a random per-turn bearer token bound to `{runId, attemptId, wakeSeq}`, passed in
  `session/new.mcpServers[].headers` (never in a URL, argv, log or K2 event). A `Host` that is not
  the bound loopback address or any `Origin` header is refused. Token dies when the turn ends.
  One delegation per turn; a second call is a tool error. ACP's unstable `acp` MCP transport is a
  future option; HTTP is the stable one and the agent must advertise `mcpCapabilities.http`.
- **Contract** (`packages/contract/src/lead.ts`): strict `leadDelegateInputSchema` (objective,
  definition of done, relay plan, caps, executor connection/model, relative `deadlineMs`,
  `onDeadline`, `onCancel`) and `leadWakePacketSchema`. The host adds identity, roots and judges.
- **Child starter** (`children.ts`): pluggable `ChildStarter.start(launch) -> ChildHandle{done, stop}`
  plus `ChildReporter`. The R1 child created by `delegate` receives its attempt from `runs.start`.
  The relay adapter uses only the public `RelayStarts` surface (`start`, `status`, `stop`) keyed by the
  child id: `RelayStarts.start` cannot adopt an existing R1 child (it always creates a root run), so the
  child stays the lead's promise as a mirror kept in step with the relay run. No relay file is edited.
- **Wake packet** (`packet.ts`, pure): structured fields only, whitelisted from the child report,
  never a trace. Outcome, item statuses, gate results (clipped output), diffstat, head, handoff
  reference, costs, open questions, drill-down ids. Budget 4000 tokens, counted conservatively as
  `ceil(utf8Bytes/3)`; ordered shrink steps record a `truncated` list. Scrubbed, and refused
  (`content_withheld`) if scrubbing would change the rendered text.
- **Service** (`service.ts`, `lead.external`): `startLead`, `cancel`, `decide`, `pump`, `recover`.
  Own pump interval (injectable); tests call `pump()` with fake clocks.
- **K5 extension** (shared edit): `RolePrompt.lead` carries `mcpServers`, `resume`, `seed`,
  callbacks `onSession`, `onActivity`, `onUsage` and a cooperative `hibernateSignal`. `AcpClient.prompt`
  uses `session/load` when `agentCapabilities.loadSession` and a saved id exist, otherwise (or on a
  load error) a new session with the seed. On hibernation it sends `session/cancel`, reads the
  cancelled `PromptResponse` (usage) within a grace, returns `stopReason: 'hibernated'`, and the
  existing close path confirms the process group before the admission holder is released.
  Replayed history during `session/load` is ignored. Behaviour without `lead` is unchanged.

## Sequences and invariants

1. **Start.** `runs.create` and `runs.start` give attempt A1; `retain` records the scratch resource;
   a `lead_sessions` row is written under the fence. The turn runs through `agent.external`.
   First `session/update` of the prompt calls `modelStarted`. A heartbeat renews A1.
2. **Delegate.** Validate the brief and refuse bad input to the lead as a tool error (turn goes on).
   Persist a `lead_delegations` **intent** (key = `lead:<run>:<attempt>`) under the fence, then abort
   the pending tool call by hibernating: cancel, read final usage, confirm the process group is
   empty. Record usage with `recordCost` (idempotent keys), then one `runs.delegate` (child,
   promise, timer, `waiting_children`, lease released), then mark the intent `delegated`, then start
   the child. The tool call is never answered, so the lead consumes no further tokens.
   A crash before `delegate` leaves the intent: recovery restarts the lead run, repeats the same
   keyed `delegate` (idempotent) and never re-prompts the lead.
3. **Hibernation.** Nothing is held but the retained scratch resource. Lead cost totals are read
   twice in tests (after delegate, before wake) and must be equal; hibernation records no cost.
4. **Wake.** The pump claims only runs with a `lead_sessions` row and no live turn, `deliver`s
   (new fenced attempt per delivery), builds the packet once into immutable `lead_wakes`
   (redelivery reuses it), and resumes. Any activity before the ack is not an ack. Ack happens
   once, in `modelStarted`. A turn that ends while a promise or wake is pending yields with
   `runs.hibernate`; otherwise it completes. Failure before any activity yields the same way, keeps
   the wake and packet, applies a backoff and calls `notify` with `lead_unavailable`; the run's
   optional fallback binding is tried first (seeded session). Failure after the ack is `input_required`.
5. **Cancel.** `runs.cancel(lead)` cancels the chain once (R1); the service then calls
   `ChildHandle.stop()` for each canceled child still marked started. A live lead turn is aborted.
6. **Recovery** (first pump after the home is claimed): finish intents, start children that have no
   attempt, re-stop canceled children, redeliver unacknowledged wakes (R1 does the fencing).
   K5 keeps an admission holder for a lead killed mid-turn until an audited break exists; a
   killed node can also leave an orphan agent group. Both are named K5 residuals, not hidden.

## Storage

Migration **41** (40 was free at planning time; Q0 took it before merge, so the next free number on main is used): `lead_migrations`, `lead_sessions`,
`lead_delegations`, `lead_wakes` (packet immutable by trigger) in the node database, additive,
created in one transaction, no `user_version` change, FKs to `durable_runs`. No existing migration is edited.

## Tests (fixtures only; no network, account, model or `~/.guanxi`)

- Fixture agent: ACP lead scenarios calling the tool over HTTP, `loadSession` on/off, replayed
  history on load, usage reporting, JSONL event log appended by every process.
- Unit: MCP endpoint (auth, Host/Origin, bad JSON, size, token lifetime); packet (scrub, budget,
  truncation, determinism); schema; migration idempotence and bytes.
- Integration (real K5 + fixture): delegate, hibernate, no live process or admission holder,
  child resolves after simulated hours, one wake, one resumed turn by `session/load` and by seed,
  planted secret absent from the prompt seen by the agent, cost ledger unchanged, resumed second delegation,
  escalation then completion (two wakes, one resolution), deadline, unavailable lead retry.
- Crash (`SIGKILL` worker, style of `durable-run-crash.test.ts`) at every LW and R1 boundary of
  delegate, resolve, deliver, ack with a scripted lead port: exactly one resolution, one
  acknowledged wake, one completed resumed turn per wake, child started once, integrity checks.
- Cancel of a hibernating lead: R1 cancel counts 1, child `stop` once, no wake.
- Mutations: each guard removed must fail an assertion (recorded in the hand-off).

## Gates and delivery

`npm run typecheck`, `lint:md`, `check:licenses` directly; `npm test`, `npm run build` through
`agent-dev run --resource heavy`, one per call. Envelope: K5 external-agents, runs and relay suites.
Separate commits: plan, implementation, tests, hand-off. A read-only reviewer sub-agent checks the
pinned diff; fixes land in a separate commit. Shared edits: K5 `acp.ts`, `service.ts`, `types.ts`,
fixture process, plugin exports, `RunStore.alwaysOnHome` getter. Hand-off: `LW.handoff.md`.
Rollback: unload the plugin; additive tables stay; no inference is resumed automatically.
