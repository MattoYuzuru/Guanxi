# Legacy documentation (Alamo era, Russian)

**Status:** implemented (describes the current code) · **Archived:** 2026-10-19

Until 2026-10-19 the project was called **Alamo UI**: a local-first web interface and
runtime-control layer over Ollama. Its documentation, written in Russian, lives in
[`alamo/`](alamo/NAVIGATION.md) unchanged except for the product name.

These documents still describe the code in `packages/` accurately — durable Chat jobs,
Resource Governor, runtime reconciliation, capability evidence, catalog, Projects,
retention, attachments, recipes and localization (legacy Phases 0–3, slices P0-A–P3-Q). Use
them when changing that code.

They are **superseded as the target direction** by the English documents in
[`docs/`](../NAVIGATION.md): owner decisions D-101–D-113, ADR-0015–0031 and the new
[roadmap](../plans/ROADMAP.md). Legacy code is ported into the new architecture stage by
stage; see [TARGET_ARCHITECTURE §11](../architecture/TARGET_ARCHITECTURE.md#11-migration-from-the-legacy-code).

Internal links inside `alamo/` are relative to that folder; links that pointed to the
repository root (`../README.md`, `../AGENTS.md`, `packages/…`) now need two more `../`
segments.
