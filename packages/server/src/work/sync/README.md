# Tracker sync core (WG2-a)

**Status:** implemented internal library core, not wired into plugins, routes, contract, UI or
agent tools. WG2 remains in progress. **Date:** 2026-10-22.

Sources: [ADR-0032](../../../../docs/decisions/0032-work-ledger-board-and-tracker-sync.md)
§7 and its invariants, ROADMAP `WG2`, owner decisions D-115, D-121, D-171 and D-175, and the
WG1-a work ledger in [`../`](../README.md). The eventual home is a sync plugin; this slice
keeps the core under `packages/server/src/work/sync` and adds no wiring.

## Boundary

The tracker owns business intent; Guanxi owns execution state. The engine imports title,
description, priority, assignee and labels into display metadata and never sends them back.

- `types.ts` defines the HTTP port, link, business fields, comment/mutation vocabulary,
  errors and the transition marker.
- `engine.ts` owns policy: polling, business-field import, coarse transition decisions,
  idempotent comments and deferral.
- `github.ts` and `jira.ts` are the only adapters. They never use `fetch`; they call the
  injected `http(request) => response` port, so tests replay recorded-style fixtures.
- `rate-limit.ts` is a pure clock-injected token-bucket and backoff calculator. The engine
  returns an exact `nextAllowedAt` instead of sleeping or retrying internally.

Credentials are a `secret://` reference plus an injected `authorize(headers)` callback. The
adapter stores the reference for configuration audit and passes the header object to
`authorize`; it never resolves, reads or logs the token. Transport and authorization failures
are rethrown as fixed messages without a cause, so a token cannot ride an error message.

## Link model

```ts
TrackerLink {
  itemId: string
  tracker: 'github' | 'jira'
  externalKey: string            // example-org/example-repo#7 or PROJ-12
  lastSyncedStatus: DerivedStatus | null
  lastRemoteEtag: string | null
  lastRemoteUpdatedAt: string | null
  lastCommentId: string | null
  lastTransitionSeq: number      // monotonic marker counter, starts at 0
}
```

A link is data. The caller persists it; the engine keeps an in-memory copy for convenience
and returns the next link from every poll and sync. `lastTransitionSeq` advances only when
every write for a transition has succeeded.

## Business fields

`RemoteBusinessFields` is `title`, `description`, `priority`, `assignee` and `labels`.
`poll` returns the changed fields plus `ItemDisplayMetadata`; `engine.metadata(itemId)` is
the current display projection. No adapter has an issue-update method.

The complete outward write surface is:

```ts
{ kind: 'comment', body, marker }
{ kind: 'status-label', status }   // GitHub only
{ kind: 'transition', status }     // Jira only, and only when mapped
```

Any other mutation throws `TrackerSyncError` with code `business_field_write_refused`. The
GitHub adapter sends no PATCH or PUT; label writes carry only `{ labels: [ 'guanxi:<status>' ] }`
and comment writes carry only `{ body }`. The Jira adapter sends comments and transitions only.
Tests inspect every recorded request, not just the adapter return value.

GitHub has no native priority field. The adapter maps a `priority:<value>` or
`priority/<value>` label into the priority display value and leaves the label itself in the
business label list. Guanxi owns exactly the `guanxi:<coarse-status>` labels and excludes
those from business labels: they are execution state, not tracker intent. Other labels in
the `guanxi:` namespace, such as `guanxi:needs-triage`, are user intent and stay. That is a
read mapping, never a write.

## Coarse outward writes

A write happens only on a derived-status transition into the coarse set (ADR-0032 §7):

| Outward state | Comment | GitHub label | Jira |
| --- | --- | --- | --- |
| `in_progress` | one start comment | `guanxi:in_progress` | mapped transition when configured |
| `blocked` (from `blocked` or `failed`) | one blocked comment | `guanxi:blocked` | mapped `blocked` transition when configured |
| `done` | one done comment with the evidence link | `guanxi:done` | mapped transition when configured |
| anything else | none | none | none |

ADR-0032 §7 has one blocked outward state. Moving between `failed` and `blocked` updates the
stored derived status but posts no comment and writes no label or transition.

The comment body ends with
`<!-- guanxi:transition:<itemId>:<status>:<seq> -->`. The marker is kept as plain text on
every tracker, so it stays visible in Jira and survives ADF flattening. Before posting, the engine lists existing
comments and looks for that exact marker, but only on comments authored by the authenticated
tracker identity (`adapter.self()`, cached from GitHub `GET /user` or Jira `/rest/api/*/myself`).
A user can copy marker text into a comment; it does not suppress the status comment. If the
marker is present on an own comment, the comment counts as already posted and only the
remaining status write is attempted. This makes a process crash between
the POST and the local save safe: the retry reuses the sequence, finds the marker and does not
post twice. The sequence is not advanced on a deferred or failed transition, so a retry after
a failed label or transition also reuses the same marker.

GitHub keeps exactly one `guanxi:<coarse-status>` label: stale labels from that exact set are
removed and the target is added. Other `guanxi:*` labels are never deleted. A transition to a
status outside the coarse set does not touch the label.
Jira transitions are optional configuration. An unmapped status is comment-only.

## Polling

