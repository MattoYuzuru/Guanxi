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

## Independent review fixes

**Date:** 2026-10-23. Each finding is a separate commit on `codex/wg2a-tracker-sync`, written
test-first: the new assertion failed before the source change. Nothing was pushed.

- P2-1 (`07d9fc29`): Guanxi owns exactly `COARSE_STATUSES.map(s => "guanxi:" + s)`. A user
  label such as `guanxi:needs-triage` stays in business labels and is never deleted; the
  engine test audits DELETE targets.
- P2-2 (`bd4c1d54`): adapters report every read response to the governor (`observeRead`, 304
  counts as success), and retryable reads (429, secondary 403, 5xx) raise
  `TrackerRetryableError`. `poll()` and `sync()` turn it into a deferral at the exact
  `retry-after` / reset / backoff time; `remaining: 0` on a read defers the next write.
- P3-1 (`0f2525f7`): `RemoteComment` carries `author`; `self()` is cached from GitHub
  `GET /user` or Jira `/rest/api/*/myself`, and a marker only counts on the authenticated
  identity's comment. Jira identity reads are scoped to the issue key (`d3862793`) so a
  retryable identity read defers under that key instead of hot-looping.
- P3-2 (`857674c6`): `failed` and `blocked` share one outward blocked state: one comment,
  `guanxi:blocked`, and no new write when moving from one to the other.
- P3-3 (`231e4230`): GitHub keys reject empty, `.` and `..` owner/repo segments.
- P3-4 (`21bf4c9a`): each mutating label request counts against the GitHub content budget.
  The engine reserves the first token and charges the adapter's reported DELETEs plus POST;
  a skipped swap refunds the reservation.
- P3-5 (`4f04757f`): Jira v3 comments use ADF `strong`/`code` marks and v2 uses wiki markup
  (`*bold*`, `{{code}}`). The marker stays plain text and remains visible in Jira.
- P3-6 (`dad5052b`): a mapped Jira transition the workflow no longer offers becomes
  comment-only and records `SyncResult.warnings` instead of throwing on every sync.
- P3-7 (`289c2ebe`): a response `Last-Modified` header, when present, becomes the next
  `If-Modified-Since` validator; body `updated_at` / `updated` remains the fallback.

### Commands and results

- `nice -n 10 node --test packages/server/test/work/sync/*.test.ts packages/server/test/work/*.test.ts`
  → **79 tests, 79 pass, 0 fail**, exit 0. The sync suite grew from 26 to 40 tests (14 new)
  across `sync-engine.test.ts`, `adapters.test.ts` and `rate-limit.test.ts`; the existing
  `test/work/*.test.ts` suite remains 39 passing tests.
- `nice -n 10 npx tsc --noEmit -p packages/server` → exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/work/sync/README.md docs/plans/lanes/WG2-a.handoff.md`
  → 0 errors (2 files).
- `git diff --check` → clean. No dependency, route, contract, schema, UI or third-party code
  changed.

### Residuals

- The read observation is per adapter instance and in-memory, like the governor; durable
  rate-limit state remains caller work.
- The content-budget settlement charges additional label requests after the adapter reports
  them. The first request is reserved before the swap, but a partial swap interrupted by a
  transport failure cannot be counted exactly; the retry remains marker-safe and idempotent.
- Jira `self()` caches the first authenticated identity for the adapter lifetime; a token
  change requires a new adapter instance.
