# K4 queue-v3 Q2 handoff

**Status:** implemented, independently reviewed, focused local checks pass. Final hosted
completion must be established for the exact ready candidate in
[PR #5](https://github.com/MattoYuzuru/Guanxi/pull/5) using `npm run ci:finish -- 5 --wait`.
**Date:** 2026-11-01 · **Base:** `1be1b6de` · **Branch:** `lead/wave9`.

The root authored the producer and new tests. A separate native agent adapted four inherited
test files in an isolated worktree; a third, read-only agent reviewed the integrated code and
re-reviewed fixes. Local target: this Mac, Node 26.9.0, existing dependencies, synthetic provider
and temporary `.lane-data` fixtures. No remote host, live model, paid call or owner data.
Plan: [Q2](K4-queue-v3-Q2.plan.md), parent [contract](K4-queue-v3.plan.md).

## Implemented behavior

- Every new add/remove snapshot is v3, including inline-only and empty snapshots. At most
  16 KiB of scrubbed UTF-8 stays inline; larger incoming and retained legacy text becomes
  a session-owned artifact. Historical v1 events are not rewritten.
- Normalization runs inside the admitted FIFO with captured session/active/attempt/home/abort
  checks before and after awaited writes and immediately before the final atomic append.
  Descriptor resolution and the queue event share the existing log transaction. Retained
  artifacts are neither hydrated nor rewritten; removal deletes no historical data.
- A current-registry projection synchronously re-bounds every artifact excerpt at commit,
  preserving immutable checksum/size/media type and protection of a secret prefix at a cut.
- Side-chat Send, the agent queue tool and ordinary running-turn prompts share this producer.
  Existing operation IDs remain idempotent. Request shapes, CLI result JSON and execution
  policies are unchanged. Legacy progress returns typed 406 for pending artifacts; progress2,
  stop and result remain usable.

No contract/schema migration, dependency, UI, tool-set or model-prompt change. The obsolete
internal `blocksV1Producer` helper was removed; the public legacy refusal schema/route handler
remain compatible with older nodes. No new input acceptance cap or automatic inference added.

## Review and fixes

| Independent finding | Evidence and resolution |
| --- | --- |
| Q22 lacked the actual large HTTP POST pairing | `c210d394`: direct unchanged POST returns 202; default/v1 exact 406; strict progress2 artifact bytes/checksum/no tail and zero blob reads; stop/result remain usable |
| Native README opener contradicted Q2 | `c210d394`: distinguish historical v1 from current v3 production |
| Registry registration during storage could expand an excerpt past 8 KiB and fail the running turn | Reproduced before fix (`check-9tk_o9ne`: incoming case failed `invalid_event`). `b6fcefee`: final synchronous projection for all descriptors; two held-write regressions pin incoming expansion and retained cut-prefix, including raw new durable payload assertions |

The independent re-review of `b6fcefee` found no remaining blocking code findings. It checked
FIFO, captured ownership, atomic reuse/removal, full-byte execution, restart, compatibility and
claimed assertions. Review was read-only and did not duplicate the test run. Separate document
review covered the roadmap/current-state audit and root's status/continuation evidence.

## New evidence / regression envelope

**New: 21 tests** in `native-agent/queue-v3-producer.test.ts`:

- Q01/Q06: 5 byte-boundary/Unicode/surrogate cases, full verified queued input dispatched once;
- Q02: equal large text, distinct IDs, one metadata/blob digest and no duplicate snapshot;
- Q04: retained legacy normalization on add/remove (2), removal of broken artifacts without
  reads/deletion (1);
- Q03: held-write add/add/remove FIFO (1), provider completion while storage is held (1);
- Q05: stop/leave/fence/helper failure (4), owner loss after successful storage (1);
- Q09: restart after acceptance starts no inference, explicit continuation consumes once (1);
- Q10: known/late secrets at storage and dispatch (1), late registration during storage (2);
- Q22: direct large HTTP compatibility pairing (1).

**Regression: 205 tests** — 142 inherited native/CLI and 63 log/artifact/version/privacy.
The adapted Q1 cases are regression evidence, not new tests: obsolete restriction/v1-production
assertions now pin v3 acceptance, retained references, tools and side-chat; historical-reader
cases explicitly seed v1 through a closed writer. Other assertions were preserved.

## Commands and observed results

Server tests always include `--import ./packages/server/test/setup/no-ambient-key-file.mjs`.
Heavy commands use `python3 -B /Users/yuzuru/.agents/skills/workstation-dev/scripts/dev.py run
--cwd /Users/yuzuru/Projects/Guanxi --node 26 --resource heavy -- node ...`.

| Scope | Result |
| --- | --- |
| Final focused union: `native-agent/{queue-v3-producer,queue-v3-reader,queue-v3-review,queue-v3-round2,agent,input-artifacts,crash,review,side-chat,lifecycle,tool-errors,port-wiring}`, CLI `agent-exec`, log `{queue-artifacts,queue-v3-contract,queue-v3-projection,version-negotiation,routes,truncated-egress}`, `egress-truncated-prefix` | 226 pass, 0 fail, 0 skipped; `check-2jjanoy9`, code `b6fcefee`, no source drift |
| Earlier native/CLI union before final review fixes | 160 pass, 0 skipped; `check-pjkt2ea2` |
| Producer + log envelope after HTTP regression, before excerpt fix | 82 pass, 0 skipped; `check-f_ogsa1u` |
| `npm run typecheck --workspace @guanxi/server` on final code | exit 0 |
| ESLint on changed production and test TypeScript files | exit 0 |

The final run log and receipt live under `~/.local/state/agent-dev/check-2jjanoy9/`. The
runner explicitly marks receipts non-reusable because `.claude/skills/guanxi-ui` targets a
directory; these are observed local results, not source-reuse attestations. Full hosted CI
checks the exact ready PR candidate. Final docs lint/link results and hosted run/revisions must
be recorded in the PR/finish output without a post-success tracked edit (CI protocol).

## Compatibility, limits and next slice

Q0+Q1 is the restricted-reader rollback floor: it can consume v3 but refuses mutations over
pending v3. A max-2 reader stops at the first new v3 event, before unsupported bytes; rollback
before Q0 needs a stopped consistent pre-upgrade DB/WAL/artifact backup and loses new writes.
An old client may POST successfully and then need to upgrade for progress2. There is no mutation
replay or automatic inference on restart; external dispatch still has the documented uncertain
crash window after the durable prompt marker.

Late registry expansion of a stored inline item still fails closed, preserving input. Removal
requires an active mutation owner and is sealed during preparation; an idle broken head has no
new recovery UI/API here. Whole-buffer replay and missing-attempt-allocation observability remain
named residuals. No live/Fedora, hardware-signing or desktop-distribution claim is made.

After the final PR gate succeeds, continue a bounded macOS local service lifecycle slice
(launchd/login/tray), per [NEXT_AGENT_PROMPT](../NEXT_AGENT_PROMPT.md). If CI is absent/failed/stale,
remain on this slice and diagnose its exact blocker first. This handoff does not close all K4/MS2 gates.
