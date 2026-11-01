# Versioned macOS release delivery

**Status:** implementation plan under the owner's versioned-DMG cadence decision (2026-11-01).
**Base:** `6d596ec7`; branch `codex/dmg-release`; author owns workflow/CI/release scripts only.
Root integrates and records owner decisions; a separate agent reviews this change. No tag,
release, push, merge or publication will be executed during implementation.

## Outcome and trust boundary

A future `v<semver>` tag push runs the same complete 15-task matrix, including the existing
macOS package build/smoke. Branch pushes remain quick, and PR/manual diagnostic events never
publish. The publisher alone has `contents: write`; build/check jobs remain read-only and
receive no signing secrets. Tag publication is an intended future workflow effect, not an
authorization to publish the current alpha or choose its first version now.

Before writes, require the exact tag/commit/version, clean source, main ancestry and package
evidence bound to that commit/tree/app identity. Recheck remote tag/main and every matrix job
in the current workflow run. Consume the successful desktop-package job's artifact from this
same run, including on a partial rerun; never rebuild packages in the publisher or assume
byte reproducibility across runs.

Create a draft only after preflight; list all releases/assets with pagination, reject duplicate
release/tag or asset names, extra files and conflicting bytes before mutation. Upload only the
verified DMG, ZIP, SHA256SUMS and package-evidence.json. Existing identical assets are skipped,
never deleted/replaced. Validate upload size, digest, state and response identity, re-list and
verify the complete asset set, then publish the draft. Already-published identical releases
are a no-op; incomplete/conflicting published releases fail closed. A failed partial draft is
retained for the same-run artifact retry, compatible with immutable GitHub releases.

## Checks and residuals

Use pure/temp-file tests plus fake GitHub HTTP: tag/event/version/ancestry policy, complete
matrix failures/skips/duplicates, same-run artifact selection across attempts, local exact-file
and regular-file/digest checks, paginated release/asset conflicts, draft/upload/publish order,
response validation, partial retry and zero mutation on preflight failures. CI planner tests
pin tag full-matrix selection and publisher-only write permissions/triggers. Run affected Node
tests, ESLint, actionlint and Markdown/link checks under the common heavy resource where needed.
No desktop build or remote service mutation is needed for this lane's local verification.

Hosted tag execution, GitHub permissions and immutable-release enforcement remain untested
until an authorized version tag is created after integration. Existing ad-hoc/Gatekeeper and
Developer ID/notarization limitations remain. Do not change account/release settings.

Primary protocol references: [immutable release preparation](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases),
[release API](https://docs.github.com/en/rest/releases/releases),
[release assets](https://docs.github.com/en/rest/releases/assets),
[Actions artifacts](https://docs.github.com/en/rest/actions/artifacts).
