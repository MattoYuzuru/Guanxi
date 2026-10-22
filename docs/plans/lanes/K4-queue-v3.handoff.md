# K4 queue v3 handoff

**Status:** Q0 accepted by its author on 2026-10-23, with every gate below green at the named
pins. This is not a second independent acceptance; the last independent review
(`reviews/codex-k4-Q0-acceptance-20261022.md`, pin `14db1971`) requested changes, and the
two findings it raised are resolved here. Q1 and Q2 are not started.

- Checkout: `/Users/yuzuru/Projects/Guanxi-lanes/k4-queue-v3-foundation`, branch
  `codex/k4-queue-v3-foundation`.
- Plan: [`K4-queue-v3.plan.md`](K4-queue-v3.plan.md). Detailed Q0 history, compatibility,
  rollback and file list: [`K4-queue-v3-Q0.handoff.md`](K4-queue-v3-Q0.handoff.md).
- Final pin: `ec3a1550` plus this hand-off commit (docs only). Main merged at `069eeb24`
  (merge commit `426cef23`; no `package.json` changed, so no install).

## Resolution of the acceptance findings

| Finding | State at `7ec79c59` | Resolution |
| --- | --- | --- |
| P2: Russian test looked up the timeline by its English name | oracle fixed in `4880ad16` | confirmed: it now uses the Russian accessible name; passes |
| P3: preview copy called every inline item legacy and doubled the byte unit | tests fixed in `7ec79c59`, production unchanged, 4 of 6 cases red | production fix `50c66e68`: `inspector.queue.previewDetail` (EN source, curated RU) now reads "Preview: first {shown} of {total}. The rest of the inline text is not shown here." for v1 and v3 inline items; `formatBytes` supplies the only unit |

Red then green: with the locale change stashed, 4 of the 6 queue cases failed; with it, all
pass. The component tests assert the full EN and RU sentences, exact row order and ids, tail
and artifact id absence, and the artifact descriptor with one unit per quantity.

## Further failures found by the full gates, fixed in separate commits

- `bcc842bf` (test only): `sandbox.test.ts` "Unix socket exposed inside a selected root"
  failed with `listen EINVAL`. The fixture socket was 105 bytes deep in this long lane path,
  over the macOS limit (about 103). The file name is now `s.sock`; assertions are unchanged.
  The lane path, not Q0, caused it. A deeper lane path would hit it again.
- `bfa87733` (test only): the inspector browser case counted `getByText('Inline')`, a
  case-insensitive substring match that also hit the item id `phone-inline`. This case had
  never been run; it now uses `{ exact: true }` for "Inline" and "Bounded input".
- `ec3a1550` (type only): `npm run typecheck` failed in `packages/bench/src/k2-retention.ts`
  (three TS2345 errors). The Q0 `SessionAppendData` widening made `SessionEventInput<T>`
  invariant in `T`, so a `SessionEventInput<'reasoning'>` no longer fit a parameter typed with
  the full union. The bench `append` helper is now generic over the event type. The Q0 author
  had typechecked only server, web, contract and cli. My first light-gate run missed this
  because I read a truncated tail without the exit status; the table below is corrected.
- Two indexing tests (`indexing/process.test.ts` sandbox read race, `indexing/service.test.ts`
  two ticks) timed out at 20 s in the first full `npm test` while the host load average was
  about 15 (Spotlight `mds` and unrelated apps). Both pass alone (`check-mdsvwh2o`) and in the
  second full run. No timeout, retry or assertion was changed. Treat as load-sensitive.

## Gates

All heavy runs: `agent-dev run --node 26 --resource heavy --lock-timeout 3600`, ports
5210/4410, data dir `.lane-data`. The external `guanxi-ui` symlink makes receipts non-reusable
(`source_verifiable=false`); they are direct observations at the pin. `[R]` = the runner
masked digits in the log.

| Gate | Pin | Result | Receipt |
| --- | --- | --- | --- |
| `lint:md` (217 files, 701 links), `check:licenses` (675 pkgs), `ui:check` | merge `426cef23` | pass | direct |
| `typecheck` | `426cef23` | FAIL (bench, 3 errors) | direct |
| `typecheck`, `lint` (eslint, css, suppressions) | `ec3a1550` | pass, exit 0 | direct |
| Native/helper/CLI envelope (6 files, `--docker`) | `426cef23` | 79/79, 0 skips | `check-ohv7g5n1` |
| Inspector components (3 files) | `426cef23` | 25/25 (was 23/24) | `check-hfzlyqud` |
| `npm test` first run | `426cef23` | FAIL: 3 failures (sandbox socket, 2 indexing timeouts) | `check-o5eb89tz` |
| Indexing pair alone | `426cef23` | 2 files pass | `check-mdsvwh2o` |
| Socket case alone | `bcc842bf` | pass | `check-luefu_u_` |
| `npm test` | `bcc842bf` | pass in every workspace: 0 failures; server 2 platform skips (Linux-only); web 43 files 359 tests; cli 74 tests | `check-5zjj0brk` |
| `test:web:browser` first run | `bcc842bf` | FAIL 96/97 (queue badge count 3) | `check-ufwm1xq0` |
| Inspector browser spec alone | `bcc842bf` + fix | 2/2 | `check-9pahkkmt` |
| `test:web:browser` | `bfa87733` | **97/97**, 0 flaky | `check-lpxat6mf` |
| bench workspace tests | `ec3a1550` | pass, 0 fail | `check-m6v_kgb4` |
| `build` | `ec3a1550` | pass | `check-kvajoc7a` (also `check-mzymb2ho` at `bfa87733`) |

`npm test` ran before the browser-spec-only commit, which no unit workspace imports; it was
not rerun. `lint:md` was rerun with this file: pass. `npm test` and the browser gate ran before the
type-only bench commit; it touches no runtime path, and bench tests plus build were rerun after it.

## Counts

- New Q0 case identities: 42 (41 authored before, plus one: the legacy-preview component case
  is now an EN/RU pair). Executed and green: repository 34 (independent, `71dc6bb0`), native
  service 1, inspector component 6, inspector browser 1; the rest inside `npm test`.
- Regression envelope: 78 inherited native/helper/CLI cases, 19 inherited inspector component
  cases, the 30 inherited repository cases, and the whole `npm test` and 96 inherited browser
  cases, all green except as listed above.
- Earlier independent receipts still stand at their own pins: repository 64/64
  (`check-np6q_yoe`) and outside controls 5/5 (`check-q3orx9yn`, SHA `eae2c7e2...`). The outside
  controls were not rerun here; no production code they cover changed after `71dc6bb0`
  except the inspector locale string.

## Residuals

- Q1 (restricted native reader, progress2, whole-buffer paths) and Q2 (producer activation,
  old-POST-202 to progress1-406 pairing) are not implemented. The native producer stays v1.
  Legacy progress still refuses a present v3 snapshot with content-free `agent_unavailable`.
- Legacy oversized v1 inline snapshots are immutable; the inspector shows a bounded preview.
- No queue FTS, hydration endpoint, per-blob GC or total-memory claim. Q0 is not a native v3
  rollback floor. Rollback needs a stopped, consistent SQLite and artifact backup.
- A second independent acceptance at the final pin has not been done; root decides whether
  to request one before integration. `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are
  untouched here and belong to the root integration.
