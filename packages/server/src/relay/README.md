# Relay executor (R2)

**Status:** implemented internal single-node service; validation is recorded in the
[R2 hand-off](../../../../docs/plans/evidence/R2.md).

`guanxi.relay` provides `agent.relay`, loaded after K3 in the default server. Loading it
starts no inference. A trusted execution host initializes an R1 attempt with an immutable
plan and delegation caps, then supplies `RelayInput`: a K3 connection/model, a runtime
meter, reserves, optional execution limits and a workspace. The additive public bridge below
has HTTP and CLI entry points; there is no relay UI.

## Partial trusted public bridge

`POST /api/relay` accepts an explicit owner plan/caps, project, connection, model, start key,
Full-access consent and allowed domains. The strict wire schema accepts no loaded window,
placement, tokenizer or source/confidence claims. Server project/workspace bindings supply roots;
the immutable run policy captures those roots and owner choices. The default server refuses
`runtime_meter_unavailable` before creating a run, attempt or start mapping. A configured runtime
without an owned-workspace allocator refuses `relay_workspace_unavailable` instead. This is a
partial R2 bridge, not an operational stock-Ollama executor or a full R2/MS1 gate.

The trusted `StartOptions.relay` port must supply an exact rendered-request counter bound to
installed digest/runtime identity and an owned isolated checkout allocator. There is no byte-count,
catalog-context or unsandboxed allocation fallback. Loaded W comes from current Ollama `/api/ps`,
matched to an installed artifact. The counter and loaded observation have explicit sources,
timestamps, high-confidence attestations and a host-selected maximum age. Status retains the
admission observations and their age; it does not claim the runtime is still live. Local zero-cost
accounting is an explicit trusted host-compute policy, not an observed provider bill. The counter
port remains responsible for proving local placement and renderer correctness; a loopback address
alone proves neither. Stock Ollama does not supply this port here.

`GET /api/relay/starts/:key` and `/result` return metadata-only status; `POST .../stop` cancels
preparation or its committed run and waits for resource cleanup acknowledgement. Run-id aliases
are available after admission. Identical start-key retries return the same run, changed choices
conflict, and restart reports interrupted work without dispatching inference. Events use the
existing `/api/sessions/:sessionId/stream`; disconnecting that observer does not cancel execution.
All routes require a loopback peer and mutation routes enforce JSON/origin checks. Stop cannot
force a noncooperative allocator to acknowledge cleanup; a known K4 quarantine is retained and
reported as `cleanup_unconfirmed`. Transport settlement is a separate prerequisite for treating
a canceled model call as released; this slice makes no backend-compute cessation claim.

Public start migration **39** uses `relay_start_migrations` and `relay_public_starts`, created
atomically with R1 attempt, K2 session and relay initialization. A failed transaction creates none
of them. Losing the home generation prevents publishing settled state. Rollback disables new
admission and retains additive history; no inference is resumed automatically.

See the [slice plan](../../../../docs/plans/lanes/R2-trusted-start.plan.md) for the bounded scope.

## Operational local runtime (R2-op)

`StartOptions.operationalRelay` is an immutable, explicit boot option of the trusted host. It is
not an HTTP setting and cannot be combined with `StartOptions.relay`. Without it, or when the
binary or model file is absent on this node, the stock refusals above are unchanged.

**Counter: a direct llama-server runtime, not an Ollama sidecar.** The server that is dispatched
to is also the renderer and tokenizer. `/apply-template` renders the one-message `think:false`
request (`enable_thinking:false`), `/tokenize` (`add_special`, `parse_special`) counts it, `/props`
supplies the loaded per-slot `n_ctx`, and dispatch is `POST /completion` of exactly the counted
string. An Ollama sidecar was rejected: Ollama renders with its Go template layer, not the GGUF
Jinja, so equality cannot be shown for an unknown model; the installed llama-server has no
vocab-only mode, so a sidecar means a second full model load; and a llama.cpp-only host has no
Ollama store at all. Stock Ollama therefore still refuses `runtime_meter_unavailable`.

Identity is `{alias, SHA-256 of the GGUF file named by /props, llama-server/<build_info>, n_ctx}`;
the digest is computed once and recomputed when path, size, mtime or inode change. In `spawn` mode
the file's device, inode, size and mtime are also recorded when the child is started, so a file
renamed over the same path afterwards is `runtime_identity_unknown` instead of a silent swap, and a
split GGUF (`-00001-of-0000N`) is refused (`llama_server_model_unsupported`) because its shards are
not hashed. An `attach`ed server cannot be checked this way; shards, `--mmproj` and draft models
are outside its identity. The synchronous
`count` that the executor needs is served by one worker thread doing the two HTTP calls while the
calling thread blocks in `Atomics.wait` with a hard timeout (default 10 s plus 2 s); a timeout or
any invalid reply is `runtime_count_invalid`, never an estimate. The block is milliseconds for an
uncached count on a healthy server and up to the timeout when the server hangs, and it stalls the
whole event loop, so it suits one relay run at a time. Bind proves once per
served identity that the template adds framing, echoes the message once and agrees with the
bridge. Before each POST the transport re-renders, re-counts and compares with the executor's
synchronous count (`runtime_counter_mismatch`), refuses a window overrun, re-runs the final fence
check and issues the POST in the same synchronous stretch, and refuses a `truncated` reply. After
the reply the executor's existing `prompt_eval_count` comparison (`truncation_protocol`) is the
first real-dispatch cross-check; there is no fallback. `tokens_evaluated` is taken to be the whole
prompt including cached prefix tokens (`cache_prompt` is on); if a real binary reports otherwise,
every cached call fails closed and `cachePrompt: false` is the boot-level remedy. No request to a
real llama-server has been made yet: field names were only found as strings in the installed
build 10964.

Dispatch still goes through K3 `localChat` (`transport` option): scrubbing, unattended consent,
the single governor permit (provider `ollama`, model name prefixed `llama-server:`; widening the
governor vocabulary is open) and the usage receipt (`llama-server:/completion`) are unchanged.

