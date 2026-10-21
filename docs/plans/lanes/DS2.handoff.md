# Lane DS2 hand-off — approval signing helper

**Status:** implemented on `lane/ds2-signing-helper` · **Updated:** 2026-10-21 · **Prompt:**
[DS2.md](DS2.md)

## What was built

1. **Approval format.** Approvals and revocations now use `guanxi.ui-approval/3` and
   `guanxi.ui-revocation/3`, signed with ECDSA P-256 / SHA-256 in IEEE P1363 form (64-byte r‖s,
   base64). Trusted keys are `algorithm: "p256"` with
   `keyId = "p256:" + sha256(SPKI DER).slice(0, 32)`; the parser accepts only P-256
   (`asymmetricKeyType === 'ec'`, `namedCurve === 'prime256v1'`). `verify.ts` verifies with
   `dsaEncoding: 'ieee-p1363'`, and the key-set rotation signature uses the same scheme. The
   `/2` Ed25519 schema is removed and documented as never used.
2. **Native helper.** `native/approval-signer/` contains `Sources/main.swift`, `build.sh` and
   `README.md`. It implements `status`, `init` and `sign` over one JSON request/response per
   invocation, creates a Secure Enclave P-256 key with
   `.privateKeyUsage + .userPresence`, stores the wrapped blob in the login keychain behind a
   `SecAccessCreate` access list that trusts only the helper's path, checks canonical JSON and
   the `/3` schemas, builds the exact approval/revocation reason, creates a fresh `LAContext`
   with zero reuse and signs. The test build (`-D GUANXI_SIGNER_TESTING`) uses a raw software
   key in a temp directory, a fake authenticator with an auth log, a file-backed item and an
   optional throwaway keychain. Production builds fail the `strings` check if `SIGNER_TEST_`
   survives.
3. **Installer and node signer.** `packages/server/scripts/install-approval-signer.ts` builds,
   copies to `<home>/Library/Application Support/<PRODUCT_NAME>/approval-signer/<PRODUCT_FILE_PREFIX>-approval-signer`,
   sets mode `0755`, re-signs ad hoc, prints the path and accepts `--home`. `signer.ts` no longer
   has the `security`/keychain signer; `helperSigner()` runs the helper with `execFile` (no shell),
   writes one request to stdin, caps stdout at 64 KiB, times out at 120 s and maps helper errors.
   The server constructs it at the installed path. `approval-key.ts init` now runs the installed
   helper's `init` and prints the `p256` entry; its Ed25519 keychain code is gone.
4. **Exit-gate tests.** `packages/server/test/ui-catalog-signer-exit-gates.test.ts` proves the
   seven item-4 boundaries; the helper protocol and adapter tests live in
   `ui-catalog-signer-helper.test.ts` and `ui-catalog-signer-install.test.ts`.
5. **Docs.** The helper README and this hand-off cover the protocol, install, rationale and
   residuals. `docs/design/COMPONENTS_AND_CATALOG.md` §4.1 and §8 describe the `/3` format and
   the helper instead of the old Ed25519 keychain path.

## Gate evidence (new envelope)

Each item was developed test-first; the mutation is the guard removed after the test passed,
then restored.

