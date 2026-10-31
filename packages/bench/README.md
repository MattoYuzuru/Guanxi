# Bench base

**Status:** partially implemented B1; fixture foundation locally validated. Real corpus execution
and a real model noise floor remain unfinished · **Updated:** 2026-10-22

`@guanxi/bench` implements the B1 measurement core from
[ADR-0025](../../docs/decisions/0025-bench-stage-and-ab-gate.md). It adds no scaffolding to the
native agent. `createBenchPlugin` provides `bench.runner` over R1's `runs.durable` and K2's
`egress.scrubber`; the server does not load it by default. The CLI is also usable without a
server. Harbor and mini-swe-agent run in a separately installed Python process, never in a
node bundle. No shared wire contract, server route or migration changes.

The continuation adds a [trial-bound K3 admission gateway](REQUEST_ADMISSION.md) and
[task-content staging](STAGING.md), a [private channel protocol](PRIVATE_CHANNEL.md), a
[private stream adapter](PRIVATE_STREAM.md), a real fenced K2 retention sink, and an
owned [private process binding](PRIVATE_PROCESS.md). These have synthetic/OS-fixture
assertions and author-focused checks; independent review is pending for this slice. They do
not supply a real provider meter/price adapter, task image, public corpus, container boundary
or measured five-seed experiment. Stock real/paid execution still refuses.

## B3-a offline relay evidence validator

**Status:** implemented as a pure parser and reducer; locally validated by fixtures only. It is
not the B3 benchmark and evaluates no B3 exit criterion. Plan:
[B3-a plan](../../docs/plans/lanes/B3-a.plan.md).

`checkRelayMeasurement` / `validateRelayMeasurement` parse a recorded `guanxi.b3.measurement/v1`
envelope strictly (unknown keys, versions and free text are refused; omitted trial, cycle or
row slots are refused; explicit `missing` / `unknown` slots are kept). Failures use six fixed
codes and never echo input. `reduceRelayMeasurement` returns descriptive counts per arm and
cycle, `null` for any fraction with an unknown denominator, and marks the seven B3 criteria
(slope CI, naive non-inferiority, critical probes, guarded repeats, truncation, ledger/handoff
consistency, ETA P80) as `unevaluated`. The report always carries `gate: measurement_only`,
`authenticity: not_verified_offline` and `realEvidenceCredit: 0`: a pure function cannot prove
that a referenced seal or run exists, and a caller's `recorded_observation` label is not proof.
There is no CLI, no IO and no clock. Real cohort, effective-length calibration, measurement on
the D-194 node and gate evaluation remain unimplemented.

## B3-b smoke cohort runner

**Status:** implemented and fixture-validated offline (fake relay, loopback server, database built from the server's
own table text); never run on the Fedora node. Operator runbook and details: [RELAY_SMOKE.md](RELAY_SMOKE.md); plan:
[B3-b plan](../../docs/plans/lanes/B3-b-smoke.plan.md).

`src/relay-smoke-cli.ts` (`plan`, `preflight`, `run`, `report`, `fixture`) executes a task × arm cohort of `ledger-lite`
plans through the owner API of a home node, records cycles, whole-answer probes, truncation, dead-end repeats and
item outcomes into a `guanxi.b3.measurement/v1` document, validates it with `validateRelayMeasurement` and reduces it
with `reduceRelayMeasurement`. It is a separate runner, not a CLI mode of the B3-a validator. The reading is descriptive
(D-219): every criterion stays `unevaluated`, `realEvidenceCredit` stays 0, and anything the relay does not record is
`unknown`, never imputed. The naive-compaction arm is a node-wide relay mode (`home.relayCompaction`, server lane B3-c); it runs as a second pass of the
same home against the same output directory, and each trial's arm is confirmed from its own events (a mismatch fails the run,
it never relabels).

## Commands

Run from the repository root, with the lane's web/API ports and private data directory:

```bash
export GUANXI_WEB_PORT=5198 GUANXI_API_PORT=4398 GUANXI_DATA_DIR="$PWD/.lane-data"
npm run smoke --workspace @guanxi/bench
npm run test:bench
npm run test:mutations --workspace @guanxi/bench
# After the separate locked environment is installed:
.lane-data/bench-python/bin/python -B packages/bench/tools/external-smoke.py
```

