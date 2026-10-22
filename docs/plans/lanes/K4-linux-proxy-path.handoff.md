# K4 Linux proxy socket-path repair handoff

**Status:** independently verified and integrated into local main45491863; actual Fedora
regression passes. No whole K4/platform/MS1 closure.
**Date:** 2026-10-22. Branch `codex/k4-linux-proxy-path`, base main `d64ce92b`.
Author root; separate reviewer GPT6.1Sol/high `encoding_review2`.

## Change and confirmed cause

The inherited Linux TMPDIR produced an expected110-byte Unix socket name, beyond Linux's
107 usable pathname bytes. The runtime created a different truncated socket, so sandbox
readiness failed. Unchanged-source long-parent failure/short-parent success was observed
under check-12pdoq96 before changing code. It is diagnostic evidence, not a new test.

Source a7df34d4 allocates Linux's private proxy directory under trusted `/tmp`; Darwin keeps
`/private/tmp`. Realpath,0700 creation, writable-root overlap refusal, worker staging, command
scratch-local HOME/TMPDIR, filesystem/network/TLS/CA/seccomp policy and teardown are unchanged.
No dependency, wire, database or model change. `/tmp` usability remains a host prerequisite.

The new Linux-only regression was committed first in1038a934 and actually failed on Fedora.
Describe-only grouping df521acc makes Node22 JUnit recognizable; it changes no assertions.
Separate test commits27fe4e1a/f86e57d3/28653d92 make privacy and cleanup durable: a read-only
observer in the isolated child delegates all original fork arguments unchanged, catches
metadata errors without throwing inside the hook, restores it in finally, and asserts after
settlement. It observes exactly one worker and only that worker's owned paths, never scans
`/tmp`, and emits derived facts rather than commands, paths or environment values.

The case requires canonical short `/tmp` proxy allocation,0700 mode, both known socket names
within107 bytes, proxy outside scratch, matching trusted HOME, canonical worker staging
directly under runtimeBase/outside scratch, and removal of proxy/staging before settlement.
Exact result/code/output/stderr/truncation, command HOME==TMPDIR, scratch file bytes and empty
old parent remain asserted. It is still **one new case**, not several new tests.

## Actual checks and pins

Dedicated remote task:
`/home/guanxi-bench/checks/guanxi-linux-proxy-path-20261022/source`, uid1001, Node22.23.1,
own npmci/contract resolution, sanitized environment and host-local shared heavy lock.
Retained units use2CPU/MemoryHigh3GiB/Max4GiB/weights20/Tasks512; terminal observations below
have loaded units, correct exit states and empty control groups. No live model or owner data.

| Scope | Pin | Actual result |
| --- | --- | --- |
| Own dependency installation | 1038a934 | check-s45rw1pi pass; contract resolves inside the Mac checkout |
| New actual Linux regression, before fix | 1038a934 | check-ne9ii2tm,1 case/1 failure, sandbox_failed; child1 |
| Same new case, fixed source | 3e75852c | check-9tcwnyd3,1/1 pass, zero skips |
| Selected14 native/core files plus new case | 3e75852c | check-2jqnqayy,214 total/208 pass/6 named Darwin-only skips/0 failures |
| Independent corrected lifecycle/policy comparison | 3e75852c | check-bmjp2k61 pass; details below; not repository credit |
| Strengthened same repository case | 28653d92 | check-abea4ty4,1/1 pass, zero skips, valid fresh JUnit |
| Mac workspace types / scoped ESLint | 3e75852c | check-bzszawee / check-a12fls2u pass |
| Mac full npm regression envelope | 3e75852c | check-jqapa65j pass; core1633/1631 pass/2 Linux-only skips; kernel107, web353, UI43, UI-gates102, catalog74, codemod6, bench137 |
| Final scoped ESLint | 28653d92 | check-sh60fky6 pass |

The selected Linux214 are **1 new +213 inherited**; inherited207 pass/6 Darwin-only skip.
All25 failures from original main3e4840bb are absent. Counts use every actual JUnit testcase;
the existing Node22 helper's top-level suite summary undercounts nested cases/skips. The
initial red additionally has a helper-invalid top-level JUnit layout, but its actual failing
testcase and child exit1 were independently parsed. No failure is relabelled green.
The strengthened final case changes tests only; all packages/src and dependency manifests
are byte-identical to3e75852c. The214 Linux cases and full Mac npm were not repeated afterward.

## Independent control correction

Original control check-ttg_w6kn and explicit captured repeat check-58q7d_36 both exited1.
The helper redacted a boolean key containing private through the rest of its JSON line;
a separate strict-schema private0600 capture retained safe flags and preserved child1.
Only result-code/output expectations failed; host sentinel, proxy privacy and cleanup passed.

The original control wrongly assumed a syscall to a hidden host pathname must fail. The
runtime can make a private tmpfs shadow writable while the host file remains unchanged.
Separate comparison check-bmjp2k61 actually observes the original expression's exit22 with
host bytes intact, then a corrected readable-but-readonly owned root denies writes and
returns the exact success markers. All25 corrected lifecycle/policy flags, cleanup and
source-unchanged checks pass. This corrects the control premise; it changes no product guard.
These diagnostic calls are not extra repository tests or replacements for the original reds.

Private receipts/JUnit/unit observations:
`/Users/yuzuru/.local/state/guanxi-fedora-checks/20261022-native-proxy-path`.
Outside independent report:
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/codex-k4-linux-proxy-path-20261022.md`.
Unsupported external UI-skill symlink means source_verifiable/reusable remain false. Report
actual clean pins and observed results, not a portable source certificate.

## Integration, rollback and residuals

Final candidate45491863 types/build/Markdown/license/lint pass respectively:
check-fo_1sgj2, check-2f9913p3, check-d6e5mxce, check-_y5egedl (675/0) and check-ccs7zg8j.
Coordinator exits0; source stays clean/unchanged. Root fast-forwarded this exact reviewed tree
into local main without conflict or resolution. The all-eight main sequence remains at1b6;
no repeated npm/browser run is claimed at454 after the test-only tightening/docs.
No web code changes in this slice. No database/data migration or down migration is needed;
rollback reverts the focused allocation/test/docs commits. The source rollback reintroduces
the demonstrated long-parent Linux startup failure, so prefer a forward repair.

This closes neither whole K4/platform acceptance nor queue consumption, real LSP, untrusted
rootless benchmark, physical fleet or MS1. The actual six-hour other-node30B delegation,
zero lead-token change, one wake and accepted B3 quality/calibration gates remain separate.