| Gate item | Test | Mutation | Result |
| --- | --- | --- | --- |
| 1. approvals are P-256 `/3` | `verifies a P-256 approval and rejects one flipped signature byte`; `accepts only P-256 public keys`; `rejects an Ed25519 key in approval-keys.json`; `rejects a payload still signed under the /2 (Ed25519) schema`; server review tests | `verify.ts` switched back to `verify(null, …)` (Ed25519 mode) | 28 tests failed, including the P-256 verification and every signed-record test; restored → 102 pass, 0 fail, 1 opt-in keychain test skipped at that stage |
| 2. helper protocol | `reports missing before init, creates the key once and reports it without prompting`; `signs the exact canonical payload bytes and the signature verifies`; `writes the exact approval reason to the fake authenticator log`; `refuses a non-canonical payload, the removed /2 schema and an invalid id`; `refuses to sign when the fake authenticator denies, returning signing_denied only` | canonical-payload guard removed from `main.swift` | 1 test failed (`payload_not_canonical` case), restored → 107 pass, 1 skipped |
| 3. installer and node signer | `installs the helper under the brand path, executable and ad-hoc signed`; `maps a missing helper to signer_helper_missing without running anything`; `exposes only keyId, publicKey and signature, and signs the exact bytes it receives`; `maps a non-canonical payload to payload_not_canonical`; `times out a helper that does not answer, and refuses unbounded output`; `creates the owner entry through the installed helper and prints it in P-256 form` | `helperSigner` mapped `payload_not_canonical` to `payload_schema` | 1 test failed; restored → 110 pass, 0 fail, 0 skipped |
| 4.1 key bytes never leave | `never lets key bytes or the test item escape through stdout or stderr` | none applied; scans raw, base64, base64url, hex (both cases), latin1 and item bytes over status, init and three signs, then checks node return keys | pass |
| 4.2 prompt names component and hash | `names the component and the full source hash in the one prompt` | approval reason changed to omit `, source <hash>` | 1 test failed; restored → pass |
| 4.3 every signature needs confirmation | `requires one confirmation per signature and none for a denial` | none applied; asserts 3 auth lines for 3 signatures and `signing_denied` with no signature under deny | pass |
| 4.4 payload integrity | `refuses non-canonical payloads, the removed /2 schema and invalid ids` | covered by the item-2 canonical-guard mutation | fail under mutation, pass after restore |
| 4.5 signatures verify | `verifies a helper signature and G12 accepts only a trusted key` | covered by the item-1 `verify(null, …)` mutation | fail under mutation, pass after restore; G12 passes with the helper key in a temp `approval-keys.json`, fails with an untrusted P-256 key |
| 4.6 production has no test hooks | `fails the production hook check when a test build leaks SIGNER_TEST_` | builds with `-D GUANXI_SIGNER_TESTING` and calls the production `--check` | production check 0; leaked test build check 1 with `contains test hooks (SIGNER_TEST_);` |
| 4.7 keychain access list | `trusts only the helper path in a throwaway keychain access list` | none applied; the test itself exposed a real bug: `kSecUseKeychain` does not scope `SecItemCopyMatching`, so status reported missing. Fixed with `kSecMatchSearchList` for searches in commit `b3c8cd0` | pass on this Mac, not skipped: exactly one trusted application, the test binary's path; the throwaway keychain never entered the search list |
| 5. documentation | README and this hand-off; design doc §4.1/§8 | none (docs-only) | reviewed against the implemented protocol |

## Commands and final result lines

Run from the repository root, exactly these two targeted commands:

```sh
nice -n 10 node --test packages/server/test/ui-catalog*.test.ts packages/ui/gates/catalog/test/*.test.ts
nice -n 10 sh native/approval-signer/build.sh --test
```

Final results on this Mac (macOS 26.7, Apple M5 Pro, Swift 6.3.3, Node 26.9.0):

```text
ℹ tests 117
ℹ suites 21
ℹ pass 117
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37115.719209
```

```text
/Users/yuzuru/Projects/Guanxi-lanes/dsh-ds2/native/approval-signer/.build/approval-signer-test.tmp.13070: replacing existing signature
exit:0
```

Additional checks used by the tests:

- `sh native/approval-signer/build.sh` → production binary at `.build/approval-signer`.
- `sh native/approval-signer/build.sh --check .build/approval-signer` → exit 0.
- `sh native/approval-signer/build.sh --check .build/approval-signer-test` → exit 1,
  `contains test hooks (SIGNER_TEST_)`.
- The throwaway-keychain test ran, not skipped. It creates a keychain in the temp directory,
  never adds it to the search list, and restores `security list-keychains -d user` afterwards.

## What could not be run

- `npm test`, `npm run typecheck`, `npm run build`, `npm run test:web:browser`, `npm run lint:md`
  and `npm run check:licenses`: forbidden by the lane prompt; the integrator runs the full gates.
- The production helper's `init` and `sign`: forbidden by the hard rules. The only production
  paths exercised are the build, codesign and `strings` check. `status`, `init` and `sign` are
  tested through the test build only.
- The owner's real login keychain: never touched. `approval-key.ts init` was tested only with
  `--helper` pointing at the test build and a software key.
- Merging `main`, rebasing, pushing and independent cross-family review: not allowed by the
  prompt; the integrator owns those.

## Residual risk

- A process that obtains the wrapped blob and the owner's touch can request a signature while
  showing a misleading reason. Every signature still requires the owner's presence, but the
  helper cannot prove which screen the owner saw.
