# U2 package CI handoff

**Status:** implementation/review and local mounted smoke complete; final hosted gate
pending at this document's commit. **Date:** 2026-11-01. **Base:** `574bb3bf`.

## Implemented and independently reviewed

`c69c8e93` adds the fifteenth task, arm64 DMG/ZIP verification and artifacts. Separate fixes
`bbc1ca83`, `1e896b74`, `f278b55d`, `88c1adc5` address path aliases/cleanup, build-time
provenance, resource/reload assertions and early instrumentation. Read-only review passed
those boundaries at `88c1adc5`; later `33d3ba6b` improves synthetic status diagnostics.

The build wrapper records clean source before/after build and exact package hashes. The
verifier refuses stale bytes, compares mounted DMG/extracted ZIP files, internal symlinks and
executable bits, verifies notices, bundle/version, pinned Node and ad-hoc signature, then
starts only the packaged app. Renderer origin/mount, new-loader reload, no Node globals,
installed CSP, resource errors and service survival/confirmed cleanup have direct assertions.

The accepted permanent bundle ID and scoped licensing exceptions are recorded by D-222–D-224.
The [release lane](DMG-versioned-release.handoff.md) adds version-tag promotion after all
checks; no real release has been made and current publication authority/version remain open.

## Keychain incident and corrected test boundary

Direct smoke/diagnostic launches omitted `--use-mock-keychain`/`--password-store=basic`, which
the installed Playwright Electron launcher supplies. The owner reported repeated missing
Keychain/reset prompts and app windows. All known temporary app/Node processes were stopped;
no Keychain reset, deletion or OS settings change was performed. The user was told to Cancel.
An app selection by display name also showed the default port; that shell was immediately
quit. Do not launch by name during future diagnostics or infer that retained owner state
belongs to a disposable fixture.

[Electron's upstream report](https://releases.electronjs.org/pr/53790) identifies unsigned-app
cookie initialization as a source of Keychain prompts/timeouts. Earlier late-CDP, timeout and
foreground experiments did not establish an independent root cause; a single early success
does not prove a fix and could have depended on an external prompt response.

Separate fix `a51adfe6` gives **only the test process** Chromium's mock-Keychain flags, with
exact argv and unchanged production cookie-encryption assertions. Independent read-only
review passed. Empty K3 vault registration was traced separately: no secret rows means the
OS keychain provider is never invoked; provider-key import is explicitly disabled. No new
plaintext key or production bypass is added. Real OS Keychain security/onboarding is outside
the test's evidence. The full isolated mounted flow passed at `a57a42ac` (`check-ixv3t383`, 11.9 seconds), after
fresh build `check-hp7o65g5`. DMG/ZIP contents, notices, runtime/signature/identity, renderer,
CSP/isolation, service survival and owned cleanup all passed. No additional local GUI repro
is needed for unchanged source; complete the hosted candidate gate.

## Checks and residuals

Combined packaging/release scope: **62 new / 173 inherited**, 235 passed, zero skips on the
Mac (`check-ujt7xptp`). The release author's 54 new / 11 inherited are included, not additive.
Desktop types passed (`check-swfzhfby`); lint passed with four existing noInlineConfig warnings;
Markdown/links and 875-package license gate passed. The successful mounted
artifact's receipt names exact source `a57a42ac71de07e97092e8e5a3a42c2108676155` and tree
`b2f601e1b9dd8722fe43262a21b455d2fc0a56c0`. Later documentation does not change those bytes;
final hosted CI builds its own exact candidate again.

Local agent-dev receipts cannot be reused as source attestations because of the tracked
`.claude/skills/guanxi-ui` directory symlink. Final exact source/run identity comes from the
ready PR's full hosted gate and `ci:finish`. Capture the run URL, head/base/tested SHA in PR
evidence after success, without changing the tested source afterward.

No live model, provider billing, other owner host, downloaded/quarantined-app Gatekeeper
onboarding, Developer ID, notarization, updater or real published release is validated here.
Preserve production encryption and never reset a keychain to make an automated test pass.
