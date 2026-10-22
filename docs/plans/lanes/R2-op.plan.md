# R2-op — operational local runtime: implementation plan

**Status:** accepted slice plan (lane author) · **Date:** 2026-10-23 · Base `069eeb24`, branch
`codex/r2-operational-runtime`, ports 5212/4412, checkout-local `.lane-data`, Node 26.
Brief: `Guanxi-lanes/prompts/w2-r2-operational-runtime-20261023.md`. No SSH, live model,
paid call, owner Ollama store, `~/.guanxi` or secrets. No migration and no contract change.

## Outcome and non-goals

An opt-in server boot can give the R2 public start (`POST /api/relay`) a real **exact
rendered-request counter** and an **owned checkout allocator**. Without the opt-in, or when
the configured binary is absent, the existing `runtime_meter_unavailable` /
`relay_workspace_unavailable` refusals are unchanged. Non-goals: a stock-Ollama counter,
router-mode llama-server, multi-slot scheduling, UI, CLI flags, B3 quality claims, Fedora
validation, container/GPU management, a boot-time reaper for crashed checkouts.

## Facts checked before choosing (2026-10-23, this Mac)

- `/opt/homebrew/bin/llama-server` exists (build 10964, `0.4.1`). Its `--help` has **no
  `--vocab-only`** option (0 matches). `llama-tokenize` exists but only tokenizes and cannot
  render a chat template. A "vocab-only sidecar" therefore means a second full model load.
- Field names the client needs exist as strings in `libllama-server-impl.dylib`:
  `/props`, `/apply-template`, `/tokenize`, `/completion`, `/health`, `n_ctx`, `model_path`,
  `model_alias`, `build_info`, `tokens_evaluated`, `tokens_predicted`, `stop_type`,
  `truncated`, `add_special`, `parse_special`, `enable_thinking`. No live request was made.
- `RelayExactCounter.count` and the executor `Measure` are **synchronous** and called tens of
  times per request build (`budget.ts`). `ConnectionRelayModel` dispatches only through K3
  `localChat`, hard-wired to the Ollama client; the governor accepts only provider `ollama`.
- `RunningModel.source` is the literal `ollama_api_ps`; `/api/ps` is the only loaded-window
  source of the current runtime path.

## Design decision: direct llama-server runtime, not an Ollama-blob vocab sidecar

**Chosen:** a direct **llama-server runtime path**. The dispatching runtime is also the
renderer and tokenizer: `/apply-template` renders the one-message request, `/tokenize`
(`add_special`, `parse_special` true — the flags `/completion` applies to a string prompt) counts
it, `/props` gives the loaded per-slot `n_ctx`, and dispatch is `POST /completion` of exactly the
rendered string that was counted. `tokens_evaluated` must equal the counted value.

Reasons for rejecting the Ollama-blob sidecar:

1. **Divergence is unprovable.** Ollama renders with the manifest's Go `text/template` layer, not
   the GGUF `tokenizer.chat_template` Jinja. A sidecar renders the Jinja. For one user message
   with `think:false` the two can differ (default system text, BOS handling, empty think block).
   A fixture can detect a known difference but cannot prove equality for an unknown model, so the
   brief's "detect and refuse" would refuse nearly everything or guess.
2. **No vocab-only mode** in the installed binary: a sidecar loads the 30B-class GGUF again beside
   Ollama (memory doubling on a 24 GB Mac or a 12 GB GPU).
3. **A Fedora host running llama.cpp has no Ollama store.** The sidecar cannot serve it at all;
   the direct path needs only the llama-server binary and a GGUF file.
4. **Least new surface where it matters:** Ollama stays untouched and keeps refusing stock
   starts. The new code is isolated (`runtime/llama-server/`) plus three small seams:
   `RelayRuntimePolicy.observer`, `RuntimeMeter.transport`, `localChat(..., {transport})`.

