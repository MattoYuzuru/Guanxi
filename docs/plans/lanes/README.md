# Parallel lanes

**Status:** accepted (owner, 2026-10-20) · **Updated:** 2026-10-24

Several agents, possibly from different model families and harnesses, work on independent
roadmap stages at the same time on the owner's Mac (Apple M5 Pro, 15 cores, 24 GB). This file
holds the rules every lane follows. Each lane has its own prompt file in this folder. The integrator merges lanes into `main`. The initial coordinating session was Claude Opus;
the 2026-10-21 continuation is coordinated by Codex. Check the latest handoff and live
processes before assuming a worker is still running.

## Lanes

| Lane | Stage part | Runs in | Branch | `GUANXI_WEB_PORT` / `GUANXI_API_PORT` | Status |
| --- | --- | --- | --- | --- | --- |
| [K1](K1.md) | K1 kernel | Claude Opus session | session branch | 5181 / 4381 | merged ([evidence](../evidence/K1.md)) |
| [DS1-a](DS1-a.md) | tokens, fonts, logo assets, gate runner, G1–G7 | GPT (Codex), xhigh | `lane/ds1-a-tokens` | 5182 / 4382 | merged ([evidence](../evidence/DS1-a.md)) |
| [DS1-b](DS1-b.md) | `@guanxi/ui` primitives, stories, catalog, approvals, G10–G16 | Claude Opus session | session branch | 5183 / 4383 | merged ([evidence](../evidence/DS1-b.md)) |
| [DS1-c](DS1-c.md) | ESLint and stylelint, G8–G9, suppression ratchet, codemod | GPT (Codex), run by the integrator (owner, 2026-10-20) | `lane/ds1-c-ratchet` | 5184 / 4384 | merged ([evidence](../evidence/DS1-c.md)) |
| [K2](K2.md) | K2 session log, inspector, egress scrubber core | Claude Opus session | session branch | 5186 / 4386 | merged ([evidence](../evidence/K2.md)) |
| [K3](K3.md) | K3 connections, vault, pi-ai, probes | GPT (Codex), xhigh | `lane/k3-model-access` | 5187 / 4387 | merged ([evidence](../evidence/K3.md)) |
| [R1](R1.md) | R1 durable runs, hibernation and wake | GPT (Codex), xhigh | `lane/r1-durable-runs` | 5188 / 4388 | merged ([evidence](../evidence/R1.md)); follow-up `lane/r1-followup` |
| [F1](F1.md) | F1 federation base | GPT (Codex), xhigh | `lane/f1-federation` | 5194 / 4394 | merged ([evidence](../evidence/F1.md)) |
| [K4](K4.md) | K4 native agent, tools, access modes, projects | GPT (Codex), xhigh | `lane/k4-native-agent` | 5189 / 4389 | merged ([evidence](../evidence/K4.md)); follow-up merged ([evidence](../evidence/K4-followup.md)) |
| [R2](R2.md) | relay executor and trusted public admission | GPT 6.1 Sol/high; independent GPT review | `lane/r2-relay-executor` and follow-ups | 5195 / 4395 | reviewed public start/CLI/K3 settlement integrated locally `1b6f495`; stock meter/workspace authority and operational gates remain |
| [K5](K5.md) | external agents and durable same-node admission | DeepSeek Flash/max; independent GPT 6.1 Sol/high | `codex/k5-durable-admission` | 5196 / 4396 | reviewed admission/learning integrated locally `1b6f495`; vendor/implicit-bare/Claude producer scope remains |
| [X1](X1.md) | repository map and full-text index | GPT 6.1 Sol/high; independent GPT review | `codex/x1-parent-read-boundary` | 5197 / 4397 | local Colima62/62; integrated1b6; actual Fedora3e X1/kernel62/62 no skips; separate nativecore25 failures under diagnosis, production proof remains |
| [B1](B1.md) | bench foundation, private process and K2 retention | DeepSeek/GPT authors; independent GPT 6.1 Sol/high | `codex/b1-trial-binding` and integration | 5198 / 4398 | reviewed process/retention and fixture repairs integrated locally `1b6f495`; paid execution/corpus/billing/five seeds remain |
| [DS2](DS2.md) | DS2 approval signing helper (Secure Enclave P-256) | DeepSeek Flash/max; independent GPT 6.1 Sol / high review | `codex/ds2-review-fixes` | none (no server) | merged locally `03c655b`; full candidate gates pass ([evidence](../evidence/DS2.md)); main full gates pass at `5e9bbfe`; owner-present hardware signing pending |
| [U1](U1.md) | layout/replication, canonical CSS, shell/search preparation | DeepSeek/GPT authors; independent GPT 6.1 Sol/high | `codex/u1-completion` | 5199 / 4399 | reviewed preparation integrated locally `1b6f495`; product mounting follows in the isolated lane below |
| K4 follow-up 2 | K4 residuals: R1 integration and native session retention | DeepSeek Flash/max; independent GPT 6.1 Sol / high review | `codex/k4f2-review-fixes` | 5189 / 4389 | merged as `8006cd8`; full integrator gates pass ([evidence](../evidence/K4-followup-2.md)); broader K4 residuals remain |
| F2 integration | offers/grants/dispatch and composed migration bundle | GPT 6.1 Sol/high; independent GPT review | `codex/in-progress-integration` | 5201 / 4401 | reviewed bundle `73ebbb18` merged locally as `1b6f495`; whole F2/MS1 exits remain open |
| U1 product mount | actual App shell composition | DeepSeek author; independent GPT6.1Sol/high closed | `codex/u1-shell-mount` | 5202 / 4402 | finalae691c23: endpoint/contrast/ratchet repairs independently closed; included in separate unvalidated unionc0145958, no main mount claim |
| U1 workspace states | loading/error/empty vocabulary and three-component readiness | GPT6.1Sol/high author; separate review follows | `codex/u1-workspace-states` | 5205 / 4405 | root plan8a001b66 from unionc0145958; ownCI z2yiultz; exact12-image root baseline allowance; author active |
| [Review](REVIEW.md) | cross-family review of a finished lane | a model of another family | none (read-only) | 5190–5192 / 4390–4392 | when a lane hands off |

