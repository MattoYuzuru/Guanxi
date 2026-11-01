# First macOS alpha release

**Status:** authorized by the owner · **Date:** 2026-11-01

## Outcome and scope

Merge reviewed PR #5, refresh PR #6 onto main, prepare `v0.1.0-alpha.1`, pass its full hosted
gate, then merge #6 and push that version tag on the resulting main commit. The tag pipeline
must build/verify the package and publish its four verified assets as an ad-hoc alpha prerelease.
The owner explicitly authorizes these merges/publication and autonomous continuation on
plugins, accounts and GitHub sync. New feature lanes remain outside the first alpha candidate.

Use one product version constant for CLI/node reporting, matching desktop/CLI/server package
metadata and lock entries. Kernel API and wire protocol compatibility versions stay separate;
no dependency, schema, public API removal or user-data migration is intended.

## Gates, failure and recovery

PR #5 keeps its exact existing reviewed head/full gate and is merged with a merge commit.
The refreshed #6 candidate receives independent review of version/docs changes and a fresh
15-task hosted gate, including the real package smoke. Do not repeat local GUI/Keychain tests.
The smoke keeps its mock-Keychain isolation; actual OS Keychain, Developer ID/notarization,
updater, paid inference and other owner hosts remain outside this release's validation.

Check main/tag identity, package version, all required tag-run jobs and same-run asset hashes
before declaring publication complete. The publisher must never clobber an asset or mutate
an existing published release to recover. On ambiguous writes inspect actual API state once;
follow the publisher's same-run recovery contract. A failure leaves its draft intact for
inspection, not an automatically published incomplete release. Do not delete/move tags or
rewrite public history as rollback. Roll forward with a reviewed new version if required.

## Verification

Add a cross-boundary version-coherence assertion; run the affected CLI/server version tests
and release/CI policy tests. Existing P1/package/release reviews and tests remain evidence for
unchanged behavior, while exact full hosted checks bind the new candidate. Record merge SHAs,
head/base/tested revision, release run and verified download URLs in the handoff/PR evidence.
