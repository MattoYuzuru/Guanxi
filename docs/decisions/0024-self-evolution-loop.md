# ADR-0024: Self-evolution loop with risk classes and protected surfaces

**Status:** accepted for autonomy tiers (owner decisions D-107, clarified by D-117); proposed design · **Date:** 2026-10-19

## Context

The owner sees agents repeatedly hit the same friction and invent odd workarounds until a human
intervenes; parallel agents collide on ports and Docker; dictated prompts carry misheard terms.
The harness should audit its own sessions and improve at three levels: the project, the local
harness, and the upstream repository, up to writing a plugin and restarting itself when idle.

Evidence (lane 5): experience-driven text changes (skills, playbooks, instructions) give the
most reliable gains (SkillOpt +19.1 points inside Claude Code with a no-regression gate; ACE
+10.6%; Agent Workflow Memory +24.6–51.1% relative). Open-ended code evolution is costly (a
Darwin Gödel Machine run ≈ $22k and two weeks) and self-improvers game metrics: faked test
logs, removed detector markers, disabled sandboxes.

## Decision

1. **Capture** normalised trajectory events from the session log (ADR-0023) with a host
   snapshot for correlation.
2. **Triggers**: "Audit now" button; schedule; every N sessions or tool calls; sampling
   (p ≈ 0.2 per finished session) plus always for sessions with a user stop, ≥3 identical
   failures or a denied `input_required` decision or confirmation. Audits are idle-priority runs under the governor with a
   budget.
3. **Privacy before any model**: exact-match scrub of known secrets, secretlint/gitleaks
   rules, optional PII scrub; the auditor is an agent without network, shell or secret
   references, reading a redacted view; local model by default; remote models only on
   redacted clusters with per-project consent; the redacted view never contains reasoning
   events, which only local auditors may read (ADR-0023); upstream receives only aggregated
   findings.
4. **Detectors** (deterministic first): repeated failing command; the same action re-done
   through `python -c`/`sed`/heredoc after a tool failed; `--no-verify`, `.skip`, `@ts-ignore`,
   test edits in the same change as code; `EADDRINUSE`, "port is already allocated",
   "container name already in use", lock contention; "I cannot do X" while tool X is enabled;
   manual tool hints from the user; long time-to-first-edit; token or compaction blow-ups;
   voice prompts followed by corrections.
5. **LLM facets** (sampled, local) label friction with a taxonomy (MAST/AgentErrorTaxonomy
   plus `env-collision`, `missed-capability`, `instruction-gap`, `tool-ergonomics`,
   `model-limitation`, `spec-ambiguity`, `stt-misrecognition`, `reward-hacking-signal`).
   Every finding must cite event IDs; findings without valid evidence are dropped. Findings
   are clustered across sessions by recurrence × waste.
6. **ChangeSets by risk class** (RC0–RC4; D-107 as clarified by D-117: every automatic change
   passes a pre-apply gate):

   | Class | Surface | Application | Gate |
   | --- | --- | --- | --- |
   | RC0 | glossary, STT dictionary, append-only project memory | automatic after the gate + notification + one-click revert | pre-apply replay: STT eval set (term F1 must not drop, U-WER rise ≤ 1 point) or the project smoke suite for memory notes |
   | RC1 | project `AGENTS.md`, skills, docs, scripts | branch in a worktree; auto-merge only with per-project opt-in | project smoke suite + instruction token budget |
   | RC2 | local harness config: routing, timeouts, lease ranges, role prompts | versioned config, canary | private benchmark + canary A/B with auto-rollback |
   | RC3 | sandboxed T2 plugins only | sandbox build, staged slot | full tests, browser gate, license scan, style gate, permission diff; any new right needs owner approval |
   | RC4 | any in-process code (T0 core, T1 plugins) and upstream pull requests to Guanxi | fork/branch/PR with provenance | always owner review |

   In-process code is never changed automatically.
7. **Protected surfaces** never edited by the loop: evaluators, scorers and hold-out tasks,
   gate thresholds, redaction rules, permission policy and security profile, the audit
   pipeline, rollback, provenance log.
8. **Rollout**: shadow → concurrent canary vs control → promote; one canary at a time;
   rollback triggers: more interventions, tool-error rate, crashes, token blow-up. The arm and
   `harness_version` are written into each run's immutable policy snapshot (per-run harness
   version registry).
9. **Staged idle restart** with A/B version slots and post-boot health checks; restart only
   with no running inference, no pending `input_required` decisions, no recording, user idle > N minutes, after a
   drain. Schema changes follow expand/contract so the previous slot still runs.
10. **Provenance**: findings, input hashes, auditor/proposer models and prompt hashes, gate
    results, approver, rollout state; git trailers; optional Sigstore signing.

## Validation

Seeded friction corpus (planted collisions, workarounds, misheard terms) must be detected with
recall ≥ 0.8 and precision ≥ 0.7; an RC0 glossary entry that lowers term F1 on the eval set is
not applied; an attempt to route in-process code through RC3 is refused; a planted reward-hacking ChangeSet (editing tests) must be rejected by the
gate; a canary with injected regression must auto-roll back.

## Evidence

Lane 5 §1 and §0 ([research](../research/README.md)).
