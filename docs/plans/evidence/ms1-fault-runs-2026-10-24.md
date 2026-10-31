# MS1 fault runs with the Claude Code lead (2026-10-24)

**Status:** locally validated record (real hardware, real models); MS1 exit met except the B3 gate · **Updated:** 2026-10-24 · **Decisions:** D-214 (exit by
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
| 10 | The relay model's `shell` tool failed (`tool_denied_or_failed`) although gates ran in the same sandbox: it started outside the relay checkout, and a red test came back as an opaque failure | shell starts in the checkout; fixed tool codes surface; a non-zero exit returns code and scrubbed output to the relay model |
| 11 | Probes asked for a non-existent `open` list (model answered `nextItem: null`); then the strip had both `current` and `next`, and the model copied `next` for `nextItem` | probe asks only for strip fields; strip adds `currentStatus` and names the following item `queued` |

## Runs

| Run | Plan | Faults | Outcome | Lead tokens while asleep | Wakes |
| --- | --- | --- | --- | --- | --- |
| A (attempts 1–4) | I01–I10 | — | blocked by findings 2–5 | — | 1 (honest failure after #5) |
| A1 | I01–I10 | E1 at 09:53:59–09:55:29 | stopped by E1 (finding 6) | 0 (turns at 09:52, 10:0x) | 1 |
| A2 | I01–I10 | E1 10:04:34–10:06:04, E2 10:09:47 | **E1 and E2 survived** (3 and 1 retries, 0 errors); stopped by the operator: gates could never run (finding 9) | 0 between 10:03:26 and 10:28:22 | 1 |
| A3 | I01–I10 | E1 10:39:05–10:40:35, E2 10:48:19 | E1 survived, I01 done; E2 failed as `provider_failed` (finding 7) | 0 between 10:31:35 and 10:50:47 | 1 |
| A4 | I01–I10 | E1 11:02:15–11:03:45, E2 11:16:15, E3 llama-server restart 11:28:19–11:29:44 | **all three faults survived** (3, 1 and 2 retries; 0 errors); I01–I05 done with green gates; stopped at cycle 5 `probe_failed_twice` (finding 10) | **0 for 79 minutes** (10:52:53 → 12:11:43) | **1** |
| A5 | I01–I10 | E1 12:52:59 | aborted by the operator to deploy finding 10's output fix | — | — |
| A6 | I01–I10 | E1 13:04:34–13:06:04, E2 13:18:34, E3 13:30:35–13:31:57 | all three faults survived (6 retries, 0 errors); stopped at cycle 2 `probe_failed_twice` (finding 11, `next` copied) | 0 (12:55:50 → 13:40:17) | 1 |
| **A7** | **I01–I10** | **E1 13:58:00–13:59:30, E2 14:12:05, E3 14:24:06–14:25:27** | **all ten items done, relay `finish`, run `completed`**: 10 cycles, 2 h 29 min, 220 remote model calls on Fedora (2 020 762 evaluated prompt tokens, 21 077 output tokens), 6 transient retries, 0 errors | **0 for 2 h 29 min** (13:49:16 → 16:18:28) | **1** |
| B | I04–I05 | **E4** home SIGTERM while the lead slept (12:24), restart | home exited in 2 s; relay `input_required`; on restart no second lead (`lead-exists`), **exactly one** honest wake (`failed`, `stopped: relay_stopped`), no re-delegation | 0 (12:22:52 → 12:25:08) | **1** |

**A7 independent reproduction:** a clean clone of the target plus the run's sealed bundle (head `1e769d6a`) changes only the ten
`src/` modules (578 insertions, 17 deletions), `test/` untouched; `node --test` with default isolation: I01 11/11, I02 9/9, I03 9/9,
I04 8/8, I05 11/11, I06 10/10, I07 9/9, I08 8/8, I09 10/10, I10 8/8 (93/93). Lead cost for A7: two turns, $0.090 (API usage);
the lead's wake report correctly lists all ten gates green and says it did not run them itself.

A4 independent reproduction: a clean clone of the target plus the run's sealed bundle (head `886048bd`) changes only the five
`src/` modules (226 insertions, 11 deletions), `test/` untouched; `node --test` with default isolation: I01 11/11, I02 9/9,
I03 9/9, I04 8/8, I05 11/11. Lead cost for A4: two turns, $0.084 total (API usage, the owner's credit).

## MS1 exit (D-214) — where it stands

| Exit property | Evidence | State |
| --- | --- | --- |
| Lead delegates to a 30B-class local model on another node and hibernates | A2–A4, B | met |
| Survives a dropped link during a call (E1) | A2, A3, A4, A6, A7 | met |
| Survives an executor restart (E2) | A2, A4, A6, A7 | met |
| Survives a runtime restart (E3) | A4, A6, A7 | met |
| Home restart while the lead sleeps ends with one honest wake (E4) | B | met |
| Lead spends 0 tokens between delegate and wake | A2–A4, A6, A7, B (cost rows only at delegate and wake) | met |
| Exactly one wake | all runs | met |
| All plan items close with green gates in a clean checkout | A7: 10 of 10, reproduced 93/93 in a clean clone | **met** |
| B3 relay benchmark gate | none | **not run** — owner decision pending (see the next-agent prompt) |

## Residuals

- The lead has no read-only view of the project; its plan facts come from the prompt. A node-served read-only project tool
  is the product fix: implemented opt-in in wave 7 (`home.lead.projectView`, see
  [hand-off](../lanes/LP-lead-project-view.handoff.md)); not yet exercised by a real lead.
- A `sk-ant-usr` key bills the owner's API credit; the lead's own spend is not under `moneyMicros` (runbook section 7).
- The SSH forwards are owner-run; their reconnect loop is an ops script, not product.
- Stale home relay pins after forced exits are reaped by F2-reap (observed nothing to reap in these runs).
