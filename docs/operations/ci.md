# CI and local checks

**Status:** implemented protocol; first hosted verification recorded in the evidence below · **Updated:** 2026-10-24

Owner decision [D-213](../decisions/2026-10-24-ci-protocol.md) supersedes older instructions
to run full local gates for each lane/merge. Existing safety, review and product exit criteria
remain applicable. [Research and implementation evidence](../research/2026-10-24-ci.md).

## One candidate, one final validation

1. Reuse the existing checkout and dependencies. Inspect its HEAD, branch and dirty files;
   preserve unfinished work. Install only for a new checkout, changed lock/runtime or a
   diagnosed missing/broken installation. Work in a private lane; the lead owns integration.
2. Write behavior and proportional verification scope before a significant change. Iterate
   with focused tests for changed behavior and its consumers. `npm run check:affected --
   <base-ref>` suggests areas; it is not an automatic dependency oracle or test runner.
3. Obtain independent read-only review. Fix findings in a separate commit. Commit coherent
   working checkpoints, including the final handoff; no commit-per-edit or push-per-commit rule.
4. Finalize tracked status, handoff and next-prompt edits before the final ready candidate.
   The lead collects local branches without recloning. Push a draft PR at review/handoff;
   repeated local commits require no push. Draft PRs run quick checks only. Mark the reviewed
   candidate ready once implementation, docs and review fixes are included: ready PRs run full CI.
5. Run `npm run ci:finish -- <PR-number> --wait` from the clean candidate checkout. It waits
   in one process with bounded polling, then emits compact JSON. Exit 0 means the PR head,
   base and tested merge candidate are current and every expected job actually succeeded;
   1 means failure/stale evidence and 2 means pending/missing evidence. Diagnose failed jobs,
   reproduce with focused tests, fix, then publish a corrected candidate. Never rerun until
   green without diagnosis, weaken an assertion or mark pending CI complete.
6. Record the run URL and tested revision in the same-run artifact, PR description and final
   response. The tracked handoff already states scope, residuals and the PR/checks link.
   Do not edit tracked files after a successful finish merely to write the result back: that
   would create a new candidate and an avoidable validation loop. A necessary documentation
   correction is a separate scoped follow-up with its own declared evidence.
   A code/base change invalidates the candidate. Integrate that tested candidate, preserving
   independent review. Do not automatically run all gates again locally or on main after it.

One or two full runs per bounded slice is a target, not a correctness ceiling. Unexpected
failures can require more. No running work is blocked on a polling model turn: use the wait
command and continue independent docs/handoff preparation. If a slice is genuinely unable
to obtain CI, leave it unfinished with recovery instructions; local evidence is not hosted CI.

## Local command selection

Commands run from the repository root unless a workspace is named. Select exact test files
and relevant callers. Flags for Node's test runner go **before** file patterns; appended flags
after patterns can be ignored. Always include the key-file guard for server tests.

```bash
node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/path.test.ts
npm exec --workspace @guanxi/web -- vitest run test/component/path.test.tsx
npm exec --workspace @guanxi/ui -- vitest run test/component.test.tsx
npm run test:browser --workspace @guanxi/web -- test/browser/path.spec.ts
node --test packages/kernel/test/path.test.ts
npm run typecheck --workspace @guanxi/server
```

| Change | Local scope before handoff |
| --- | --- |
| Documentation only | Markdown lint and link checks; executable fixtures/docs assertions if affected |
| Server/CLI module | Changed behavior, route/store callers, error/cancel/restart boundaries, module types |
| Contract/shared config/dependencies | All affected consumers; unknown scope widens rather than silently skips |
| Web screen | Related component tests and browser specs, keyboard/error/mobile states, web types |
| UI tokens/shared components | Fast UI gates, affected component/story checks and all known consumers |
| Kernel/bench | Related deterministic tests and package types; real/paid experiments remain separate |

Resource-heavy local reproductions (browser/catalog suites, full suites/builds, benchmarks)
still use `agent-dev --resource heavy` with lane ports/data, one command per call, preserving
the exit code. The shared lock protects this Mac only; isolated hosted VMs do not share it.
Do not copy `check | tail; echo $?` or shell loops that continue after a failed stage.

## Hosted matrix and completeness

The source is [the workflow](../../.github/workflows/full-gate.yml) and
[task inventory](../../scripts/ci/tasks.mjs). PRs check their integration merge ref with full
history, not only the feature head. The matrix covers root `npm test` leaves, static/type/doc
checks, root builds (web before CLI), Storybook, both browser gates, three bounded core shards,
the Electron shell (units on Linux, the Electron-launching suites on macOS) and macOS signer tests. Browser
tests keep one worker per isolated shard; broad Node core tests use two file workers per shard to reduce
timing-fixture starvation. The current fourteen
tasks may start concurrently on isolated runners; account runner capacity still applies. Matrix fail-fast is
off so one run reports independent failures together. Newer runs supersede older runs for
the same PR only. Main pushes run quick checks; manual dispatch runs the full matrix but
does not substitute for the final PR completion contract.