`engine.poll(link, now)` sends ETag / If-Modified-Since where the tracker supports it. When a
read response carries `Last-Modified`, the adapter stores that exact value as
`lastRemoteUpdatedAt` and uses it for the next `If-Modified-Since`; otherwise it falls back to
the body's `updated_at` / `updated`. `304` returns `notModified: true`, no changes, the same
link and unchanged display metadata. A `200` returns a field diff and updates
`lastRemoteEtag` / `lastRemoteUpdatedAt`. A retryable read
(429, secondary-limit 403, 5xx) returns `deferred` with the exact retry time instead of
throwing. Scheduling is the caller's job; D-175 expects every ten minutes. This core starts
no timer and opens no socket.

## Rate limits

All methods take an injected clock. `checkWrite` reserves nothing when it denies a write and
returns the exact next-allowed epoch millisecond.

- GitHub content creation (comments) uses token buckets of 80 per minute and 500 per hour.
  Each bucket refills at `capacity / window`: the 81st immediate comment is allowed at
  `now + 750 ms`, and an isolated hourly bucket refills one token every 7,200 ms.
- Every read response is observed by the engine: `x-ratelimit-remaining` and
  `x-ratelimit-reset` on a read update the same server-backoff state as writes. A read that
  reports `remaining: 0` defers the next write to the reset time.
- A retryable read response becomes `TrackerRetryableError`; `poll()` and `sync()` translate
  it into a deferral at the exact `retry-after` / reset / backoff time. `304` counts as a
  successful read for observation.
- Every GitHub mutating label request counts against the content buckets: each stale-label
  `DELETE` and the target-label `POST` consumes one token. The engine reserves the first
  token before the swap and charges the adapter's reported additional requests afterwards;
  a skipped swap refunds the reservation.
- `x-ratelimit-remaining: 0` defers until `x-ratelimit-reset`; `retry-after` accepts delta
  seconds or an HTTP date and wins over local timing.
- Secondary-limit `403` uses a 60 s initial bounded exponential backoff when no server time
  is supplied (capped at 900 s); `429` and other retryable failures start at 1 s and cap at
  60 s. `429` with `retry-after` uses that header exactly.
- Jira allows 20 writes per issue per two seconds, so the 21st immediate write is allowed at
  `now + 100 ms`. The bucket is per issue; other issues are independent. `Retry-After` on
  `429` defers the issue.
- `5xx` and transport failures on writes are retryable; the engine returns a deferred result
  and never sleeps. A transport failure on a POST is treated as ambiguous, which is safe
  because the marker check runs first on retry.

## Adapters

### GitHub Issues

`owner/repo#123` keys; empty and `.`/`..` segments are rejected. Reads `title`, `body`, labels,
assignee and `updated_at`, with ETag
conditionals. Comments carry `user.login` as their author and paginate through the `Link`
header; a cross-origin next page is refused. `self()` reads and caches `GET /user`. Label
writes read the issue first, remove stale coarse status labels, and add the target.

### Jira

One adapter, selected by `apiVersion`: Cloud uses `/rest/api/3`, Data Center uses
`/rest/api/2` (D-121). Reads summary, description, priority, assignee, labels and `updated`.
Cloud descriptions are flattened from ADF; Data Center descriptions remain plain/wiki text.
Cloud comments are sent as ADF with `strong` and `code` marks; Data Center comments use wiki
markup (`*bold*`, `{{code}}`). The engine emits one markdown-like source body and each adapter
translates it, so no literal `**` or backticks reach Jira. Comment reads flatten ADF to text
so marker checks work on both variants; the author is
`accountId` (Cloud) or `name` (Data Center), and `self()` caches `GET /rest/api/*/myself`.
`transitions` maps an outward state (`in_progress`, `blocked`, `done`) to a transition id or
name; configure `blocked` once for both `blocked` and `failed`. The adapter resolves it from
the issue's available transitions and sends only `{ transition: { id } }`. If the workflow no
longer offers the mapped transition, the write becomes comment-only and
`SyncResult.warnings` records `transition_not_found` instead of throwing on every sync.

## Tests and fixtures

`packages/server/test/work/sync/` replays authored fixtures in `fixtures/` that follow the
public GitHub and Jira response shapes; no fixture contains real account data and no test uses
a network. The suite covers:

- business-field changes while syncing, with every outgoing request inspected;
- one marker per coarse transition, idempotent retry after a crash, and retry after a deferred
  label write, plus a user-authored marker that does not suppress the status comment;
- no request at all for non-coarse transitions;
- GitHub label swap, Jira transition mapping, unmapped comment-only statuses and an
  unavailable mapped transition that warns and stays comment-only;
- exact 80/min, 500/h, 20-per-issue burst, `retry-after`, reset-header and bounded `5xx`
  backoff times, plus engine deferral;
- conditional `304` polling for GitHub and Jira, including `Last-Modified` validators;
- credential hygiene across errors, results and the recorded request log;
- Jira v3 ADF `strong`/`code` marks, v2 wiki markup, and ADF marker extraction.

## Residuals

- Plugin packaging, manifest and permissions are P1 work; no plugin wiring, route, contract,
  UI, board or agent tracker tool exists in this slice. Agents get no tracker tools by default.
- Credential setup UI and `secret://` registration stay with the vault/connections work.
- The 10-minute polling scheduler and durable link/last-synced storage are caller work.
- A webhook relay plugin is postponed unless polling proves insufficient (D-175).
- Fixtures are authored from public API documentation. Replacing them with live recorded
  fixtures from real API responses remains later verification; no live service was called here.
- GitHub priority is label-derived until a project/issue-type field mapping is designed.
- Comment-list pagination follows server pages without a local cap; a pathological server can
  make one marker check long. The engine has no timeout of its own because the transport owns
  deadlines.
