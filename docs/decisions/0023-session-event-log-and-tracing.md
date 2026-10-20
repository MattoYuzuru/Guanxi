# ADR-0023: The session event log is the trace

**Status:** proposed (reasoning capture accepted by owner decision D-113) · **Date:** 2026-10-19
**Changes:** the legacy invariant "do not log reasoning/thinking" becomes "never export
reasoning and never write it to plain-text logs; storing it in the local session log is
allowed under the retention policy".

## Context

The brief asks for tracing at least as detailed as DeepSeek Harness, usable by people and
agents. DSH keeps one lossless append-only `SessionEvent` log per session (single-writer
lease, crash recovery, torn tail never returned) with an inspector, lineage and full-text
search; OpenTelemetry there only carries product telemetry. The OpenTelemetry GenAI semantic
conventions are still "Development" and moved to a separate repository without releases.

## Decision

1. Each session has one **append-only event log** in the home node's SQLite database:
   monotonic `seq`, single writer (ADR-0018), idempotent append by `(session, seq)`,
   persisted before it is streamed (legacy P1 discipline), torn writes impossible by
   transaction.
2. **Event families** (all schemas in `packages/contract`): prompt (with origin: typed, voice,
   queued, remote, delegated), assistant message, visible reasoning, tool call / result (with
   redacted arguments and bounded output plus evidence links), sub-agent span, plan revision,
   item status, relay cycle and handoff events, judge verdicts, lease events, attempt events
   (validated and ingested by the home node from the executor's fenced attempt stream),
   cost and usage, user intervention (stop, deny, edit, retry, correction), environment events
   (port in use, container conflict, OOM, governor rejection).
3. **Reasoning**: stored when a provider exposes it, with a per-project retention setting;
   never replicated to other nodes (ADR-0018 §2); readable by people with access to the
   session and by agents and auditors running on **local runtimes** of the owner's devices;
   never sent to remote model providers (including through query tools or remote auditors),
   OTel or upstream reports; never written to plain logs.
4. **Large payloads** go to content-addressed artifacts; the event carries the hash and a
   bounded excerpt.
5. **Inspector UI** (people) and **query tools** (agents) read the same log, minus reasoning
   for agents on remote providers: timeline with nested spans, lineage, FTS5 search, token
   meter, cost per span.
6. **OpenTelemetry GenAI export** is an optional, version-pinned projection with
   `guanxi.*` attributes; optional local viewers (otel-desktop-viewer, Jaeger v2) are
   process-only.
7. **Storage choice**: SQLite rather than DSH's JSONL+zstd files, because Guanxi already has a
   tested SQLite event store with recovery, FTS5 is built in, and replication streams are
   per-table offsets.

## Invariants

- Every event that changes state is in the log before any client sees it.
- No secret value is ever stored in an event (exact-match scrub at write time).
- The log can be replayed into the same UI state (reload test).

## Validation

Crash-point tests for append; reload replay equality; scrubber test with planted secrets;
export test proving reasoning events are absent from OTel output; an agent on a remote
provider that calls the query tool receives 0 reasoning events; a peer replica contains 0
reasoning events.

## Evidence

Lane 1 §3, lane 3 §6 ([research](../research/README.md)).
