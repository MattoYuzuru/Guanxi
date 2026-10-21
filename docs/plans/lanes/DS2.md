# Lane DS2 — Approval signing helper

**Status:** running · **Updated:** 2026-10-21 · **Runs in:** DeepSeek-V4.1-Flash (max) in
DeepSeek Harness headless; Claude cross-family review · **Branch:** `lane/ds2-signing-helper`

## Design (integrator, 2026-10-21)

D-184 requires a code-signed helper outside the checkout. Only this helper can sign approvals,
it asks for Touch ID or the password on every signature, and it names the component and its
hash in the prompt.

**Key.** The integrator chose a **Secure Enclave P-256 key** over an Ed25519 key in the
keychain.

- The private key never exists outside the Secure Enclave, so no process, including a
  modified node, can obtain its bytes.
- The key's access control (`.privateKeyUsage` + `.userPresence`) makes the hardware demand the
  owner's presence on every use.
- A keychain "Always Allow" cannot remove that requirement.

**Verified on this Mac (2026-10-21).** An ad-hoc-signed Swift command-line tool with no
entitlements and no Apple Developer membership:

- creates such a key;
- stores its 427-byte wrapped blob;
- reloads it with the same public key.

Signing needs the owner's touch, so it was not exercised. The spike is in the integrator's
scratchpad.

**Consequences.**

- Approval signatures become ECDSA P-256 with SHA-256 in IEEE P1363 form (64-byte r‖s,
  base64). The record schemas move to `guanxi.ui-approval/3` and `guanxi.ui-revocation/3`.
- Trusted keys use `algorithm: "p256"` and `keyId: "p256:" + first 32 hex characters of
  SHA-256(SPKI DER)`.
- No Ed25519 key was ever trusted: `approval-keys.json` is empty. So `/2` and Ed25519 support
  are removed, and G12 accepts only P-256 keys.
- The wrapped blob is not secret, because only this device's Secure Enclave can use it. It is
  still stored in a login-keychain item whose access list trusts only the helper, so another
  process must pass a separate keychain prompt even to fetch it.
- **Residual:** a process that obtains the blob and the owner's touch could sign while showing
  a misleading Touch ID reason. Every signature still requires the owner's presence.

## Prompt

Paste everything below the line into the runner in a standalone clone on the lane branch.

---

You are implementing lane DS2 (approval signing helper) of Guanxi, an Apache-2.0 TypeScript
monorepo (ESM, Node 26) with a small native Swift helper. The current directory is a standalone
git clone on branch `lane/ds2-signing-helper`. Dependencies are already installed. The Swift
compiler is `swiftc` (Command Line Tools, Swift 6.3) on an Apple M5 Pro Mac.

Read first:

- this file's Design section above: `docs/plans/lanes/DS2.md`;
- `docs/design/COMPONENTS_AND_CATALOG.md` §4 and §4.1;
- `packages/server/src/ui-catalog/signer.ts`;
- `packages/server/src/ui-catalog/service.ts` (lines 200–245, how it signs);
- `packages/ui/catalog/approval/keys.ts`, `record.ts`, `verify.ts` and `index.ts`;
- `packages/ui/gates/catalog/g12-approval-integrity.ts`;
- `packages/ui/catalog/scripts/approval-key.ts`;
- `packages/ui/catalog/approval-keys.json`;
- the existing tests for these files, found with
  `grep -rl "approval\|signer" packages/server/test packages/ui/gates/catalog/test`.

## Hard rules

- Never create, read or modify a key in the owner's real login keychain. Never create a Secure
  Enclave key in a test.
- Never call the production helper's `init` or `sign` from a test.
- Tests use the **test build** described below, with a software key in a temp directory and a
  fake authenticator.
- Do not run `npm install`, `npm ci`, `npm test`, `npm run build` or the browser gates. The
  integrator runs the full gates.
- Run only these targeted commands, always under `nice -n 10`:

