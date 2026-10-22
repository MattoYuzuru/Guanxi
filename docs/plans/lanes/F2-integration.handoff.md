# F2 and InProgress integration handoff — 2026-10-22

**Status:** implemented integration candidate; author scoped checks passed; independent
composition review and root full candidate gates pending. This does not close F2 or MS1.

## Checkout and ownership

- Author checkout: `/Users/yuzuru/Projects/Guanxi-lanes/ms1-f2`.
- Bundle branch: `codex/in-progress-integration`.
- Preserved F2 branch: `codex/ms1-f2` at `b3b1077e`.
- Last executable/test change: `e9611d3596c93fdc0a7412f73c9694936040217e`.
- Root authorized the local merges and owns main, central status, final aggregate gates and
  any later push. Central documents enter only through reviewed parent ancestry; this
  integration authors no central status change.
- Runtime: local macOS arm64, Node 26.9.0; ports 5201/4401 and checkout `.lane-data`.
  No live model, provider, paid call, owner data, SSH, other host or container was used.

## Exact parent composition

| Integration commit | First parent | Reviewed second parent | Resolution |
| --- | --- | --- | --- |
| `5cda1449` | F2-a `5c66e27` | U1/K4 privacy `aa878593` | No conflicts |
| `63c8c3e1` | `5cda1449` | F2-b `ffa9d1ac` | No conflicts; K3 service auto-merged |
| `1dbce567` | `63c8c3e1` | R3/K3/R2 `6a3e6441` | Two additive seams below |
| `b3b1077e` | `6503199c` | U1 Markdown `84c9f651` | No conflicts; formatting/evidence only |
| `656d0635` | `b3b1077e` | X1/current main `d861b581` | Two additive seams below |
| `bd0cef30` | `656d0635` | B1/current main `fb57323e` | No conflicts |
| `a8eabb24` | `d640546a` | K5 durable admission `e4c7cf32` | No conflicts |

The R3, B1 and K5 objects were fetched from the explicitly authorized local standalone clones.
No rebases, resets, migration rewrites, deployments or remote Git operations occurred.

### Actual conflicts and compatibility changes

- R3 contract barrel: retain both layout and relay exports.
- R3 Connections service: retain the reviewed post-authorization runtime-host revalidation
  and final synchronous preparation. Resulting Connections service and Ollama client are
  byte-identical to `6a3e6441`; neither hook was dropped.
- X1 scrubber: retain both `scrubTruncatedPrefix` and `snapshot`. The former keeps private
  cached prefix matching; the latter remains the trusted child IPC copy. Neither becomes
  a REST field. The facade assertion retains both methods, copy isolation and closed checks.
- Existing F2 DDL assertions now expect global migration 33, introduced by K4; their
  independent 36/37 assertions remain. Before correction, the actual DDL regression failed
  with actual 33 versus expected 32. An earlier unmatched name filter is not credited.
- `6503199c` adds one actual composed F2/K3 ownership assertion, described below. It also
  removes one inherited extra Markdown blank; the later U1 formatting parent subsumes it.
- `85e039dc` changes only the B1 trial-host test wrapper to return `RunStore.renew`'s receipt.
  Bench typecheck first failed at its two typed callsites because the wrapper returned void;
  production was unchanged. The corrected test and typecheck pass.

## Properties preserved by source composition

- Federation minor 3, with distinct layout minor 1, reservation minor 2 and dispatch minor 3
  guards/capabilities. Reservation receipts remain `dispatchAuthorized: false`; only a distinct
  signed, exact-bound dispatch grant authorizes text inference.
- Signed owner/device scopes, grant/home/executor/attempt fencing, reservation consumption,
  renewal, expiry, ordered receipts, restart refusal and direct owner cancellation remain.
  Timeout does not grant a second holder.
- Async authorization remains after local governor admission and version preflight, followed
  by final synchronous scrub/preparation directly before POST. Actual transport/body/reader
  and cancel acknowledgements retain ownership until local cleanup settles. This is local
  client settlement evidence, not proof a backend stopped computing.
