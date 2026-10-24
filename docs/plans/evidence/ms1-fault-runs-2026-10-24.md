# MS1 fault runs with the Claude Code lead (2026-10-24)

**Status:** locally validated record (real hardware, real models) · **Updated:** 2026-10-24 · **Decisions:** D-214 (exit by
fault scenarios), D-215 (user API key for the lead), D-210 (Sonnet 5.5 medium lead)

Home: this Mac (`ms1-live start`, checkout `Guanxi-lanes/ms1run`), executor: the Fedora node (`guanxi-bench`, llama.cpp
b11496, Qwen3.8-27B IQ3_S, RTX 3060 12 GB, window 32 768), federation over SSH forwards with automatic reconnect
(`-L 4562`, `-R 34561`). Lead: the official Claude Code CLI 2.1.287 through `claude-agent-acp` 0.94.0, Sonnet 5.5 at medium
effort, `home.lead.auth: "api_key"` with the owner's `sk-ant-usr…` key (D-215). Target: `Guanxi-Test-Repo` (`ledger-lite`)
at base `51c44bfd`, tests protected. Faults were injected by hand or by `~/ms1/ops/faults-run.sh` and logged in UTC.

## What the runs found (each fixed, reviewed by Opus 5.5, with tests that fail without the fix)

| # | Observed on the real run | Fix |
| --- | --- | --- |
| 1 | The owner's key starts with `sk-ant-usr`; Guanxi accepted only `sk-ant-api`/`sk-ant-oat`, so the lead never started (the previous session asked the owner for a new token instead) | `sk-ant-usr` is an Anthropic API key family (D-215); doctor labels it |
| 2 | The lead's cwd is an empty private directory; it cannot see the project | lead prompt carries the plan facts (residual: a node-served read-only project view, see below) |
| 3 | K5 answers every ACP permission request with `cancelled`, including the lead's own `guanxi_delegate`: the real CLI could never delegate | a lead turn pre-allows only its own MCP tool server (`mcp__guanxi`) in the bridge's programmatic settings |
| 4 | A finished lead blocked every later lead task on the node (`lead-exists`) | only a live lead or the same (normalised) task refuses |
| 5 | `moneyMicros: 0` (the only cap the owner's ceiling allows) wrapped the relay up before its first call | a zero cap admits zero-cost local calls, stops on any spend or unknown cost |
| 6 | **E1**: a 90 s link drop during a model call → `runtime_meter_unavailable`, relay stopped | bounded transient retries of the same reserved call (5 s…240 s), fence re-checked after each wait; observe/count/measure retried too; only real transport failures are transient |
| 7 | **E2**: executor restart → raw transport error reported as `provider_failed`, not retried; the executor ignored SIGTERM for 90 s | transport failures mapped as transient on the call path; the executor stops within 10 s, aborting in-flight holders without inventing a terminal state |
| 8 | The woken lead thought its delegation had been refused and could not say why the relay stopped | wake prompt says the delegation ran (resolution of a started child only); the packet narrative carries the relay's fixed stop codes |
| 9 | The lead guessed the executor (`fedora`/`local`) and sent `acceptance` as one spaced string or JSON text, which `/bin/sh` cannot run (code 127) | the delegate tool names the allowed executors and refuses non-argv acceptance while the lead can still correct it |
| 10 | The relay model's `shell` tool was refused in 0 ms (`tool_denied_or_failed`) although gates ran in the same sandbox; probes asked for a non-existent `open` list and the model answered `nextItem: null` | lane `relay-shell-probe` (in progress at the time of writing) |

## Runs

| Run | Plan | Faults | Outcome | Lead tokens while asleep | Wakes |
| --- | --- | --- | --- | --- | --- |
| A (attempts 1–4) | I01–I10 | — | blocked by findings 2–5 | — | 1 (honest failure after #5) |
| A1 | I01–I10 | E1 at 09:53:59–09:55:29 | stopped by E1 (finding 6) | 0 (turns at 09:52, 10:0x) | 1 |
| A2 | I01–I10 | E1 10:04:34–10:06:04, E2 10:09:47 | **E1 and E2 survived** (3 and 1 retries, 0 errors); stopped by the operator: gates could never run (finding 9) | 0 between 10:03:26 and 10:28:22 | 1 |
| A3 | I01–I10 | E1 10:39:05–10:40:35, E2 10:48:19 | E1 survived, I01 done; E2 failed as `provider_failed` (finding 7) | 0 between 10:31:35 and 10:50:47 | 1 |
| A4 | I01–I10 | E1 11:02:15–11:03:45, E2 11:16:15, E3 llama-server restart 11:28:19–11:29:44 | **all three faults survived** (3, 1 and 2 retries; 0 errors); I01–I05 done with green gates; stopped at cycle 5 `probe_failed_twice` (finding 10) | **0 for 79 minutes** (10:52:53 → 12:11:43) | **1** |
| B | I04–I05 | **E4** home SIGTERM while the lead slept (12:24), restart | home exited in 2 s; relay `input_required`; on restart no second lead (`lead-exists`), **exactly one** honest wake (`failed`, `stopped: relay_stopped`), no re-delegation | 0 (12:22:52 → 12:25:08) | **1** |

A4 independent reproduction: a clean clone of the target plus the run's sealed bundle (head `886048bd`) changes only the five
`src/` modules (226 insertions, 11 deletions), `test/` untouched; `node --test` with default isolation: I01 11/11, I02 9/9,
I03 9/9, I04 8/8, I05 11/11. Lead cost for A4: two turns, $0.084 total (API usage, the owner's credit).

## MS1 exit (D-214) — where it stands

| Exit property | Evidence | State |
| --- | --- | --- |
| Lead delegates to a 30B-class local model on another node and hibernates | A2–A4, B | met |
| Survives a dropped link during a call (E1) | A2, A3, A4 | met |
| Survives an executor restart (E2) | A2, A4 | met |
| Survives a runtime restart (E3) | A4 | met |
| Home restart while the lead sleeps ends with one honest wake (E4) | B | met |
| Lead spends 0 tokens between delegate and wake | A2, A3, A4, B (cost rows only at delegate and wake) | met |
| Exactly one wake | all runs | met |
| All plan items close with green gates in a clean checkout | A4: 5 of 10 | **not yet** — rerun after finding 10 |
| B3 relay benchmark gate | none | **not run** (owner decision pending) |

## Residuals

- The lead has no read-only view of the project; its plan facts come from the prompt. A node-served read-only project tool
  is the product fix (not started).
- A `sk-ant-usr` key bills the owner's API credit; the lead's own spend is not under `moneyMicros` (runbook section 7).
- The SSH forwards are owner-run; their reconnect loop is an ops script, not product.
- Stale home relay pins after forced exits are reaped by F2-reap (observed nothing to reap in these runs).