**Boot modes.** `spawn` runs the owner-supplied binary with a fixed argv (`--host 127.0.0.1 -np 1
--jinja --no-context-shift --no-webui --alias`), an allow-listed environment and discarded
output, loads in the background (loading means `runtime_meter_unavailable`), never restarts, and
stops only the child it started on close. `attach` uses an existing loopback server (started with
`--alias` and `--jinja`; another host needs a tunnel) and never signals it. The model reference must
be a local one; no cloud name is accepted. The child gets a neutral working directory, and a child
that exits is recorded with its exit code or signal only, because its output is discarded. A crash
of the Guanxi process itself leaves the child running (residual).

**Owned checkout allocator.** `allocate` clones the project's committed history under
`<data>/relay-checkouts/r-*` (a marked directory), detaches at `plan.base`, removes the remote and
every ref, expires reflogs and repacks so no object newer than the base remains, and creates
`runtime/` and `runtime/scratch/`. The source worktree, uncommitted changes and the source
repository are only read. Files are never hardlinked (the K4 sandbox refuses writable hardlinks).
`close()` deletes only a marked directory directly under the allowed root, keeps everything when a
K4 quarantine exists, proves the removal and otherwise reports `cleanup_unconfirmed`, which an
abort cannot hide. A source that borrows objects through alternates is made self-contained and then
checked: the stored objects must equal exactly those `HEAD` reaches. Crash leftovers are not reaped
at boot and removal assumes the sandbox is stopped, which the quarantine check enforces (residual).

## ETA projection (R3-a)

The trusted host may additionally supply `RelayInput.eta`. It contains an exact
model/host/repository cohort, per-item **remaining** duration estimates, completed historical
estimate/actual observations with source and time, and an explicit sampling policy
(`simulations`, unsigned 32-bit `seed`, `minSamples`, `maxAgeMs`). The service refuses a model
that differs from the execution model. Configuration is copied at admission and sampled
synchronously at cycle start and after final gate observations, before handoff construction.
This avoids concurrent projection writes changing an in-flight seal hash. Fresh ledgers
without this configuration retain `null`; recovery retains the last timestamped observation
until the host supplies fresh configuration.

The forecast bootstraps empirical estimate/actual ratios independently per unfinished item,
then sums their durations in serial plan order and reports nearest-rank P50/P80 remaining
milliseconds and finish timestamps. Verified `done` items contribute zero; dependency-blocked
items still contribute. The host supplies remaining estimates; the estimator never subtracts
run age or pretends to know when an item began. Recovery requires a fresh host configuration.
Missing estimates or insufficient recent untainted history return `unknown`, null quantiles
and a reason. A fully completed plan has zero remaining duration even without history.

Every projection includes its observation time, cohort, sample/exclusion counts, source list,
oldest/newest sample time, policy and the serial/independent-ratio assumption. Forecasts have
`low` confidence and `unvalidated` calibration. The optional runtime-counter observation
compares remaining tokens / observed throughput with the P80 duration: a fresh contradiction
is explicit, a stale or future observation is marked stale, and an unavailable forecast is
distinguished from agreement. The `minimumRemainingMs` / `below_runtime_floor` names describe
a constant-observed-throughput heuristic: observed throughput is a baseline, not a proven
maximum speed or guaranteed duration bound. This check does not silently rewrite the
distribution.

Projections use the existing R1-fenced transaction and scrubber, persist in the ledger and
sealed snapshot, and survive store reconstruction. No migration, public API, UI, model call,
judge, wake policy or routing change is added. The host still owns measurement collection and
cohort identity; there is no automatic historical timing collector or calibrated live ETA.
Fixture quantile assertions do **not** satisfy the R3/B3 gate requiring P80 coverage between
0.7 and 0.9 across at least 20 real runs. Judge replay precision/recall, night wake rates,
delegation policy and the six-hour MS1 envelope remain unfinished.

## Judge observations (R3 follow-up)

The trusted host may also supply `RelayInput.judgeSignals`: an explicit
`JudgeSignalPolicy` and a `collect` function. This is T0 data like the runtime meter and the
workspace, never parsed from model JSON or HTTP and not a public wire surface. Admission copies
and freezes the flat policy, checks that `collect` is a function without calling it, and rejects
invalid configuration with a fixed `judge_config_invalid` error. There are no policy defaults:
every threshold must come from the host.

When configured, the executor takes one observation at `cycle_start` immediately after
`store.begin` and the ETA update, before orient or any model call, and one at `pre_seal` after
the final ETA update and before the fresh narrative and handoff construction. The collector
receives a detached ledger copy, a detached attempt identity (`id`, `runId`, `epoch`, `token`)
and the actual run abort signal. It cannot mutate the authoritative ledger or the frozen policy.
There is no timer or background writer; sampling is synchronous with the cycle.

Only the reviewed `judge-signals.ts` pure module evaluates the observation. On success the
executor appends exactly one `agent.note` with
`{relay:'judge_signals', phase, cycle, signals, unknownFacts}` through the existing R1-fenced
transaction. `unknownFacts` names `heartbeat`, `lease`, `deadline`, `disk` and `tokenBudget` for
each missing observation field, so an empty `signals` array is not a health claim. Without a
journal (the default for a bare cascade) the full observation and the `protectedPathEdits` /
`outOfScopeEdits` values are never persisted or logged; the optional local journal below is the
only place they may be stored (D-199).

A collector rejection or an invalid observation fails the cycle closed with the fixed
`judge_observation_unavailable` or `judge_observation_invalid` code respectively; no judge note
is published and no follow-up model call is made. Cancellation and a revoked/stale fence keep
the existing loss/cancel semantics instead of being converted into an observer error. Signals
themselves do not stop, reroute or wake anything; J2/J3, verdicts, routing and the action
cascade remain separate opt-in work below. Pure observation waits race the run abort signal,
consume late outcomes and cannot hold disposal open; this adds no timer or new cancellation
authority. Resourceful checker/model ownership uses the distinct settlement contract below. Fixture tests prove wiring,
detached inputs, cancellation/fence behavior and seal consistency only; they are not real host
observations, a calibrated classifier, or the R3 precision/recall/night-wake gates.