Honest costs: (a) a synchronous count needs a synchronous bridge: one worker thread does the
two HTTP calls and the main thread blocks on `Atomics.wait` with a hard timeout, plus a bounded
content-hash cache; (b) the governor vocabulary is Ollama-only, so a llama-server call takes the
same single permit under provider `ollama` with a `llama-server:` model-name prefix; widening the
governor/contract vocabulary is recorded as a residual, not done here; (c) digest identity is
SHA-256 of the GGUF file named by `/props` (cached by path/size/mtime/inode), computed once.

## Components

1. `runtime/llama-server/client.ts` — loopback-only HTTP client (no redirects, no credentials,
   bounded JSON bodies, abort-aware, no retry). Typed refusal codes only; no body text escapes.
2. `runtime/llama-server/runtime.ts` — `LlamaServerRuntime`: `observe` (props + digest +
   build identity, alias must equal the requested reference), `counter` (template round-trip
   self-test, sync bridge), `transport` (re-render, re-count, compare with the synchronous
   count, refuse above `n_ctx`, dispatch the counted string, map usage to the Ollama chunk
   shape, refuse `truncated`). `runtime/llama-server/sync-count.ts` — the worker bridge.
3. `runtime/llama-server/process.ts` — boot options: `spawn` (binary, model, context, optional
   port) or `attach` (loopback base URL). Missing/non-executable binary or model file resolves
   to "unavailable" without throwing. Spawn uses a fixed argv (`--host 127.0.0.1 -np 1 --jinja
   --no-webui --alias`), an allow-listed environment, ignored stdio, health polling, and kills
   only the child it started.
4. `relay/checkout.ts` — `OwnedCheckoutAllocator.allocate`: marker-owned directory under
   `<data>/relay-checkouts`, `git clone --no-checkout --no-hardlinks` of the source commit
   history, detach at `plan.base`, drop every ref and remote, repack and prune so no object
   beyond `plan.base` remains, `scratch` inside `runtime`. `--no-hardlinks` is mandatory: the
   K4 sandbox refuses writable hardlinked files. `close()` verifies the marker, refuses on a K4
   quarantine, removes the tree and proves absence; any failure is `cleanup_unconfirmed`.
5. `relay/operational.ts` + `StartOptions.operationalRelay` — immutable boot policy, built once,
   starts the runtime in the background (loading means `runtime_meter_unavailable`), closes the
   child and worker on server close. Both `relay` and `operationalRelay` set is a boot error.
6. Seam edits: `relay/runtime.ts` (observer branch, transport onto the meter, Ollama path
   byte-identical), `relay/model.ts` (pass the transport), `connections/service.ts`
   (`localChat` accepts a trusted transport; Ollama path unchanged), `relay/start.ts` (a
   `cleanup_unconfirmed` from a failed allocation is not masked as `relay_stopped`).

## Fail-closed matrix (each needs a failing-when-violated test)

Missing option, binary, model file or loading server keeps the stock refusal code. Stale
`/props` observation: `runtime_observation_stale`. Changed digest, version, window or host:
`runtime_identity_changed`. Alias differs or digest unreadable: `runtime_identity_unknown`.
Count vs `tokens_evaluated` mismatch: `truncation_protocol` (existing executor code); pre-dispatch
count disagreement: `runtime_counter_mismatch`; `truncated` response: transport refusal. Bridge
timeout or invalid reply: `runtime_count_invalid`. No fallback to a byte or catalog count.

## Allocator and restart matrix

Checkout is at the exact base (HEAD equals base, clean, no remote, no ref, no future object,
no `nlink>1`, no write outside the allocation, source repository untouched). Abort before,
during and after the clone cleans; a forced `rm` failure and a K4 quarantine give
`cleanup_unconfirmed`. A wrong marker or path outside the root is never deleted. Restart reports
`interrupted/process_restarted` and neither dispatches nor allocates.

## Checks

Targeted `node --test` on the new files, then `typecheck`, `lint:md`, `check:licenses`, and
through `agent-dev` (heavy, one per call) `npm run test` and `npm run build`. The relay,
connections, Ollama client and R1 suites are the regression envelope. Reviewer: a separate
read-only `sde-agent:implementation-reviewer` on the exact diff, fixes in a separate commit.
No third-party code is copied; no dependency is added. Rollback: remove the boot option.
