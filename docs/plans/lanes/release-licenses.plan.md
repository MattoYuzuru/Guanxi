# First alpha bundled legal notices

**Status:** authorized implementation plan · **Date:** 2026-11-01 · **Base:** `71087caf`.

## Outcome and scope

The current desktop staging omits the repository's OFL texts while shipping IBM Plex font
binaries. ADR-0016/D-129 require those texts. Add `service/licenses` to the existing staged
service: preserve repository LICENSE, NOTICE, THIRD_PARTY_NOTICES, both font OFL texts and
the models.dev metadata license byte-for-byte. Add a clearly labelled collection of available
top-level LICENSE/NOTICE/COPYING texts from installed lock-derived inputs under root
node_modules only. This collection is an attribution superset, not a claim that every
inventoried package ships. It does not inventory workspace-local or every staged runtime
version; staged runtime dependencies retain their original notices in service/node_modules.

The collector reads package metadata only for name/version/license and copies only allowed
legal-text filenames; it does not read credentials, config, source files or follow symlinks.
Resolve only safe lock paths below the checkout's root node_modules; skip lock workspace
links and unavailable optional packages, recording availability explicitly. Reject unsafe
paths, symlink components, invalid metadata and nonregular notice sources. A deterministic
manifest records source identity, output paths, sizes and SHA-256 digests without timestamps
or absolute paths. No new dependencies or downloaded/copied source code are needed.

Staging assumes an isolated, unchanged trusted installation. Existing symlinks are rejected
with component checks/O_NOFOLLOW and file pre/post checks; these are not descriptor-relative
directory traversal and do not guarantee confinement against hostile concurrent writers.

## Implementation and failure boundary

Add a pure filesystem collector/verifier under desktop `scripts/lib`, call it after the
staged npm install, and extend `verifyNotices` to require the known project/font/data texts
and validate the collection manifest/files/digests. Staging failure prevents package creation;
package smoke failure prevents evidence publication. Keep Electron/Chromium/Node original
notices and the D-223 build-only-code prohibition. Document collection scope in
THIRD_PARTY_NOTICES. No app/runtime, vault, signing, encryption or public API changes.

Use temporary fixture trees for byte preservation, deterministic order/manifest, scoped and
nested lock inputs, absent optional packages, metadata projection, path traversal, symlink,
nonregular source and missing/tampered required-file tests. Run the focused desktop unit
files, desktop types, scoped ESLint and docs/link checks with Node 26.9.0 and the shared
agent-dev heavy lock; own npm ci first. Do not run local GUI, Keychain, model or owner data
tests. A separate reviewer examines the exact commit and any fixes land separately; the
integrator owns fresh full hosted package/CI evidence and publication.

## Recovery and limits

Rollback removes only this additive build collection/staging hook; no user database or
retained data is modified. Do not claim a license-completeness opinion for packages lacking
top-level legal texts, or infer bundled code from the superset manifest. Existing license
allowlist checks remain required. First-alpha publication stays blocked until this fix and
fresh current-candidate hosted checks pass. No tag, release, push or publication is performed
by this lane.
