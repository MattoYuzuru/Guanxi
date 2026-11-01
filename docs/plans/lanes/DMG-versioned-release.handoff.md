# Versioned DMG release delivery handoff

**Status:** author implementation and focused local checks complete; independent review and
final hosted integration remain root duties. **Date:** 2026-11-01. **Base:** `6d596ec7`.
**Branch:** `codex/dmg-release`. Plan `eedf48bc`; implementation `1bf949ec`; attempt-history
hardening `91b8908a`; independent-review fix `e70873b7`.

## Implemented scope

- `v*` tag pushes plan all 15 existing CI tasks, including the real macOS package build/smoke,
  and the aggregate Full gate. Main pushes remain quick; ready PRs/manual diagnostics retain
  their existing matrix semantics. Tag workflows are not cancelled by another run on the tag.
- The new publisher job alone receives `contents: write` plus `actions: read`; it checks out the
  exact commit without persisted credentials and performs no dependency install or build.
  Only tag pushes after the full gate can enter publication. All actions use immutable SHAs.
- `scripts/release.mjs` checks clean source, version/tag/commit/tree/main ancestry; fresh remote
  repository/tag/main and current run identity; all required successful jobs; and the original
  successful package job's same-run artifact. Publisher-only reruns reuse that job's attempt
  artifact rather than assuming another build is byte-reproducible.
- The downloaded set is exactly DMG, ZIP, SHA256SUMS and package-evidence.json. Pinned regular
  handles, exact names, sizes, SHA-256, build identity, arm64, permanent app ID and ad-hoc state
  are validated. Symlinks, hardlinks, extra files and inconsistent evidence are refused.
- Paginated release/asset preflight precedes changes to existing drafts. Exact identity and
  identical assets are reusable; extra/duplicate/conflicting/incomplete-upload assets fail
  without clobber. No asset replacement or deletion exists. Create a draft, upload missing
  verified assets, validate responses and the complete set, recheck gate/tag, then publish.
- An ambiguous mutation is never retried within the invocation. A later same-run attempt can
  discover the existing draft or published identical release; published identical is a no-op.
  Incomplete drafts remain for recovery. Different runs/artifacts cannot overwrite them.
- Every supported release remains an explicit alpha prerelease, never Latest, with ad-hoc/
  not-notarized/Gatekeeper wording and a package-instructions link. No stable-signing policy,
  auto-update feed, signing secrets or repository-settings change is introduced.

The future publication effect is documented in [release operations](../../../scripts/release-README.md).
No Guanxi tag, release, push, merge or publication was executed by this lane. The owner's
cadence choice does not choose the first version or authorize today's alpha publication.

## Evidence — new / regression envelope

**New: 54 tests** (53 in `scripts/release.test.mjs`, one in `scripts/ci/ci.test.mjs`).
**Regression: 11 inherited CI tests.** The affected union passed **65/65, zero skipped** at
clean `e70873b7`, under the shared `agent-dev` heavy resource; receipt `check-q9y6fl4x`.
The source fingerprint was unchanged. Receipt reuse remains unsupported because of the
tracked `.claude/skills/guanxi-ui` directory symlink; this is actual local execution evidence,
not reusable source attestation or hosted publication evidence.

Coverage includes temporary real Git identity/annotated tags; branch/PR/manual/forced/dirty/
off-main refusal; required matrix counts, skips/failures/duplicates and cancellation; original
artifact selection across attempts; exact local file/evidence constraints; paginated remote
preflight; create/upload/publish response validation; no clobber; partial and ambiguous retry;
late moved tags/failed gates; and credential-origin/redirect/error hygiene. Temporary Git tags
exist only in synthetic test repositories removed by their fixtures.

| Check | Result |
| --- | --- |
| `node --test scripts/release.test.mjs scripts/ci/ci.test.mjs` | 65 pass, 0 failed/skipped; final shared-lock receipt above |
| ESLint over release scripts and changed CI scripts/tests | exit 0 |
| `actionlint .github/workflows/full-gate.yml` | exit 0 |
| Targeted Markdown lint on plan/release operations | 0 errors |
| `node scripts/check-doc-links.mjs` | 344 files, 957 links, 0 problems |
| `git diff --check` | exit 0 |

`npm ci --no-audit --no-fund` installed this worktree's dependencies; contract resolution was
inside this checkout. Node 26.9.0, Mac only, no Docker/model/live owner data. A bounded read-only
GitHub observation confirmed workflow-job `run_attempt`; no release write occurred. The new
download action pin `018cc2cf5baa6db3ef3c5f8a56943fffe632ef53` was resolved from the official v6
tag. No third-party source or new dependency was copied into the repository.

## Independent review and residuals

Independent reviewer `local_inventory` found that a fresh release read or publication response
with a different positive ID could pass metadata checks. `e70873b7` pins both responses to the
selected release ID and adds two direct fake-response regressions: a mismatched fresh read
cannot publish, and a mismatched publish response cannot report success or automatically retry.
Final read-only recheck is requested. Root owns integration and the final full hosted candidate
gate; this fake-service check alone is not a release-ready verdict.

Author hardening `91b8908a` makes partial-rerun semantics explicit: read all job attempts and
select the highest actual attempt of every required name. Same-attempt duplicates, future or
foreign attempts and a newer failed/incomplete execution are refused; older green checks
cannot override them. Two direct history tests supplement the original artifact-reuse case.
The PR completion command remains unchanged and still requires its actual PR candidate.

Actual tag workflow execution, GitHub upload/publication permissions and immutable release
enforcement remain untested until an authorized version tag is created after integration.
Permission errors fail closed without PAT escalation. Current check artifacts expire after
seven days. A full rebuild/new run may produce different bytes and cannot replace a partial
or immutable release; use the original same-run artifact or explicit operator resolution.
The final read/publish interval is not an atomic transaction against other authorized remote
writers; repeated identity/asset observations and no-clobber writes detect observed conflicts.
