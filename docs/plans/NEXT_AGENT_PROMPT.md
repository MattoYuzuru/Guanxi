# Next agent prompt — make the real relay finish items, then the Claude Code lead and the six-hour run

**Status:** active continuation · **Updated:** 2026-10-23

Read [AGENTS](../../AGENTS.md), [WORKFLOW](WORKFLOW.md), [lanes/README](lanes/README.md), [PHASE_STATUS](PHASE_STATUS.md),
the [Fedora record](evidence/fedora-real-runtime-2026-10-23.md) and the [MS1 live runbook](../operations/ms1-live-run.md).
Inspect live workers, branches and the latest hand-offs before reopening work; do not repeat closed author/reviewer
rounds. Each slice: own clone, plan first, separate commits, an independent review, fixes as separate commits, then
integration with the full gate sequence through the shared heavy lock.

## Scope and boundaries now

- `ssh fedora` is available (D-196): real llama-server runs, two-host runs and the full MS1 run are authorised there.
  D-194 still excludes real benchmarks on the Mac. Kill only processes you started (by recorded PID, never by pattern).
- Owner decisions up to D-210 ([2026-10-23 addendum](../decisions/2026-10-23-owner-decisions-addendum.md)): the MS1 lead
  is Claude Sonnet 5.5 at medium effort through K5; the UI redesign (D-200–D-207) is a priority; provider models in chat.
- Local `main` is pushed after each integration checkpoint.

## Live state left running (2026-10-23)

- Fedora: user unit `guanxi-llama` (owner user; llama-server b11496, Qwen3.8-27B IQ3_S, `127.0.0.1:8090`) and
  `guanxi-ms1-exec` (as `guanxi-bench`, executor node, `~/ms1/repo` at `536cad90`, data `~/ms1/exec/data`).
- Mac: home node (`~/ms1/home`, data `~/ms1/home/data`, federation port 34561 because of Fedora SELinux) and the
  `ssh -N -L 4562 -R 34561 fedora` forward, both started from the session that wrote this; restart them per the runbook.
  The project `guanxi-test-repo` is registered on the home (`~/ms1/home/project.env`).

## First unfinished slice: R2-json, then integrate the real-run fixes

1. Lane `claude/model-json-fences` (three commits on top of `536cad90`): one-fence JSON tolerance, the prepare-time count
   (the post-call recount failed every call longer than the observation age) and a `call_failed_reason` note. Needs an
   independent review, then integration.
2. Lane **R2-json** (`claude/relay-structured-output`, built on the branch above): llama-server `json_schema` constrained
   output for relay actions, probes and judge verdicts, carried through the counted and pinned F2-d request; paged
   `file_read`; probe prompt shows the facts it asks for. Review, integrate, then rerun the one-item smoke
   (`~/ms1/home/smoke-1.json` with a new key) until an item is verified on the real model.

## Then

1. A multi-item relay (I01–I05 of `ledger-lite`) with `home.judge` signals plus the cascade sized for the executor
   (≈5 tokens/s: raise `sampleTimeoutMs`, lower `maxOutputTokens`).
2. **Claude Code lead (D-210):** install the ACP bridge `@agentclientprotocol/claude-agent-acp` (pin an exact version)
   outside the repository, write `home.lead` (Sonnet 5.5; medium effort through the CLI's own settings in K5's private
   config directory, since K5 refuses `params.reasoning`), then the owner runs the one-time sign-in command `start` prints.
3. The ≥ 6-hour MS1 run on `Guanxi-Test-Repo` with R3/B3 evidence recorded; the Mac on AC under `caffeinate`, lid open.
4. **UI redesign** second pass (lane `claude/ui-redesign`): native selects replaced, timeline session view, mobile drawer;
   owner picks the palette (Porcelain + Cobalt is the working default); then catalog re-review and DS2 signing of the
   `review` components with the owner's Touch ID key (now trusted on main).
5. MS2 platform: fleet map (D-209), U2 Electron shell, C1 browser host, C4, U3 authentication, real action ports.

Residual risks to keep visible are in each hand-off; notably resident llama-server memory is invisible to the governor,
the 27B IQ3 model's instruction following is weak without constrained output, a home restart ends a running relay, and
the Mac must stay awake for the whole run.