After this workflow exists on main, isolated hosted diagnosis can use
`gh workflow run full-gate.yml --ref YOUR_BRANCH -f task=mac-signer` (or another exact task ID).
This manual mode explicitly reports `full: false` and skips the aggregate Full gate; it
cannot narrow a ready PR or satisfy `ci:finish`. Use `task=all` for a full manual diagnostic
run. Keep the PR draft while publishing diagnostic fixes, then publish one ready candidate.

The inventory rejects new workspaces, unclassified test/build entrypoints and body changes
to indirectly covered commands (shards, wrappers and generator checks). When adding a
package, test mode, build target or changing root test composition, update its task/classification,
dependency order, platform setup, cache inputs and completeness tests together. A command
classification must identify an actual job or an explicit opt-in exclusion with rationale.
Bench mutation campaigns remain opt-in; ordinary offline bench tests run in CI. Generated
tokens are checked by G2, not restored over committed source. The catalog browser builds its
harness; the production root build and Storybook run separately. G13 uses the observed ARM raster
platform, not a different CPU architecture with silently regenerated snapshots.

`Full gate` is the aggregate check; matrix jobs may not be skipped to manufacture success.
Keep it required before merging when branch protection is configured. A draft's absent full
gate is not completion. The finish command also rejects missing, duplicate, skipped, failed,
cancelled and outdated jobs even if a broad workflow status appears green.

## Cache policy

| Input/output | Policy | Invalidation |
| --- | --- | --- |
| npm package downloads | `setup-node` cache; `npm ci` every job | OS/architecture/lock; ordinary source/docs edits keep it useful |
| Pinned standalone setpriv | Exact OS/architecture/preparation-script cache; install and preflight every job | Version, verified source digest and build flags in the preparation script |
| Native Docker layers | BuildKit GHA cache; isolated native profile scope | Dockerfile, pinned base, guard content determine layer reuse |
| `node_modules` | Never persisted/shared | Native packages and workspace symlinks must match this install |
| Browser binaries | Install Chromium dependencies; no cross-run browser cache | Playwright recommends installation rather than browser caching |
| Visual baseline runtime | Pull the exact canonical image digest | Version/digest changes are explicit; never auto-update baselines |
| Built `dist`, generated tokens, test success | No cross-run cache | Rebuild/retest current source; no ambiguous transitive input keys |

GitHub cache scope and eviction apply: a new PR can start cold; repeat source edits within
that PR can reuse downloads/layers. A lock change legitimately changes the npm key; it does
not justify changing source-dependent build keys to a constant. Docker contexts contain only
their Dockerfile/guard, so unrelated TS/docs changes do not invalidate native layers. The
existing application build costs seconds locally; caching its outputs is deferred until
measured benefit exceeds hashing/restoration cost. Reuse output within a verified build job
(web → CLI); never use an artifact from another revision. Future shared build artifacts need
explicit producer/consumer dependencies and exact run/revision/platform identity.

## Platform, security and diagnostics

Hosted jobs receive no owner secrets, provider keys, SSH access, live models or user data.
Use read-only permissions, immutable action SHAs, no persisted checkout credentials and no
`pull_request_target` execution of contributor code. Treat caches/artifacts as untrusted
inputs; none can grant a passing check. Retain task logs/receipts, JUnit core reports and
failure screenshots/traces for seven days; never upload `.env`, home/config directories,
provider credentials, reasoning or private runtime logs.

Linux core jobs explicitly prepare bubblewrap/user namespaces, a checksummed standalone
setpriv build and the pinned native image, then execute a real synthetic sandbox preflight;
an unavailable image is a failing setup step. macOS signer tests explicitly select Xcode
26.3 on macOS 15 and compile the real optimized helper; missing toolchains fail setup.
The hosted image's older default Xcode 16.4 corrupts the synthetic probe's captured values;
an isolated same-OS comparison passes on 26.3. Do not silently fall back to that default.
Platform-specific skips remain visible in logs. Hosted macOS does not provide this owner's
Colima setup, Secure Enclave identity or Touch ID. macOS container/sandbox behavior, owner
hardware, Fedora/live/paid integration and the six-hour MS1 exit still need their explicit
integration envelope. Do not relabel the hosted offline gate as production validation.

## Updating existing lanes

The lead follows [the restart prompt](../plans/NEXT_AGENT_PROMPT.md) and the local resume
inventory in `Guanxi-lanes/infra`. Existing lane clones may be ahead, behind or dirty. A
local `CLAUDE.local.md` / `AGENTS.override.md` adapter points them at this current protocol
without pulling, recloning, resetting, committing their work or reinstalling dependencies.
The adapter is machine-local and excluded from Git. Old `*gates.sh` entrypoints are adapters
that print affected guidance; pass `--finish PR` only from the reviewed integration candidate.
When the lane later incorporates current main, remove an obsolete local adapter only after
checking that it contains no user edits. The source-of-truth protocol stays in the repository.
