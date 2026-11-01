# U2: verifiable macOS package artifacts

**Status:** implementation plan · **Date:** 2026-11-01

## Outcome and boundary

Add a full-gate macOS arm64 packaging task that builds DMG and ZIP with the pinned
Electron/Node toolchain, verifies their actual contents and runs the mounted application
against an isolated temporary data directory. Retain the verified files and a hash/provenance
manifest as CI artifacts. Fix the bundle ID to the owner's accepted value.

This slice prepares delivery. PR merge, public publication, release cadence and the first
version remain unresolved owner choices. It creates no release/tag and introduces no updater.
No Apple credentials exist; builds are explicitly ad-hoc signed, without Developer ID or
notarization. Those properties must be stated in the manifest and user instructions.

## Changes and failure boundaries

- Desktop packaging config, verification scripts and unit tests; CI task inventory/workflow;
  operations documentation and owner decision records. No wire or database migration.
- Require bundled Electron, Chromium and Node license files (D-222). Preserve the narrow
  build-only WTFPL exception (D-223), without allowing that license generally.
- Mount DMG read-only, compare the complete extracted ZIP app tree, including symlink targets,
  file digests and executable bits. Reject missing/multiple apps or unexpected ZIP paths.
- Start only the packaged executable, with temporary node and Chromium data, no checkout
  service overrides or provider keys. Assert renderer mount, isolation and service lifetime.
  Use a loopback-only debugging endpoint during the bounded test, then remove owned processes.
- Always detach the test volume and remove temporary test data; never kill an unverified PID
  or alter an installed service. Failures retain content-free diagnostics rather than user data.
- Record exact Git commit/tree, package version, architecture, bundle ID and SHA-256/size.
  Generated outputs stay ignored. Build jobs have read-only GitHub permissions and no signing
  secrets. No artifact is described as a public release.

## Checks and rollback

Focused desktop units and CI-script tests cover config identity, missing notices, altered ZIP
contents, symlink/executable differences and artifact manifest contents. One real local
package/smoke run establishes Mac behavior; the fifteenth hosted task repeats that envelope
on the final candidate. A separate reviewer checks code, cleanup, permissions and claims;
findings are fixed in a separate commit before full hosted CI.

Existing Electron and Playwright dependencies are reused; no external source is copied and
no new dependency is added. Reverting this slice restores artifact-free CI without migrating
user data. Signing, public-release automation and SDK/voice/browser work remain later slices.
