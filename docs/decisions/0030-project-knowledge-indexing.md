# ADR-0030: Project knowledge indexing only where it measurably helps

**Status:** proposed · **Date:** 2026-10-19

## Context

Large projects may benefit from indexes (embeddings, symbol graphs) per worktree (REQ-H5). The
evidence is split: Cursor dropped embeddings for grep in July 2026, while 2026 studies report
+7.9 points resolve rate from a structural index and RepoMap as the best context per token.

## Decision

- **IX0** grep/ripgrep: always available.
- **IX1** tree-sitter repository map: automatic.
- **IX2** SQLite FTS5 trigram index: automatic above a repository size threshold (built into
  `node:sqlite`).
- **IX3** embeddings (default `qwen3-embedding:0.6b` on a local runtime): opt-in per project,
  enabled by default only after the A/B on the owner's repositories shows a gain (ADR-0025).
- Everything is keyed by content (git blob SHA or chunk hash), so worktrees share vectors and
  re-indexing is incremental.
- Index builds are idle-priority runs under the governor with preemptible leases.
- LSP is used directly (or Serena as a separate process; Serena v2 is GPL-3.0).

## Validation

Offline localisation A/B on the owner's git history (find the files a real commit touched);
index freshness test after branch switches across worktrees.

## Evidence

Lane 5 §4 ([research](../research/README.md)).