- X1 index registration and the optional ninth NativeAgents index argument remain. Native
  source and indexing source are byte-identical to `d861b581`; K4 durable tool-call gates
  and input artifacts therefore remain alongside indexing.
- RelayStarts, Eta, Judge, Cascade and trusted runtime services remain; the model and
  Connections implementations equal reviewed `6a3e6441`.
- Layouts and session-log source equal `aa878593`. Egress differs only by X1's additive
  snapshot method/type. Current-registry truncated-prefix privacy is retained.
- B1 production source equals `fb57323e`; later changes only repair the trial-host test
  wrapper and private-process test fixtures, with one cleanup regression below.
- K5 external-agent production and test trees equal independently reviewed `e4c7cf32`.
  Durable same-node account admission, cleanup acknowledgement and atomic learning are
  retained without altering K3 launch authorization or adding recovery authority.
- Global user_version 33 and independent ledgers 36 (offers), 37 (dispatch), 38 (judge),
  39 (trusted start) coexist without rewriting their applied SQL.

## New assertion and regression envelope

**New: 1 integration test. Regression envelope: 304 tests.** The 305-test author command
passed at clean `bd0cef30`, zero failures/skips, receipt `check-dhs16sga`. After the next
executable delta (the one-line test wrapper), the affected trial-host test passed
1/1, zero skips, at clean `85e039dc`, receipt `check-0bzgbnyi`. This rerun is not another new
case. Existing facade/DDL cases are strengthened in place, not counted as new tests.

The new `remote-dispatch.test.ts` case uses actual F2 and Connections/OllamaClient code with
an in-memory fake response body. After exactly one model POST, signed owner cancel aborts
transport but `settled()` stays pending and the actual governor lease stays held while
`ReadableStream.cancel()` acknowledgement is blocked. Releasing it settles the lifetime and
releases the permit, with one cancel and no retry. Cleanup gates release in `finally`.
F2 remains non-stream text inference; inherited K3 stream assertions cover streaming cleanup.

The exact selected files, all passed in full:

```text
packages/server/test/remote-attempts.test.ts
packages/server/test/remote-dispatch.test.ts
packages/server/test/layout-replication.test.ts
packages/server/test/egress-scrubber.test.ts
packages/server/test/egress-truncated-prefix.test.ts
packages/server/test/session-log-truncated-egress.test.ts
packages/server/test/connections/model-access.test.ts
packages/server/test/connections/model-transport-settlement.test.ts
packages/server/test/ollama-client.test.ts
packages/server/test/durable-runs.test.ts
packages/server/test/kernel-plugins.test.ts
packages/server/test/federation/integration.test.ts
packages/server/test/federation/boundaries.test.ts
packages/server/test/federation/persistence.test.ts
packages/server/test/relay/judge-model.test.ts
packages/server/test/relay/judge-cascade.test.ts
packages/server/test/relay/trusted-runtime.test.ts
packages/bench/test/k3-gateway.test.ts
packages/bench/test/trial-host.test.ts
packages/bench/test/trial-binding.test.ts
packages/bench/test/k2-retention.test.ts
```

Commands use `node --test` followed by those paths, with the workstation runner selecting
Node 26 and shared `/Users/yuzuru/.local/state/agent-dev` resource `heavy`. Offline own
`npm ci --offline --no-audit --no-fund` passed after X1's manifest changes at `bd0cef30`,
receipt `check-9tdfej9c`. Contract resolution points into this checkout's contract source.

Scoped `npx tsc --noEmit -p packages/<workspace>/tsconfig.json` passed:

| Workspace | Pin | Receipt |
| --- | --- | --- |
| server | `bd0cef30` | `check-_6eyuioc` |
| contract | `bd0cef30` | `check-cetrp6a6` |
| cli | `bd0cef30` | `check-go_7g1su` |
| bench | `85e039dc` | `check-uozivdop` |

