# Bench base

**Status:** implemented foundation, fixture validated; real corpus runs and paid noise floor
are not measured · **Updated:** 2026-10-21

`@guanxi/bench` implements the B1 measurement core from
[ADR-0025](../../docs/decisions/0025-bench-stage-and-ab-gate.md). It adds no scaffolding to the
native agent. `createBenchPlugin` provides `bench.runner` over R1's `runs.durable` and K2's
`egress.scrubber`; the server does not load it by default. The CLI is also usable without a
server. Harbor and mini-swe-agent run in a separately installed Python process, never in a
node bundle. No shared wire contract, server route or migration changes.

## Commands

Run from the repository root, with the lane's web/API ports and private data directory:

```bash
export GUANXI_WEB_PORT=5198 GUANXI_API_PORT=4398 GUANXI_DATA_DIR="$PWD/.lane-data"
npm run smoke --workspace @guanxi/bench
npm run test:bench
npm run test:mutations --workspace @guanxi/bench
```

The Mac smoke uses in-memory fake arm results, no SSH, container engine, network or model.
It writes a private JSON receipt and standalone HTML under `.lane-data/bench/`. Its control
label is a fixture, not a measured mini-swe-agent score. The actual control integration is
exercised by the host smoke. Reports use English source text and no app UI, remote fonts,
scripts or network resources. `htmlReport(plan, trials, true)` removes task identifiers for
aggregate publication; the default private report lists flipped and excluded task IDs.

## Locked external environment and host

`python/pyproject.toml` pins Harbor 0.24.0 and mini-swe-agent 2.4.6. `python/uv.lock` pins their
transitive dependencies and artifact hashes; Python is 3.12.14. Do not use Harbor extras,
which can introduce proprietary adapters. Dependencies stay in a lane-local or benchmark-user
virtual environment. Check licenses before installation:

```bash
python3 packages/bench/tools/python-licenses.py
UV_PROJECT_ENVIRONMENT="$PWD/.lane-data/bench-python" \
  uv sync --project packages/bench/python --frozen --python 3.12.14 --no-dev
```

The audit checks all 106 locked registry packages. Non-SPDX package metadata has exact-version,
metadata-hash-reviewed entries in `python/LICENSES.json`. PSF-2.0 and CNRI-Python components
are confined to this external Python process; this does not extend ADR-0016's copying or node
dependency allowlist. No dependency code is copied into the repository. The scalar Inspect AI
estimator port retains its MIT license and notice in `THIRD_PARTY_NOTICES.md`.

For the provisioned host, stage only `python/` under `/home/guanxi-bench/b1`, and use the same
locked installation with `UV_PROJECT_ENVIRONMENT=/home/guanxi-bench/b1/.venv`. A managed Python
may first need `uv python install 3.12.14` **as guanxi-bench**, never a system install. Configure
transport through a private JSON file, for example:

```json
{ "ssh": "your-benchmark-host-alias", "root": "/home/guanxi-bench/b1" }
```

```bash
node packages/bench/src/cli.ts run .lane-data/host-plan.json .lane-data/host.json
```

The transport changes to `/tmp`, executes `sudo -n -u guanxi-bench env -i`, sets HOME and the
uid-1001 runtime bus, and launches the host venv. There is no owner-user, root-container,
localhost or Docker fallback. The worker checks the actual UID/name and Podman's rootless /
systemd state. Containers have explicit CPU/memory ceilings, no GPU/device grants, no host
binds, no network, dropped capabilities and a PID limit. Harbor's bookkeeping log binds are
recognized but implemented as copies. Observed container cgroups must contain
`user-1001.slice`. One host worker owns an advisory lock. Container UUIDs are removed and
absence is checked; unresolved cleanup fails the worker. Owner services, port 8080 and the VPN
are outside the runner's command surface.

The host fixture mode accepts exactly two toy tasks, one real mini-swe-agent control and seed
0. It builds its toy image locally from an already cached base image (`--pull=never`, build
network disabled). Its deterministic free model writes an answer; a clean, separate verifier
passes the first task and intentionally fails the second. This is a transport/adapter smoke,
not a model-quality result. The image and temporary Harbor task/log directories are removed.

The `GuanxiExec` Harbor adapter calls `guanxi agent exec --json` **inside a prepared task
container** whose node/project/connection already target that container's `/app`. It validates
K4's versioned stdout and does not export the response text. A completed agent never passes a
task by itself. The hidden verifier is the only pass gate. Stock task images do not contain
such a node; the adapter requires this explicit image preparation.

## Corpus and protocol

`selectCorpus` consumes private metadata, never task contents. It locks exactly 50 fresh
SWE-rebench tasks from an explicit window of at most 62 days and 30 Verified regression tasks,
with deterministic selection and a SHA-256 manifest receipt. Insufficient or stale input
fails rather than substituting old tasks. The selection is not evidence that tasks were
oracle/no-op/flakiness validated; the B2 factory owns those checks. No real benchmark task or
canary content is committed here.

