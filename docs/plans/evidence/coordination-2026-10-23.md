# Autonomous continuation — 2026-10-23 (night fan-out)

**Status:** implemented record · **Updated:** 2026-10-23 · **Scope:** the overnight owner-away run

The owner approved, on 2026-10-22 late evening, an autonomous nine-hour run without SSH or other
hosts: push, clean up, and fan out up to three Sonnet and two DeepSeek workers, with Opus
reviews. The earlier Codex root session had stopped mid-round (K4 Q0 test fixes committed but not
re-accepted; U1 baselines half-written); this run took over both. No Fedora, no live model, no
paid call, no owner workspace was used. "Implemented" below means merged into local `main` with
the stated tests; it never means a stage or milestone exit.

## Housekeeping

- `main` pushed to GitHub (`069eeb24`, then at every integration checkpoint).
- 37 merged worktrees, 17 merged clones, raw DSH logs and 9 GB of DS1 scratch copies moved to
  `~/.Trash/guanxi-cleanup-20261022` (hard deletion was refused by the session's safety policy);
  unique unmerged refs archived under `refs/archive/*`. `Guanxi-lanes` went from 40 GB to 4 GB.
- Stale `refs/remotes/coord/*` removed; an orphaned 11-day-old Chromium pair stopped; the
  superseded X1 fixture image and dangling images removed. Other projects' containers untouched.

## Integrated slices (author → independent reviewer → fixes)

Every slice was authored in its own clone, reviewed by a separate Opus reviewer that ran tests
and mutations, and its findings fixed in separate commits before merge. Counts are the slice's
targeted suites at merge.

| Slice | Author | Review findings fixed | Targeted tests |
| --- | --- | --- | --- |
| K4 queue-v3 Q0 acceptance | Sonnet | P2 Russian oracle, P3 truthful preview copy (locale) | inspector 25/25, browser 97/97, full npm |
| U1 integration (workspace states, mounted shell, status closure, primitives, glossary) | Sonnet | P2 overflow hidden by route host; G11 circular assertion | browser 172–173, full gates |
| B3-a offline relay evidence validator | Sonnet | P2 `complete` with missing field evidence; unasserted rules | bench 168, 45 mutations killed |
| NC1-a/b/c/d/e notifications core, inbox, delivery, producers, OS adapters | DeepSeek | forecast vs any dependent run, hidden reset, acted-snooze revival, port idempotency keys, DST edge, currency provenance, bidi titles | 86 + 13 |
| V1-a/b/c voice glossary, store, eval metrics | DeepSeek | P1 `про`→`PR-о` false inflection, cross-token matches, perf, per-account ids, revert replay, fingerprinted eval sets | 220 |
| WG1-a work ledger core; WG2-a tracker sync | DeepSeek | wrong-command evidence reaching `done`, proposal DAG, user label deletion, read-side rate limits | 39 + 40 |
| U3-a authorization core | DeepSeek | owner grant treated as ownership (D-190), NaN expiry, cross-type ids | 33 |
| P1-a skills/AGENTS.md; P1-b plugin manager | DeepSeek | root-check bypass, unread-body proof; install and uninstall crash windows, recovery under lock | 41 + 34 |
| R3-b judge replay; R3-c ETA calibration | DeepSeek | gate per required class; P1 one run dominating ETA coverage | 9 + 11 |
| F2-c remote cost ledger (+ R1 `complete(…, cost)` seam) | DeepSeek | crash-test coverage and atomicity probes | 97 + crash suite |
| R2-op operational llama-server relay runtime and owned checkouts | Sonnet | P1 unported spawn never wired the relay; unfinished stop types | relay 224 |
| C1-a browser origin policy and site grants | DeepSeek | data-carrying model URLs, context scope, suffix-wide grants | 39 |
| MS2 wiring: notifications, voice, work plugins + REST + contract + web client | Sonnet | damaged sidecar failing the whole boot; account-scoped de-dup | 149, browser 173 |

## Root-caused gate failure

`indexing/service.test.ts` timed out repeatedly in full `npm test` runs (also seen by earlier
authors). Root cause: the X1 worker runs at macOS background QoS (`taskpolicy -b`), which
throttles I/O as well as CPU; under the parallel suite it starved indefinitely (a 60 s budget
still failed, CPU-only synthetic load still finished in ~20 s). Service-semantics tests now run the
worker at inherited priority (`workerPriority: 'inherit'`, test-only); the product default stays
background and the wrapper keeps its own tests. The next full sequence at `712b464d` passed all
four heavy gates (receipts `check-hflwk1f7`, `check-06qj8wnm`, `check-i_6xvct1`, `check-l78h8rlx`).

## What this does and does not close

No stage exit or milestone is claimed. MS1 still needs the lead hibernation/wake lane (LW),
remote relay inference (F2-d), a real two-host run with a 30B-class model on the Fedora node for
≥ 6 hours, recorded R3/B3 corpora and calibration. MS2 still needs UI for the new backends, real
action ports, U2 desktop, C1 browser host, C4 Bridge, U3 authentication, DS2 owner signing and the
owner's two-week daily-use gate. Residuals per slice are in each `docs/plans/lanes/*.handoff.md`.
