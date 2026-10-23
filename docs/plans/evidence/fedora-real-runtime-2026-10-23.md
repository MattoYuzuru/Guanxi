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

A relay through the production boot on two hosts, a judge on a remote relay, a real Claude Code lead and the
six-hour run. See `NEXT_AGENT_PROMPT.md` for the order.
