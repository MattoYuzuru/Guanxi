# Project knowledge index (X1)

**Status:** implemented; local gate evidence is recorded in
[X1 hand-off](../../../../docs/plans/lanes/X1.handoff.md).

`guanxi.project-index` provides the frozen `project.index` kernel service. It requires the
process-local Resource Governor and K2 `egress.scrubber`. Native projects register their
roots on load, root changes and session creation. Registration schedules a background build;
queries also register roots. No model or network is used by the index.

## Levels and settings

- IX0: literal Node search is always available, including without a database or plugin. No
  ripgrep binary is bundled. Search is case sensitive; it returns paths, line numbers and
  matching lines. The default result limit is 200 with an explicit `truncated` flag. The
  internal service accepts a caller-supplied limit; native tools can narrow the path.
- IX1: cached tree-sitter declarations for TypeScript/TSX/JavaScript, Python, Go, Rust, Java,
  C/C++, plus Markdown ATX/setext headings outside fences. Unknown languages, missing or
  incompatible grammars return file entries. Queries made before a build return file entries.
- IX2: SQLite FTS5 with `trigram case_sensitive 1`, automatically populated when a root has
  at least `ftsMinFiles` eligible text files. Queries shorter than three Unicode code points,
  an unavailable FTS database, and content without an FTS row use literal search.
- IX3: absent. The future embedding flag is inert, including when true. X2 owns the A/B,
  opt-in policy and any future implementation (D-169). No embedding model is loaded.

`start({ indexSettings })`, `projectIndexPlugin` configuration `settings`, and `ProjectIndex`
options accept the following documented policy settings. They are defaults, not fixed limits:

| Setting | Default | Meaning |
| --- | --- | --- |
| `ftsMinFiles` | 1000 | Eligible text-file count that activates IX2; zero forces it |
| `maxFileBytes` | 2097152 | Per-file safety policy; larger/binary/non-UTF-8 files count as skipped |
| `pollMs` | 5000 | Background root refresh and deferred-build retry interval |

The scanner honors root and nested `.gitignore` rules, including negation, for tracked and
untracked files. It always excludes `.git`, `node_modules`, every `.env*` path component,
symlinks, and paths/files changed by the registered K2 scrubber. It waits for source readiness
by deferring builds; queries fail closed when the scrubber is not ready. Git hooks, filters,
external helpers and global config are never run. Git is used only for the checked-out commit;
non-git directories work with a null commit. No global git excludes are read from the home
folder. Root overlap with the data directory or the filesystem root is refused.

## Freshness, storage and recovery

Data lives in `<dataDir>/knowledge-index/index.sqlite`, with a private captured worker runtime
also under the data directory. The scanner only opens root files for reading. Worker source
is captured at service creation so later checkout edits cannot replace a launched worker.

SHA-256 of file content keys `contents`; `(hash, language, parser-version)` keys `maps`. One
content and FTS row is shared across every worktree. A canonical-root hash selects the
separate `files` manifest and `roots` observation. Every query reads a fresh filesystem
snapshot and hashes its eligible content before trusting the cache. Newly edited content
uses literal search; removed/renamed/ignored paths cannot contribute stale hits. Every
successful result includes observation time, current commit, indexed commit, index age,
eligible/indexed/skipped/symbol coverage, and freshness scope (`verified-snapshot`). This is
a snapshot observation, not a filesystem-wide transaction against concurrent external edits.
The scan cost is linear in eligible bytes; X1 claims incremental parsing and shared content,
not a measured localisation speedup or an O(1) freshness check. B1/X2 benchmarking remains.

Content writes commit individually. The manifest is published in a single transaction only
after a second scan matches the content fingerprint and commit. Worker termination can leave
reusable content, but cannot publish half a manifest. Restart/retry rebuilds the manifest;
SQLite WAL and `synchronous=FULL` protect transaction recovery. Sidecar `user_version = 1`
is independent of the main node migrations; future versions are refused. Removing the
sidecar while the node is stopped rebuilds the index from roots and leaves projects intact.

## Scheduling and tools

