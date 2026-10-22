# F2 and InProgress integration handoff — 2026-10-22

**Status:** implemented integration candidate; author scoped checks passed; independent
composition review and root full candidate gates pending. This does not close F2 or MS1.

## Checkout and ownership

- Author checkout: `/Users/yuzuru/Projects/Guanxi-lanes/ms1-f2`.
- Bundle branch: `codex/in-progress-integration`.
- Preserved F2 branch: `codex/ms1-f2` at `b3b1077e`.
- Last executable/test change: `85e039dc9c773aa1c0c03ba9858e1fcbec0adc1a`.
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

The R3 and B1 objects were fetched from the explicitly authorized local standalone clones.
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
- B1 production source equals `fb57323e`; its only later delta is the test wrapper return.
- Global user_version 33 and independent ledgers 36 (offers), 37 (dispatch), 38 (judge),
  39 (trusted start) coexist without rewriting their applied SQL.

## New assertion and regression envelope

**New: 1 integration test. Regression envelope: 304 tests.** The 305-test author command
passed at clean `bd0cef30`, zero failures/skips, receipt `check-dhs16sga`. After its only
subsequent executable delta (the one-line test wrapper), the affected trial-host test passed
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
