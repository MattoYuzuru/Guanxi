# R2-json — constrained JSON output for relay calls on llama-server: hand-off

**Status:** implemented and independently reviewed candidate; fixture-validated only (fake llama-server, in-process nodes, two real
processes in the ms1-live suite). **Date:** 2026-10-23 · **Branch:** `claude/relay-structured-output`, lane clone
`/Users/yuzuru/Projects/Guanxi-lanes/structured`, base `536cad90` plus the integrator commits `705bae3b`, `cba2c638`, `6b4cd329`; main
`cc2f80f6` merged. Ports 5237/4437, Node 26.9, macOS only. No push, SSH, live model, secret, `~/.guanxi` or `~/ms1` was used.
`PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are untouched. No migration, no dependency, no third-party code. Plan:
[R2-json.plan.md](R2-json.plan.md). Design and operator notes:
[relay README, constrained JSON output](../../../packages/server/src/relay/README.md#constrained-json-output-r2-json).

## What changed

- **Constrained decoding.** Probes, work actions and judge J2/J3 verdicts carry a response schema from `RelayModel.call` to
  `OllamaChatRequest.format`, through K3 `localChat` and `LlamaServerRuntime.chat` to `LlamaServerClient.complete`, which sends it as
  `json_schema` on `/completion`. The narrative stays prose. A `model_api` connection ignores the schema; a stock Ollama receives it as
  `format`. The schema never changes a counted prompt token.
- **Pinned, locally and remotely.** `meter.validatePrepared(request, schema)` makes a different schema `runtime_request_changed`; the judge's
  request check pins `format` (`judge_request_shape`). On F2-d the schema is in the signed job (`LocalInferenceJob.responseSchema`), in the
  counted chain (`CountedRequest.responseSchemaSha256`), in the executor's `expectedTransport` check and in the signed terminal echo
  (`responseSchemaSha256`), which the home compares with what it sent.
- **Schemas.** `relay/json-schema.ts` converts the Zod subset in use (no dependency; anything else throws `json_schema_unsupported`).
  `relay/response-schemas.ts`: the action schema is an `anyOf` with one variant per tool the workspace lists (`name` const, `args` that tool's
  own parameters) plus the non-tool actions converted from the Zod `actionSchema` that still validates the reply; the probe schema has five
  required keys, `nextStatus` an enum of the ledger's non-done statuses (tied to the type at compile time); the judge verdict is the converted
  `resultSchema`.
- **Tool UX.** `RelayWorkspace.tools()`; `file_read` takes a byte `offset` and returns `more`/`nextOffset`; the executor passes
  `pageBytes = floor(T_hard/4)` (its per-turn bound), so a page is never cut behind its cursor; `tool_output_read` honours the same budget.
- **Prompts (ADR-0025).** The work prompt is generated from the tool list and shows valid JSON (the model had copied
  `{action:tool,name,args}`); the probe prompt defines each key (the `nextItem: null` answers followed the strip's `next` field, another item,
  beside the probe's `nextItem`, which is the strip's `current`). The check, its inputs and its expected values are unchanged. **The B1 bench
  does not exist yet: neither prompt edit carries a bench result.**
- **Switch.** `RelayLimits.structuredOutput` (default true), `home.structuredOutput` in `ms1-live.json`; `preflight` fails with
  `peer_protocol_old` when the grammar is on and the executor declares federation below 1.6.

## Exact llama-server request body produced

```json
{"prompt": "<rendered, counted string>", "n_predict": 4096, "stream": false, "cache_prompt": true,
 "json_schema": {"anyOf": [{"type": "object", "properties": {"action": {"const": "tool"}, "name": {"const": "work.query"},
   "args": {"type": "object", "properties": {"offset": {"type": "string"}}, "additionalProperties": false}},
   "required": ["action", "name", "args"], "additionalProperties": false}, "..." ]}}