```sh
nice -n 10 node --test packages/server/test/ui-catalog*.test.ts packages/ui/gates/catalog/test/*.test.ts
nice -n 10 sh native/approval-signer/build.sh --test
```

- Build Swift with `-module-cache-path` inside this directory (`native/approval-signer/.build/`).
  Add `.build/` to `.gitignore`.
- Never write outside this directory, except temp files in the system temp dir.
- No network. Do not merge, rebase or push.
- Product names and paths come from the brand module (`grep -rn "PRODUCT_NAME" packages/*/src` to
  find it). Do not hardcode "Guanxi" in new TypeScript; pass names into the helper as arguments.

## Work items (one commit each, in order)

For every item:

1. Write the test first.
2. Confirm the test passes after the fix.
3. Remove your guard, confirm the test fails, and restore the guard.
4. Note the item, the test name, the mutation and the result for the hand-off.

### 1. Approval format: P-256, schema `/3` (`feat(ui): switch approvals to Secure Enclave P-256 keys`)

- `keys.ts`:
  - `TrustedKey.algorithm` becomes `'p256'`;
  - `keyIdForPublicKey` returns `p256:` + the first 32 hex characters of SHA-256(SPKI DER);
  - `parseTrustedKeys` accepts only P-256 (`asymmetricKeyType === 'ec'` and `namedCurve === 'prime256v1'`);
  - update the comment.
- `record.ts`:
  - set `APPROVAL_SCHEMA = 'guanxi.ui-approval/3'` and `REVOCATION_SCHEMA = 'guanxi.ui-revocation/3'`;
  - `SIGNATURE_PATTERN` matches base64 of exactly 64 bytes: `/^[A-Za-z0-9+/]{86}==$/` is already 64 bytes, so keep it and say so in a comment.
- `verify.ts`:
  - verify with `crypto.verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, signature)`;
  - rotation signatures (`keySetSigningBytes`) use the same scheme.
- Update `review.schema.json` if it pins the schema strings, and update every fixture or test
  that builds keys. Use `generateKeyPairSync('ec', { namedCurve: 'prime256v1' })` and
  `sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' })` in a shared test helper
  `p256TestKey()`.
- Update `docs/design/COMPONENTS_AND_CATALOG.md` §4.1: the schema strings, "ECDSA P-256 (SHA-256,
  IEEE P1363) over canonical JSON", and a sentence that `/2` (Ed25519) was never used and is
  removed.
- Tests:
  - G12 rejects an Ed25519 key in `approval-keys.json`;
  - G12 rejects a `/2` payload;
  - a P-256 approval made with the test key verifies;
  - flipping one signature byte fails.

### 2. The Swift helper (`feat(signer): add the Secure Enclave approval signing helper`)

Create `native/approval-signer/`:

- `Sources/main.swift`: the helper;
- `build.sh`;
- `README.md`.

**Protocol.** One request per invocation. The request is a single JSON object on stdin, and the
response is a single JSON object on stdout. Exit 0 on success, 1 on a refused or failed request,
2 on a usage error. Nothing else is written to stdout. Diagnostics go to stderr and never contain
key material.

Requests:

- `{"op":"status","service":S,"account":A}`
  - returns `{"ok":true,"state":"available","algorithm":"p256","keyId":K,"publicKey":SPKI_BASE64}`
    or `{"ok":true,"state":"missing"}`;
  - never prompts.
- `{"op":"init","service":S,"account":A}`
  - creates the Secure Enclave key: `SecureEnclave.P256.Signing.PrivateKey(accessControl:)` with
    `SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], nil)`;
  - stores `dataRepresentation` in the login keychain as a generic password `(service S,
    account A)` whose access list trusts only this helper's own path;
  - refuses with `key_exists` if an item exists;
  - returns the same object as `status`.