- Ad-hoc signing changes the helper's code identity on every rebuild. The existing keychain
  item's access list then trusts the old identity; the owner must delete the item and re-run
  `init` with a new key, which re-grants access to the new binary. `init` refuses to overwrite
  the old item.
- Any local process can ask the helper to sign a canonical payload with a valid schema and id;
  the owner must compare the prompt's component id and source hash with what the app showed.
- The keychain access list relies on deprecated `SecAccessCreate` /
  `SecTrustedApplicationCreateFromPath`. The helper resolves them dynamically and refuses `init`
  with `keychain_access_unavailable` if they fail; there is no unprotected fallback.
- The helper is ad-hoc signed, not notarised; there is no Apple Developer membership. The
  installed path and code identity are re-signed on every install.
- Runtime errors from the helper are mapped to `SignerError` reasons; protocol/typing errors
  are only exercised through the tests below, not through a full application run.

## Shared edits

- `packages/contract/src/ui-catalog.ts`: added the `signer_helper_missing` read-only reason.
- `packages/ui/catalog/review-api.ts` and `packages/ui/src/i18n/messages.ts`: the matching UI
  reason and English/Russian text.
- `packages/web/test/browser/component-catalog.spec.ts`: mock key id and 64-byte signature.
- `docs/design/COMPONENTS_AND_CATALOG.md`: §4.1 and §8 updated for `/3` and the helper.
- `.gitignore`: `native/approval-signer/.build/`.
- Server review tests: removed the old `keychainSigner` suite and switched the fixture to
  `p256TestKey()`.

## Next slice

The integrator should merge the lane, run the full gates, and have the owner install the helper
(`node packages/server/scripts/install-approval-signer.ts`) and create the first key
(`node packages/ui/catalog/scripts/approval-key.ts init`) on `main`. Until that public entry is
committed, `approval-keys.json` is empty and G12 correctly reports no trusted key. The catalog
cannot write approvals before that.

## Review-fix round (2026-10-21)

Two independent GPT review findings in this lane were closed. The earlier sections above are
historical evidence for the original slice and are not rewritten.

### Finding 1 — unsupported platform guard

`helperSigner` now refuses before `execFile` on a host other than macOS:

- `status()` returns `{ state: 'unavailable', reason: 'platform_unsupported' }`;
- `sign()` throws `SignerError` with reason `platform_unsupported` and a macOS/Secure Enclave
  message, not install guidance or `signer_helper_missing`.

`HelperSignerOptions.platform` is the explicitly documented test seam. Production uses
`process.platform`; no caller passes it outside tests. The existing fixture-helper test seam
(`env`) is unchanged, so the test build is still invoked only deliberately.

**New test** (`packages/server/test/ui-catalog-signer-install.test.ts`):
`reports platform_unsupported on a Linux injection without spawning the helper`. It covers a
missing helper (the old Linux case) and a marker-writing fake helper, and asserts the marker
does not exist after both `status()` and `sign()`.

**Mutation control:** removing both guards made the test fail with
`actual { state: 'unavailable', reason: 'signer_helper_missing' }` versus the expected
`platform_unsupported`; restoring the guards made it pass.

**Commit:** `6bd9dc1 fix(server): report platform_unsupported before helper invocation`.

### Finding 2 — production confirmation policy

The previous test build compiled out the `.privateKeyUsage`/`.userPresence` access control and
the `LAContext` localized reason/zero reuse, so the fake-auth call count could not detect their
removal. The production policy is now built by shared functions outside the conditional
branches:

- `approvalKeyAccessPolicy()` is the single source of
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `[.privateKeyUsage, .userPresence]` and
  reuse duration `0`;
- `makeApprovalAccessControl()` passes that policy to the public
  `SecAccessControlCreateWithFlags` API and is used by production `init`;
- `configureConfirmationContext(_:reason:)` sets `localizedReason` and the policy reuse
  duration; `makeConfirmationContext(reason:)` is the fresh-context wrapper used by production
  `sign`;
- `signingReason(schema:id:sourceHash:)` builds the exact approval/revocation prompt, including
  the full `sha256:…` source hash, for both the production sign path and the probe.

The test build gains only `test-policy`, guarded by `#if GUANXI_SIGNER_TESTING`, and
`operationTestPolicyProbe` calls those same builders. It never loads a key, prompts, signs or
writes a keychain item. The probe seeds a nonzero `LAContext` reuse value first, so deleting
the explicit zero assignment cannot pass by matching the API default.

