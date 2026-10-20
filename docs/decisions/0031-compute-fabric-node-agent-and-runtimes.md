# ADR-0031: Compute fabric — node agent, runtime adapters, catalog and fit, cloud budget

**Status:** proposed · **Date:** 2026-10-19
**Carries forward:** legacy ADR-0002 (Resource Governor), ADR-0003 (capability manifest),
ADR-0006 (catalog sources), ADR-0012 (estimated admission verdicts).

## Context

The owner's fleet mixes Apple Silicon (32 GB and 256 GB), a Windows PC with a 12 GB GPU and a
Linux VPS, plus optional per-minute cloud GPUs. Every modality (text, image, video, STT, TTS,
classifiers) should run where it fits (REQ-A4, REQ-B4, REQ-G1–G6).

Lane 3: no existing node agent covers this mix (GPUStack v2 Linux-only; LocalAI distributed
needs PostgreSQL + NATS; Xinference unauthenticated by default; exo Apple-only); runtime APIs
drift (llama-server's default port moved to 9931, Ollama removed image generation in
v0.32.6); several runtimes have unsafe defaults (mlx-vlm binds 0.0.0.0, llama.cpp RPC must
never be exposed).

## Decision

1. **Node agent** is part of every Guanxi node: enrollment and heartbeat, hardware inventory
   with provenance, runtime discovery and probes, model installation as node-owned runs with resumable download
   (D-147), the
   local governor, execution of attempts (agent loops, shell/tests, batch jobs) in a sandbox,
   workspace manager (git mirrors, worktrees), resource-lease enforcer and reaper, local event
   spool, artifact cache.
2. **Runtime adapters**, probe-first (never trust default ports or versions):
   - Tier 1: Ollama, llama-server (router mode), whisper.cpp server, stable-diffusion.cpp
     `sd-server` (image and Wan/LTX/Hunyuan video), mlx-audio or Kokoro-FastAPI (TTS);
   - Tier 2: ComfyUI (GPL-3.0, process only), mlx-vlm, LM Studio (via its published API),
     exo, Xinference;
   - Tier 3: vLLM and SGLang on Linux/WSL2/cloud only.
   `llama-swap` (MIT) is an optional supervisor whose config Guanxi generates; the governor
   stays the only admission authority for Guanxi work (load from other programs is observed
   as telemetry, not controlled). All runtimes bind to loopback.
3. **Catalog**: Hugging Face Hub as the main source (`pipeline_tag`, `filter=gguf|mlx`,
   remote GGUF headers via `@huggingface/gguf`); the Ollama registry only through its
   undocumented manifest endpoint, labelled unofficial; models.dev for cloud prices and limits;
   ranking signals from Arena (CC-BY-4.0), MTEB (CC0) and OpenRouter with source labels.
4. **Fit ladder** FIT0–FIT4: unknown → heuristic → GGUF metadata → runtime estimate on the target
   node → observed load. Only FIT3/FIT4 may claim "fits"; everything carries source, time and
   confidence (legacy ADR-0012 discipline).
5. **Placement** (ADR-0018): hard filters (modality, model installed or installable, policy,
   OS/arch/backend, data locality, fit ≥ FIT3 when GPU fit is required) then a score (fit
   confidence, expected start, throughput history, affinity memory such as "tests run faster
   on Mac Studio", cost, waking a sleeping host). Active agent attempts are not preempted.
6. **Telemetry**: per-OS samplers with provenance; Apple GPU counters are treated as fragile
   (private APIs) and fall back to `unknown`.
7. **Cloud rental**: provider adapters (RunPod REST v2, Vast, Modal; optionally SkyPilot as an
   external provisioner); a budget ledger reserves `price/h × max_duration + storage` before
   launch; monthly and per-launch caps; a dead-man switch (`max_lifetime`,
   `owner_unreachable_shutdown_after`) on every cloud node, because neither SkyPilot nor dstack
   caps total spend.
8. **Power**: a node may hold a power assertion while it holds or grants active leases or has
   pending timers (D-148); Wake-on-LAN is opt-in per node.
9. **Media models and the composer (REQ-G2, REQ-G3)**: each runtime adapter publishes a
   capability manifest per model (input and output modalities, parameter schema with types,
   ranges and recommended presets, limits with source). The composer renders only the inputs
   the selected models accept (an image-only model hides the text box) and exposes every
   parameter in the schema; no UI value is capped below the adapter's declared limit.

## Validation

Property: the governor is never bypassed (a remote inference cannot load a model the local
governor rejected); unload is impossible while a remote lease is active; a cloud launch without
a reservation fails; the dead-man switch stops an instance when its owner node disappears.

## Evidence

Lane 3 §§2–4, 7 ([research](../research/README.md)).