```bash
node packages/bench/src/cli.ts corpus .lane-data/task-metadata.json 2026-10-01 2026-10-21
```

Each metadata item has `id`, `suite` (`swe-rebench` or `verified`), `revision` (the SHA-256 of
sorted relative file names, NUL, then each file's SHA-256 bytes), `path` (a staged directory
under `/home/guanxi-bench/tasks`) and `published` (ISO date). The host rechecks the digest,
rejects symlinks and requires separate hidden verifiers with offline phase policies. Tasks
must have locally prepared images; missing images fail as infra errors, without pulling.

`validatePlan` is the executable schema: one fixed model/provider per experiment, fixed
versions, same task/seed/resource pairs, explicit time/step/token/cost ceilings, an equal
per-arm experiment cap and the provider's daily token cap. The default change type is
`simplification`; set `change: "addition"` for additions. Scheduling alternates adjacent arm
order. Noise-floor mode requires one permanent control arm and exactly five distinct seeds;
run it before the first A/B. Infra-tainted tasks must be rerun with new run IDs and fresh
reservations before a decision. The stock host worker currently enables only `fixture-free`
models; real task selection and a real model noise floor still require staged data and the
bounded K3 gateway below. No live quality claim is made by fixture results.

## Budget boundary and managed lifetime

All money is integer USD micro-units. A SQLite `BEGIN IMMEDIATE` reserves the entire worst
case (`tasks × seeds × arms × per-trial ceiling`) before executor dispatch. It enforces the
per-arm cap, D-150's protected $200 monthly cap and provider daily token cap. Reopening the
same ledger preserves holds. An existing experiment ID never dispatches again. Crashes,
cancellation, unknown billing and invalid/oversized results keep the full reservation; even
successful runs conservatively retain their reserved amount. Budget overflow is refused.
All processes using the same benchmark account must share this one private ledger; choosing
a different file is a separate budget domain and must not be used to bypass D-150.

A reservation alone cannot constrain a provider call already in flight. Consequently the
stock Harbor executor **refuses every paid run**. `runBench` accepts a paid experiment only
with an explicit integrator approval tied to its ID **and** a trusted executor with a bounded
K3 billing gateway. That gateway must quote and reserve each request's worst-case input/output
cost and enforce output/step/token bounds before contacting the provider. B1 does not ship
such a paid gateway or claim that mini-swe-agent's post-call `cost_limit` enforces a hard cap.
K3 connections remain the only credential owner: configs carry `secret://` references, never
key values. Do not activate a paid executor by declaring an unbounded provider as bounded.

The R1 plugin renews its attempt while the external process is active and aborts on lease
loss or unload. There is no automatic inference restart. The managed process bounds stdout,
clears inherited provider credentials, returns codes only on failure and waits for child
close. A dropped SSH channel does not prove remote cleanup; reservations stay charged and
operators must check the dedicated user's containers before retrying. Worker timeouts bound
remote work independently of the client. No host-shell fallback or owner service restart is
used to recover a benchmark.

## Statistics and interpretation

The primary score averages hidden-test success over seeds **within each task**, then weights
tasks equally. Paired bootstrap resamples whole tasks (10,000 replicates, recorded PRNG seed).
Infra errors and preempted (`infra_tainted`) trials have separate counts. If any task/seed is
infra-tainted on either arm, that whole task is excluded from both arms for paired inference;
excluded IDs are reported. Missing, duplicate, foreign, malformed and unbilled scored trials
are refused. Exclusion is not a substitute for rerunning infrastructure failures.

Reports stratify by suite and a single configured model. McNemar is exact and two-sided on
per-task **all-seed success**, not on correlated individual epochs. Holm corrects these
p-values across arm/suite comparisons. Bootstrap intervals use Bonferroni family coverage.
`passHat` implements Inspect's without-replacement pass^k estimator, distinct from pass@k;
insufficient seeds return an explicit missing value. The Inspect fixture is reproducible with
`tools/inspect-fixture.py` and the pinned upstream checkout.

The −5 percentage-point non-inferiority and >0 superiority margins are strict. Additions may
also qualify statistically with non-inferiority plus a measured ≥15% paired cost/time saving.
These are fixed-horizon measurements, **not always-valid intervals**: do not peek repeatedly
and stop early. Holdout confirmation, cost/infra/regression/canary and per-stratum guardrails
remain necessary before accepting a change. This package reports `measurement_only` and does
not implement B2's release gate. The planted 10-point fixture proves detection for its stated
80-task, three-seed, one-direction-discordance design; it does not promise power for every
real disagreement distribution.