Port 5185/4385 belongs to the localization-flake investigation. Merge order within DS1:
DS1-a → DS1-b → DS1-c. DS2 (approval signing helper, D-184) and U1 open after DS1; see the
[roadmap graph](../roadmap.mmd).

## Rules for every lane

1. **Read first:** [AGENTS.md](../../../AGENTS.md), [WORKFLOW](../WORKFLOW.md), this file and
   your lane file. They override anything you assume from other harnesses.
2. **Worktree and branch:** work only in your own git worktree on your lane branch. Never
   commit to `main`, never push, never merge. The integrator merges.
   - Run `npm ci` once in a new worktree before its first check, then confirm with
     `node -e "console.log(require.resolve('@guanxi/contract'))"`. It must print a path inside
     your worktree.
   - A worktree nested in the main checkout (`.claude/worktrees/…`) without its own
     `node_modules` silently resolves `@guanxi/*` to main's packages.
   - After adding a workspace package, run `npm install` in your worktree.
3. **Ownership:** edit only the paths your lane file owns. If you must touch another lane's
   path, keep the change minimal and list it under "Shared edits" in your hand-off.
4. **Ports and data:**
   - Export your lane's `GUANXI_WEB_PORT` and `GUANXI_API_PORT` in every shell, and
     `GUANXI_DATA_DIR="$PWD/.lane-data"`.
   - The browser gate, the Vite dev server and proxy, and `npm run dev:server` read them.
   - A busy port fails loudly, and an invalid value fails with a message naming the variable.
     Never kill a process you did not start.
5. **Scoped local iteration; final hosted CI.** Follow [the CI protocol](../../operations/ci.md).
   Workers run exact tests for changed behavior and affected consumers; they do not run
   `npm test`, full browser/catalog suites, Storybook or all builds after every edit.
   The lead publishes one reviewed integration candidate as a ready PR, then checks
   `npm run ci:finish -- <PR-number> --wait`. A worker cannot replace CI with a local receipt.
   A justified resource-heavy local reproduction still uses the shared lock:

   ```bash
   agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- node --test path/to/affected.test.ts
   ```

   Preserve the server key-file import guard for server tests (see the CI protocol). Busy means
   wait or work independently; do not bypass the lock. Run dependent commands sequentially
   and stop on failure. Existing clones/dependencies are reused; `npm ci` is needed after lock
   or runtime changes, missing modules or a diagnosed installation problem, not each handoff.
6. **Live server:** never use the owner's `~/.guanxi`; two servers on one data directory
   reconcile each other's chat jobs.
   - With the exports from rule 4, `npm run dev:server` is safe.
   - The CLI equivalent is
     `node packages/cli/src/bin.ts --port "$GUANXI_API_PORT" --data-dir "$PWD/.lane-data" --no-open`.
   - `.lane-data/` is ignored by git.
