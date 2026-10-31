# B3-c hand-off — default-off naive-compaction relay arm

**Status:** implemented and fixture-tested; **never run against a real model or the Fedora node**. B3 stays `proposed`, no
criterion is evaluated. Independent review has not been done (the lead runs it) · **Updated:** 2026-10-31 ·
**Branch:** `lane/b3c-naive-arm` · **Base:** `lead/wave7` `a9a25c82` · **Decision:** D-219 · **Plan:** [B3-c plan](B3-c-naive-arm.plan.md)

## What changed

| File | Change |
| --- | --- |
| `packages/server/src/relay/types.ts` | `RelayLimits.compaction?: 'ledger' \| 'naive'` (absent means ledger) |
| `packages/server/src/relay/executor.ts` | the switch, `this.naive`, at: the constructor (mode validated; `work.query`/`notes.search` not listed), `tool` (those two refused with `tool_denied`), `run` (marker note), the work context head, `orient` (no probe call), `handoff` (summary instead of narrative, no notes in the seal), `make` (no notes), one small `summarized` note helper |
| `packages/server/src/relay/response-schemas.ts` | three fixed texts: summary prompt, degraded summary, unavailable summary |
| `packages/server/src/ms1-live/config.ts`, `boot.ts` | `home.relayCompaction` (optional `ledger`/`naive`), passed to the relay start host limits only when `naive` |
| `packages/server/src/relay/README.md`, `docs/operations/ms1-live-run.md` | arm section; config key; the restart-per-arm procedure |
| `packages/server/src/relay/handoff.ts`, `start.ts` | review fixes: `taskStatement(plan)`; `RelayStarts` validates the mode at construction (boot) |
| `packages/server/test/relay/naive-compaction.test.ts`, `default-path-pin.test.ts`, `test/ms1-live/relay-compaction.test.ts` | 17 + 1 + 4 new tests |

No contract, migration, route, web, bench, `PHASE_STATUS.md` or `NEXT_AGENT_PROMPT.md` change. The default path emits no new
event, builds no new prompt, and seals the same bytes (asserted: an explicit `ledger` run and a default run have identical prompts,
event texts and ledger once random ids and hashes over them are normalised).

## Design deviations from the B3-b sketch, and why

1. **Restart-per-arm passes of the same home, not a second home process** (the independent review of the B3-b design): the pairing
   has one `peer.url` and one pinned peer identity. The mode is node-wide config (`home.relayCompaction`); the operator stops the
   home, flips the key and restarts it with the same data directory, executor and commit. Documented in section 5 of the runbook.
2. **The seal is unchanged** (the sketch said "seal only a summary"). The ledger, strip, bundle and `validateHandoff` stay, so the
   fencing and integrity facts the comparison relies on do not move; in naive mode the model is simply never shown them.
3. **No probes in the naive arm** (the review asked for an explicit choice). The five probes are strip facts; carrying them in the
   summary would give the arm the ledger by another route, and asking them would fail by construction and cost a call per cycle. The
   cycle records `{relay:'probe_not_applicable', mode:'naive', cycle, reason:'ledger_facts_not_shown', damaged}` and writes **no**
   `probe` note, so a consumer that counts `probe` notes can never count it as a pass or a fail. Reasoning is in the plan and the README.
4. **Task statement, not the strip, for the first cycle** (review H1/M2 changed this). Cycle 1 has no previous context; it is shown a
   task statement derived from the immutable plan alone (`{initial:true, current, queued, blocked, title, acceptance}`, every item
   open), without live status and without the `query:'work.query'` hint. The same text is used by a resumed attempt that has no
   seal. A cycle-1 strip that follows the ledger would have fed the naive arm progress; one frozen from the ledger would have named a
   refused tool and kept `open` after the gate passed.

## Attribution from the run itself

Naive runs write `{relay:'compaction', mode:'naive', attempt, epoch}` (R1-fenced, once per executor attempt) before that attempt's
first model call, a `compaction_summary` note (with `attempt`) after each seal and `probe_not_applicable` each cycle after the first. A
ledger run writes none of them. A trial is therefore attributed from its own session events, not from configuration or the pass it was
started in. **A run whose attempts disagree is invalid for the bench**: every attempt in `relay_seals.attempt_id` must have its own
marker and every `compaction_summary` must name a marked attempt (README, "What is recorded"); the runner applies that rule.

## Gates (Mac, Node 26, worktree-local `npm ci`; `@guanxi/contract` resolves inside the worktree)

