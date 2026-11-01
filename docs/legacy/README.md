# Legacy documentation (Alamo era, Russian)

**Status:** implemented legacy scope · **Archived:** 2026-10-19 · **Context updated:** 2026-11-01

Until 2026-10-19 the project was called **Alamo UI**: a local-first web interface and
runtime-control layer over Ollama. Its documentation, written in Russian, lives in
[`alamo/`](alamo/NAVIGATION.md). The retained documentation is maintained when relevant
legacy behavior changes; its historical plans and evidence keep their original scope.

These documents describe the retained workbench — durable Chat jobs, Resource Governor,
runtime reconciliation, capability evidence, catalog, Projects, retention, attachments,
recipes and localization (legacy Phases 0–3, slices P0-A–P3-Q). Use them alongside current
source when changing that legacy behavior. Newer subsystems and the new shell have merged
since archival; this folder is not their architecture or current-state reference. Start at
[stage status](../plans/PHASE_STATUS.md), the affected source README and the
[repository overview](../../README.md) for the implemented scope and evidence.

They are **superseded as the target direction** by the English documents in
[`docs/`](../NAVIGATION.md): owner decisions D-101–D-113, ADR-0015–0031 and the new
[roadmap](../plans/ROADMAP.md). Legacy code is ported into the new architecture stage by
stage; see [TARGET_ARCHITECTURE §11](../architecture/TARGET_ARCHITECTURE.md#11-migration-from-the-legacy-code).

Internal links inside `alamo/` are relative to that folder; links that pointed to the
repository root (`../README.md`, `../AGENTS.md`, `packages/…`) now need two more `../`
segments.
