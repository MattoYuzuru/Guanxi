# NC1-e handoff — content-free OS notification adapters

**Status:** bounded slice implemented and locally validated; independent review below.
**Date:** 2026-10-23 · **Branch:** `codex/nc1e-os-adapter` · **Base:** `0d5dc746` · NC1 remains **in progress**.

## What exists

- `os-adapter.ts` — `createOsNotifier`, `CommandRunner`, `OsNotifier` and the default `execFile`
  runner. macOS: `/usr/bin/osascript` with constant `-e` lines, title/app name after `--`;
  Linux: absolute `notify-send --app-name <app> -- <title>`; Windows/other unsupported.
- Payload boundary — exactly `title`/`tag` own keys; trimmed title 1–120; opaque tag with no
  length cap; C0/C1 and U+2028/U+2029 refused as `payload_invalid`; inherited extras unread;
  the tag never reaches a process; invalid app names and bad lookups are `unavailable`.
- `os-adapter.test.ts` — 13 tests: exact macOS/Linux argv, constant AppleScript, injection title
  after `--`, missing/relative/throwing resolver, Windows, key/length/control refusal,
  inherited/logging evidence, runner failure/timeout/signal/throw, darwin `/usr/bin/true` smoke.
- `README.md` — appended NC1-e section; no earlier section rewritten.

## Commands and evidence

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/notifications/README.md docs/plans/lanes/NC1-e.handoff.md
```

- Tests: `tests 99`, `pass 99`, `fail 0`, `skipped 0` — **13 new / 86 regression**.
- tsc exit 0, no diagnostics.
- markdownlint: 0 errors.

## Independent verification

A separate read-only reviewer found no P1. It found one P2: `execFile`'s timeout was advisory,
so a SIGTERM-ignoring child could outlive 5 s and later report success; fixed with
`killSignal: 'SIGKILL'`. P3s fixed: success now requires no signal; a throwing `resolveBinary`
maps to `notify_send_missing`; C1/U+2028/U+2029/symbol/read-trap/inherited/logging properties
are covered. Fix commits: `6b6a852e`, `c7f66674`, `9a1f9286`.

## Residuals (later NC1 work)

- Windows toast, Web Push, and plugin/boot wiring of the notifier to `planDelivery` and the OS
  channel decisions.
- User-visible macOS permission prompts and attribution; tests spawn no real notifier. The
  SIGKILL timeout was checked against a TERM-ignoring child, not in the suite (one-smoke rule).
- Settings persistence/UI, HTTP routes and contract schemas remain later NC1 work.

**Shared edits:** none; only the three owned files and the notifications README were touched. No
status files were edited.

## Independent review (Opus, 2026-10-23)

No P1/P2. Integrator fixed P3s: bidi overrides/isolates and zero-width characters are refused in
titles; notify-send gets `--app-name=<name>`; the child receives a minimal environment instead of
the server's full `process.env`. Residuals: no real-runner timeout test; a grandchild holding stdout
could outlive the SIGKILL (neither notifier forks).
