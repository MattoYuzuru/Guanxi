# macOS package artifacts

**Status:** implementation prepared; final candidate smoke and hosted evidence in PHASE_STATUS
**Updated:** 2026-11-01

## Build and verify

Use a clean committed checkout, Node 26.9.0 and locked dependencies on an Apple Silicon Mac.
The first build downloads pinned Electron and a digest-checked official Node archive.

```bash
npm ci --no-audit --no-fund
GUANXI_DESKTOP_SIGN=0 GUANXI_DESKTOP_NOTARIZE=0 CSC_IDENTITY_AUTO_DISCOVERY=false \
  npm run package:mac --workspace @guanxi/desktop -- --publish never
npm run test:package --workspace @guanxi/desktop
```

The wrapper records source commit/tree before building, refuses source changes and binds
DMG/ZIP bytes to `release/build-evidence.json`. Verification refuses stale/different files,
mounts DMG read-only, preflights/extracts ZIP and compares complete app files, symlink targets
and executable bits. It checks bundle ID/version, notices, pinned Node and ad-hoc signatures.
The mounted packaged executable uses temporary node/Chromium data, no checkout overrides
or provider credentials. The renderer test checks mount, Node isolation, installed CSP and
resource errors; service lifetime and confirmed cleanup are asserted. No model run is tested.

Successful verification writes `release/package-evidence.json` and `SHA256SUMS`. The full
ready-PR gate retains DMG, ZIP and these two files as `macos-arm64-package-ATTEMPT` for seven
days. Build/test receipts and failure diagnostics are separate. Artifacts are verification
outputs, not public releases or an update feed. There is no new package dependency or
third-party source copy in this slice.

## Distribution and signing

The accepted permanent bundle ID is `io.github.mattoyuzuru.guanxi` (D-224). Apple Developer
credentials are absent; Developer ID signing and notarization are deferred. Ad-hoc signing
makes the arm64 binary runnable but does not identify a developer or satisfy notarization.
The license exceptions are approved (D-222/D-223), and their notices remain in the app.

For a future explicitly published unsigned alpha, copy the app to Applications and attempt
opening it, then use System Settings → Privacy & Security → Open Anyway if macOS offers the
per-app exception. Follow [Apple's current instructions](https://support.apple.com/102445).
Do not disable Gatekeeper globally. A locally built unquarantined smoke is not proof of the
downloaded/quarantined onboarding flow; that needs a separate observation.

PR merge/publication authority, release cadence and the first version remain Q-249/Q-250.
Do not create a release/tag from this runbook. Once accepted, use a versioned tag → full
gate/package → draft release → verified assets → publish sequence, compatible with
[immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
Publisher-only retries must reuse the same verified package bytes, compare every existing
asset before writing and refuse conflicts; DMG/ZIP byte reproducibility is not assumed.
Keep upload permissions out of build/PR jobs. This publication workflow is still unimplemented.

## Failure recovery

The verifier signals only its child shell and a temporary service whose UID, executable,
entry and data-directory arguments match. An unobservable process is not called stopped.
If cleanup or detach fails, the error retains the task mount path and both failure causes;
inspect that exact temporary sandbox and its process ownership before recovery. Never kill
a port occupant by number alone, force-unmount another volume, or delete retained user data.
