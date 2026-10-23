# Fedora node — first real runs (2026-10-23)

**Status:** locally validated record · **Updated:** 2026-10-23 · **Scope:** D-196 owner-approved runs on the
Fedora node (`ssh fedora`), the first contact of R2-op's production classes with a real llama-server

The owner restored `ssh fedora` on 2026-10-23 and approved full testing there (D-196). Nothing here is an MS1
exit: MS1 still needs the remote-relay judge, stale-pin reaping, production boot wiring of the remote relay and
a real six-hour run with a real lead.

## Host

| Fact | Value | Source, observed |
| --- | --- | --- |
| GPU | RTX 3060 12 GB, driver 615.71.09 | `nvidia-smi`, 2026-10-23 |
| CPU / RAM | 12 cores / 31 GB | `nproc`, `free`, 2026-10-23 |
| Node | 22.23.1 | `node -v` |
| Runtime | llama.cpp `llama-server` b11496-000bee54a (`/props` `build_info`) | probe, 2026-10-23 |
| Model | Qwen3.8-27B GSQ-RCO IQ3_S GGUF, 11.77 GB, `sha256:64b53b64…6d810` | R2-op digest, 2026-10-23 |
| Bench user | `guanxi-bench` (uid 1001), units through `systemd-run --user` | provisioning script |

`guanxi-bench` was given traverse-only ACL entries (`--x`) on the two owner directories above the model so the
executor can hash the model file in attach mode (R2-op `observe` digests `props.modelPath`); it cannot list them.

## Regression on Linux

Fresh clone of `3ec3bc12` as `guanxi-bench` (`CPUQuota=600%`, `MemoryMax=12G`, ports 5273/4373):
`npm ci`, `npm run typecheck` and `npm run build` passed. `npm test`: 2677 core tests, 2668 pass, 2 fail,
7 skipped. Both failures depended on the environment, not on product code: an exec-bit assertion that assumed
umask 022 (the bench user has 077) and two wall-clock performance bounds (585 ms against 400 ms on a loaded
host). Fixed in `592cfe28` (owner exec bit only; CPU time instead of wall clock); the two files then passed
114/114 on Fedora. The Chromium browser gate was not run on Linux.

## Real llama-server

Unit `guanxi-llama` (owner user): `--host 127.0.0.1 --port 8090 -c 32768 -np 1 -t 6 -b 512 -ub 128
--flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --jinja --no-context-shift --metrics --no-webui
--alias qwen3.8-27b-iq3s --device CUDA0`. Ready in about 16 s, 10.7 GB VRAM.

1. **Raw protocol probe** (`/props`, `/apply-template`, `/tokenize`, `/completion`): `n_ctx` 32768,
   `total_slots` 1; `/tokenize` of the rendered prompt = 21 = `tokens_evaluated` with `cache_prompt` false and
   true (`timings.prompt_n` 4 when cached, so `tokens_evaluated` is the full prompt either way); `stop_type`
   `eos`, `truncated` false. `/apply-template` with `enable_thinking: false` emits an empty `<think>` block.
   This closes R2-op residual 1 (field names of a real server) for this build.
2. **R2-op production classes** (`LlamaServerHost` attach → `LlamaServerRuntime`), script
   `Guanxi-lanes/infra/fedora-runtime-smoke-20261023.ts`, run as `guanxi-bench` on the `3ec3bc12` checkout:

   | Check | Result |
   | --- | --- |
   | `observe` | model `qwen3.8-27b-iq3s:latest`, window 32768, `llama-server/b11496-000bee54a`, source `llama_server_props`; 7.5 s first call (model hash) |
   | `counter` | source `llama-server:/apply-template+/tokenize`, confidence `high`, template proof passed |
   | exact count | worker bridge 39 = async `measure` 39 = `prompt_eval_count` 39, cold and warm |
   | dispatch | exactly one `onDispatched` per call; `done_reason` `stop`; correct code answer |
   | speed | 23 output tokens in about 4.1–4.4 s end to end (about 5.2–5.6 tokens/s including prompt) |
   | ceiling | `num_predict` = window refused `context_ceiling` before dispatch |

## Not yet run

A verified relay item on the real model, a judge sample on the real executor, a real Claude Code lead and the six-hour
run. See `NEXT_AGENT_PROMPT.md` for the order.

## Two-host pairing and the first real relay runs (later on 2026-10-23)