## Local judge observation journal (D-199)

The cascade has one optional local sink. When a relay executor receives a `cascade`, it supplies
a lazy `JudgeJournal` unless the caller explicitly passes `journal: null`; the relay plugin does
the same for a public start. Construction (`BEGIN IMMEDIATE`, DDL, version check) happens on the
first `record()`, never while a start or executor is assembled: a foreign ledger value, an open
transaction or `SQLITE_BUSY` disables the local sidecar and leaves the judged relay untouched.
If a journal table already exists, a load-time probe still constructs the store (inside the
purge guard) so the retention purge runs on a restart without a judge. A bare
`RelayJudgeCascade` has no journal and creates no journal table. The sink is the single
`request()` evaluation point: one row per actually evaluated J1.5 checker/J2/J3 request, not per
model sample and not for a duplicate request that reuses a stored result.

`judge-journal.ts` owns independent additive ledger **43** (`relay_journal_migrations`), so
`user_version`, ledger 42 (F2-reap) and every earlier ledger are untouched. A row holds
run/session/attempt ids, cycle, phase, layer, reason, request key, the exact scrubbed evidence
packet the judge received (paths included), the detached host `JudgeObservation` and signal
policy, the J0/J1 signals, `summary.unknownFacts` and the collector's declared `unobserved`
facts, the terminal state and result (sample verdicts, checker result or a fixed
unavailable/invalid code), and start/finish timestamps. `UPDATE` is refused by a trigger. A
journal write is best-effort after the fenced judge result is persisted, so a local sidecar
failure never turns a valid verdict into `unavailable`. A failed write increments the run's
counter in `relay_journal_runs`; `readJournalReplay` then carries `incomplete: true` and the R3
gate refuses the corpus as `incomplete_corpus` rather than scoring a short one as complete.

The journal is not an export. No route, contract, event, wake packet, handoff, federation
message or log line reads it. Every packet/observation/result/signal is scrubbed at insert and
again on read, and the scrubber must be ready at both points, so a registered secret never
enters a row or comes back out of one; paths intentionally remain (D-199). Rows expire under the
implemented D-113 reasoning retention (7 days, shortened by a parent Thread TTL); expired rows
are unreadable even before the purge. The plugin purges every 10 minutes once a journal exists,
and `purgeRun` / `purgeSession` are the explicit run paths; the native session delete also
calls the non-migrating session purge inside its home-fenced transaction, and `ON DELETE
CASCADE` from `durable_runs` removes rows with the owning run. `secure_delete` zeroes the freed
pages.

For local calibration, `readJournalReplay` / `readJournalCorpus` turn a finished run's J2 rows
into the strict R3-b v1 corpus with `origin: 'recorded'`. A real store leaves an unverified
executor claim at `verification_requested` and only moves an item to `done` after a passing
gate, so both statuses are recognised as a claim; `acceptancePassed` is the newest gate at the
packet's current head. Steps are ordered by attempt ordinal, cycle, phase and insertion id, so a
recovery attempt is never stitched onto the previous attempt; equal `observedAt` values from a
same-millisecond host clock are valid. `unknownFacts` is carried into the step and a detector
whose source fact was unobserved reports an unknown step instead of treating the zero as
healthy. Labels are never invented: a caller supplies the owner's ground truth later. A
finished but unlabelled run therefore scores, but does not evaluate the R3 gate.
`judge-journal.test.ts` proves default/off and plugin-injection wiring, append-only rows,
read-time expiry and re-scrubbing, all three purge paths plus the native delete transaction,
completed and unavailable/invalid/abandoned rows, real-store premature-done replay, per-attempt
ordering, equal timestamps, unknown-fact markers, incomplete-corpus refusal, and that a planted
journal path and a registered secret appear in no wake packet (built from the real child
reporter), real session-export route, relay handoff, signed F2 dispatch grant (built through
`AttemptDispatch.prepare`/`grant`) or captured test log. Source guards fail if those egress
producers start reading the journal.

## Runtime and context

The meter must observe the **actual loaded** context window (with source, observation time
and high confidence) and count the **rendered request**, including chat-template tokens.
The service refuses unknown/invalid windows. A catalog maximum or requested `num_ctx` is
not a loaded-window observation. K3 currently has no universal tokenizer/window observer;
an execution-host adapter must supply these observations before live relay admission.
Fixture meters are used in the tests; no live-model quality claim is made.

`H = W - R_turn - S`, `T_hard = H - R_ho - R_tool` and the soft/boundary rules come from
ADR-0020. Every call, including probes and the fresh writer, checks its scrubbed request
against H, including a final check after K3 scrubs immediately before dispatch. Local Ollama also compares `prompt_eval_count` with the meter's count; a mismatch or an input above H
is a protocol error. Output-length termination is separate: a limited narrative degrades the
handoff, a limited work reply is an invalid action, and any other purpose is a protocol error.
Output has the runtime/policy turn reserve. There is no fixed context or cycle ceiling.

### Execution limits

These are named policy settings, not hidden constants. `relayPlugin({ db, limits })` supplies
plugin defaults and `RelayInput.limits` overrides them for one execution; the built-in defaults
are below. There is no fixed blob limit: bundle objects and gate blobs stream through
`git cat-file --batch`. The remaining 32 MiB buffer is a guard for textual git metadata
commands only.

