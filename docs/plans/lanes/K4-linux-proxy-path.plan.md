# K4 Linux proxy socket path repair

**Status: independently verified and integrated locally; actual Fedora regression passes.** Date:2026-10-22.
Checkout `/Users/yuzuru/Projects/Guanxi-lanes/k4-linux-proxy-path`, branch
`codex/k4-linux-proxy-path`, base main `d64ce92bf4570e99b61db1b4a0f0e929b9c9b398`.
This is separate from the active queue-v3 and workspace-state author checkouts.

## Observed defect and outcome

Actual Fedora source3e/executable1b6 passes X1/kernel62 but selected native/core fails25/213.
Independent source diagnosis and unchanged-source synthetic comparison `check-12pdoq96`
confirm the inherited long TMPDIR produces an expected110-byte Unix socket pathname. Socat
creates a different socket, so runtime readiness fails. The identical production command
fails under the long parent and succeeds under `/tmp`, with every sandbox guard unchanged.
The diagnostic is not a new regression pass; private observation is
`/Users/yuzuru/.local/state/guanxi-fedora-checks/20261022-3e4840bb/probe-20261022T194759Z.json`.

Allocate Linux's private network/proxy directory under the short trusted `/tmp` base, just as
Darwin already uses `/private/tmp`, while keeping realpath/overlap checks,0700 creation,
cleanup, CA hiding and all filesystem/network/process restrictions. Worker staging and actual
command scratch/TMPDIR remain independent. No provider/model/logging/timeout/retry change.

## Implementation and falsifiable checks

1. Add one actual Linux-only regression with a long **parent** TMPDIR in a fresh child
   process, a separate scratch and sanitized fixture environment. Run production execution,
   assert exact marker/file bytes, command scratch-local TMPDIR and complete owned cleanup.
   Commit test before source fix and observe it fail on actual Fedora.
2. Minimal sandbox.ts allocation change, separate commit, then run the same new case green.
   Preserve long-scratch regression, real overlap refusal, cancellation/descendant ownership,
   method/TLS/CA/egress guards and source quiet. No global environment shortening workaround.
3. Repeat the affected selected14-file native/core envelope plus the new test on actual
   Fedora under dedicateduid1001, Node22, private source/fixtures and shared remoteheavy.
   Six named Darwin-only skips are expected; require no unexpected failure or skip.
4. Separate GPT6.1Sol/high independently reviews the diff and discriminating actual evidence.
   Root runs proportional types/lint and integration checks on clean pins before main merge.

Own only sandbox.ts, new regression and native README/lane handoff. Do not change sandbox
worker diagnostics, policy, seccomp/runtime dependency, queue code, schemas, owner data, UI,
models or existing tests. No new license/dependency. Rollback reverts the focused source/test
commits; no stored data or public API migration. `/tmp` availability/permissions remain a
host prerequisite; this does not claim arbitrary-host platform acceptance or MS1 closure.

Root owns Mac/Fedora runtime. Local Node26 own npmci, remote supported Node22 own npmci.
Use resolved workstation-dev skill, personal infrastructure navigator, repo AGENTS/WORKFLOW/
lanes and common host-local agent-dev state/resourceheavy. Checks freeze source and runner.
No live model, paid call, owner workspace, key or GitHub push. Record new1 versus inherited
envelope and real red/green/skip/terminal metadata; unsupported skill symlink remains a source
certification limitation. Root alone updates PHASE/NEXT after actual integration.
