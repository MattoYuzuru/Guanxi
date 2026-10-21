# U1 session metadata continuation

**Status:** implementation and focused checks complete; independent review/full gates pending.
**Date:** 2026-10-22 · **Branch:** `codex/u1-shell`. Local Mac only, synthetic in-memory SQLite.

The shell needs a paged session list and actual execution observations. The existing strict
`GET /api/sessions` list remains unchanged. New `GET /api/sessions/list/page` accepts a page
size (1–200, default 50) and a validated opaque cursor. This is a transport page size, not a
limit on visible sessions. The nested route preserves existing summaries, including a session
whose valid ID is `page`. The web inspector client has a typed page method for shell consumers.

Pages order by immutable creation time and session ID, descending. A cursor identifies the
last returned row; additional available sessions produce a next cursor. Withheld identifiers
and deferred Chat mirrors are skipped before filling a page and produce explicit omission
flags. Titles use the existing K2 read-time scrubber. No reasoning/event/private payload field
is returned. The existing loopback and egress-readiness guards apply to the new route.

An execution observation joins `durable_runs.session_id` to the listed session, selecting its
latest updated root run (ID breaks equal timestamps). The latest ordinal attempt supplies
its stored state. Descendant runs sharing that session do not replace their root's observation.
Missing data is `null`. Source `run-home`, its recorded update time and observed confidence
describe stored metadata, not a fresh process/liveness or hardware observation. No association
is guessed by matching run IDs to session IDs. There is no schema migration or durable write.

**New:** four Node integration cases in `session-list-page.test.ts` assert 212 tied-date
sessions cross the legacy 200 boundary with exact counts/no duplicates, cursor validation,
old list/summary compatibility, late-secret withholding and title scrubbing, no reasoning or
private fields, egress readiness, loopback refusal, deferred mirror omission, exact run/session
mapping, terminal observation and sleeping-root selection despite its shared-session child.
**Regression envelope:** 33 existing K2 route/readiness/re-check cases; combined 37/37 pass,
zero skips. All-workspace typecheck passed. Later targeted assertion additions are rerun before
commit. No live model, remote host, user database or owner workspace was accessed.

Independent acceptance must cover pagination boundaries/withholding, read-time privacy,
root/child mappings, version compatibility and actual HTTP trust guards. Root owns full gates
and integration. The shell consumer, navigation, palette and remaining U1-b/c scope are not
closed by this endpoint.