**New test** (`packages/server/test/ui-catalog-signer-exit-gates.test.ts`):
`wires the production access-control and confirmation policy through the shared builders`
asserts the access control was created, device-only accessibility, `.privateKeyUsage`,
`.userPresence`, `confirmationReuseDuration: 0`, the exact
`approve the "button" component, source sha256:<64 hex>` reason, no signature field and no
fake-auth line.

**Mutation controls after the refactor:** each mutation made that test fail; each was restored.

| Removed/changed production policy | Observed failure |
| --- | --- |
| `.userPresence` removed from `accessFlags` | `userPresence: false` |
| `.privateKeyUsage` removed from `accessFlags` | `privateKeyUsage: false` |
| accessibility changed to `kSecAttrAccessibleWhenUnlocked` | `accessibilityDeviceOnly: false` |
| reuse duration changed from `0` to `30` | `confirmationReuseDuration: 30` |
| `context.localizedReason = reason` removed | `localizedReason: ''` |
| `context.touchIDAuthenticationAllowableReuseDuration = …` removed | seeded value `120` remained |
| `, source <sourceHash>` removed from `signingReason` | shortened `localizedReason` |

Before the refactor, removing `.userPresence` and setting reuse duration to `30` each left the
old `requires one confirmation per signature and none for a denial` test green, reproducing the
review finding.

**Commit:** `f15cf44 fix(signer): prove the production confirmation policy`.

### Scope and evidence

Changed files in this review-fix round:

- `packages/server/src/ui-catalog/signer.ts` — platform guard and test seam;
- `packages/server/test/ui-catalog-signer-install.test.ts` — Linux-injection regression;
- `native/approval-signer/Sources/main.swift` — shared policy/context/reason builders and the
  test-build-only probe;
- `packages/server/test/ui-catalog-signer-exit-gates.test.ts` — policy-wiring regression;
- `docs/plans/lanes/DS2.handoff.md` — this review-fix section.

**New / regression envelope:** 2 new tests; the scoped regression run below executes 45 tests
in 4 files (43 pre-existing plus the 2 new).

Commands and final result lines, run from the repository root:

```sh
nice -n 10 node --test packages/server/test/ui-catalog-review.test.ts \
  packages/server/test/ui-catalog-signer-install.test.ts \
  packages/server/test/ui-catalog-signer-helper.test.ts \
  packages/server/test/ui-catalog-signer-exit-gates.test.ts
```

```text
ℹ tests 45
ℹ suites 10
ℹ pass 45
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

```sh
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
```

Exit 0, no output.

```sh
nice -n 10 sh native/approval-signer/build.sh --test
nice -n 10 sh native/approval-signer/build.sh
nice -n 10 sh native/approval-signer/build.sh --check native/approval-signer/.build/approval-signer
```

All exit 0. The only stderr was codesign's `replacing existing signature` line; `swiftc` emitted
no warnings. The production hook check passed. `strings` also reports `test-policy` zero times
in `.build/approval-signer` and once in `.build/approval-signer-test`, and `SIGNER_TEST_` zero
times in the production binary, so the test-only probe is not compiled into production.

### Residuals and boundaries

- **Policy wiring, not hardware confirmation.** The probe proves the values passed to the public
  `SecAccessControlCreateWithFlags` and `LAContext` APIs. It does not prove that the Secure
  Enclave enforces them, that Touch ID or the password dialog appeared, or that hardware user
  presence was verified. No production `init`/`sign` was called, no Secure Enclave key or
  keychain item was created, and no real prompt was shown. The hardware claim remains exactly
  the original local spike, not this test.
- The platform guard was exercised by injecting `platform: 'linux'` on macOS. A native Linux run
  was not performed; the guard returns before any platform-specific API or process spawn.
- The test-only `test-policy` operation exists only under `GUANXI_SIGNER_TESTING`; production
  `strings` checking still rejects leaked `SIGNER_TEST_` hooks, and the production build above
  passed that check.
- Full `npm test`, `npm run typecheck`, builds, browser gates, `lint:md` and license checks
  remain the integrator's job; this sandbox ran only the scoped signer tests, package `tsc` and
  the native helper builds.
- The original residuals (misleading reason from a process holding the blob and the owner's
  touch, ad-hoc identity changes, any local process asking for a canonical payload, deprecated
  access-list APIs) are unchanged.