Each command ran with quiet pinned source. Receipts mark reuse unverifiable because the
inherited `.claude/skills/guanxi-ui` symlink points outside the checkout. These are observed
local results, not reusable source certificates. Full eight gates and browser checks have
not been rerun by this author; root owns them after independent composition review.

## Full candidate failure and bounded repair

Root's actual `npm test` at clean `d640546a` failed with exit 1, receipt
`check-z1rw6rql`; this is a failed aggregate gate, not superseded evidence of a pass.
Core reported 1575 passed / 1 Linux-only skip; kernel 107, web 353 and UI 43 passed.
Bench reported 118 passed / 17 failed out of 135, all in `private-process.test.ts`.
The workspace script runs in `packages/bench`, but the test resolved its fixture,
supervisor and launcher from the invocation CWD using repository-relative paths.
Policy validation consequently failed before the intended assertions. Seven detached
fixture groups had also started before a throwing record-construction call reached
`try/finally`, keeping the bench Node process alive. Root identified their exact owned
parent/groups and killed only those seven; all were gone before npm naturally exited 1.
The prior full typecheck passed (`check-xoh7p92q`); root stopped the eight-gate sequence
at npm test. Neither result is claimed as the final K5-composed candidate gate.

Separate focused fix `cb520038` resolves every fixture/identity path via module URL
and `fileURLToPath`, with one canonical bench directory independent of the npm caller.
It registers an idempotent per-test cleanup immediately after a grouped fixture spawns,
before awaiting setup or constructing records. Existing finalizers call the same cleanup.
No production behavior, safety assertion or deadline was weakened.

Independent composition review requested direct failure-path evidence. Separate review-fix
`9e90e20a` extracts the same test-only helper and adds one subprocess regression. The child
uses actual `node:test`, creates the owned group, records the exact supervisor/client PIDs
and deliberately throws before caller `finally` or record construction. The parent asserts
exit 1 with the intentional error, both PIDs absent, and group observation failing with
ESRCH. Its own fallback kills only those report-owned fixtures on failure. The intentional
failing child is not a second repository test credit.

The first workspace run at `9e90e20a` failed 1/136 (`check-qyk8s80g`): the nested test runner
inherited `NODE_TEST_CONTEXT` and Node skipped the child file. A bounded outside-checkout
probe reproduced its recursive-run warning and exit 0; no fixture group was spawned.
Separate correction `e9611d35` removes only that inherited runner marker from the child
environment. Final runs below pass, with no process cleanup intervention.

## K5 integration and final author checks

