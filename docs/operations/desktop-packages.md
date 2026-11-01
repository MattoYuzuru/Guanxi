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
or provider credentials. Its Chromium process uses `--use-mock-keychain` and
`--password-store=basic`, matching Playwright's Electron launcher. Without that test isolation,
an unsigned app can block cookie initialization on a macOS Keychain prompt (see
[Electron's upstream test fix](https://releases.electronjs.org/pr/53790)). This is a test-process
setting; production cookie encryption remains enabled. An empty synthetic node vault also
keeps its independent K3 keychain provider lazy. This gate does not validate the owner's OS
Keychain, login or downloaded-app onboarding. The renderer test checks mount, Node isolation, installed CSP and
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

DMG for each versioned release is accepted (D-233). D-234 authorizes PR #5/#6 integration and the first
version v0.1.0-alpha.1.
After the authorized candidate passes review and fresh CI, use a versioned tag → full
gate/package → draft release → verified assets → publish sequence, compatible with
[immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
Publisher-only retries must reuse the same verified package bytes, compare every existing
asset before writing and refuse conflicts; DMG/ZIP byte reproducibility is not assumed.
Keep upload permissions out of build/PR jobs. The future tag workflow is implemented and
fake-service tested in [release operations](../../scripts/release-README.md); actual authorized
publication, permissions and immutable-release integration remain unvalidated.

## Failure recovery

The verifier signals only its child shell and a temporary service whose UID, executable,
entry and data-directory arguments match. An unobservable process is not called stopped.
If volume detach fails, the error retains the task mount path and verification/detach causes;
inspect that exact retained sandbox and its process ownership before recovery. A failed smoke
whose volume detaches successfully removes its temporary files. Never kill
a port occupant by number alone, force-unmount another volume, or delete retained user data.
