# K4F — Native agent follow-up

**Status:** implemented, verified by the integrator, merged into `main` (`a2c2f90`); inherited K4 residual scope remains · **Updated:** 2026-10-21

This file was the lane hand-off; the integrator moved it here at the merge. Integrator check
(Claude, cross-family): the production diff was read in full. Removing the IP-literal port
requirement from the contract fails 3 tests; disabling the request-time literal-host check
fails 1. Gates on `main` at `a2c2f90`: typecheck, `lint:md`, licenses, `ui:check`, `npm test`
(core 1018, kernel 106, catalog 70, UI gates 51), browser gate 65/65, `ui:check:browser` and
build.

**Branch:** `lane/k4-followup` · **Base:** `0e22a92` · **Validated code:** `36ef4ba`

## Outcome

| Item | Status and implementation |
| --- | --- |
| R1 (Medium) | Fixed in `82142a5`: the portable contract requires a valid explicit port for every IPv4/IPv6 literal and localhost entry. WHATWG normalization catches unspecified/numeric IPv4 aliases. The shared request filter rechecks normalized host plus the explicitly granted service port, denying port-less old/internal grants and unnamed ports on both backends. |
| R3 | Asserted in `cb82dd3`, strengthened in `36ef4ba`: a real server binds API port 0 and a fixture binds the web port. Both native access modes create valid policies, deny the actually bound API/web ports despite explicit domain grants, and allow a granted non-node control. Only the fixture model transport runs. |
| R4 | Asserted in `6536293`: the worker uses a captured `egress-ipc.ts` helper. A parent that never answers plus a virtual clock exercises the existing 1 s timeout without waiting. Disconnected/missing IPC, send callback errors, synchronous send exceptions and in-flight disconnects deny. Concurrent response correlation, explicit allow and late replies have controls. |
| R2 (docs only) | Corrected in `147657e`, retained through the evidence-file move: registered values cannot leave in an exactly registered form in URL/header. **K4-EGRESS-ENCODINGS** names encoding, splitting across requests or headers, and case changes next to **K4-EGRESS-BODIES**. No broader confidentiality claim is made. |

The follow-up adds no dependencies, database migrations or public wire fields. Port-less IP grants
are intentionally incompatible: recreate such development sessions with explicit service ports;
their immutable stored policies are not rewritten. DNS domain entries retain their existing
optional-port semantics and upstream resolved-address controls.

## New assertions / regression envelope

Relative to the merged `main` (`7de9e6c`): **11 new server tests**. The combined native scope
is **11 new / 60 regression**, 71 total, counting `native-agent-contract.test.ts` once.
The same 11 are included in the core gate and are not credited twice.

- Contract: unspecified addresses (`0.0.0.0`, `0`, shortened/octal/hex zero aliases), IPv4
  loopback aliases, LAN/public IPv4, IPv6 unspecified/loopback/mapped/public literals,
  valid explicit/default ports, malformed authorities and out-of-range ports.
- Request policy: both access modes deny port-less policies, unnamed/default ports and
  requests before scrubber authorization; explicit 80/443 and the named service succeed.
- Adapted reviewer probes from `k4-review/final/zz-review.test.ts`: disposable wildcard
  listeners expose `0.0.0.0` and the actual LAN IPv4 address. Port-less entries fail policy
  parsing before dispatch; each explicit entry produces `200 403`, exactly one granted
  request and zero traffic to the unnamed service. These assertions ran on both backends.
- Real `start({ port: 0 })` wiring and deterministic IPC failure assertions as above.

All fixtures use temporary trees/listeners and synthetic data. No live model or owner data
is used. R2 changes documentation only and adds no artificial prose-content test.

## Mutation evidence

Command: `python3 -B /Users/yuzuru/.local/state/agent-dev/k4f-20261021/mutate.py`.
The driver applies one mutation, runs the selected Node test, saves TAP and restores the
original bytes in `finally`. **12 mutation runs exited 1 with failing assertions**; all
mutations were restored. R3 mutations were repeated after the final test refinement.