| Setting | Default | Effect |
| --- | --- | --- |
| `gateTimeoutMs` | `120000` | Timeout for one acceptance command in the clean gate checkout. |
| `goalBytes` | `512` | Upper bound on the plan goal injected into each work prompt. |
| `pageBytes` | `2048` | Page size for `work.query` and `notes.search`. |
| `invalidActions` | `3` | Invalid work turns before the cycle hands off. Valid tool, note, proposal, checkpoint and verify turns do not count. |
| `structuredOutput` | `true` | Decode probes, work actions and judge verdicts under a JSON Schema (see [constrained output](#constrained-json-output-r2-json)). Turn it off only for a runtime that rejects the grammar; replies are then validated exactly as before. |

Local runtime calls are treated as zero cost: the adapter reports `moneyMicros: 0` because
the host meter quotes local compute rather than an observed bill. This is an assertion shared
with the host, not an observation. A loopback proxy in front of a paid API, or another billed
route hidden behind a local-runtime connection, would therefore count as free. An Ollama model
whose name ends with `:cloud` is reported as unknown (`moneyMicros: null`) instead; the host
must represent other paid routes as `model_api` or supply a priced meter.

The work strip is at most 300 UTF-8 bytes (a conservative token bound). `work.query` pages
the full run ledger; `notes.search` pages matching typed notes. Tool results remain in K2
and K4 output artifacts where applicable. Context turns stay in the current cycle until
wind-down; only the last three enter the fresh narrative writer. Previous narratives never
enter that writer. All calls use K3, all state events use K2, and all persisted/model-facing
values pass the scrubber. Structured provider reasoning is discarded. K3 observes dispatch start before awaiting
the response, so R1 can acknowledge a wake while inference is still in flight.

## Constrained JSON output (R2-json)

The first real two-host run (Qwen3.8-27B on llama.cpp b11496) never reached a verified item: replies came back with unquoted keys,
prose plus Qwen tool-call tags, a fenced block, or probe values that were plausible and wrong. A reply that must be JSON is therefore
decoded under a JSON Schema, and the schema is a pinned part of the request, not a hint.

- **Which calls.** The five critical probes (`probeResponseSchema`), every work step (`actionResponseSchema`) and every judge J2/J3
  sample (`judgeResultJsonSchema`). The narrative stays prose and unconstrained. A `model_api` (provider) connection ignores the schema
  and is unchanged. A stock Ollama `local_runtime` receives it as the chat request's `format`, which Ollama defines as a JSON Schema;
  nothing else changed on that path.
- **Carrier.** `RelayModel.call(..., { responseSchema })` puts the schema into `OllamaChatRequest.format` for a local runtime. K3 scrubs
  the request like any other and runs `onPrepared` on the clean copy; the meter's `validatePrepared(request, responseSchema)` requires
  `canonical(request)` to equal the rendering of exactly this prompt and schema (`runtime_request_changed` otherwise, as for a changed
  prompt), and the judge's own request check pins `format` the same way (`judge_request_shape`). `LlamaServerRuntime` sends it as
  `json_schema` and refuses a `format` that is not a bounded JSON object (`'json'`, an array, over 64 KiB). Constraint does not
  change a prompt token: the count, the rendered-hash chain and the `tokens_evaluated` comparison are untouched.
- **Request body.** Exactly the field llama.cpp b11496 accepts on `/completion` (checked by the integrator against the real server with
  `const`, `enum`, `required` and `additionalProperties`):
  `{"prompt": <rendered>, "n_predict": <turn reserve>, "stream": false, "cache_prompt": true, "json_schema": {...}}`. Without a schema the
  body has no `json_schema` key at all.
- **Remote (federation 1.6).** The schema is part of the signed job (`LocalInferenceJob.responseSchema`, so of `jobHash`) and of the
  counted chain (`CountedRequest.responseSchemaSha256`, the SHA-256 of the sorted-key JSON; `schemaDigest` equals the federation
  canonical hash, asserted by a test). The executor refuses a grant whose hash is not the schema's (`dispatch_binding`), the
  executor's `expectedTransport` refuses a request whose `format` is another schema or none (`runtime_request_changed`), and its signed
  terminal event echoes `responseSchemaSha256`, which the home compares with what it sent (`truncation_protocol`). An executor older
  than 1.6 is refused by the home channel with `426` instead of dropping the field, and an executor refuses a schema from a home that
  declares an older minor (`ms1-live preflight` reports `peer_protocol_old` for it unless `home.structuredOutput` is false). Peers without
  schemas interoperate as before. The order of a schema's keys is the order a grammar writes a reply in (`name` before `args`), so it is
  preserved end to end: the channel sends the body as the sender built it (its proof signs the sorted hash) and the home keeps the job
  text unsorted.
- **Schemas.** `toJsonSchema` converts the Zod subset the relay uses (strict objects, string, number/int, boolean, null, literal,
  enum, nullable, optional, array, record, union, discriminated union, unknown) and throws `json_schema_unsupported` for anything else,
  including an object that would tolerate unknown keys. Numeric bounds are not emitted: the grammar fixes shape and types and Zod still
  validates what is parsed. The work schema is an `anyOf` with one variant per tool that the workspace actually lists (`name` is a
  `const`, `args` is that tool's own parameter object, `additionalProperties: false`) plus the non-tool actions converted from the same
  Zod definitions that validate the reply, so the grammar is narrower than the validator on tool names and arguments. The probe schema
  has five required keys, `nextStatus` is `open`, `verification_requested` or null (the ledger's own statuses minus `done`, tied to
  its type at compile time), and no ledger-specific value (hash, head, revision, item id) appears in it.
- **Tools.** `RelayWorkspace.tools()` lists the model-callable native tools (everything but `plan`, `queue`, `note_add`) with their typebox
  parameters, plus the executor's own `work.query(offset?)` and `notes.search(query, offset?)`. `file_read` takes an optional byte
  `offset` (decimal digits, a position this tool returned) and answers `{more, nextOffset, offset, code, stderr, truncated, stdout}`
  with the text last. `nextOffset` is a position in the file, so it is issued only while the page is the file's own bytes. That is checked
  per page: a page ends in front of the first redacted region or the first character the file does not hold (an invalid byte decodes to
  U+FFFD), only a page that would start there is refused (`page_cursor_unavailable`), and a real U+FFFD is kept when `od` shows the file holds
  EF BF BD. Without a budget the whole remainder is returned as before and an untrustworthy cursor is `null`. A budget that cannot hold one character is
  `page_too_small`, an offset inside a character `invalid_offset`. The executor passes `pageBytes = floor(T_hard / 4)`, the per-turn bound it applies to every tool result, so a
  page is sized to fit it and is never cut by the executor behind a cursor that says it was read; `tool_output_read` honours the same
  budget. Without a budget (the K4 session) the result is the old one plus the cursor fields.
- **Prompts (ADR-0025).** The work prompt is generated from the tool list (`name(arg, arg?)`), its examples are valid JSON (the model had
  copied `{action:tool,name,args}` with unquoted keys) spaced after the colon so they cannot be mistaken for the relay's own compact
  turns, and it says once that arguments are strings and that `more:true` continues at `offset=nextOffset`. The probe prompt defines
  each key; the cause of `nextItem: null` while an item was open was the strip's `next` (another item) beside the probe's `nextItem`,
  which is the strip's `current`. The check itself, its inputs and its expected values are unchanged. The B1 bench does not exist yet:
  these two prompt edits are minimal and factual, and carry no bench result.
- **A rejected schema.** A `/completion` refused (4xx or 500) while a `json_schema` was sent is `llama_server_schema_rejected`, then
  `response_schema_rejected` (never `runtime_identity_unknown`). K3 keeps a trusted transport's fixed refusal code as `ConnectionError.reason`
  (message and `code: provider_failed` are unchanged), so the executor's `call_failed_reason` note, the signed terminal `reason` and the
  run's error all say `response_schema_rejected`, and the run stops there instead of retrying into `probe_failed_twice`. **No server text is
  kept anywhere**: the grammar error is in the llama-server's own log. `ms1-live preflight --completion` on the executor sends the probe,
  work and judge schemas with `n_predict: 1` (check `schemas`).
- **Observation age.** Every count (packing, probes, narrative, the call itself) now follows a fresh `observe`: an exact count is valid only
  against an observation at most `maximumAgeMs` old, and the previous call or gate may have taken minutes. Dispatch observes again itself.
- **Notes.** The schema digest sorts object keys but not arrays, so two schemas that differ only in key order have one digest while a
  different `required` or `enum` order is a different schema; the key order itself is preserved on the wire for the grammar. A stock Ollama
  `local_runtime` judge receives the verdict schema as `format` (Ollama defines `format` as a JSON Schema); that path is covered by the
  K3 judge test and was not run against Ollama.
- **Not validated here.** No live llama-server was used. The real-server behaviour of an `anyOf` grammar with this many variants, and
  the quality of the model's choices under it, are for the integrator's Fedora run; `structuredOutput: false` is the switch if the grammar
  is rejected. Tests: `test/relay/{json-schema,structured-output,structured-llama,structured-remote}.test.ts`,
  `test/llama-server/*`, `test/native-agent/file-read-paging.test.ts`.

## Ledger, probes and sealing

The run ledger stores the planner's immutable revision and acceptance argv, dependencies,
protected paths, evidence, observed git state, counters and cap accounting. `verify` requests
harness acceptance; a claim alone cannot mark an item done. `propose` records an amendment
for the lead (D-158). Project boards and external tracker sync remain ADR-0032 later work.

Typed notes are append-only. Selection is stable by insertion order: links to unfinished
items, the last three decisions and unexpired dead ends, within the handoff budget.

`guanxi.handoff/v1` contains a hash/reference to the full immutable boundary snapshot,
a bounded work strip, selected notes and a fresh narrative. The full snapshot lives with
the sealed artifact, avoiding growth of the model context as the evidence ledger grows.
JSON and its deterministic Markdown rendering each fit within 15% of W. Writer failure
uses a ledger-built `degraded` narrative; verification evidence remains authoritative.

`RunStore.mutate` is a trusted synchronous extension seam. It checks the R1 home and attempt
fence inside the same `BEGIN IMMEDIATE` as extension SQL and K2 appends. A seal uploads
JSON, Markdown, its SHA-256, the ledger snapshot and git bundle as one immutable row in the
home database; it updates the live ledger to `sealed` in that transaction. A stale attempt
cannot upload or become last sealed. Reads of last sealed take the run's latest accepted
seal, whichever admitted attempt wrote it; the current attempt still owns the fence. A value
registered after evidence was stored makes the live-ledger read a redacted copy marked
`withheld: true`; the next mutation persists it so the run continues instead of failing every
read. Earlier immutable seals and bundles cannot be rewritten, so their historical bytes are
a retained residual rather than a live-context source.
Explicit recovery under a newly admitted attempt uses the live ledger; it never replays a
pending model/tool call automatically.

Orient checks the artifact digest, ledger hash, references, size and bundle, then asks five
deterministic critical probes. Failure rebuilds a degraded handoff from the authoritative
snapshot and retries once. A second failure emits a J2 request and moves to escalation/input
required. R2 emits judge requests; R3 owns judge execution and verdict policy.

Progress counts a verified item becoming `done`, a gate becoming passing, or a nonempty
committed diff. The first observation of a failing gate, notes, proposals and verification
requests are not progress. Two empty cycles request J2; three escalate.
Cycle, token, money and wall-time caps are normative; J3 review execution belongs to R3, so the relay has no J3 counter to enforce. Calls reserve the full admissible input ceiling plus output reserve as their worst-case
tokens and a host-supplied monetary bound before dispatch. Unknown price with a money cap
refuses dispatch. Failed/crashed calls retain conservative reservations. Exhaustion enters
R1 `wrapping_up`; no new work/model calls run there. The retained ledger is the deterministic
report; a later lead decides completion/cancellation.

## Workspace boundary

`GitRelayWorkspace` uses K4's tools and ExecutionOwner with Full access, a dedicated root,
planner protected paths and harness-owned `.git`. Checkpoints use raw hash-object/update-index/commit-tree plumbing without filters,
hooks or inherited credential environment. Dirty checks use one filter-neutral `git status --porcelain=v2`; object reads are
streamed through one `git cat-file --batch`. Tests/specs/CI paths are additionally rejected at checkpoint and seal validation;
the default heuristic covers `test`/`tests`/`spec`/`specs`/`__tests__`, `*.test.*`/`*.spec.*`, `*_test.go`, `*_test.py`/
`test_*.py`/`conftest.py`, manifests and lockfiles (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`),
jest/vitest/playwright/pytest configuration, CircleCI/Travis/Azure/Buildkite/GitLab/Jenkins and `Makefile`. **The planner must
list any other file the acceptance command depends on**; the default is a heuristic, not a proof of isolation. A dirty checkout
cannot seal or run a gate, so the executor commits uncommitted work through the same harness checkpoint (and its
refusals) before a `verify` action or a handoff, records an `auto_checkpoint` note and tells the model
(`autoCheckpoint: true`). Untracked build or test output that is not ignored is committed too, and under a protected path it
stops the run as `protected_path`. A tree still dirty right after that checkpoint stops once as
`checkout_dirty_after_checkpoint`. Gate evidence is bound to a head and a new head reopens every item, so `verify` re-runs the
gates of an item's not-done dependencies first, in dependency order; an unknown id or an item already done at this head is
answered to the model instead of stopping the run (an item counts as done only on a clean tree: work written after it passed is
checkpointed first and reopens it). When every item was done and a handoff checkpoint reopens them, the final gates run again
at the new head, and the next cycle gets an `open_issue` note that the harness made that commit. A verify result leads with its
verdict (`item`, `ok`, `failedAt`) before the gate outputs, so a bounded result never cuts the answer.

Gates materialize raw objects without archive attributes, `.git` or untracked files, restore planner-owned
protected paths from the base revision and run acceptance argv in K4 Read-only mode.
Linked/gitlink trees are refused before preparation. All done evidence is invalidated
when HEAD changes, and final acceptance rechecks every item at the final HEAD.
A bundle is refused if reachable objects contain a registered secret; compressed bundles
are never scrubbed in place. The host must assign an isolated worktree/root and immutable
sandbox policy; external processes changing that tree are outside the single-writer model.

## Schema and recovery

Relay migration **35** uses its independent `relay_migrations` ledger in the node database;
F1 owns **34** in its federation ledger. The global migrations 1–31 and `user_version`
remain unchanged. Additive tables are `relay_runs`, `relay_notes`, `relay_seals`; notes and
seals have append-only triggers. Failed DDL rolls back. Keep SQLite and WAL in the stopped
node backup. Prefer a forward fix; rollback uses the pre-upgrade backup, without deleting
run evidence. No owner data, installed models, provider network or third-party source copies
are used by R2 tests.

## Opt-in judge cascade and delegation brief (R3 foundation)

A trusted internal host may supply `RelayInput.cascade` (executor optional argument nine, after
`judgeSignals`). Absence creates no R3 tables and preserves prior execution. This is an opt-in
fixture foundation, not an activated product judge/routing policy: real ADR-0025 paired benchmark
evidence is still required. No public route accepts callbacks, inventory facts or model authority.

The immutable version-one brief binds the exact plan and caps to a run and its current attempt
fence before cycle work. It records objective/DoD, estimates, constraints, resources, model roles
and fallback/quota policy, checker pin, judge limits, requested wake policy and report shape.
The brief is copied and deeply frozen; it does not authorize filesystem/network/model effects
by itself. Exact replay is idempotent; changed plan/caps/brief conflicts. Session choice precedes
project choice and policy selection. Hard local-placement/consent filters cannot fall through
a denied explicit selection. Automatic selection requires fresh host-supplied validated calibration,
never a fabricated success probability or fixture prior. Live inventory collection is not included.

Independent ledger 38 shares SQLite with R1/K2 without changing main user_version or existing
ledgers. Each request binds run/attempt/epoch/token/cycle/phase/layer/reason/brief hash and a
harness-evidence digest. Prepare, dispatch reservation and outcome are separate fenced atomic
commits. Exact duplicates never dispatch again; conflicting evidence refuses. Failed/unknown
dispatches retain their worst-case token/money debit. R3 reservations also count in relay caps.
J3 has per-run and account/local-night call/token/money limits, normally at most three strong
reviews; an explicit recorded policy override is required to exceed three. An account's persisted
timezone/night-start anchor prevents another run selecting a different night namespace. This is
accounting, not a real price/usage or calibrated quality claim. Lost-attempt pending requests are
abandoned on reconstruction; no checker/inference automatically resumes after restart.

At cycle start and before sealing, optional J1.5 verifies a lead-owned base/path/content digest
and passes copied verified bytes to a T0 read-only supervisor with explicit timeout/output policy.
No concrete production checker supervisor is included; the host must enforce its declared sandbox
and confirm actual process settlement. A mismatched pin invokes zero checker bodies. J2 uses
exactly two or three fresh tool-free samples with strict taxonomy/verdict/existing-evidence refs
and a non-authoritative diagnosis. Executor claims are quoted untrusted data. Disagreement,
invalid output and missing facts remain explicit; no calibrated confidence is inferred. J3 is
requested only for flagged/probe/final cases and cannot pass an item or override a failing gate.
Three unavailable cycles request one existing R1 parent escalation; multiple phases/samples in
one cycle count once, and a valid J2 resets the streak. Existing hard/probe/no-progress guards stay.

Read-only observation/admission waits may abort-race with late outcomes consumed. Active checker
and model adapters must abort and await actual owned-resource settlement, rather than treating
timeout as cleanup. Every callback boundary has pre/post R1 checks; stale results cannot update
a later cycle or wake a newer attempt. Judge refs enter the next safe ledger snapshot, preserving
sealed ledger/handoff hashes. Completion wake intent may say defer-until-08:00, but current R1
completion still wakes immediately: durable night scheduling is explicitly unfinished.

`ConnectionJudgeModel` uses public K3 with the actual T0 owner account, an exact rendered token
meter and a fresh trusted installed-local digest/consent observation. Local_runtime alone and
model suffixes are insufficient; no API/cloud fallback exists. It does not discover an installed
model or enable inference at plugin load. **Activation dependency:** the current K3 client may
settle an aborted model POST before its injected fetch settles and release its governor permit
early; a separately owned client fix must prove POST/body local settlement and preserve the
after-version final-preparation fence. This adapter has positive fake K3 construction/account/
scrub checks, but active-transport cancellation is not earned until that fix merges. Awaited
local fetch settlement also cannot prove a backend stopped inference.

No real model, paid provider, remote host, toolful F2 workspace bridge or live policy activation
is included. Monthly owner-labelled judge calibration, precision >=0.8/recall >=0.9, >=20-run
ETA P80 coverage 0.7–0.9, B3 quality gates, operational night wake and the >=6-hour MS1 envelope
remain unearned.

## Remote relay runtime (F2-d)

`RemoteRelayRuntime` (`remote-runtime.ts`) is a `RelayRuntimeObserver` factory for a llama-server on
**another owned node**. `RelayRuntimeSource` asks it for one session per start (`open()`); the
session is the observer, the exact counter and the chat transport, and it binds every request to the
relay run and its fence: `prepareBind` (awaited before the run is created) asks the executor to pin the relay run with a
signed message, and `bind` (inside the creation transaction) attaches the attempt without any remote write. Facts come only from the executor's signed evidence (see the
[remote attempts README](../remote-attempts/README.md#relay-inference-on-another-node-f2-d)). There
is no byte count, catalog value or local-runtime fallback: an unreachable, unsigned, unpinned or
mismatching executor is `runtime_meter_unavailable`, `runtime_identity_unknown`,
`runtime_identity_changed` or `runtime_counter_mismatch`, and the home never evaluates a request.

**Pin lifetime (F2-reap).** The executor's `relay:<run>` pin must not outlive its run, including when the home dies. Four rules
keep that true without a second holder of anything (ADR-0018): (1) the home writes its own durable journal row
(`federation_relay_pin_journal`) *before* the signed pin leaves, and deletes it when the executor acknowledges the signed
`unpin`; (2) `Federation.reconcileRelayPins()` sends a signed, fenced `unpin` for every journal row that no session of this
process still needs (after a crash that is every row; a live session is registered in memory in the same synchronous step as
its journal write, so a fresh start cannot be mistaken for an old row), at construction and then every
`dispatch.relayPinMaintenanceMs` (60 s; `0` disables), and a session whose `close()` could not reach the executor leaves its row
to the same reconciliation; (3) the unpin is fenced by the run id and epoch: a pin bound at another epoch is not removed; (4) the
executor leases each pin (`relayLimits.pinTtlMs`, 10 minutes by default), renewed by every valid observe/count and by the live
session's heartbeat (`pinRenewMs`, 60 s, the same idempotent signed pin). A lapsed or lease-less relay pin is deleted on the
executor's own transaction, lazily before every relay request and by its maintenance timer. A lapsed pin only removes a
permission, so a home that is alive but partitioned for longer than the TTL simply re-pins with its next heartbeat, if the
cap allows. Federation **1.5** gates this: an executor refuses (`426`) pin and unpin messages from a home that declares an older
minor, because such a home never renews. A released run id is tombstoned on the executor for one TTL, so a pin or heartbeat that is
slower than the home's own 5 s bound cannot re-create a pin after its unpin. Leases run on the lease clock (the monotonic-anchored
`dispatch.leaseClock`), and an executor restart grants every relay pin one fresh TTL before anything can be swept. The home cannot see the executor's TTL: keep `pinRenewMs` well under `pinTtlMs`, and note that an executor clock jump
or suspend longer than the TTL lapses a live run's pin (the run's next call is `runtime_identity_unknown`, the next heartbeat
re-pins). A journal row for an executor that refuses permanently (another model, no relay runtime, no longer trusted) is retried
every pass and never given up; the executor's lease still frees its pin. Tests: `test/relay/pin-reaping.test.ts` and the pin lines of `test/ms1/rehearsal.test.ts`.

**Asynchronous exact count.** The R2-op `Atomics.wait` bridge is not used over F2: the signing key
and transport live on the main thread, and blocking the home event loop for a network round trip
would also stop the lease renewals that keep the fence alive. The meter gains `countAsync`;
`budget.request` is one generator driven synchronously (local meters, identical behaviour) or by
`requestAsync` (remote). The synchronous `count` K3 needs in `onPrepared` is a lookup of exact answers
already obtained for the identical bytes and refuses on a miss. The answers belong to one served
identity and are dropped when it changes.

**Dispatch.** `LocalChatTransport.remote` (K3) lifts the loopback requirement and the home permit:
the executor's own governor admits the call through its F2 reservation. The final scrub, fence check,
fenced start observation and the signed dispatch request share one synchronous stretch
(`FederationChannel.dispatch(grant, beforeSend)`); while a call is pending the transport heartbeats the
fence so a lost relay attempt aborts and cancels it. A judge on such a meter is described in
[the next section](#judge-on-the-public-start-and-on-a-remote-runtime-r3-remote).

## Judge on the public start and on a remote runtime (R3-remote)

`RelayStartHost.judge` (`judge-start.ts`) carries the R3 judge into `RelayStarts`, local or remote. It is a
T0 source function called **once per start** with that start's input and policy, the guarded meter the relay's
own calls use, and the admitted runtime facts. It returns `{ signals?, cascade? }`: the existing
`RelayJudgeInput` (J0/J1 signals, needs no model) and `RelayCascadeInput` (delegation brief, judge model,
optional checker). Nothing of it is wire input. `RelayConfig.judge` is the plugin-level default, used only
when the start host has no `judge` of its own (`startHostWithJudge`). No source, or a source that returns
nothing, leaves that start exactly as before: no judge event, no judge call, no judge ledger.

**Fail closed before the pin and the run exist.** The source runs after the runtime is admitted and the checkout is
allocated, and before the signed pin, the run or its session exist (the checkout is released like any other
refusal). The signals policy, the brief (`copyBrief` against the start's plan, caps equal to the start's caps), the
model shape and, for a runtime that counts through its own transport, the brief's J2/J3 roles (they must be the
relay's own connection and model) are validated there, and the executor, which opens the additive judge ledger 38,
is built there. Any failure, including a source that throws or returns a promise, refuses the start with the one
public code `judge_config_invalid`. The judge ledger tables are additive and may remain after a later refusal
(pin, abort); a run, session or pin never do.

**Signals.** `ledgerJudgeInput(policy, clock)` is a ready collector that reports what the relay ledger holds
(cycle, no-progress streak, wall deadline) and leaves heartbeat, lease, disk and the per-item token budget
unknown, never healthy. The ledger has no repeated-failure, edit-revert, dead-end, crash, protected-path or
per-item token facts; the observation shape requires a value for them, so they are zero or empty and the collector
declares them in `RelayJudgeInput.unobserved`, which adds `failureStreak`, `editRevert`, `deadEnds`, `pathEdits`,
`crash` and `itemTokens` to the `unknownFacts` of every published observation and of the J2 packet. This
collector can raise only `no_progress` and `deadline`; a host that observes more supplies its own collector. A
collector that fails keeps its existing rule (fixed `judge_observation_unavailable`, run `input_required`,
ledger retained).

**Judge model on a transport meter.** `ConnectionJudgeModel` takes a `runtime` binding
`{ connectionId, model }`. A meter that carries a `transport` (llama-server, remote node) is accepted only
with that binding. With a binding, whatever the meter, the judge role must be exactly that connection and that
model string (the string the relay itself sends); another spelling or runtime is `judge_config_invalid` at
admission. The judge never leaves the runtime that counts: the prompt is pre-counted with the
meter's `countAsync` when it has one (the remote count is a signed round trip, and `meter.count` is then a
lookup of that answer), the request is dispatched through `meter.transport` itself with `think:false`, the
meter's `authorizeDispatch` re-observes the runtime first, `onPrepared` pins the exact request K3 hands back (model,
options, shape) and the count, and the result must echo the counted input tokens. A meter with `countAsync` and no
transport (counted by one runtime, dispatched on another), a transport without a binding or an inexact
meter is `judge_config_invalid`. `meter.validatePrepared` is not used for the judge: it pins `num_predict`
to the relay turn, and the judge has its own output ceiling. `relayJudgeModel(context, ...)` builds this model
from a start's context; `relayRuntimeAttestor` attests it from a fresh observation of the runtime, and only for
the relay's own connection and model. A host that wants a different judge model on a stock Ollama relay builds
`ConnectionJudgeModel` itself, without a binding. The role's `temperature` is not sent to a llama-server
runtime (its client posts only the prompt and the output limit), so the samples of one boundary are drawn with the
server's own sampling and the cascade's "agreement" is only that.

A judge on any relay runtime (a binding, or a local-only exact meter, which includes the stock Ollama relay) asks it in
the form the relay's own calls use: `think:false`, a fresh runtime observation (`authorizeDispatch`) before the dispatch,
and the request pinned exactly (model, options). A thinking model evaluates a request without `think:false` in another form
than the one the exact counter rendered, which would be `judge_usage_invalid` after paid inference.

**Age and time limits.** One admission (the attestation and the loaded window) serves every sample of a request. Past half of
`maxAgeMs` it is observed again before the sample and again right after the dispatch authorization, so a runtime whose samples
each take longer than `maxAgeMs` is not refused on its own admission's age; a refresh that finds another loaded window or
another model identity is refused. Each refresh is one more observation (a signed round trip on a remote runtime). A sample
also has a wall limit (`role.sampleTimeoutMs`, default `DEFAULT_JUDGE_SAMPLE_TIMEOUT_MS`, 5 minutes) that aborts the same
signal the owner's cancel does, so the runtime is stopped and acknowledged first and the verdict is `unavailable` with
`judge_sample_timeout`; without it a stuck executor holds a cycle for the call deadline of its runtime (30 minutes a call).
The relay `maxAgeMs` must still be longer than the observations themselves.

**Billing.** A remote judge sample is one more per-call child run on the relay's session, so the
executor-reported tokens land on that child's R1 ledger atomically with its terminal (F2-c), apart from the
relay run's own rows and from the lead. The relay run's `run_costs` never include judge calls. The relay caps
see the judge only through the cascade's existing pre-debit (`tokenReserve` per sample, never settled to
actuals), so a judged relay reaches `caps.tokens` earlier than the same relay without a judge, and the wake
packet's token metric includes that reserve. The two views are never summed. A judge on a local relay (Ollama or a
local llama-server) has no child run: its usage is K3's usage record plus the same pre-debit.

**Degradation.** Unchanged cascade rules: an unavailable, invalid or inconsistent judge gives a verdict row
(`unavailable`, `invalid`), never an item marked done and never a stopped run. A cancel during a judge call
waits for the executor's acknowledgement like any remote call, and the request stays `dispatched`
(the revoked fence cannot append an outcome) until a later judge ledger opening abandons it. A run lost with
its process never replays a judge call.

**Not covered.** No real model, no Fedora run, no calibration, no checker supervisor, no durable night
wake; a remote judge call costs a signed round trip pair per sample on the executor (two samples at each of
two boundaries per cycle by default).
