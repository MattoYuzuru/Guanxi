# MS1-relay-residuals hand-off

**Status:** locally validated (scoped tests, no hosted CI) · **Updated:** 2026-10-31 · **Branch:** `lane/ms1-relay-residuals`
(from `lead/wave7` `14b1d569`) · **Ports:** `GUANXI_WEB_PORT=5231`, `GUANXI_API_PORT=4431` (no server was started)

Two residuals of [finding 10](../evidence/ms1-fault-runs-2026-10-24.md) in the relay's command paths. No independent review
has been run; the lead runs it separately.

## What changed

1. **Composed `cd`.** Every composed `cd … &&` in server code was found with grep: `native-agent/tools.ts` (`run`, used by the
   relay's `shell`) and `relay/workspace.ts` (the acceptance gate). Both now use `inDirectory(dir, command)`:
   `cd <dir> 2>/dev/null || { echo cwd_unavailable >&2; exit 125; }; <command>`. The command no longer runs after a failed `cd`
   (`&&` exited 1, the same as a red test or a missing file). `cwdFailed(result)` recognises it by exit 125 **and** a first stderr line
   `cwd_unavailable` (the shell's own message is silenced so nothing precedes the marker), so an argv that itself exits 125 is
   still its own result.
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
| `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/relay/cwd-and-exit.test.ts` | pass 5, fail 0 |
| same, `packages/server/test/relay/*.test.ts` plus `native-agent/{tool-errors,file-read-paging,agent}.test.ts`, `fs-tools.test.ts`, `external-agents/host-tools.test.ts` | tests 437, pass 437, fail 0, skipped 0 |
| `npx tsc --noEmit -p packages/server` | exit 0, no output |
| `npx eslint` on the three changed source/test files | no output |
| `npm run lint:md` | 0 errors (run on the final tree) |

New: 5. Regression envelope: 432 existing tests of the same files, all passing. `native-agent/sandbox.test.ts` (real sandbox, needs
the container runtime) and the full suites were not run (scoped iteration per the CI protocol).

## Residuals

- A 125 from the container guard's own `cd "$HOME"` (macOS container) has no marker, so it is not treated as `cwd_unavailable`.
- `file_write` and `fetch` (`curl --fail`) still reduce a non-zero exit to `tool_failed`; they are not `shell` and were left alone.
- The marker check is behavioural against a real `/bin/sh` only; the macOS container path was not exercised.
- Hosted CI and the independent review are the lead's.

## Next slice

None owned by this lane.