`main` `536cad90` on both machines (Fedora: a bundle clone as `guanxi-bench`, `npm ci`, Node 22.23.1). Executor node as a
`systemd-run --user` unit `guanxi-ms1-exec`; home node on the Mac under `caffeinate -dimsu`; one `ssh -N` with
`-L 4562` and `-R 34561`. **Fedora's SELinux (enforcing) lets sshd bind remote forwards only in the ephemeral range**:
`-R 4561` and `-R 14561`/`24561` failed (`remote port forwarding failed`), `-R 34561` worked, so the home's federation
port is 34561 (informational `federationPort` in the peer offer edited to match). `doctor` and `preflight` passed on
both sides; `preflight --completion` evaluated exactly the counted probe; the home's `preflight` showed the signed
handshake, observation and exact count (22 tokens) across the link, window 32768, digest `sha256:64b53b64…6d810`.

Four one-item relay runs (plan: ledger-lite `I01`, gate `node --test test/01-money.test.mjs`, protected `test/`), each
ending `input_required` without a verified item:

| Run | Reached | Stopped by | Cause |
| --- | --- | --- | --- |
| smoke-1 | orient, two probes | `probe_failed_twice` | correct probe values inside a ```` ```json ```` fence; strict `JSON.parse` |
| smoke-2 | probes passed, tool work, a full `file_write` of an implementation (892 tokens, executor `completed`) | `model_failed` | discarded reason (see smoke-3) |
| smoke-3 | as smoke-2 | `model_failed`, reason `runtime_observation_stale` | the relay model recounted the prompt after the reply, which demands an observation younger than 60 s; calls of 13 860 prompt tokens + 892 output tokens take minutes |
| smoke-4 | tool work | three `invalid_action`, then `probe_failed_twice` | model format: `<tool_call>` tags, prose before JSON, missing `action`, invented tool `work.query`, wrong probe values (`nextItem: null`) |

Fixes on `claude/model-json-fences` (one fence removed, nothing else repaired; the prepare-time count reused; a fixed
`call_failed_reason` note). Also observed: `file_read` ignores an `offset` argument the model keeps sending, so it never
sees past the first 8 KiB page of a long file. llama-server b11496 honours `json_schema` on `/completion` without changing
`tokens_evaluated` (checked: an action schema with `const`/`enum`/`required`/`additionalProperties` produced exactly
`{"action": "tool", "name": "file_read", "args": {"path": "SPEC.md"}}`); lane R2-json carries it through the relay.

## First verified item on the real model (smoke-8)

With constrained output (R2-json, `47e238c7`), the auto-checkpoint before `verify` (`claude/verify-autocheckpoint`, under
review) and the gate command `node --test --test-isolation=none test/01-money.test.mjs`, the relay **finished ledger-lite I01 on
Qwen3.8-27B**: 2 cycles, 18 minutes, 29 remote model calls (137 863 evaluated prompt tokens, 4 950 output tokens, one
`remote-dispatch:` cost row each), state `finish`, start `completed`. The first gate failed an assertion (`-13` for `-1250`);
the model fixed it and the next two gates passed 11/11. Only `src/01-money.mjs` changed (82 insertions, 2 deletions) in two
harness checkpoints. Independently reproduced: a clean clone of the target repository plus the run's sealed git bundle at head
`671b36fb` passes `node --test test/01-money.test.mjs` 11/11 with the default test isolation.

Smoke-6 and smoke-7 had found the two blockers on the way: `verify` without a checkpoint stopped the run (`checkout_dirty`),
and every gate failed with `spawn EPERM` because the K4 workload seccomp filter denies `socketpair`, which libuv uses for child
stdio pipes; `node --test` runs each test file in a child process. `--test-isolation=none` is a plan-level workaround; lane
K4-pipes is the fix.

## Five items in one relay run (multi-2)

Plan: ledger-lite I01–I05 (I02 depends on I01), gates `node --test --test-isolation=none test/<item>.test.mjs`, protected
`test/`, caps 40 cycles / 4 M tokens / 6 h, judge signals on. Code: `main` `47e238c7` plus the real-run fixes later merged as
`daee6007` (auto checkpoint, long completions, Node 22 fetch pairing; the second review round was not yet deployed).

Result: **all five items `done`**, state `finish`, start `completed`, 4 cycles in 64 minutes, 96 remote model calls on the
Fedora executor (930 361 evaluated prompt tokens, 9 823 output tokens, one F2-c cost row each), 8 judge-signal notes, no error
event. The first five-item attempt (multi-1) had stopped at its first call longer than 300 s (`runtime_meter_unavailable`, Node
fetch's default headers timeout), which `daee6007` fixes. Independently reproduced: a clean clone plus the sealed bundle at head
`093accc3` changes only the five `src/` modules (237 insertions, 14 deletions) and passes every gate with the default test
isolation: I01 11/11, I02 9/9, I03 9/9, I04 8/8, I05 11/11.
