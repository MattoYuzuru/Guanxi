# B3-c — naive-compaction relay arm: plan

**Status:** implemented (see the [hand-off](B3-c-naive-arm.handoff.md)); plan revised after the independent review of the B3-b design · **Updated:** 2026-10-31 ·
**Branch:** `lane/b3c-naive-arm` · **Base:** `lead/wave7` `a9a25c82` · **Ports:** 5234 / 4434 ·
**Decision:** D-219 · **Follows:** B3-b hand-off and plan (branch `lane/b3b-smoke`, not yet merged)

## Goal

The B3 scope lists the arm "naive summary compaction" next to the ledger relay
([ROADMAP B3](../ROADMAP.md#b3--relay-benchmark)); D-219 names it for the smoke cohort. The relay has one
handoff mechanism (ADR-0020), so the arm cannot run. This lane adds the smallest honest switch: a
trusted-host, node-wide, **default-off** `RelayLimits.compaction: 'ledger' | 'naive'`. In `naive` mode the next
cycle receives a model-written summary of the previous context instead of the ledger strip, notes and ledger
queries. Budget, probes, gates, judges, the cost ledger, the sealed handoff and fencing stay exactly as they are,
so a comparison with the ledger arm differs only in what the model is shown.

It is a **benchmark arm, not a product feature**: no wire field, no contract change, no route, no UI, no
default. The B3-b runner reaches it only through the home's ms1-live config (`home.relayCompaction: "naive"`), by
**restart-per-arm passes of the same home**. The B3-b sketch of a second home process is not used: the pairing
has one `peer.url` and one pinned peer identity ([MS1 live run](../../operations/ms1-live-run.md) sections 2 and 3),
so a second home would need a second pairing. The procedure is written in section 5 of that runbook.

## Definition: "naive summary compaction"

The owner has not defined it further; the default used (recorded as such) is the common rolling summary:

1. Cycle 1 (and a resumed attempt with no seal) is shown a task statement derived from the plan alone (review fix H1):
   `{initial:true, current, queued, blocked, title, acceptance}` with every item open, no live status, no tool hint; there
   is no previous context to compact.
2. At the cycle boundary the same model, with the same window and reserves, is asked once to summarise what it
   was shown (the head of that cycle, which for cycle 2 and later is the previous summary, plus the cycle's turns).
   Input packing is the existing `pack`: oldest turns fall off first and a drop or cut is reported as
   `context_dropped`.
3. The reply (`purpose` `narrative`, so cost and output-limit handling are the existing ones) is the only thing
   the next cycle sees besides the plan goal. The strip, the notes selection, `work.query` and `notes.search`
   are not offered, so the ledger cannot be re-read. The critical probes are not asked (decision below).
4. The summary is bounded by the existing handoff bound (`t.handoff`, 15% of the window) through `make()`
   (`bounded`, which appends `[use paging]`); a cut is also reported in a `compaction_summary` note.

Not changed: the checkpoint-if-dirty, `validate`, final gates, `countProgress`, judge samples, ETA, the bundle,
`validateHandoff`, `store.seal` and the append-only `relay_seals` row. The durable seal still carries the ledger
and strip for fencing and integrity checks; in naive mode they are never shown to the model. (This deviates from
the B3-b sketch "seal only a summary": a changed seal would also change the integrity facts and the fence
checks the comparison relies on, for no benefit in what the model sees.)

## Sites in `executor.ts` (all behind `this.naive`)

| Site | Ledger (unchanged) | Naive |
| --- | --- | --- |
| constructor | tools = `LOCAL_TOOLS` + workspace tools | `work.query` / `notes.search` not listed; `tool()` refuses them with `tool_denied` |
| `run()` | — | one `{relay:'compaction', mode:'naive', attempt, epoch}` note per attempt, before the first model call |
| work context head | `[strip(l) live, goal, narrative]` | no seal: `[task statement, goal]`; later: `[goal, summary]` |
| `orient()` | two probes, `probe_failed_twice` escalates | no model call; records `probe_not_applicable`; a damaged seal gives a fixed "summary unavailable" text, not a ledger recovery |
| `handoff()` narrative | `Write a fresh bounded handoff narrative…` over strip, notes, last 3 turns | `Summarize…` over the cycle's head and all its turns; stored handoff has no notes selection |

## Decision: the probes in the naive arm

The five probes (`ledgerHash`, `head`, `revision`, `nextItem`, `nextStatus`) are facts of the ledger strip. Two
options were weighed after the review of the B3-b design:

1. **Carry the identity facts in the naive handoff** (head, revision, ledger hash as plain facts). Rejected: the
   ledger hash is meaningless to a summarizer, `nextItem`/`nextStatus` are the strip's item state, and any of it in the
   context hands the arm the ledger by another route, breaking "the naive arm must not secretly receive the ledger
   strip".
2. **Record the probes as not applicable with a fixed reason.** Chosen. The executor makes no probe call in the naive
   arm and writes `{relay:'probe_not_applicable', mode:'naive', cycle, reason:'ledger_facts_not_shown', damaged}`; it
   writes no `probe` note, so no consumer can count it as a pass or a fail.

Fairness: a probe that fails by construction measures nothing and would cost a model call per cycle on the single
executor slot. Each arm pays for its own mechanism (probes and the narrative for the ledger arm, the summary call for
the naive arm), all through the same cost ledger; analysis must not subtract either. The B3 probe criterion
(accuracy at least 95%) is a ledger-arm criterion; the arm comparison is item success.

## Recording the mode

The mode is read from `RelayLimits`, never from the wire. A naive run writes, through the existing R1-fenced
`store.emit`:

- `{relay:'compaction', mode:'naive'}` at the start of each `executor.run` (each attempt);
- `{relay:'compaction_summary', mode:'naive', cycle, attempt, summaryBytes, summaryLimitBytes, outputLimitTokens, truncated, degraded, degradedReason, inputDropped, inputCut}` per sealed cycle;
- `{relay:'probe_not_applicable', mode:'naive', cycle, reason, damaged}` for each cycle after the first.

The default path emits **none** of these and its events, prompts, seals and ledger hashes are unchanged
(asserted by the tests). So a trial is a naive trial iff its run's session carries the marker; the marker is
written before the run's first model call by the same flag that changes behaviour. The runner reads the arm from
the run itself and also checks it against the pass it planned, marking a mismatch invalid; it never infers the arm from
operator configuration.

## Config

`home.relayCompaction` (optional `"ledger" | "naive"`) in the ms1-live home section, mapped to
`limits.compaction` only when `naive` (so the default parsed config and limits are unchanged). A caller's
`relayHost.limits` overrides field by field as for `structuredOutput`.

## Non-goals

Observation masking and single-large-window arms; per-field probe results in the ledger arm; changing the plan
digest or any bench schema; a second summary model; the lead path; calibrating `E`; any B3 gate evaluation.

## Tests (`packages/server/test/relay/naive-compaction.test.ts`, one ms1-live config/boot case)

Each is checked to fail with the change removed (stash the source, run, restore):

- default: the work prompt of cycle 2 contains the strip and the narrative text, lists the ledger tools, makes no
  `Summarize` call, the events carry no `compaction` note and the probe note has the original shape (the ledger
  strip path asserted explicitly);
- naive: cycle-2 work prompts contain the summary and the goal and **not** the strip, `work.query` or
  `notes.search`; the model is asked to summarise exactly once per boundary and never to probe; the tools are absent
  and refused; a model note is stored but never shown or sealed;
- the mode is recorded (run marker before the first model call, summary note, `probe_not_applicable`), and the stored seal is still valid;
- a summary larger than the handoff bound is cut with `truncated:true` and a visible `[use paging]`; an
  over-large turn history reports `inputDropped`/`inputCut`; a failed summary seals `degraded` with the
  fixed text and the run continues;
- a model that would fail the probe cannot escalate the naive run (no probe is asked), while the default still does;
- invalid `compaction` value is refused at construction;
- ms1-live: `home.relayCompaction` parses, defaults to absent, reaches the start host limits only when `naive`.

Each guard was mutation-checked (the guard removed, the new tests must fail); the survivor list and the commands are in
the hand-off.

Commands: `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test <files>` for the new test, the
relay tests and the ms1-live config/boot tests; `npx tsc --noEmit -p packages/server`; `npm run lint:md`.

## Ownership

Server relay: `packages/server/src/relay/{types,executor,README}`, `packages/server/src/ms1-live/{config,boot}.ts`,
`docs/operations/ms1-live-run.md`, new test, this plan and the hand-off. `packages/contract`, `packages/bench`,
`packages/web`, `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are not touched; runner changes needed by B3-b are
listed in the hand-off.