```

`n_predict` is the relay's turn reserve; `cache_prompt` is `true` unless `LlamaServerClient` is built with `cachePrompt: false`. The narrative
call has the first four keys only. The probe call's `json_schema` is
`{"type":"object","properties":{"ledgerHash":{"type":"string"},"head":{"type":"string"},"revision":{"type":"string"},"nextItem":{"anyOf":[{"type":"string"},{"type":"null"}]},"nextStatus":{"anyOf":[{"enum":["open","verification_requested"]},{"type":"null"}]}},"required":["ledgerHash","head","revision","nextItem","nextStatus"],"additionalProperties":false}`.
The unit test `test/llama-server/client.test.ts` asserts the integrator's own probe shape (`const`, `enum`, `required`, `additionalProperties`)
key for key: `{prompt, n_predict: 60, stream: false, cache_prompt: false, json_schema}`.

## Protocol and version changes

Federation **1.6** (`FEDERATION_VERSION`, `RELAY_STRUCTURED_MINOR`). Additive and optional: `LocalInferenceJob.responseSchema` (object, at most 64 KiB,
only on a counted job and only together with `counted.responseSchemaSha256`), `CountedRequest.responseSchemaSha256`, terminal
`responseSchemaSha256`. An executor refuses (426) a schema from a home that declares below 1.6; the home channel refuses (426) to send a schema to an
executor that declares below 1.6. Jobs without a schema are byte-for-byte what they were. The federation channel now sends a body as the sender built
it instead of the sorted form (the request proof signs the sorted hash, so authentication is unchanged): a schema's property order is the
order a grammar writes a reply in. **Both nodes must run this commit for a constrained run** (or set `home.structuredOutput: false`).

## For the integrator: Fedora validation

Not validated here (no live server): (1) that b11496 builds a grammar from the `anyOf` of eighteen object variants (the integrator's probe covered
`const`, `enum`, `required`, `additionalProperties`, not `anyOf`; the variant list is about 4.4 KB); (2) the optional-argument objects
(`offset`) and `properties: {}` with `additionalProperties: false` (`project_info`, `attachments`); (3) generation speed under the grammar on the
RTX 3060; (4) that `tokens_evaluated` equals the count with a schema present (the integrator measured 10 with and without). If the grammar is
rejected, set `home.structuredOutput: false`; the failure is `response_schema_rejected` and the cause is only in the llama-server's own log (no server text is kept by Guanxi); the run then behaves as before this lane.

## Gates

Mac, Node 26.9.0, shared lock resource `heavy`, clean tree at `b4dbea35` (main `cc2f80f6` merged, no conflicts). The UI gate G12 used
`GUANXI_UI_G12_BASE=refs/remotes/origin/main`.

| Gate | Result |
| --- | --- |
| `npm run typecheck` (all workspaces) | pass, exit 0 |
| ESLint on every changed `.ts` (`6b4cd329..HEAD`) | pass, no output |
| `npm run lint:md` | pass, 290 files, 773 links |
| `npm run check:licenses` | pass, 675 packages, 0 not allowed |
| `agent-dev … npm run test`, receipt `check-y5lb40fl` | exit 0: `test:core` 2935 tests, 2933 pass, 0 fail, 2 skipped (the two pre-existing Linux-only tests); codemods 6; web 659; ui, ui-gates, kernel and bench stages 0 fail (several counts are masked in the log by the scrubber) |
| `agent-dev … npm run build`, receipt `check-isr9tg2h` | exit 0 |
| Targeted, before the review round | 852 tests, 0 fail, 1 skipped (relay, llama-server, federation, native-agent, ms1, ms1-live, remote-attempts, connections) |

**New: 38** test cases = `json-schema.test.ts` 8, `structured-output.test.ts` 5, `structured-llama.test.ts` 2, `structured-remote.test.ts` 6,
`file-read-paging.test.ts` 6, `preflight-protocol.test.ts` 1, and ten cases added to existing files (llama-server client, runtime and
expected-transport; judge model and cascade; ms1-live config and boot; relay model and workspace). **Regression envelope:** the rest of the core
run (2935 - 38 = 2897 cases). Existing tests changed: `pin-reaping.test.ts` (the handshake minor, 5 to 6) and `context.test.ts` (see below);
helpers `fake-llama-server.ts`, `remote-fixture.ts`, `fixture.ts` gained optional members.

Commands run from the repository root (some fixtures use `process.cwd()`); the `sealing.test.ts` failure seen when a file list is run from
`packages/server` is that, not a regression.

## Properties and their failing-when-violated probes

Each mutation was applied to the source, the named files run, and the source restored (from a copy, not `git checkout`). All were caught.
Request path: relay model drops `format`; meter ignores the schema; runtime does not send `json_schema`; client omits it or sends `null`;
`expectedTransport` skips the hash check; `format: 'json'` accepted. Remote: executor skips the chain binding; does not pass the schema to the
request; does not echo it; home skips the echo check; home puts no schema in the job; home channel and executor service do not gate on 1.6;
channel sorts the wire body; home stores a sorted job; counted content budget ignores the schema. Executor: no probe schema; no action
schema; the narrative constrained; the switch ignored; no page budget. Prompts: the old probe wording; unquoted examples. Judge: model drops
`format`; model does not pin `format`; cascade asks for none. Switch wiring: the start host ignores `home.structuredOutput`; preflight allows an old
executor. `file_read`: `nextOffset` ignores the page; offset ignored; no budget fit; hex offsets accepted; cursor over redaction; no cut before an
invalid byte; no `od` check (two mutants); zero-progress page (file and artifact); `tool_output_read` ignores the budget; the workspace lists `plan`.
Compile-time: a status added to or dropped from the probe enum fails `tsc`.

## Independent verification

`sde-agent:implementation-reviewer` (read-only) reviewed `6b4cd329..023e25b1`. **P1 fixed** in `2d70f507`: `home.structuredOutput` never reached the start
host in the real boot (`index.ts` read only reserves, allocate and runtime of the pairing's relay options); a boot test now asserts it, merged under
`relayHost.limits`. **P2 fixed:** the federation channel and the stored job text sorted a schema's keys (`args` before `name`); `file_read`
cursors were wrong after redaction or an invalid byte, and a real U+FFFD at a cursor was refused as `invalid_offset`. **P3 fixed:** a budget below one
character returned an empty page; the content budget ignored the schema; the probe enum was not tied to the ledger type; preflight did not report
an old executor; `model_api` ignoring the schema and `GitRelayWorkspace.tools()` had no direct test. **Judged legitimate:** the `context.test.ts`
fixture resize (the work prompt grew; the test now derives the size of a tool turn from the prompt and asserts its own preconditions).
Left as is: the 426 for an executor older than 1.6 arrives after the offer (cleaned up by `stop()`; `preflight` is the early signal).

## Fix round after the integrator's Opus review and the first Fedora smoke

Each item is its own commit with a test that fails without it. (The coordinator's real smoke on `4178dff0` showed every action valid JSON and
`file_read` paging working; the 18-variant schema was accepted by b11496 in 5 s.)

- **`runtime_observation_stale` (found by the smoke).** Confirmed: `RelayExecutor.call()` counted the request before `model.observe()`, and the
  packing in the work loop, the probe retry and the narrative counted against the observation taken before the previous call, which had taken
  minutes. Every count site now follows a fresh observe (`fresh()`; window unchanged); dispatch still observes again itself.
  Tests (`observation-age.test.ts`, a clock where each call takes two minutes; synchronous and asynchronous exact meters; a second probe attempt)
  fail without it. Scan of the other places: the judge path re-observes past half its age (existing tests); verify and checkpoint are followed by
  the work-loop `fresh()`; `maxCostMicros` and `validatePrepared` run right after the count. The `fresh()` inside `call()` is defensive
  (callers observe just before); its removal survives the tests by design.
- **Rejected schema reported as an identity change (P2).** `llama_server_schema_rejected` (4xx/500 on `/completion` with a schema) ->
  `response_schema_rejected`; K3 keeps a trusted transport's fixed code as `ConnectionError.reason`, so the `call_failed_reason` note, the signed
  terminal reason and the run's error carry it, and the run stops there instead of `probe_failed_twice`. No server text is kept anywhere (the
  earlier hand-off line about reporting the server's message is corrected: the cause is in the llama-server's log). `preflight --completion`
  sends the probe, work and judge schemas with `n_predict: 1` (check `schemas`).
- **`file_read` redaction and U+FFFD (P3 1, 2).** The check is per page (a page ends in front of the first redacted region or foreign
  character), a real U+FFFD is kept when `od` shows the file holds it, and the unbudgeted K4 read of a large file is an artifact again, with a
  `null` cursor where it cannot be trusted.
- **Judge fence handling (P3 4)** now has a test that fails if the cascade goes back to `JSON.parse`. **Prompt example path (P3 5)** is the
  placeholder `PATH`. **Notes (P3 3, 6)** on the order-preserving schema digest and the stock-Ollama judge `format` are in the relay README.

Gates after this round, clean tree at `ab9e329f`: typecheck, ESLint on every changed `.ts`, `lint:md` and `check:licenses` pass; targeted run
(relay, llama-server, federation, native-agent, ms1, ms1-live, remote, connections) 862 tests, 0 fail after one existing test was rewritten (below);
`agent-dev … npm run test` receipt `check-t4jswtri` exit 0 (core 2944 tests, 2942 pass, 0 fail, 2 skipped, the same two Linux-only tests);
`agent-dev … npm run build` receipt `check-bogk1a1a` exit 0. The earlier receipts (`check-y5lb40fl`, `check-isr9tg2h`) are superseded.
The operational test that expected the run to stop when the clock passed the observation age during a call asserted the very failure the
smoke hit; it now asserts that a refreshable observation continues (and re-reads `/props`) and an unrefreshable one (the server answers as
another model) still dispatches nothing more.

Updated mutation list: the above all caught, plus `redaction check whole window`, `no FFFD byte verification`, `FFFD always trusted`,
`no-budget cursor kept`, and each observation site except the defensive one in `call()`.

## Residual risk

1. No real-server run of the grammar (above). The schema is large for a grammar; if generation is slow, a smaller variant set (only the tools the
   plan needs) is the next step, and it is a prompt/schema change that needs the B1 bench.
2. `file_read` pages are byte positions; a registered secret or an invalid byte in the page makes it refuse the cursor
   (`page_cursor_unavailable`). A model then reads the rest with `shell` (`tail -c`, `head -c`).
3. `tool_output_read` offsets are in the scrubbed artifact, as before.
4. The prompts are unbenched (ADR-0025).
5. Grammar-constrained output cannot fix a wrong choice: a tool the model should not call is still callable; `verify` item ids are strings, not an enum.
6. A `model_api` lead or judge is not constrained.

## Shared edits

Contract (`federation/index.ts`: minor 6, job, counted, terminal); F1 `channel.ts` (gate, body text) and `service.ts` (gate); F2-b `dispatch.ts`;
R2 seams (`executor`, `model`, `runtime`, `start`, `types`, `workspace`, `remote-runtime`, `judge-model`, `judge-cascade`); R2-op
`runtime/llama-server/{client,runtime}.ts`; K4 `native-agent/{tools,outputs}.ts` (`file_read` fields, page budget) and its README; MS1-live
`config.ts`, `boot.ts`, `preflight.ts`, `index.ts` and the runbook. Test helpers: `fake-llama-server.ts` (a reply can depend on the request body),
`remote-fixture.ts` (`responseSchema` in `call`), `fixture.ts` (`plan`, `tools`).

## Next slice

The Fedora run with `home.structuredOutput` on; then, depending on speed and quality, a plan-scoped tool list in the schema, an enum of plan
item ids for `verify`, and the B1 bench result for the two prompts.