The Mac smoke uses in-memory fake arm results, no SSH, container engine, network or model.
It writes a private JSON receipt and standalone HTML under `.lane-data/bench/`. Its control
label is a fixture, not a measured mini-swe-agent score. The actual control integration is
exercised by the host smoke. Reports use English source text and no app UI, remote fonts,
scripts or network resources. The private process fixture is a local Node child with anonymous
inherited FDs; it proves ownership/cleanup mechanics, not task execution or isolation.
`htmlReport(plan, trials, true)` removes task identifiers for aggregate publication; the default private report lists flipped and excluded task IDs.
Reports identify the protocol, model/provider and arm versions and label synthetic fixture
outcomes. New CLI receipts carry `recordedAt` in UTC; older receipts show an unrecorded time.
Public mode also omits the experiment identifier.

## Locked external environment and host

`python/pyproject.toml` pins Harbor 0.24.0 and mini-swe-agent 2.4.6. `python/uv.lock` pins their
transitive dependencies and artifact hashes; Python is 3.12.14. Do not use Harbor extras,
which can introduce proprietary adapters. Dependencies stay in a lane-local or benchmark-user
virtual environment. The worker checks the interpreter patch version. Check licenses before installation:

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
binds, no network, dropped capabilities and a PID limit. Workloads explicitly use container
UID/GID 65532, including when host defaults select another container user. Each output pipe
is bounded to 1 MiB; overflow kills the exec and removes its environment. Harbor's bookkeeping log binds are
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

## Private trial binding and process ownership

[PRIVATE_PROCESS.md](PRIVATE_PROCESS.md) describes the bounded T0 slice: an immutable binding
with a host-generated nonce, a pre-dispatch R1 attempt fence, a real `RunStore.append`/K2
retention sink, the authoritative scrubbed public projection used by both K2 and the task
frame, and one supervised local process reached only through anonymous inherited fds 3/4.
The task cannot select account, connection, model, trial, output policy, cleanup or billing
facts. The nonce is host correlation, not authentication.

The K2 sink writes a bounded two-phase receipt inside the existing reasoning class for every
completion, including an empty one. Begin and done receipts carry only ordered spec hashes, a
public digest and the scrubbed public stop reason; the returned projection is derived from the
acknowledged stored content. A new completion gets a stable opaque correlation span derived
from the binding nonce and request id, so a shared session/request id cannot conflate bindings.
Legacy raw-span traces are refused by a fenced metadata existence read of the stored event
rows: same session, old raw span and this binding/request key prefix, with no payload read and
no `LIKE`/`GLOB`. A tool id redacted after its append therefore stays authoritative, while
another binding's raw-span rows never match. Changed reason/removed/reordered specs,
partial-prefix gaps, purged receipts and a recreated sink are reconciled or fail closed as
documented.

The supervisor is a trusted source-run asset. It generates a fresh 256-bit cleanup generation,
writes only its hash to a `0600` version-2 record under a `0700` directory, and passes the token
only in the launcher/client argv. The token grants nothing and is not in the record, environment
or private frames. The supervisor terminates its process group on lifetime EOF and never
unlinks the record. Only a live parent or the next reaper removes it, after exact process
identity validation and actual process-group ESRCH. A live mismatched supervisor, unknown
observation, wrong client token or legacy v1 group is quarantined rather than killed through a
shared PID/argv. A missing supervisor/launcher asset fails closed; there is no direct-spawn
fallback. A future bundle must include both `.mjs` assets. Same-UID cleanup is best-effort, not
an isolation boundary; a `setsid` descendant is outside the process-group proof.

There is no acknowledgement timeout. Abort or child death may start process-group shutdown
immediately, but the owning promise and active binding remain owned until the real gateway and
K2 retention settle. Timers bound process startup/output/shutdown only. A pending retention can
therefore keep the run promise pending by design. No automatic redispatch/retry is added.
Per-event fenced K2 appends can leave an idempotent private partial trace; no task response is
written until the done receipt acknowledges.

## Corpus and protocol