7. **Status files:** do not edit `docs/plans/PHASE_STATUS.md` or
   `docs/plans/NEXT_AGENT_PROMPT.md`. Every lane edits them, so they would conflict at merge.
   Write your status into `docs/plans/lanes/<lane>.handoff.md` instead:
   - exit-gate items with evidence split into "new / regression envelope";
   - commands with the result line or `agent-dev` receipt path;
   - verification findings and their fix commits;
   - residual risk and shared edits;
   - the next slice.

   The integrator folds the hand-off into the status files at merge.
8. **Dependencies:** add a dependency to your own package's `package.json` where possible. Do not
   hand-resolve `package-lock.json`; the integrator regenerates it after each merge and re-runs
   the gates. Every copied third-party file needs a `THIRD_PARTY_NOTICES.md` entry in the same
   commit, and `npm run check:licenses` must stay green.
9. **Before hand-off:**
   - merge the current `main` into your branch (no rebase of pushed history);
   - re-run your gates;
   - run the independent verification your lane file names, as a separate action, with fixes
     in separate commits.
10. **Never:**
    - put secret values anywhere;
    - write reasoning to logs;
    - set a component's review status to `approved` (only the owner's signed approval can);
    - weaken an existing test to make it pass;
    - mark `proposed` work as implemented.
11. **Blocked:** write the blocker and the recovery steps into your hand-off file, commit it on
    your branch, and stop.

## DeepSeek lanes (owner, 2026-10-21)

Up to four DeepSeek runs may work at the same time (owner, 2026-10-21 continuation),
next to at most three GPT 6.1 Sol / high reviewer or implementation agents. Each DeepSeek run
uses the configured DeepSeek-V4.1-Flash release 1017 at max effort in DeepSeek Harness
headless mode, with the integrator's
overlay `Guanxi-lanes/infra/dsh-headless.patch.yml`. That overlay restores the saved key, keeps
the `workspace-write` sandbox and rejects every approval request. The configuration identifies the requested release;
remote backend release identity is not independently attested.

The local `infra/dsh-run.sh` and `dsh-queue.sh` now share four atomic `flock` slots through
`infra/dsh-safe-run.py`. It preserves the child exit code and discards thinking/tool/raw-stderr
streams before writing a private final-only JSONL. Stub verification covers exit propagation,
stream exclusion, name collisions, concurrent slots and gate failure short-circuiting.
The old launcher logs remain historical local files; do not inspect or export stored reasoning.
Legacy `infra/*gates.sh` entrypoints are compatibility adapters to the current protocol;
they no longer reinstall dependencies or start full local runs automatically.

- **Fitting tasks:** fully specified work. Review-fix rounds, where each finding already names a
  file:line, a scenario and the smallest fix, suit it well. So does mechanical new work with a
  design written by the integrator.
- **Workspace:** a standalone `git clone` on the lane branch, not a worktree. The sandbox can
  only write inside its working directory, and a worktree's git metadata lives outside it. The
  integrator installs dependencies once when creating a new checkout; reuse existing clones
  and installations unless the lock/runtime changed or installation is diagnosed broken.
- **Inside the sandbox:** the run uses targeted `node --test` files plus
  `npx tsc --noEmit -p <package>` under `nice -n 10` only. Node's type stripping does not
  typecheck, and one DeepSeek fix round shipped a type error that only `tsc` caught. It cannot
  take the `agent-dev` lock or run the full suites.
- **Not for DeepSeek:** code whose tests start a nested sandbox (`sandbox-exec`, `bwrap`,
  containers), because DeepSeek's own sandbox refuses them. X1's sandboxed-worker regressions
  slipped through that way. Such fixes go to Codex.
- **Integrator duties:** collect the existing branch, arrange
  an independent GPT 6.1 Sol / high review after DeepSeek (owner, continuation), then merge
  only after the required checks. Existing original-code cross-family review obligations stay
  explicit in each handoff.

## Integrator checklist (per merge)

- [ ] Read the hand-off and the diff; check that ownership was respected.
- [ ] Cross-family review done ([REVIEW](REVIEW.md)), findings fixed on the lane branch.
- [ ] Compose the lane on a private integration branch, regenerate `package-lock.json` with
      `npm install` if dependencies/workspace manifests changed. Do not stage unchecked code
      directly on main.
- [ ] Finalize the hand-off in `docs/plans/evidence/<lane>.md`, status and next prompt before
      publishing the final ready candidate. Link its PR/checks; record exact final run identity
      in the workflow receipt, PR description and final response without another tree edit.
- [ ] Publish the reviewed integration candidate as a ready PR; require its parallel full CI
      and successful `ci:finish`. Refresh and revalidate if `main` changed. Do not repeat the
      full local gate on the same candidate before/after merging.
- [ ] Integrate the tested candidate through the authorized merge method; tell lanes which
      base changed. Reuse their checkouts and preserve dirty work when incorporating main.
