# MS1-relay-residuals hand-off

**Status:** locally validated (scoped tests, no hosted CI) · **Updated:** 2026-10-31 · **Branch:** `lane/ms1-relay-residuals`
(from `lead/wave7` `14b1d569`) · **Ports:** `GUANXI_WEB_PORT=5231`, `GUANXI_API_PORT=4431` (no server was started)

Two residuals of [finding 10](../evidence/ms1-fault-runs-2026-10-24.md) in the relay's command paths. No independent review
has been run; the lead runs it separately.

## What changed

1. **Composed `cd`.** Every composed `cd … &&` in server code was found with grep: `native-agent/tools.ts` (`run`, used by the
   relay's `shell`) and `relay/workspace.ts` (the acceptance gate). Both now use `inDirectory(dir, command)`:
   `cd <dir> 2>/dev/null || { echo cwd_unavailable:<random> >&2; exit 125; }; <command>`. The command no longer runs after a failed
   `cd` (`&&` exited 1, the same as a red test or a missing file). The returned `failed(result)` recognises it by exit 125 **and** a
   stderr line equal to this call's whole marker line (see "Review findings and fixes" for the per-call random suffix), so an argv
   that itself exits 125 is still its own result.
   - Gate: `GitRelayWorkspace.verify` throws `RelayError('cwd_unavailable')`, so the run stops as an infrastructure failure
     (like `container_runtime_unavailable`) instead of reporting a red gate. The executor does not otherwise distinguish infra from
     red gates; this reuses its existing "a thrown RelayError stops the run" path.
   - Shell: `run` throws the fixed code `cwd_unavailable`; the relay model sees it as that code.
   - `container-runner.ts` already used `cd "$HOME" || exit 125`; its 125 has no marker and is not reclassified.
2. **Fixed-command path hid a non-zero exit.** Trace: Finding 10 made the arbitrary-command branch of `shell` accept any exit code
   when `ctx.cwd` is set. The *fixed* branch (`pwd|ls|cat|head|tail|wc …`) still called `run(…, [0], true, ctx.cwd)`, so
   `cat missing.txt` (exit 1) or `ls nowhere` (exit 2) threw `tool_failed`, which `GitRelayWorkspace.tool` and the executor
   (`executor.ts` ~538) pass on as an opaque error. The fixed branch now accepts any exit code when `ctx.cwd` is set. Result: code,
   scrubbed and bounded stdout/stderr come back. Unchanged: no exit code (`null`, killed) is `tool_failed`; sandbox refusals
   (`container_runtime_unavailable`, `sandbox_failed`, `path_denied`) and `cleanup_unconfirmed` keep their codes; a plain native
   session (no `cwd`) still treats a non-zero exit as `tool_failed` (guarded by a new test and by `tool-errors.test.ts`).

Docs: `packages/server/src/relay/README.md` ("Workspace boundary").

## Tests

New: `packages/server/test/relay/cwd-and-exit.test.ts`, 5 tests. Checked against the pre-fix source (`git checkout
packages/server/src`, run, re-apply): **4 of 5 fail without the fix** (gate stop, gate argv not run after failed cd, shell
`cwd_unavailable`, fixed read returns code and scrubbed output); the fifth (native shell without a checkout keeps `tool_failed`) is
a regression guard for the narrowed change and passes on both.

| Command | Result |
| --- | --- |
| `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/relay/cwd-and-exit.test.ts` | pass 8, fail 0 |
| same, `packages/server/test/relay/*.test.ts` plus `native-agent/{tool-errors,file-read-paging,agent}.test.ts`, `fs-tools.test.ts`, `external-agents/host-tools.test.ts` | tests 440, pass 440, fail 0, skipped 0 |
| `npx tsc --noEmit -p packages/server` | exit 0, no output |
| `npx eslint` on the three changed source/test files | no output |
| `npm run lint:md` | 0 errors (run on the final tree) |

New: 5 in the first commit, 3 more in the review-fix commit (8 in total). Regression envelope: 432 existing tests of the same files,
all passing; the table below is the state after the review fixes (440 = 432 + 8). `native-agent/sandbox.test.ts` (real sandbox,
needs the container runtime) and the full suites were not run (scoped iteration per the CI protocol).

## Review findings and fixes

Independent review: no Critical or High. Fixed in a separate commit (`fix(relay): review fixes …`):

1. **Medium, fragile marker; Low, forgeable marker.** `startsWith('cwd_unavailable')` broke when a wrapper (bwrap, setpriv, the
   container guard) wrote to stderr first, and a command printing `cwd_unavailable…` and exiting 125 was taken for a failed `cd`
   (stopping the whole run in a gate); `cwd_unavailable_x` matched too. `inDirectory` now returns `{ line, failed }` with a
   per-call marker `cwd_unavailable:<32 hex chars from crypto.randomBytes(16)>`; `failed` requires exit 125 **and** a stderr line equal
   to that whole line, anywhere in stderr. Residual: the line is in the command text, so a command that reads its parent's arguments
   could still forge it (damages only its own verdict). Tests: wrapper noise before the marker still classifies as `cwd_unavailable`
   (shell and gate); a command printing `cwd_unavailable`, `cwd_unavailable:`, `cwd_unavailable:<other hex>` or `cwd_unavailable_x`
   and exiting 125 keeps its own result (shell and gate). Both fail against the old `startsWith` check (checked by running the file
   with `packages/server/src` reverted to the first commit: 2 failures, 6 passes).
2. **Low, scrub assertion did not isolate `run`'s scrub.** The earlier assertion (secret in a file read with `cat`) is kept as the
   end-to-end check, which `NativeOutputs.bound` (a second scrub) also satisfies. A new test uses a scrubber that redacts only
   structured results and passes strings through, so only `run`'s own `scrubber.scrub(result)` can redact; it fails when that line is
   removed (checked by mutation). The secret is built in the shell (`sec""ret`) because the tool arguments are scrubbed too. The same
   test asserts that an oversized non-zero result (200000 bytes, exit 3) is bounded: result under 64 KiB, `truncated: true`, excerpt
   at most 8 KiB, artifact readable with `tool_output_read` and still showing `"code":3`. The bound test guards existing behaviour
   and passes without the fix.
3. **Low, README.** The `tool_failed` sentence now says that a child killed under `sh -c` is an ordinary code (128 plus the signal)
   and that only a result without an exit code (the owner killed or lost the command) is `tool_failed`; the checkpoint sentence is back
   in its own paragraph; "Both"/"in both" now name the `shell` tool and the acceptance gate, and the with/without-checkout cases.

## Residuals

- A 125 from the container guard's own `cd "$HOME"` (macOS container) has no marker line, so it is not treated as `cwd_unavailable`.
- `file_write` and `fetch` (`curl --fail`) still reduce a non-zero exit to `tool_failed`; they are not `shell` and were left alone.
- The marker check is behavioural against a real `/bin/sh` only; the macOS container path was not exercised.
- Hosted CI and the independent review are the lead's.

## Next slice

None owned by this lane.