| Command | Result |
| --- | --- |
| `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/relay/naive-compaction.test.ts packages/server/test/ms1-live/relay-compaction.test.ts` | 22 tests, 22 pass |
| the same runner over `packages/server/test/relay/*.test.ts`, `ms1-live/*.test.ts`, `llama-server/*.test.ts` | 554 tests, 554 pass, 0 fail (includes the 22 new; the first pass before the review fixes was 546) |
| the same runner over `packages/server/test/ms1/*.test.ts` and `packages/cli/test/relay-exec.test.ts` | 29 tests, 29 pass (MS1 rehearsal with fault injection included) |
| `npx tsc --noEmit -p packages/server` | exit 0 |
| `npx eslint` over `packages/server/src/relay`, `src/ms1-live` and the three new test files | 0 errors |
| `npm run lint:md` | 0 errors, 318 files, 830 links, 0 link problems |

**Counts (WORKFLOW 4b):** B3-c 22 new (14 + 8 from the review fixes) / 532 envelope (relay, ms1-live, llama-server) plus 29 (ms1, cli relay-exec). Existing
tests and assertions are unmodified (`git diff lead/wave7 --stat -- '*test*'` shows two new files only). Not run: the full `npm test`,
browser gates, builds and hosted CI (the lead owns them).

**Mutation check** (a script applied one removal at a time to `executor.ts`/`boot.ts` and ran the two new files; each must fail):
19 mutants: strip kept in every naive cycle, strip kept in the naive head, ledger tools still listed, ledger tools still served, no run
marker, no summary note, truncation never reported, input loss never reported, ledger narrative prompt used, summary sees one turn, notes
sealed in naive, probes asked in naive, degraded text points at the ledger, damaged seal used, invalid mode accepted, mode ignored, default
is naive, boot always passes the mode, boot never passes it. 18 died on the first run; the survivor ("notes sealed in naive", no test
had a note) got the note test and then died. The scripts are not committed.

## What the B3-b runner must change or set (`packages/bench` was not touched)

1. **One endpoint, two passes.** The runner's naive arm must be allowed to share the ledger arm's `url`/`homeDb`, with the operator
   restart between passes (a pause/`--arm` selection, then the second pass). The config example in `RELAY_SMOKE.md` with a
   second `url` should be replaced by the procedure in section 5 of the runbook.
2. **Attribute each trial from its events:** `compaction` marker present means `naive`, absent means `ledger`. Mark a mismatch with
   the planned arm `infra_error`/invalid; do not trust the pass order.
3. **Facts parser:** `probe_not_applicable` must map to a probe fact that is not a result (the existing `probe` parser requires a
   boolean `correct` and ignores unknown note names, so the naive arm yields no `probe` facts; the rule "a cycle past the first with no
   probe note is `unknown`" must become `not_applicable`/`unsupported` for the naive arm). Optionally record `compaction_summary`
   (`truncated`, `inputDropped`, `inputCut`, `degraded`) as truncation facts of the naive arm; a truncated or degraded summary is a
   harness event, not an infra error.
4. **Arm profile:** `ledgerHandoff: false`, `deadEndGuard: false` stay right. The seal in the home database still holds the ledger,
   so the per-cycle item facts (first gate per item per cycle) work unchanged for both arms; the ledger/handoff integrity re-hash
   is still computable but describes a handoff the naive model never saw, so leave it `unknown{unsupported}` for that arm.
5. **Costs:** summary calls are `relay:narrative` calls and land in the same `run_costs` rows. There are no probe calls in the naive
   arm and none to subtract.
6. **Home restart:** the runner cannot flip the mode itself; the report should say which pass each trial belongs to only as a cross-check.

## Residual risk and not done

- **No real-model evidence.** Summary quality, the output reserve (`reserves.turn`, which bounds one summary reply; a reply the model
  cuts is `degraded` with a fixed text) and the 15% handoff bound decide how much the naive arm keeps. These are the machinery's
  limits, reported in `compaction_summary`, not hidden caps.
- **The definition of "naive" is a default**, not an owner answer: a rolling summary of the previous cycle's context (cycle 2 and later
  summarise the previous summary plus the new turns), written by the same model, with the goal kept. Record it in the owner questions
  if a different baseline (summary of the whole transcript, observation masking) is wanted.
- **`note` and `propose` actions stay offered** to the naive model (stored, never shown); `verify` still returns the gate result and,
  for an unknown id, the item list. Both arms share the harness, so item ids can be recovered that way; this is a property of the
  comparison, not a leak of the strip.
- **The judge (`home.judge`) is unchanged and reads the ledger**, never the model's context; with a judge configured both arms get
  its samples and their pre-debited tokens. A smoke should run without it or with the same setting in both passes.
