# R2-json — constrained JSON output for relay calls on llama-server: plan

**Status:** plan, written before the code · **Date:** 2026-10-23 · **Branch:** `claude/relay-structured-output`
(base `536cad90` plus the integrator commits `705bae3b`, `cba2c638`, `6b4cd329`). Lane clone
`/Users/yuzuru/Projects/Guanxi-lanes/structured`, ports 5237/4437, Node 26, Mac only. No push, SSH, live model, secret or
`~/.guanxi`.

## Outcome and non-goals

The first real two-host runs (Qwen3.8-27B, llama.cpp b11496) never reached a verified item because the model's JSON was
malformed or the tool loop starved. Outcome: every relay reply that must be JSON is decoded under a JSON Schema on
llama-server, locally and through the F2-d remote path; `file_read` can page; the probe prompt states what it asks.
Non-goals: constraining the narrative; provider (`model_api`) structured output (unchanged); changing any gate, cap or check
(the probe is not made easier); a live llama-server run (the integrator validates on Fedora).

## Facts that decide the design

- Integrator check on the real b11496: `POST /completion` with `json_schema` (`const`, `enum`, `required`,
  `additionalProperties`) returns conforming JSON and `tokens_evaluated` is unchanged by the schema. The field is exactly
  `json_schema`; prompt counting and the rendered-hash chain stay valid.
- `OllamaChatRequest.format?: 'json' | Record<string, unknown>` already exists. K3 `localChat` scrubs the whole request and the
  transport's `prepare()` runs `onPrepared` on the clean copy; `LlamaServerRuntime.chat` already requires the final `prepare()`
  to equal the first (`runtime_request_changed`). `format` therefore rides the existing pinned path: no new request channel.
- Zod is 3.25 (v3 schemas), so `z.toJSONSchema` (v4) cannot convert them; `ajv` is only transitive. A small converter for the
  used subset is written in the repo, with no dependency and no third-party code.
- Tool parameters are typebox objects, which already are JSON Schema (`required`, `properties`); the tool list comes from
  `nativeTools`, the same list `tool()` executes.
- The unquoted-key replies copy the prompt: `WORK` shows `{action:tool,name,args}`. The probe fails on `nextItem: null`
  because the handoff `strip` calls another item `next` while the probe's `nextItem` is the strip's `current`.

## Design

1. **Carrier.** `RelayModel.call(..., { responseSchema })` puts it into `OllamaChatRequest.format` for `local_runtime`
   connections (`model_api` ignores it). `RuntimeMeter.validatePrepared(request, responseSchema)` pins the request to
   `render(prompt, schema)`: another schema is `runtime_request_changed`, as another prompt is. `LlamaServerRuntime.chat` sends
   `json_schema` (`LlamaServerClient.complete(..., { jsonSchema })`) and refuses a `format` that is not a JSON object.
   The judge's own request check (`ConnectionJudgeModel`) pins `format` the same way.
2. **Schemas** (`relay/json-schema.ts`, `relay/response-schemas.ts`). Converter: object (strict becomes
   `additionalProperties:false`), string, number/int, boolean, literal (`const`), enum, nullable, optional, array, record
   (`unknown` value is `{}`), union, discriminated union (`anyOf`), unknown. Anything else throws at construction. Action schema =
   `anyOf` of one variant per available tool (`name` const, `args` = that tool's parameters) plus the non-tool actions converted
   from the existing Zod `actionSchema`, so the Zod validator stays the single source. Probe schema: five required keys, `nextStatus`
   an enum of the ledger statuses or null; the expected values are never in the schema. Judge J2/J3: the existing `resultSchema`.
3. **Remote (F2-d).** The schema is part of the signed job: `LocalInferenceJob.responseSchema` (so of `jobHash`) and of the counted
   chain, `CountedRequest.responseSchemaSha256` (SHA-256 of the federation-canonical schema). The executor checks job and counted
   evidence agree, `expectedTransport` checks the hash of the `format` it actually evaluates, and the terminal event echoes
   `responseSchemaSha256`, which the home compares with what it sent (`truncation_protocol`). Federation **1.6**
   (`RELAY_STRUCTURED_MINOR`): a home that declares an older minor cannot send a schema (executor 426); an executor older than 1.6
   is refused by the home channel (426) instead of ignoring the schema. Old peers still interoperate without schemas.
4. **Tool UX.** `RelayWorkspace.tools()` lists exactly the model-callable native tools with their parameters. `file_read` gets
   `offset` (byte offset, UTF-8 text; documented) and returns `{more, nextOffset, offset, ...}` (superset of the old result;
   `stdout` stays last, so a cut keeps the cursor). The relay passes a page budget = the executor's per-turn bound (`hard/4`), so
   a page is never silently cut by the executor; `tool_output_read` honours the same budget. The `WORK` prompt is generated from
   the tool list (`name(arg, arg?)`), uses valid JSON examples, and says once that arguments are strings and that results with
   `more` continue at `nextOffset`.
5. **Probe prompt.** Names what each key is (`ledgerHash`, `head`, `revision` from the handoff; `nextItem` the strip's `current`:
   the first open item whose dependencies are not open; `nextStatus` its status in `open`). Same check, same inputs.
6. **Switch.** `RelayLimits.structuredOutput` (default true) turns constraint off for a runtime that rejects the grammar.

## Affected contracts, stores, components

`packages/contract` federation (job, counted, terminal, version 1.6); `relay/{model,runtime,executor,start,judge-model,
judge-cascade,workspace,types}`, new `relay/{json-schema,response-schemas}`; `runtime/llama-server/{client,runtime}`;
`remote-attempts/dispatch`, `federation/{channel,service}`; `native-agent/{tools,outputs}`. No migration (job rows are JSON), no
dependency.

## Risks

Real-server behaviour of `anyOf` grammars is not validated here (integrator on Fedora); `format: object` on stock Ollama passes
through unchanged. A grammar that cannot be built is a server error and surfaces as `model_failed` with `call_failed_reason`.
A schema larger than the signed message budget is refused at the job schema (64 KiB). K4 `file_read` output gains fields only.
ADR-0025: the prompt edits (WORK, probe) are minimal and factual; the B1 bench is pending and the hand-off says so.

## Test matrix

Fake llama-server records the exact body. Fixture model returns every bad shape unconstrained and valid JSON when a schema
arrives. Tests: converter conformance (mini validator); action/probe/judge schemas; client body; runtime pin (`format` change,
non-object); K3 relay end to end; F2-d (schema in grant, `expectedTransport` mismatch, terminal echo mismatch, 1.5 peers);
`file_read` paging and relay page budget; WORK/probe prompt text. Existing relay, rehearsal and ms1-live suites stay green.

## Commands

`npm run typecheck`, `npm run lint:md`, `npm run check:licenses`, ESLint on changed files, then through `agent-dev`:
`npm run test` and `npm run build` (G12 may need `GUANXI_UI_G12_BASE=refs/remotes/origin/main`).
