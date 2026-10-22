# WG2-a tracker sync core — hand-off

**Status:** implemented internal library core; WG2 remains in progress. **Date:** 2026-10-22.
**Branch:** `codex/wg2a-tracker-sync` (clone, no push); no plugin/route/contract/UI/tool wiring.

## Delivered boundary

- `types.ts`: transport port, injected `authorize(headers)`, `secret://` credential reference,
  `TrackerLink`, business fields, three-mutation write vocabulary and typed errors.
- `engine.ts`: conditional polling, display metadata, coarse transition policy, marker-first
  idempotent comments and exact deferral. `lastTransitionSeq` advances only after the whole
  transition succeeds, so a retry reuses the same marker.
- `github.ts`: GitHub Issues reads, comment pagination, one `guanxi:<status>` label swap, no
  issue-edit request, `business_field_write_refused` for anything outside the allowlist.
- `jira.ts`: one REST adapter for Cloud `/rest/api/3` and Data Center `/rest/api/2` (D-121),
  ADF v3 comments and plain v2 comments, ADF comment/description flattening, mapped
  transitions; unmapped statuses are comment-only.
- `rate-limit.ts`: 80/min and 500/h GitHub content buckets, 20 writes per Jira issue per 2 s,
  `retry-after`/reset/secondary/5xx backoff, injected clock and exact next-allowed times.
- `README.md`: model, write allowlist, marker protocol, polling, limits, adapters and residuals.

## Commands and results

- `nice -n 10 node --test packages/server/test/work/sync/*.test.ts` → **26 tests, 26 pass,
  0 fail**, exit 0.
- `nice -n 10 npx tsc --noEmit -p packages/server` → exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/work/sync/README.md docs/plans/lanes/WG2-a.handoff.md`
  → 0 errors (2 files).
- `git diff --check` → clean. No dependency or third-party source added.

## New / regression envelope

**New:** 26 tests in `sync-engine.test.ts` (9), `adapters.test.ts` (9) and
`rate-limit.test.ts` (8), replaying 14 authored fixtures. They cover business fields never
written (every outgoing request inspected), one marker per coarse transition, crash and
deferred-label retries without a second comment, no request outside the coarse set, GitHub
label swap, Jira mapping and comment-only statuses, exact 80/min/500/h and Jira burst times,
`retry-after`/reset/5xx backoff, 304 polling, credential hygiene in errors/results/request logs,
and v2/v3 comment payloads.

**Regression:** no existing source, test, schema, contract, dependency or third-party file
changed; only the new `src/work/sync/` and `test/work/sync/` paths. No `npm test`, browser,
live server, network, model or owner data was used. This is targeted unit evidence, not a
product integration gate.

## Verification and residuals

- A self-review found a real deferred-transition bug: returning an advanced sequence after a
  comment but before a failed label made the retry post a second comment. It is fixed before
  hand-off and covered by the deferred-label regression test.
- No cross-family review is claimed; the integrator still owes the independent GPT 6.1
  Sol/high review required by the lane rules.
- Plugin packaging, manifest and permissions remain P1; credential setup UI and vault
  registration belong to connections.
- The 10-minute polling scheduler and durable link/last-synced storage are caller work.
- A webhook relay plugin is postponed unless polling proves insufficient (D-175).
- Fixtures are authored from public API documentation; replacing them with live recorded
  fixtures from real APIs remains later verification.
- GitHub priority is label-derived; a project/issue-type field mapping needs a design.
- GitHub comment pagination and Jira comment paging follow server pages without a local cap;
  transport deadlines stay the transport's responsibility.
- No routes, contract, board UI, plugin wiring or agent tracker tools exist. WG2 stays in
  progress.

## Next slice

Wire this core behind the plugin/kernel boundary without changing the write allowlist:
package it as the tracker sync plugin, add credential and polling configuration, persist
links and last-synced state, and expose the caller-side 10-minute scheduler. Then replace
authored fixtures with live recorded responses.