Builds run in a worker thread under `ResourceGovernor.tryIdleLease`. This CPU/IO lease is
separate from the accelerator permit: queued or active model work prevents admission, any
new model ticket aborts the exact idle owner, and a second idle writer waits for actual
release. Interactive admission never awaits index cleanup. Unload/cancel terminates workers.
This is a process-local background run, not an R1 durable inference run or a fleet lease.

D-189 admission and one-second resampling use CPU counters/load, available memory, thermal
observations and foreground input idle time where available. macOS uses `memory_pressure -Q`,
`pmset -g therm` and IOHID idle time; Linux uses procfs/sysfs. No window or app names are read.
Active/unknown foreground reserves 15% available memory and admits below 65% CPU busy;
observed idle uses 8% and 85%. Thermal pressure denies admission. Unknown thermal/foreground
observations use the conservative policy and report partial confidence, source and time.
This is a conservative local policy, not fleet placement or a hardware-fit claim.

Native tools use immutable session roots. `repo.map` uses the provider-safe wire alias
`repo_map`; `budget` is the positive conservative token bound, measured as UTF-8 bytes of the
**complete JSON result**, including provenance and the bound itself. Entries/symbols are
trimmed until it fits; a budget too small for the metadata is refused. This applies to
byte-level tokenizers. K4's existing large-output artifact policy still applies.

For a single-file map, an installed language server is addressed directly over stdio LSP
(initialization, document open, document symbols). It runs through `ExecutionOwner` with
read-only roots and no egress, even in Full access. Known optional executables are
`typescript-language-server`, `pylsp`, `gopls`, `rust-analyzer`, `jdtls` and `clangd`, captured
from PATH at startup. The server must be available inside that execution environment;
a host-only macOS installation may be unavailable in the container and falls back to the
cached map. Missing/error/timeout/malformed responses also fall back. No server, Serena or
GPL code is bundled. LSP can write only to scratch under the existing execution policy.

## Exact dependencies and licenses

Only npm dependencies are used; no upstream code, prompt, query file or binary is copied into
the repository. WASM grammars are loaded from their exact packages; native grammar bindings
are not imported. Each upstream tagged license was verified as MIT on 2026-10-21:

| Dependency | Pin | License source |
| --- | --- | --- |
| `web-tree-sitter` | 0.25.10 | [tree-sitter](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/LICENSE) |
| `tree-sitter-typescript` | 0.23.2 | [TypeScript](https://github.com/tree-sitter/tree-sitter-typescript/blob/v0.23.2/LICENSE) |
| `tree-sitter-javascript` | 0.25.0 | [JavaScript](https://github.com/tree-sitter/tree-sitter-javascript/blob/v0.25.0/LICENSE) |
| `tree-sitter-python` | 0.25.0 | [Python](https://github.com/tree-sitter/tree-sitter-python/blob/v0.25.0/LICENSE) |
| `tree-sitter-go` | 0.25.0 | [Go](https://github.com/tree-sitter/tree-sitter-go/blob/v0.25.0/LICENSE) |
| `tree-sitter-rust` | 0.24.0 | [Rust](https://github.com/tree-sitter/tree-sitter-rust/blob/v0.24.0/LICENSE) |
| `tree-sitter-java` | 0.23.5 | [Java](https://github.com/tree-sitter/tree-sitter-java/blob/v0.23.5/LICENSE) |
| `tree-sitter-c` | 0.24.1 | [C](https://github.com/tree-sitter/tree-sitter-c/blob/v0.24.1/LICENSE) |
| `tree-sitter-cpp` | 0.23.4 | [C++](https://github.com/tree-sitter/tree-sitter-cpp/blob/v0.23.4/LICENSE) |
| `ignore` | 7.0.5 | [node-ignore](https://github.com/kaelzhang/node-ignore/blob/7.0.5/LICENSE-MIT) |

`PARSER_VERSION` includes grammar pins; grammar changes must invalidate that key. The lockfile
pins package integrity. `npm run check:licenses` covers the installed dependency metadata;
parser tests require actual WASM symbol extraction for every required language.
