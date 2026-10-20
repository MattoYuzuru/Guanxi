# Next agent prompt — K1 Kernel spike

**Status:** ready once S0 is committed · **Updated:** 2026-10-19 (after the S0 review)

**Precondition:** S0 is the current stage until its docs, review fixes and gates are
committed (see [PHASE_STATUS](PHASE_STATUS.md)). If `git log` does not contain the S0
commits, finish S0 first: commit it, then run this prompt.

Copy the block below into a new agent session started in the repository root.

```text
You are implementing stage K1 (Kernel spike) of Guanxi.

First check that the S0 re-foundation is committed (docs/decisions/ADR-0032 and
docs/plans/roadmap.mmd exist in git history). If not, stop and report.

Read first, in order:
1. AGENTS.md
2. docs/NAVIGATION.md
3. docs/plans/WORKFLOW.md (mandatory protocol)
4. docs/decisions/0015-refoundation-on-own-cordis-kernel.md
5. docs/decisions/0022-plugin-trust-tiers-ui-slots-and-design-tokens.md (manifest and slots only)
6. docs/architecture/TARGET_ARCHITECTURE.md §§3, 11, 12
7. docs/plans/ROADMAP.md, section K1
8. docs/research/2026-10-19-landscape/02-plugins-ui-sync.md §1 (Cordis, DSH) — Russian

Goal: prove that Cordis 4 can carry Guanxi, behind a thin facade, using real legacy code.

Scope:
- Create packages/kernel (@guanxi/kernel): re-export Context, Service, inject, effect,
  events and the loader from Cordis 4 behind Guanxi names; add profile loading (ordered patch
  layers) and a minimal manifest reader (`guanxi` field in package.json: id, engines.guanxi,
  provides, requires, uses, contributes, trust).
- Pin an exact upstream Cordis 4 version (`cordis@4.0.0-rc.*`). DSH's hardened Cordis may
  be used only as vendored, attributed source (D-108), never as the `@deepseek-ai/cordis`
  npm dependency; read DSH's change log for known lifecycle fixes. Record the choice.
- Port the legacy Resource Governor (packages/server/src/runtime/resource-governor.ts,
  tests: packages/server/test/resource-governor.test.ts) and the Ollama adapter
  (packages/server/src/ollama/, tests: packages/server/test/ollama-*.test.ts) into kernel plugins WITHOUT changing their behaviour; their existing tests
  must pass through the facade (adapt only wiring).
- Add one UI slot in packages/web contributed by a plugin (list slot for the sidebar is fine),
  hot-updated by HMR and removed on unload.
- Add leak counters (listeners, timers, open handles, slot entries) and a test that runs 100
  unload/reload cycles under synthetic load.
- Measure empty-node boot time and RSS; record the baseline.

Reuse: Cordis (MIT). Copy DSH loader/slot code only with attribution in THIRD_PARTY_NOTICES.md
(repository + commit + license + local path) in the same commit.

Non-goals: no new agent features, no UI redesign, no fleet work, no data migrations.

Exit gate (each needs an assertion that fails when violated):
- legacy governor and Ollama adapter tests pass through the facade;
- 100 reload cycles → 0 leaked listeners/timers/handles/slot entries, and heap growth after
  forced GC ≤ 5% (count non-freeable ES module records and document them);
- the slot contribution appears, hot-updates, and disappears on unload;
- an empty node boots in ≤ 2 s and idles at ≤ 200 MB RSS on Apple Silicon (record values);
- Cordis is rejected if ADR-0015's rejection criteria hit; record the decision (accept with
  the version, or fall back to an own kernel with a superseding ADR).

Validation commands: npm run typecheck; npm test; npm run test:web:browser; npm run build;
npm run lint:md; npm run check:licenses; plus the new kernel tests.

Independent verification: sde-agent:implementation-reviewer on the exact diff,
architecture-agent:adversarial-architect on the kernel boundary, and
frontend-agent:accessibility-reviewer on the new web slot. Fix findings in separate commits.

Finish by updating docs/plans/PHASE_STATUS.md (evidence as "N new / M envelope") and rewriting
docs/plans/NEXT_AGENT_PROMPT.md for the next unfinished slice (K2, K3 or U1 — whichever the
owner picks; default K2).
```

## Notes for the owner

- K2, K3 and U1 can start in parallel sessions once K1 passes.
- If the spike fails, the fallback is an own kernel of about 1–2k lines with Cordis semantics
  (ADR-0015 §Validation 5).