- **Node-wide:** a home in naive mode also serves a lead's relay in naive mode. Use it only for the benchmark home.
- **A naive run with no marker** could exist only if the process died between the start commit and the first line of `executor.run`,
  before any model call; it has no model content to attribute.
- A trial interrupted by a restart ends `interrupted`; the restart-per-arm procedure requires finishing or cancelling first.
- Independent review of this lane is the lead's. Per-field probe results for the ledger arm (B3-b's wish-list) are not done.

## Next slice

B3-b/B3-c integration: apply the runner changes above, then run the pilot task in both passes on the Fedora node (restart-per-arm),
and give the independent reviewer `summary.json`, `report.json`, `measurement.json` and the commit ids.

## Review findings and fixes

The independent review verified the default path byte-identical to the base. Its findings, all fixed in `fix(relay): review fixes` commits:

| Finding | Fix | Evidence |
| --- | --- | --- |
| **H1** the frozen cycle-1 strip carried `query:'work.query'` (a refused tool: `tool_denied` raised `ledger.errors`, which the judge cascade reads) and kept `currentStatus:"open"` after the gate passed | the first cycle gets `taskStatement(plan)`: plan-derived, labelled `initial`, no query, no status. `strip` and the ledger text are unchanged | test: no prompt of the naive run, in any cycle, contains `work.query`/`notes.search`; `errors` stays 0; both cycle-1 prompts (before and after the verify turn) carry the same initial statement and never `"current":"b"` or `currentStatus` |
| **M1** the summary prompt had no size guidance; a cut reply became the degraded text | the prompt states `Your reply is cut at <reserves.turn> tokens, and the stored summary at <n> bytes`; `n` is the room the handoff bound leaves (`room()`, the arithmetic `make` applies); `compaction_summary` reports `summaryLimitBytes`, `outputLimitTokens` and `degradedReason` (`model_failed`, `narrative_output_limited`, ..., `handoff_fallback`) | tests: prompt numbers equal the note's per cycle; reasons for a failed call and an output-limited reply; a cut summary uses the room to within 20 bytes |
| **M2** marker mutation survived; no multi-attempt test; a resumed attempt with no seal saw the live strip | marker and summary note carry `attempt` (marker also `epoch`); the resumed no-seal head is the task statement | tests: two attempts write two markers, the second before that attempt's first model call (counted against the events); naive then ledger leaves a sealing attempt without a marker, which the documented rule detects; a run stopped inside cycle 1 after item `a` passed resumes with `current:"a"`, `initial:true` and no `b` |
| **M3** cycle-1 freeze untested | covered by the H1 and M2 assertions | mutation `[strip(...), goal]` for the no-seal head now dies |
| **L1** the harness-fallback summary read `truncated:false` | `summarized` compares against the model's reply, not the blanked text; `degradedReason: 'handoff_fallback'` | test forces two `handoff_size` refusals: `truncated:true, degraded:true, summaryBytes:0`, and the next cycle gets the unavailable text |
| **L2** `handoffLimitBytes` was the whole-handoff bound | replaced by `summaryLimitBytes` (the room for the summary) | the tests above |
| **L3** `relayCompaction: "naive"` with `home.lead` | refused by the configuration: `config_compaction_with_lead` at `home.relayCompaction` | ms1-live test (also accepts `ledger` and absent with a lead) |
| **L4** a programmatic `relayHost.limits.compaction` was validated at the first start | `RelayStarts` checks it when the relay plugin loads: `relay_compaction_invalid` at boot | ms1-live boot test; if a mutant lets the boot pass, the test closes the listener |
| **L5** harness-sourced warning notes | listed in the README as text the naive model never sees (the checkpoint `open_issue`) | docs only |
| **L6** the default path was compared only with an explicit `ledger` | `default-path-pin.test.ts` pins a SHA-256 of every prompt, event shape and the final ledger of a two-cycle default run; **the digest was recorded on the base commit `a9a25c82`** (`git checkout lead/wave7 -- packages/server/src`, the test passes, source restored) | the test passes on both the base and this branch's source |

Mutation check of the fixes (12 mutants: live strip in the no-seal head, `work.query` or `currentStatus` in the task statement, marker
only for one attempt token, marker or summary note without `attempt`, no size hint, wrong room, `degradedReason` dropped, fallback read as
intact, lead accepted, boot validation removed): all killed. The reviewer's `a.epoch === 1` mutant is equivalent in this store (every
attempt has epoch 1; the token changes), so the same mutation on `a.token === 1` is used instead.

Residual after the fixes: none of the review items is left open. Still true from before: no real-model evidence; the naive definition is a default.