- `{"op":"sign","service":S,"account":A,"payload":P}`, where `P` is a string.
  1. Parse `P` as JSON. It must be an object, and `canonical(P_parsed) == P` byte for byte.
     Implement canonical JSON exactly like `packages/ui/catalog/approval/canonical.ts`: keys
     sorted by UTF-16 code unit, no whitespace, and the same string escaping as
     `JSON.stringify`. Otherwise refuse with `payload_not_canonical`.
  2. `schema` must be `guanxi.ui-approval/3` or `guanxi.ui-revocation/3`; otherwise
     `payload_schema`. `id` must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
  3. Build the prompt reason exactly as follows, where `<sourceHash>` is the full `sha256:…`
     value:
     - approval: `approve the "<id>" component, source <sourceHash>`;
     - revocation: `request changes to the "<id>" component`.
  4. Create a **fresh** `LAContext` for this request with
     `touchIDAuthenticationAllowableReuseDuration = 0`. Load the key with
     `SecureEnclave.P256.Signing.PrivateKey(dataRepresentation:authenticationContext:)`, setting
     `context.localizedReason` to the reason. Sign the UTF-8 bytes of `P`.
  5. Return `{"ok":true,"keyId":K,"signature":<base64 of signature.rawRepresentation>}`.
  - Error codes:
    - user cancel or failed authentication: `signing_denied`;
    - no item: `signing_key_missing`;
    - no Secure Enclave: `platform_unsupported`.
  - Errors are returned as `{"ok":false,"code":C,"message":M}`.

**Keychain item access.**

- Use `SecAccessCreate` with `SecTrustedApplicationCreateFromPath(nil, &app)` (nil means the
  calling helper), passed as `kSecAttrAccess` to `SecItemAdd`.
- These APIs are deprecated but available. Silence the deprecation warning locally, with a
  comment explaining why.
- If they fail at runtime, refuse `init` with `keychain_access_unavailable`. Never fall back to
  an unprotected item.

**Test build** (`build.sh --test`, compiled with `-D GUANXI_SIGNER_TESTING`):

- Replaces the Secure Enclave with `P256.Signing.PrivateKey` loaded from the file named by the
  environment variable `SIGNER_TEST_KEY` (raw representation). It refuses to run if that
  variable is missing.
- Replaces `LAContext` with a fake authenticator that:
  - appends one line per authentication to the file in `SIGNER_TEST_AUTH_LOG`, containing the
    exact reason text;
  - succeeds, unless `SIGNER_TEST_AUTH_DENY=1`, in which case it returns `signing_denied`.
- Replaces the keychain item with a file `SIGNER_TEST_KEY.item`. Test `init` writes it, and
  `status` and `sign` read it.
- The production build must not contain any of this. Use `#if GUANXI_SIGNER_TESTING` blocks.
  `build.sh` (without `--test`) must fail if the produced binary contains the string
  `SIGNER_TEST_` (check with `strings`).

**build.sh:**

- `swiftc -O -module-cache-path native/approval-signer/.build/mc Sources/main.swift -o <out>`;
- then `codesign -s - -f --identifier <bundle id passed as $SIGNER_IDENTIFIER, default "local.approval-signer"> <out>`;
- `--test` builds `native/approval-signer/.build/approval-signer-test` with the test flag;
- without `--test` it builds `native/approval-signer/.build/approval-signer`;
- installing outside the checkout is item 3's job.

### 3. Installer and node signer (`feat(server): sign approvals only through the installed helper`)

- `packages/server/scripts/install-approval-signer.ts`:
  - builds the production helper with `build.sh`;
  - copies it to `<home>/Library/Application Support/<PRODUCT_NAME>/approval-signer/<PRODUCT_FILE_PREFIX>-approval-signer`, with names from the brand module, mode `0755`;
  - re-signs it ad hoc at that path;
  - prints the path;
  - takes `--home <dir>` so tests can install into a temp dir.