The local-only K5 fetch/merge adds reviewed second parent
`e4c7cf32183738887969a4fb91169a41385caf66`, with first parent
`d640546ad58de835012f43cc42d3138eb6e99d78`, as merge `a8eabb24`.
No conflict, manifest, dependency-lock, global-schema or migration resolution was needed.
The external-agent production/test trees are byte-identical to the reviewed parent.
Connections, native-agent, indexing and egress trees remain unchanged from `d640546a`.
The upstream independent review records 105 local passing cases, including the unchanged
write-boundary race probe and extra SQL/provenance case; that is inherited evidence, not
105 new integration tests. See the K5 handoff and the external review at
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/codex-k5-durable-admission-20261022.md`.

**New in this continuation: 1 cleanup regression / 135 bench regression envelope.**
The earlier 1 F2/K3 integration assertion above remains separately credited. The composed
K5 source parent contributes 37 new repository cases (27 admission, 6 process cleanup,
4 learning); the actual 103-case run below covers these plus 66 inherited cases.
Repeated runs and overlapping root/workspace invocations are not added as new tests.

All commands below ran locally with Node 26.9.0 through workstation-dev, shared
`/Users/yuzuru/.local/state/agent-dev`, resource `heavy`, pinned quiet source, exit 0,
no failures, skips or cancellations. No live CLI/vendor/model or owner workspace was used.

| Command | Pin | Result | Receipt |
| --- | --- | --- | --- |
| `npm test --workspace @guanxi/bench` | `cb520038` | 135/135 | `check-kyqki3nw` |
| `node --test packages/bench/test/private-process.test.ts` from root | `cb520038` | 18/18 | `check-ana50zqz` |
| `node --test` K5 nine files listed below | `cb520038` | 103/103 | `check-dz7pv7th` |
| `npx tsc --noEmit -p packages/bench/tsconfig.json` | `cb520038` | passed | `check-cg1zz3fz` |
| `npx tsc --noEmit -p packages/server/tsconfig.json` | `cb520038` | passed | `check-jfmdsxkt` |
| `npm test --workspace @guanxi/bench` | `e9611d35` | 136/136 | `check-nsurkdk0` |
| `node --test packages/bench/test/private-process.test.ts` from root | `e9611d35` | 19/19 | `check-zynlo85q` |
| `npx tsc --noEmit -p packages/bench/tsconfig.json` | `e9611d35` | passed | `check-qf_5gw3b` |

The exact K5 file arguments, all under `packages/server/test/external-agents/`, were
`admission.test.ts`, `process-cleanup.test.ts`, `learning.test.ts`, `lifecycle.test.ts`,
`policy.test.ts`, `adapters.test.ts`, `codex-login.test.ts`, `boundaries.test.ts`, and
`host-tools.test.ts`. After their pin only bench test/helper source changed; no K5/server
check was redundantly rerun. Final docs are a later documentation-only commit. The inherited
unsupported skill symlink still prevents reusable source certification; these are direct
observed check results with unchanged source recorded, not reusable certificates.

Independent composition review closed at `6ce226cf`; its separate setup-failure check passed
1/1 (`check-ktw6ahix`). Root owns the final aggregate eight gates. Full K5 and MS1 remain open.

## Final K4 encoding composition

Merge `30557ebb` adds independently reviewed K4 string encoding from
`63f8b0168f852f52a418dee140d2478515906497` to `6ce226cf`, without conflicts or manual
production resolutions. The private encoder, input store and affected tests are unchanged
from that source parent. Existing native-agent service, index, egress, external-agent and
bench fixture source is unchanged from the first parent.

The original decorative-bracket P2 was reproduced independently, fixed separately in
`f770c765` after red-first tests `d0f877d6`, and closed at `63f8b016`. Its final independent
check passed 19/19 (`check-a8ev7dic`): 14 repository pure cases, three unchanged regression
probes and two independent controls. Earlier helper/native coverage remains inherited
evidence; repeated runs are not new tests. Cumulative encoding repository coverage is
**19 new / 51 regression envelope**: 14 pure, four helper and one native case added.
See [the encoding handoff](K4-string-encoding.handoff.md) and the outside review at
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/codex-k4-string-encoding-20261022.md`.

Only immutable string-to-UTF-8 encoding and excerpt projection are bounded here. Artifact
reads/replay, scrubbed/base64 transport, provider history, byte-input snapshots and queue text
still have whole-buffer paths; this is not an end-to-end bounded-memory claim. Final source
composition review and the eight aggregate candidate gates remain pending on this new pin.

## Compatibility, rollback and remaining work

Disable the optional F2 grant host/adapters to stop new dispatch; retain additive ledgers
and durable receipts. Do not roll an older binary forward against migration 33 or assume
transport version negotiation restores database compatibility. Binary rollback requires the
pre-upgrade database backup described in the inherited K4 evidence. No destructive rollback
or live database upgrade was exercised here.

Independent review must check exact merge resolutions, both scrubber methods, index/native
registration, F1 layouts, R1 fencing and the final authorization/preparation/cleanup chain.
Root then runs the final aggregate eight gates before main integration; prior component
receipts remain separate evidence, not this bundle's full-gate result.

F2's toolful remote workspace/meter/git-bundle/seal connector and full client lifecycle are
still open. The fixtures do not prove real physical-host capacity, residency, wake/power
behavior, backend cancellation, cost, real six-hour operation, calibrated ETA, judge
precision/recall or MS1. R3 policy activation still requires real ADR-0025 calibration.
K4 queue text/full buffering and other accepted residuals remain; this bundle does not
relabel any complete lane or milestone as closed.
