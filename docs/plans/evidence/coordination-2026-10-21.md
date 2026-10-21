# Coordination audit and integration checkpoint — 2026-10-21

**Status:** locally validated main checkpoint; unfinished candidates remain open.
**Source:** clean `main` at `80f724525d2e4c41f60284d17157e326c737ee0c`.

## Outcome

The local `main` already contained DS1-c (`a07d3d7`), R2 (`726efc3`) and K5 (`80f7245`),
although central status files still described their review fixes as running. F1 (`e2fdd66`)
and K4 plus its first follow-up were also merged. Fetching `origin` confirmed zero commits
behind and 84 ahead before this documentation checkpoint. No unreviewed candidate was merged
by this audit.

Three independent GPT 6.1 Sol / high workers checked kernel/run lanes, design lanes and the
local coordinator/session evidence. They inspected implementation assertions, original gate
claims, clean lane heads and existing receipts. Test counts were not used as a progress proxy.
Local session inspection used tool-call metadata and delegated-task summaries; stored thinking
bodies were not read or exported.

## Progress estimates

These are judgment ranges over accepted scope and unfinished exit criteria, observed on
2026-10-21. Confidence is high for Git/merge state and medium for estimates. They are neither
measured project velocity nor release-readiness scores.

| Stage | Estimate | Evidence denominator and remaining scope |
| --- | --- | --- |
| K4 | 70–85% | Five original gate groups have local assertions; core and first follow-up merged. Follow-up 2 addresses retention/R1 integration; input artifacts, HTTPS-positive, wider UI and platform envelope remain. |
| K5 | 60–75% | Three of five original gate groups fully evidenced; release-session captures and effective implicit bare-state detection are partial. Automatic Claude quota production and distributed admission remain. |
| R2 | 80–90% | Six offline gate scenarios have direct assertions; internal service merged. Trusted live runtime meter/admission, public start path and independent semantic probe evidence remain. |
| F1 | 100% of bounded F1 | Six simulated gate groups evidenced, three Claude review rounds, merged. Remote attempts and a deployed operational fleet are later scopes. |
| B1 | 40–55% | Fixture statistics/report/reservation foundation and two-task $0 Harbor smoke exist. Immutable 50+30 task staging, real Guanxi executor, request-level billing enforcement and measured noise floor remain. |
| DS1 | 100% of bounded DS1 | All a/b/c parts merged; direct assertions cover the roadmap properties and fresh integrated fast/browser gates pass. Remaining colour suppression debt belongs to U1; owner-key custody belongs to DS2. |
| DS2 | 55–70% closure | Helper/format/install scaffolding built; production policy evidence and platform regression under review repair. Installed-helper custody and actual owner-present signing remain unverified. |
| X1 | 85–95% | Existing local Mac/Fedora gates recorded; new independent parent fingerprint read-boundary finding must be fixed before integration. |
| Whole U1 | 30–40% | U1-a mostly implemented locally; U1-b shell and U1-c migration not started. Real cross-node layout replication is absent. |

## Pinned candidates and recovery ownership

| Candidate | Inspected head | Next bounded work |
| --- | --- | --- |
| K4 follow-up 2 | `e5e9d3d` | `codex/k4f2-review-fixes`, standalone `Guanxi-lanes/coord-k4f2`; DeepSeek Flash/max repairs handover-during-delete; independent GPT recheck follows. |
| DS2 | `6463142` | `codex/ds2-review-fixes`, standalone `Guanxi-lanes/coord-ds2`; current main merged as `e088f1c`; DeepSeek Flash/max repairs two review findings; GPT recheck follows. |
| X1 | `b92fc703` | `codex/x1-parent-read-boundary`, `Guanxi-lanes/coord-x1`; GPT implements the boundary repair, a different GPT reviewer verifies it. Sandbox-dependent tests stay outside DeepSeek. |
| U1-a | `0523f9b` | Independent review/integration, explicit replication gap; then separate U1-b/c slices. |
| B1 | `298a93a` | Define request-billing enforcement, immutable corpus and real task-executor contracts before another execution slice. |

These are task assignments, not proof that a process is still running. Recheck process state
and the latest handoff before resuming. The original lane branches/worktrees were preserved.
Workers do not edit central trackers, push or merge. The coordinator owns the shared heavy
lock and delivery.

Confirmed findings in the unfinished candidates:

