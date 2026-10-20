# ADR-0015: Re-found Guanxi on an own thin kernel over Cordis 4 and pi-ai

**Status:** accepted (owner decision D-108); **the Cordis part is rejected by D-183** after the
K1 spike, and the own-kernel fallback of validation 5 applies (ADR-0037, in progress in lane
K1) · **Date:** 2026-10-19
**Supersedes:** legacy ADR-0001 (local modular monolith) as the target structure; legacy
ADR-0010 (first-party coding agent) is carried forward as the native agent of ADR-0021.

## Context

The brief asks for "everything as a plugin", including UI, hot replacement of plugins written
by agents, many providers, sub-agents and detailed tracing. The Alamo-era code is a Hono +
`node:sqlite` + React monolith with a strong durable-job core but no plugin system.

Research lane 1 scored five options (max 90): DeepSeek Harness distribution 78, own core on
`pi` libraries + Cordis 64, OpenCode fork 61, Goose fork 57, growing the current code 48.
DeepSeek Harness (DSH) is MIT and built exactly on the brief's model, but it accepts no
external pull requests, announces breaking changes and is a trademark. The owner chose the
own-kernel option to keep governance and the public API under Guanxi's control.

## Decision

1. Build `@guanxi/kernel`, a thin facade over **Cordis 4** (context, services, `inject`,
   revertible effects, loader, HMR). Pin an exact upstream version (`cordis@4.0.0-rc.*`). If upstream needs fixes, vendor
   the source with a change log, as DSH does with 24 patches; DSH's hardened Cordis may be
   used only as vendored, attributed source, never as the `@deepseek-ai/cordis` npm
   dependency (D-108).
2. Use **`pi-ai`** (provider layer) and **`pi-agent-core`** (agent loop) as dependencies for
   native agents. Disable the Anthropic OAuth path (D-104).
3. **Copy, do not depend on, DSH**: profiles/bundles/patch layers, plugin manager, typed UI
   slots, theme rules, session-handle contract and inspector ideas, under MIT with
   attribution in `THIRD_PARTY_NOTICES.md`.
4. Port the legacy code into kernel plugins with a strangler approach; `packages/contract`
   remains the single client↔node wire contract.

## Invariants

- No Guanxi feature imports Cordis directly; everything goes through `@guanxi/kernel`, so the
  kernel can be swapped if Cordis fails.
- Every plugin declares `engines.guanxi`, its services (`provides`, `requires`, `uses`) and
  its trust tier.
- Unloading a plugin reverts all of its effects (listeners, timers, routes, slots, services).
- A safe-mode boot with all T1/T2 plugins disabled always exists.

## Consequences

- Positive: governance and API stability are ours; DSH's best parts arrive without its churn;
  the brief's plugin model has a formal basis (Cordis paper).
- Negative: more work before the first usable build than a DSH distribution; Cordis 4 is still
  an RC; Guanxi must maintain any vendored patches.

## Alternatives considered

- **DSH distribution** (pinned DSH + `@guanxi/*` plugins): fastest, but upstream is closed to
  contributions, unstable, and DeepSeek-branded.
- **Hard fork of DSH**: fast now, but about 205 MB of code to maintain alone while upstream
  releases daily.
- **OpenCode fork**: Bun + Effect 4 + SolidJS, a stack change.
- **Grow the current monolith**: lowest reuse; a plugin system would be written from scratch.

## Validation (K1 spike exit gate)

1. Resource Governor and the Ollama adapter run as kernel plugins; legacy tests for both pass
   unchanged through the facade.
2. 100 unload/reload cycles under load leave zero leaked listeners, timers, handles and slot
   entries (asserted by counters), and heap growth after forced GC is ≤ 5% of the first
   cycle; ES module records that cannot be freed are counted and documented.
3. A web UI slot contributed by a plugin appears, updates on HMR and disappears on unload.
4. An empty node boots in ≤ 2 s and idles at ≤ 200 MB RSS on Apple Silicon (initial budget).
5. **Rejection criteria for Cordis**: any leak in item 2 that needs more than 10 vendored
   patches to fix, a budget in item 4 that cannot be met, or a lifecycle race found in review
   that upstream does not fix. Then fall back to a 1–2k-line own kernel with Cordis
   semantics and record a superseding ADR.

## Evidence

Lane 1 §§3–6, lane 2 §1 ([research](../research/README.md)); Cordis paper
arXiv:2608.25512 (2026-08-26).