`selectCorpus` consumes private metadata, never task contents. It locks exactly 50 fresh
SWE-rebench tasks from an explicit window of at most 62 days ending within the last 31 days and 30 Verified regression tasks,
with deterministic selection and a SHA-256 manifest receipt. Insufficient or stale input
fails rather than substituting old tasks. The selection is not evidence that tasks were
oracle/no-op/flakiness validated; the B2 factory owns those checks. No real benchmark task or
canary content is committed here.

```bash
node packages/bench/src/cli.ts corpus .lane-data/task-metadata.json 2026-10-01 2026-10-21
```

Each metadata item has `id`, `suite` (`swe-rebench` or `verified`), `revision` (the SHA-256 of
sorted relative file names, NUL, then each file's SHA-256 bytes), `path` (a staged directory
under `/home/guanxi-bench/tasks`) and `published` (ISO date). Real task staging, digest validation, separate hidden-verifier preparation and image
readiness remain continuation work before a real executor can be enabled. The stock worker
refuses non-fixture modes; it does not run the toy model against real task identifiers.

`validatePlan` is the executable schema: one fixed model/provider per experiment, fixed
versions, same task/seed/resource pairs, explicit time/step/token/cost ceilings, an equal
per-arm experiment cap and the provider's daily token cap. The default change type is
`simplification`; set `change: "addition"` for additions. Scheduling alternates adjacent arm
order. Noise-floor mode requires one permanent control arm and exactly five distinct seeds;
run it before the first A/B. Infra-tainted tasks must be rerun with new run IDs and fresh
reservations before a decision. The stock host worker enables only the two-task, single-seed `fixture-free` smoke. It
checks the actual pinned control version and refuses A/B and noise-floor execution. Real
corpus execution and a model noise floor require the bounded K3 gateway below, immutable
task staging, actual seed transport and prepared Guanxi task images. No live quality claim is made by fixture results. For already recorded validated results:

```bash
node packages/bench/src/cli.ts analyze .lane-data/recorded-results.json
node packages/bench/src/cli.ts analyze .lane-data/recorded-results.json public
```

## Budget boundary and managed lifetime

All money is integer USD micro-units. A SQLite `BEGIN IMMEDIATE` reserves the entire worst
case (`tasks × seeds × arms × per-trial ceiling`) before executor dispatch. It enforces the
per-arm cap, D-150's protected $200 monthly cap and provider daily token cap. Reopening the
same ledger preserves holds. An existing experiment ID never dispatches again. Crashes,
cancellation, unknown billing and invalid/oversized results keep the full reservation; even
successful runs conservatively retain their reserved amount. Budget overflow is refused. Metered runs whose timeout could cross a UTC budget day/month are refused before reservation.
All processes using the same benchmark account must share this one private ledger; choosing
a different file is a separate budget domain and must not be used to bypass D-150.

A reservation alone cannot constrain a provider call already in flight. Consequently the
stock Harbor executor **refuses every paid run**. `runBench` accepts a paid experiment only
with an explicit integrator approval tied to its ID **and** a trusted executor with a bounded
K3 billing gateway. That gateway must quote and reserve each request's worst-case input/output
cost and enforce output/step/token bounds before contacting the provider. B1 does not ship
such a paid gateway or claim that mini-swe-agent's post-call `cost_limit` enforces a hard cap.
K4’s current exec JSON record contains no token/cost usage; the adapter preserves that as
unknown, and unbilled scored records cannot be accepted. K3 connections remain the only credential owner: configs carry `secret://` references, never
key values. Do not activate a paid executor by declaring an unbounded provider as bounded.

The [request-admission foundation](REQUEST_ADMISSION.md) adds durable per-trial/request
debits and a hook for K3's existing pre-dispatch prepared-request boundary. Its fixtures
prove hold-before-dispatch and refusal for both arm identities. It supplies no actual
provider wire meter, pricing adapter or arm bridge and does not enable paid execution.

The R1 plugin renews its attempt while the external process is active and aborts on lease
loss or unload. Rejected or unconfirmed cancellation ends the run as failed; it never claims
confirmed remote cleanup from an SSH disconnect. There is no automatic inference restart. The managed process bounds stdout,
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
