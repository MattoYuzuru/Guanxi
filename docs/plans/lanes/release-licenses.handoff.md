# First alpha legal-notice packaging — handoff

**Status:** implemented, independently reviewed and locally checked; fresh hosted package
gate required. **Date:** 2026-11-01. **Base:** `71087caf`. **Branch:** `codex/release-licenses`.
Plan: `1b8e7c13`; author implementation: `bf9f5b54`; review fix: `f6c72ab7`.

## Delivered boundary

The staging hook now creates `service/licenses` with byte-preserved project LICENSE, NOTICE,
THIRD_PARTY_NOTICES, IBM Plex Sans/Mono OFL texts and the models.dev metadata MIT license.
It adds available top-level LICENSE/LICENCE/NOTICE/COPYING texts from installed root
node_modules paths named by the root lock. A README and deterministic manifest describe this
as a legal-text superset of inputs under root node_modules only, never a bundled-code
inventory. Workspace-local modules and every staged runtime version are not inventoried;
staged runtime dependencies retain their original notices under service/node_modules.

Only package name/version/license fields are projected. Workspace links and unavailable
platform packages are explicit; paths outside root node_modules are excluded. Traversal,
symlink components, nonregular/hard-linked/non-text sources and stale installed versions
fail closed. Collection creates a new owned directory and preserves existing output on
collision. Each copied file has source, byte size and SHA-256 provenance.
Staging assumes an isolated unchanged trusted install; component/O_NOFOLLOW and pre/post file
checks are not descriptor-relative directory traversal and provide no hostile concurrent
directory-writer confinement guarantee.

`verifyNotices` now calls the collection verifier, requires every known repository/font/data
text, compares those bytes against the checkout and verifies manifest membership/digests.
Existing Electron/Chromium/Node notices remain required. The D-223 build-only dependency code
still cannot appear in the staged runtime modules; its legal-text inventory may appear in
the explicitly labelled build-input superset.

## Validation: new / regression envelope

**New:** 10 tests in `legal-notices.test.ts`. **Regression envelope:** 28 inherited tests in
`package-evidence.test.ts` and `stage-scripts.test.ts`; the existing notices test now also
removes each of the six required copied texts and asserts the actual package verifier fails.
Focused union: **38 passed, zero failed/skipped** on Node 26.9.0 under the shared heavy lock.
Final receipt at `f6c72ab7`:
`/Users/yuzuru/.local/state/agent-dev/check-sx26x6bw/result.json`.

New fixtures cover exact bytes, metadata/file allowlists, scoped/nested lock inputs, absent
platform inputs, no-text packages, determinism, traversal, symlinked parents/metadata/text,
directories/hard links, stale versions, invalid metadata, empty/non-text/missing notices,
output preservation and missing/altered/extra/tampered manifest contents.

An actual own-install, no-runtime collection at `f6c72ab7` also passed verification:
1,066 lock inputs, 925 installed packages and 887 legal files including mandatory texts and
README. It created and removed only its own temporary output. Receipt:
`/Users/yuzuru/.local/state/agent-dev/check-62uh7rbx/result.json`.

The receipts report unchanged source during each run but are **not reusable** because the
pre-existing tracked `.claude/skills/guanxi-ui` symlink prevents the runner's full-source
fingerprint. These are scoped local observations, not substitutes for fresh hosted CI.
Own `npm ci --ignore-scripts --no-audit --no-fund` completed before checks.

Desktop typecheck, scoped ESLint, Markdown lint and `git diff --check` passed. The handoff
link check covered 348 Markdown files / 965 links with zero problems. No local DMG build,
GUI, OS Keychain, model, owner-data test, provider call, remote write, push or publication ran.

## Review, residuals and integration

Independent reviewer `local_inventory` reviewed exact `71087caf..bf9f5b54` and found a scope
wording issue: the npm superset label could imply workspace-local/staged versions were also
inventoried. Separate fix `f6c72ab7` narrows the manifest/README/docs and adds direct assertions;
it also commits the isolated-input/concurrent-writer limit. The reviewer re-reviewed that
exact fix and returned PASS with no remaining concrete finding. The reviewer ran no tests
or GUI/Keychain checks; execution evidence above is the author's.

Only assigned desktop scripts/tests, THIRD_PARTY_NOTICES and this lane's plan/handoff changed;
no central status or runtime/secret/crypto behavior changed. No dependency/source download
was added. The collection does not assert legal completeness for inputs lacking a top-level
text; existing allowlist checks remain required. The integrator must run a fresh current-head
full gate, including mounted package notice verification, before first-alpha publication.
Rollback removes only the additive build hook/collection, without user-data migration.