- In `signer.ts`:
  - **remove** `keychainSigner` and its `security` invocation entirely;
  - add `helperSigner({ helperPath, service, account, timeoutMs })` implementing `ApprovalSigner`;
  - `status()` runs `{op:"status"}`;
  - `sign(bytes)` runs `{op:"sign", payload: bytes.toString('utf8')}` and maps error codes to `SignerError` reasons, adding `signer_helper_missing` and `payload_not_canonical`;
  - spawn with `execFile`, an argument array and no shell, write the request to stdin, a 120 s timeout, and stdout capped at 64 KiB;
  - the node never receives anything but `keyId`, `publicKey` and `signature`.
- In `packages/server/src/index.ts`, construct `helperSigner` with the installed path. If the
  binary is missing, the catalog's capability reports `approval_signer_unavailable` with reason
  `signer_helper_missing` and the install command.
- Change `packages/ui/catalog/scripts/approval-key.ts init` so that it runs the installed
  helper's `init` and prints the `approval-keys.json` entry (`algorithm: "p256"`) for the owner
  to commit. Remove its Ed25519 keychain code.

### 4. Exit-gate tests (`test(signer): prove the helper protocol and confirmation boundaries`)

All of these use the test build:

1. **Key bytes never leave.** Over `status`, `init` and three `sign` requests, scan stdout and
   stderr for the raw key bytes in base64, hex and raw form, and for the test item file's
   contents. None may appear. The node signer's return values contain only `keyId`, `publicKey`
   and `signature`.
2. **The prompt names the component and the hash.** After one approval signature, the auth log
   holds exactly one line equal to `approve the "button" component, source sha256:<the hash>`.
3. **Every signature needs a confirmation.** Three signatures produce exactly three auth-log
   lines. With `SIGNER_TEST_AUTH_DENY=1`, the result is `signing_denied` and no signature.
4. **Payload integrity.**
   - A non-canonical payload (reordered keys or extra whitespace) gives `payload_not_canonical`.
   - A `/2` schema gives `payload_schema`.
   - An invalid id is refused.
5. **Signatures verify.** A helper signature verifies with `verify.ts` against the helper's
   reported SPKI. A record signed by the helper passes G12 when its key is in a temp
   `approval-keys.json`. A record signed by a P-256 key that is not in the file fails G12.
6. **The production build has no test hooks.** Assert that the `strings` check in `build.sh`
   fails when a test hook leaks. Simulate this by building with `-D GUANXI_SIGNER_TESTING` while
   calling the production check.
7. **The keychain access list.** Create a throwaway keychain in the temp dir with
   `security create-keychain -p test <file>`, never adding it to the search list. Run a variant
   of `init` that targets it: add an optional `"keychain": <path>` request field honoured only by
   `init` and `status`. Then assert that `security dump-keychain -a <file>` lists exactly one
   trusted application, the helper's path.
   - If `security` or the keychain daemon is not usable in this environment, mark the test
     `skip` with the exact error, and say so in the hand-off. The integrator runs it.

Skip any Swift-dependent test with a clear reason when `swiftc` is unavailable, for example on
Linux.

### 5. Documentation (`docs(signer): document the signing helper and its residuals`)

- `native/approval-signer/README.md` covers:
  - what the helper does, the protocol, and how to install it;
  - why P-256 and the Secure Enclave;
  - the residuals: misleading reasons from a process that holds the blob and the owner's
    touch; ad-hoc signing changes the code identity on every rebuild, so after a rebuild the
    keychain item's access list must be re-granted by re-running `init` with a new key.
- `docs/plans/lanes/DS2.handoff.md` contains:
  - what was built;
  - a table with columns gate item → test → mutation → result;
  - the exact targeted commands and their final result lines;
  - what you could not run;
  - the residuals.

Finish with `git status --porcelain` empty. Your final message is a short report:
`git log --oneline origin/main..HEAD`, the final result lines, and anything left undone.