| Mutation ID | Removed/changed guard | Failing assertion |
| --- | --- | --- |
| `r1-ipv4-schema` | Classify only `127.*` instead of every normalized IPv4 | Contract: `port-less 0.0.0.0`, actual `true`, expected `false` |
| `r1-ipv6-schema` | Remove bracketed IPv6 classification | Contract: `port-less [::]`, actual `true`, expected `false` |
| `r1-request-guard` | Bypass service-grant recheck | Request policy: old port-less `0.0.0.0` returns `allow`, expected `deny` |
| `r1-port-match` | Remove exact requested-port comparison | Request policy: unnamed `http://0.0.0.0:8081/` returns `allow`, expected `deny` |
| `r3-bound-api` | Replace `actualPort` with requested `port` | `assert.doesNotReject`: ephemeral listener must produce a valid native policy; requested 0 causes `invalid_event` |
| `r3-valid-wrong-api` | Replace `actualPort` with requested `port`, falling back to 4310 | Bound API port must deny despite its explicit grant: actual `allow`, expected `deny`; policy remains valid |
| `r3-bound-web` | Drop the configured web port | Bound web port must deny despite its explicit grant: actual `allow`, expected `deny` |
| `r4-timeout` | Timeout settles `true` | Unanswered decision fails closed: actual `allow`, expected `deny` |
| `r4-unavailable` | Missing/disconnected IPC settles `true` | Both `disconnected` and `missing-send` request assertions return `allow`, expected `deny` |
| `r4-callback` | Send callback error settles `true` | `send-callback` request returns `allow`, expected `deny` |
| `r4-throw` | Synchronous send exception settles `true` | `send-throw` request returns `allow`, expected `deny` |
| `r4-disconnect` | In-flight disconnect settles `true` | `disconnect-in-flight` request returns `allow`, expected `deny` |

Specs, driver and individual `<mutation-id>.tap` files remain outside Git in
`/Users/yuzuru/.local/state/agent-dev/k4f-20261021/`. They contain synthetic fixture evidence.

## Integration and fresh verification

- `cfd50db` merges main `0e151d1`; the R2 conflict preserves the integrator's move from
  `lanes/K4.handoff.md` to `evidence/K4.md` and the narrowed exact-form wording.
- `4b1cdc9` merges main `7de9e6c` (DS1-b); `npm ci` was repeated after its dependency changes.
  No rebase, push or merge into main was performed.
- Fresh author review reproduced two missing-helper fixture failures (`ENOENT` in worker
  crash and trusted-executable tests). Separate fix `2d8764a` stages the captured helper in
  both adversarial launchers. The full native/core envelopes cover those fixtures afterward.
- Fresh author mutation review found that `actualPort -> port` initially failed through
  event validation. Separate fix `36ef4ba` makes valid ephemeral policy creation an explicit
  assertion; the valid-but-wrong-port mutation additionally fails the actual denial check.
- A separate read-only reviewer checked `0e151d1..2d8764a`, the DS1-b merge at `4b1cdc9`, and
  `4b1cdc9..36ef4ba`: **no remaining findings**. Scope included sandbox source capture,
  host/port normalization, fail-closed IPC, correlation, startup wiring, assertion strength
  and exact-form documentation. This was source review, not runtime or cross-family review.

## Linux validation

`ssh fedora`, task-owned `~/Projects/guanxi-k4f-validate`, created from a Git bundle and
updated from task-owned bundles to `36ef4ba`. All remote work inherited `nice -n 10`.
Node **26.9.0** was unpacked inside the clone after SHA-256 verification against the official
SHASUMS256 file; system Node was unchanged. Backend: **bubblewrap 0.12.0**.

Command: `node --test --test-reporter=tap 'packages/server/test/native-agent/*.test.ts' packages/server/test/native-agent-contract.test.ts`.

