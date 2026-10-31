# B3-c — naive-compaction relay arm: plan

**Status:** plan (implementation follows in this lane; see the hand-off once it exists) · **Updated:** 2026-10-31 ·
**Branch:** `lane/b3c-naive-arm` · **Base:** `lead/wave7` `a9a25c82` · **Ports:** 5234 / 4434 ·
**Decision:** D-219 · **Follows:** [B3-b hand-off](B3-b-smoke.handoff.md) (branch `lane/b3b-smoke`)

## Goal

The B3 scope lists the arm "naive summary compaction" next to the ledger relay
([ROADMAP B3](ROADMAP.md#b3--relay-benchmark)); D-219 names it for the smoke cohort. The relay has one
handoff mechanism (ADR-0020), so the arm cannot run. This lane adds the smallest honest switch: a
trusted-host, node-wide, **default-off** `RelayLimits.compaction: 'ledger' | 'naive'`. In `naive` mode the next
cycle receives a model-written summary of the previous context instead of the ledger strip, notes and ledger
queries. Budget, probes, gates, judges, the cost ledger, the sealed handoff and fencing stay exactly as they are,
so a comparison with the ledger arm differs only in what the model is shown.

It is a **benchmark arm, not a product feature**: no wire field, no contract change, no route, no UI, no
default. The B3-b runner reaches it only through a second home process whose ms1-live config sets
`home.relayCompaction: "naive"`.

## Definition: "naive summary compaction"

The owner has not defined it further; the default used (recorded as such) is the common rolling summary:

1. Cycle 1 is unchanged except that its context head is frozen at cycle start (the strip as the task statement:
   current item with title and acceptance, queued and blocked ids; there is no previous context to compact).
2. At the cycle boundary the same model, with the same window and reserves, is asked once to summarise what it
   was shown (the head of that cycle, which for cycle 2 and later is the previous summary, plus the cycle's turns).
   Input packing is the existing `pack`: oldest turns fall off first and a drop or cut is reported as
   `context_dropped`.
3. The reply (`purpose` `narrative`, so cost and output-limit handling are the existing ones) is the only thing
   the next cycle sees besides the plan goal. The strip, the notes selection, `work.query` and `notes.search`
   are not offered, so the ledger cannot be re-read.
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
| `run()` | — | one `{relay:'compaction', mode:'naive'}` note per attempt, before the first model call |
| work context head | `[strip(l) live, goal, narrative]` | cycle 1: `[strip frozen at cycle start, goal, '']`; later: `[goal, summary]` |
| `orient()` | two probes, `probe_failed_twice` escalates | one probe over the summary only, recorded (`compaction:'naive'`, per-field results), never fatal; damaged seal gives a fixed "summary unavailable" text, not a ledger recovery |
| `handoff()` narrative | `Write a fresh bounded handoff narrative…` over strip, notes, last 3 turns | `Summarize…` over the cycle's head and all its turns; stored handoff has no notes selection |

A probe in the naive arm cannot be answered whole (`ledgerHash` is never shown); the whole-answer result is
expected `false` and is **not** a comparison metric. The per-field booleans (`nextItem`, `nextStatus`, `head`,
`revision`, `ledgerHash`) show what the summary kept.

## Recording the mode

The mode is read from `RelayLimits`, never from the wire. A naive run writes, through the existing R1-fenced
`store.emit`:

- `{relay:'compaction', mode:'naive'}` at the start of each `executor.run` (each attempt);
- `{relay:'compaction_summary', mode:'naive', cycle, summaryBytes, limitBytes, truncated, degraded, inputDropped, inputCut}` per sealed cycle;
- `compaction:'naive'` and `fields` on the `probe` note.

The default path emits **none** of these and its events, prompts, seals and ledger hashes are unchanged
(asserted by the tests). So a trial is a naive trial iff its run's session carries the marker; the marker is
written before the run's first model call by the same flag that changes behaviour. The runner should also
check marker presence against the arm it planned and mark a mismatch invalid.

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
- naive: cycle-2 work and probe prompts contain the summary and the goal and **not** the strip, `work.query` or
  `notes.search`; the model is asked to summarise exactly once per boundary; the tools are absent and refused;
- the mode is recorded (run marker, summary note, probe note), and the stored seal is still valid;
- a summary larger than the handoff bound is cut with `truncated:true` and a visible `[use paging]`; an
  over-large turn history reports `inputDropped`/`inputCut`; a failed summary seals `degraded` with the
  fixed text and the run continues;
- a wrong probe answer is recorded and does not escalate;
- invalid `compaction` value is refused at construction;
- ms1-live: `home.relayCompaction` parses, defaults to absent, reaches the start host limits only when `naive`.

Commands: `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test <files>` for the new test, the
relay tests and the ms1-live config/boot tests; `npx tsc --noEmit -p packages/server`; `npm run lint:md`.

## Ownership

Server relay: `packages/server/src/relay/{types,executor,README}`, `packages/server/src/ms1-live/{config,boot}.ts`,
`docs/operations/ms1-live-run.md`, new test, this plan and the hand-off. `packages/contract`, `packages/bench`,
`packages/web`, `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are not touched; runner changes needed by B3-b are
listed in the hand-off.