- **K4F2 home fence:** a deletion admitted by the old home continued after asynchronous
  filesystem cleanup yielded and a successor claimed R1; the old call deleted successor-visible
  run/session rows. The synthetic race reproduced. Keep deletion intent for successor recovery
  and fence later steps/final database mutation inside the owning generation.
- **DS2 evidence:** fixture builds excluded production access-control/context construction,
  so repeated fake-auth confirmations did not prove production user-presence/zero-reuse policy.
  No key-export or no-touch signing bypass was confirmed. Also, Linux reported helper missing
  rather than unsupported platform. Hardware bootstrap/signing was not run by this audit.
- **X1 read boundary:** parent-side fingerprinting read policy bytes outside the root during a
  deterministic ancestor swap, then rejected the changed tree. No exfiltration or indexing of
  those bytes was claimed. A post-read containment check is insufficient.
- **U1 replication wording:** a local in-memory LWW merge test does not prove cross-node
  layout delivery. Keep actual replication open rather than closing the roadmap requirement.

## Coordinator and harness review

Opus used concrete lane ownership, pinned diffs, per-finding commits, scoped continuation
prompts and independent falsifiable reviews well. These patterns should be retained.
Observed weaknesses were stale visible status, sending sandbox-dependent X1 checks to a
nested harness that could not execute them, and late typechecking after Node type stripping.
No measured token/cost saving is inferred from model names or session activity counts.

Local orchestration under `Guanxi-lanes/infra` was repaired separately from product code:

- `lane-gates.sh` stops on the first failed dependency/direct/heavy command.
- DeepSeek launchers preserve the real child exit, reserve private non-overwriting logs, and
  discard thinking/tool/raw-stderr streams before final-only plaintext capture.
- Direct and queued starts share four atomic slot locks, matching the owner's continuation
  limit. Historical raw logs were not inspected for reasoning or altered by this task.

Independent stub checks verified stream sentinels never reached disk/stdout, child failure
status was preserved, invalid/duplicate names were refused, five concurrent workers peaked at
four, and install/direct/heavy failures prevented later gates. Supervisor TERM cleans the
owned child group; a killed supervisor leaves the slot held by the live inherited child
until that child exits (synthetic process checks). No live model/provider was used
by those checks. These local helper changes are outside the product checkout; they do not
establish a new Guanxi runtime feature or a production concurrency guarantee.

## New / regression envelope

**New:** zero product tests in this documentation reconciliation. The local orchestration
repair has nine independent synthetic regression tests outside Git; candidate repair tests
belong to their own handoffs and are not credited here.

**Regression envelope:** fresh checks on clean `main` `80f7245`, local macOS, Node 26.9.0,
ports 5173/4310 and disposable `.lane-data`, no live model or owner data:

| Command | Result | Local evidence |
| --- | --- | --- |
| `npm run typecheck` | pass | `check-57n0cows/result.json` |
| `npm test` | pass: codemod 6, UI gates 89, core 1203 total / 1202 pass / 1 opt-in keychain skip, kernel 106, web 314, catalog 70, UI 17 | `check-zewmz8x6/result.json` |
| `npm run test:web:browser` | 65/65 mocked Chromium tests pass | `check-bqke6h2i/result.json` |
| `npm run ui:check:browser` | pass | `check-cds6vxby/result.json` |
| `npm run build` | pass | `check-7j2m33ki/result.json` |
| `npm run lint:md` | pass, 154 Markdown files / 153 link-scanned files, 598 links, zero problems | direct command output |
| `npm run check:licenses` | 658 packages, zero disallowed | direct command output |
| `npm run lint` | pass, four existing ineffective-directive warnings, zero errors | direct command output |

Receipt directories are under `~/.local/state/agent-dev/`. Each locked command returned
exit 0 with `source_changed: false`. The existing external `.claude/skills/guanxi-ui` symlink
makes source certification non-reusable; these are observed local command results, not
portable source attestations. The browser gate uses mocked services and establishes neither
live Ollama/GPU behavior nor production readiness.

Documentation changes are validated separately after reconciliation. No product source changes
after the main checkpoint are included in its regression claim. New candidate fixes require
their own independent review and appropriate gates before a future integration.

## Interactive roadmap

The original Claude artifact was inspected in the owner's Chrome session and was stale.
Its local HTML source was recovered, and an updated standalone snapshot was produced outside
Git with audited statuses and the progress table. The original Claude publication was not
modified: the current tool surface has no equivalent of its original Artifact publisher.
Canonical roadmap scope/dependencies remain in ROADMAP and `roadmap.mmd`; the HTML snapshot
is a dated view, not a second requirements source.
