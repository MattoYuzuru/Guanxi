# Approval signing helper

`approval-signer` is the only process that can sign Guanxi catalog approvals and change
requests. It owns a P-256 key in the Secure Enclave and a login-keychain item that holds only
the key's wrapped representation. The node never receives the private key; it receives a key id,
a public key and a signature.

## Protocol

One request per invocation. The request is one JSON object on stdin; the response is one JSON
object on stdout. Exit codes are 0 (success), 1 (refused or failed request) and 2 (usage error).
Diagnostics go to stderr and never contain key material.

Every request names the keychain item:

```json
{"op":"status","service":"guanxi.ui-approval","account":"owner-approval-key"}
{"op":"init","service":"guanxi.ui-approval","account":"owner-approval-key"}
{"op":"sign","service":"guanxi.ui-approval","account":"owner-approval-key","payload":"<canonical JSON>"}
```

| Request | Success response |
| --- | --- |
| `status` | `{"ok":true,"state":"available","algorithm":"p256","keyId":"p256:…","publicKey":"<SPKI base64>"}` or `{"ok":true,"state":"missing"}`. Never prompts. |
| `init` | Creates the Secure Enclave key and its keychain item, then returns the same object as `status`. Refuses with `key_exists` if the item already exists. |
| `sign` | Parses `payload`, requires it to be a canonical JSON object, requires `schema` to be `guanxi.ui-approval/3` or `guanxi.ui-revocation/3`, checks `id`, asks the owner, and returns `{"ok":true,"keyId":"p256:…","signature":"<64-byte r‖s, base64>"}`. |

The prompt reason is fixed by the payload:

- approval: `approve the "<id>" component, source <sourceHash>`;
- revocation: `request changes to the "<id>" component`.

The payload bytes that are signed are exactly the UTF-8 bytes of the string received, after it
has been proved canonical. Canonical JSON is the same function the verifier uses: keys sorted by
UTF-16 code unit at every level, no whitespace, `JSON.stringify` string escaping. A non-canonical
payload is refused with `payload_not_canonical`; a wrong schema with `payload_schema`; an invalid
component id with `payload_id`.

Errors are `{"ok":false,"code":C,"message":M}`. `signing_denied` means the owner cancelled or
authentication failed, `signing_key_missing` means no item exists, `platform_unsupported` means
this Mac has no Secure Enclave, and `keychain_access_unavailable` means the keychain or its
legacy access-list API refused the item. `init` never falls back to an unprotected item.

## Install

The installer builds the production binary, copies it under the brand path, and re-signs it
ad hoc at its final location:

```sh
node packages/server/scripts/install-approval-signer.ts
# <home>/Library/Application Support/<product>/approval-signer/<prefix>-approval-signer
```

Then create the owner key and commit the printed `approval-keys.json` entry on `main`:

```sh
node packages/ui/catalog/scripts/approval-key.ts init
node packages/ui/catalog/scripts/approval-key.ts show   # print the key id again
```

`--home DIR` installs under another home for tests. `--helper PATH` points `approval-key.ts` at
a specific binary (the test build); it is not for normal owner use.

## Why P-256 and the Secure Enclave

- The private key is generated inside the Secure Enclave and never exists outside it. No process,
  including a modified node, can read its bytes; the keychain holds only a device-bound wrapped
  blob.
- The key's access control combines `.privateKeyUsage` with `.userPresence`, so even a keychain
  "Always Allow" cannot remove the owner's Touch ID or password requirement.
- ECDSA P-256 with SHA-256 in IEEE P1363 form (64-byte r‖s) is what the Secure Enclave signs and
  what Node's `crypto.verify` checks with `dsaEncoding: 'ieee-p1363'`. Approvals therefore use
  the `/3` schemas; the `/2` Ed25519 schema was never used and is removed.
- The keychain item's access list is built with `SecAccessCreate` and
  `SecTrustedApplicationCreateFromPath(nil, …)`, so only this executable may read the wrapped
  blob. Those APIs are deprecated; the helper resolves them dynamically and refuses `init` with
  `keychain_access_unavailable` if either fails. It never stores an item without an access list.

## Build and test

```sh
sh native/approval-signer/build.sh          # .build/approval-signer, production
sh native/approval-signer/build.sh --test   # .build/approval-signer-test, test build
sh native/approval-signer/build.sh --check <binary>  # production hook check
```

`build.sh` uses `swiftc -O` with the module cache in `.build/mc`, then ad-hoc signs the binary
with the identifier from `SIGNER_IDENTIFIER` (default `local.approval-signer`). Production
builds fail if `strings` finds `SIGNER_TEST_`; test builds contain the hooks on purpose and must
never be installed.

The test build replaces the Secure Enclave with `P256.Signing.PrivateKey` loaded from the raw
32-byte key named by `SIGNER_TEST_KEY`, replaces the authenticator with a fake that appends one
line per authentication to `SIGNER_TEST_AUTH_LOG` (and denies when `SIGNER_TEST_AUTH_DENY=1`),
and replaces the keychain item with the marker file `<SIGNER_TEST_KEY>.item`. A `"keychain"`
field on `init`/`status` is honoured only by the test build, for the throwaway-keychain access
list test. The test build refuses to run without `SIGNER_TEST_KEY`.

## Residuals

- **A process that holds the wrapped blob and the owner's touch can ask for a signature while
  showing a misleading reason.** The helper builds the reason from the payload, but it cannot
  prove that the screen the owner looked at showed the same component. Every signature still
  requires the owner's presence.
- **Ad-hoc signing changes the code identity on every rebuild.** After rebuilding the helper,
  the existing keychain item's access list trusts the old identity. Re-run `init` with a new key
  (delete the old item first; `init` refuses to overwrite it) so the access list is granted to
  the new binary. Replacing the installed binary has the same effect.
- **Any local process can ask the helper to sign a canonical payload** with a valid schema and
  component id. The prompt names the component and source hash, so the owner must compare them
  with what the app showed; the helper does not know which UI asked.
- The legacy access-list APIs could disappear in a future macOS. The helper then refuses `init`
  rather than weakening the item. There is no Apple Developer membership or notarisation here;
  the binary is ad-hoc signed and its identity is a path plus an ad-hoc requirement.
- The node caps helper output at 64 KiB and waits at most 120 s for the owner. A timeout and a
  denial are reported as different errors, but neither writes a record.
