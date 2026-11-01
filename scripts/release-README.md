# Versioned macOS release delivery

**Status:** implementation; fake-service/local checks only until an authorized version-tag run.
No tag, release, publication or release-settings change was performed while building this path.

The owner selected a DMG for each versioned release. This workflow implements the future effect:
an authorized `v<semver>` tag push runs all 15 CI tasks and publishes the verified macOS package
as a GitHub **prerelease** after the aggregate gate succeeds. PRs, branch pushes and manual
diagnostic runs cannot publish. D-234 authorizes the first version `v0.1.0-alpha.1` and PR #5/#6 integration.
The authorization does not bypass review, fresh candidate/tag gates or artifact verification.

The tag must already exist, resolve to the exact checked-out commit, match
`packages/desktop/package.json`, and belong to the ancestry of `main`. Both local clean-source
checks and fresh GitHub tag/main/run/job observations are required. The publisher does not
create/move tags, merge branches, rebuild packages or enable immutable releases.

## Trust and assets

The existing read-only `desktop-package` task builds and smoke-tests the DMG/ZIP, then retains
four files. The publisher alone has `contents: write` and `actions: read`. It uses an immutable
download-action SHA and the selected artifact ID from this same run. A publisher-only rerun
selects the artifact associated with the successful package job's original attempt, even when
the current run attempt is newer. It never downloads the latest successful artifact by branch.
Job verification reads all attempts and selects each required job's highest attempt; a newer
failure or incomplete execution cannot fall back to an older green result. Duplicate names
within one attempt are refused.

Only these regular files are accepted, with no extras or symlinks/hardlinks:

- the exact versioned arm64 DMG;
- the corresponding ZIP;
- `SHA256SUMS` covering those binaries;
- `package-evidence.json`, bound to the clean build's commit/tree/version, app ID, architecture
  and exact binary sizes/digests.

The release remains explicitly alpha/ad-hoc, never “Latest”, Developer ID signed or notarized.
Release notes link to [package instructions](../docs/operations/desktop-packages.md) and explain
Gatekeeper's possible first-launch block. Stable release/signing/update policy is outside this
slice. No signing secrets are read by build or publisher jobs.

## Publication and recovery

`scripts/release.mjs` has `select` and `publish DIRECTORY` CI entry points. It requires the tag
push identity from GitHub Actions; the GitHub token is consumed from the environment and never
passed as a command argument. All HTTP calls use fixed GitHub origins, redirect refusal,
deadlines and content-free errors. Only a draft-create, missing-asset upload and final publish
are possible writes; there is no delete, replacement or automatic mutating retry.

All release pages and asset pages are inspected before changing an existing draft. A matching
draft must carry this exact source/run/artifact identity. Identical assets are skipped; extra,
duplicate, incomplete-upload or conflicting assets fail closed. A new draft receives each
verified file and validates the server's uploaded name, size, state, media type and SHA-256.
The full set, tag and complete gate are rechecked before publication. This sequence follows
GitHub's [immutable-release preparation](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

An interrupted upload leaves a draft. Rerun the publisher job from the **same workflow run**
while its original package artifact is retained; accepted bytes are reused, never regenerated.
An ambiguous create or publish is discovered on the next attempt rather than automatically
retried. A published identical release is a no-op. A full rebuild/new run with different bytes
or identity cannot overwrite a partial or immutable release; it needs explicit operator
resolution. The job's read-only/package artifacts currently expire after seven days.

GitHub permission failures, expired artifacts and identity conflicts are explicit failures.
No PAT escalation or repository-policy change is attempted. Actual hosted tag publication,
upload permissions and immutable-release enforcement need an authorized integration run;
fake HTTP does not prove them. The check/publish interval is not a transaction against other
authorized repository writers; final rechecks and no-clobber writes detect observed conflicts.