Result: **65 passed / 6 macOS-only skips / 0 failures**, 71 total: 11 new passes, 54 regression
passes and six platform exclusions. This includes the actual unspecified/LAN service probes.
No Linux full-core, live-provider or production validation is claimed.

Evidence copied to `~/.local/state/agent-dev/k4f-20261021/linux/`: TAP, revision, Node/backend
versions, nice level, contract resolution, exit code and selected archive checksum.
The remote clone, embedded runtime/archive and transport bundle were removed; cleanup exited
0 and confirmed both paths absent. No workstation-* service, llama on 8080, VPN, keykomi relay
or owner workspace was operated on.

## Final gates

Environment: `GUANXI_WEB_PORT=5189`, `GUANXI_API_PORT=4389`,
`GUANXI_DATA_DIR="$PWD/.lane-data"`. Heavy checks use Node 26 and the common `heavy` lock.

| Command | Outcome / evidence |
| --- | --- |
| `npm run typecheck` (direct) | exit 0 at `36ef4ba`; `direct-final-typecheck.log` |
| `npm run lint:md` (direct) | exit 0 after main merge; repeated after this hand-off |
| `npm run check:licenses` (direct) | exit 0; 521 packages, zero not allowed; `direct-2.log` |
| `npm run ui:check` (direct) | exit 0, fast gates/self-tests; `direct-3.log` |
| `npm test` (locked) | exit 0 at `36ef4ba`; `check-_07wclhi/result.json` |
| `npm run test:web:browser` (locked) | 65 mocked Chromium tests passed; `check-pz69proo/result.json` |
| `npm run build` (locked) | exit 0; `check-us37jer8/result.json` |

The full npm gate passed 1017 core tests with one opt-in macOS keychain test skipped,
106 kernel tests, 314 web tests, 51 UI gate tests, 70 catalog gate tests and 17 UI tests.
The core envelope is **11 new / 1007 regression** (one regression test is opt-in and skipped).
No browser, web component, kernel or UI test is newly credited to K4F.
The skipped real-keychain round-trip requires `GUANXI_TEST_MACOS_KEYCHAIN=1`; this task did
not opt in to owner-keychain interaction.

The initial macOS combined native run passed **71/71**, with zero skips, at `2d8764a`
(`check-xj_l45dt/result.json`); the final npm gate repeats it after the test-only refinement.
All receipt paths above are under `~/.local/state/agent-dev/`; direct logs are under its
`k4f-20261021/` subdirectory. An earlier full npm run also passed at `4b1cdc9`
(`check-we1__hac/result.json`); it was repeated after `36ef4ba`. One superseded queued runner
was cancelled before it acquired the lock when DS1-b arrived; it is not credited as a gate.

Final heavy receipts report `source_changed: false`. The pre-existing external
`.claude/skills/guanxi-ui` symlink makes `source_verifiable: false` and `reusable: false`;
these are command results at the recorded revisions, not reusable source attestations.
The final hand-off commit changes documentation only; markdown lint is repeated afterward.

## Residuals and shared edits

- **K4-EGRESS-ENCODINGS:** encoding (including percent encoding/base64), splitting across
  requests or headers, and case changes remain outside exactly registered-form matching.
- **K4-EGRESS-BODIES:** arbitrary request bodies are not inspected, including GET bodies.
- Existing API capability authentication, x32-container parity, hardlink/CA cost, progress
  polling, cleanup recovery, retention, input artifacts, HTTPS-positive/UI/platform evidence
  and durable-run integration residuals remain as named in [K4 evidence](K4.md).
  This follow-up closes only R1, R3, R4 and the R2 documentation correction.
- Shared edits: the contract's native-agent schema and its server contract test, the K4
  evidence text, and native-agent implementation/tests/README. Changes to shared status,
  UI/catalog and dependency files came from main merges, not lane-authored edits.

Next: the integrator reviews this follow-up and folds its evidence into the status files.
Further implementation remains the inherited K4 residual scope and the roadmap's next slice;
this hand-off is not release or merge approval.
