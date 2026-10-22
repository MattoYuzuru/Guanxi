# K4 queue v3 Q0 handoff

**Status:** Q0 implementation, seeded tests and docs authored; author-pure checks run. Real
SQLite/helper, native, browser, build and full-suite gates are **UNRUN** by this author.
Independent review is **UNRUN**. Date: 2026-10-22.

- Checkout: `/Users/yuzuru/Projects/Guanxi-lanes/k4-queue-v3-foundation`
- Branch: `codex/k4-queue-v3-foundation`
- Base: `f8c65df4` / plan commit `4cebea71`
- Q0 implementation commits: `1c06f0d6`, `85ddb3d0`, `9a399c66`, `8ab362e5`
- Author fix commits: `3f6b7129` (readAll refuses an unsupported boundary instead of silently
  stopping at it), `f9fc6e06` (ledger installer also guards the global event/artifact table
  shapes), `cba7faf0` (portable inspector queue fixture byte counts)
- Docs/handoff commit: this commit (HEAD at handoff)
- Scope authority: `docs/plans/lanes/K4-queue-v3.plan.md`, especially "Root Q0 authorization
  and exact ownership". Q1/Q2 are not authorized in this round.

## Exact new

Q0 is an unreleased compatibility foundation, not a native v3 rollback floor and not an
artifactization-complete claim.

- `packages/contract/src/events/queue-v3.ts` — dependency-free shared contract leaf (zod only).
  Moves the existing bounded-input constants/reference/descriptor schemas there and adds strict
  queue v3 published/append shapes. `session-events.ts` re-exports the existing public names, so
  both the event barrel and `native-agent.ts` import the leaf without an eager Zod cycle.
- `packages/contract/src/events/session-events.ts` — `SESSION_EVENT_VERSION_3 = 3` and max 3;
  standard `agent.queue` v3 inline/artifact envelope; plural `inputArtifactsOf(event)`;
  singleton `inputArtifactOf` keeps prompt/tool-call semantics; display-only
  `queueItemDisplayTextOf`.
- `packages/contract/src/events/inspector.ts` — `exportVersion` 1–3, `SESSION_EXPORT_VERSION_3`,
  export v2 constrained to ≤2 events, export v3 branch, `eventVersion` max 3.
- `packages/contract/src/native-agent.ts` — strict `progressVersion` query (1/2, default 1),
  `AgentProgressV2` with inline/artifact/legacy-preview branches and the exact
  `native_progress_version_unsupported` body. These are definitions only; native routes still
  serve legacy v1 until Q1.
- `packages/server/src/session-log/queue-schema.ts` — independent ledger
  `session_queue_migrations` version 40. Atomic `BEGIN IMMEDIATE` installer; re-reads the ledger
  and trigger, rejects future/unknown/incompatible shapes, preserves the v33 v1/v2/reasoning
  clauses verbatim, adds strict v3 item/metadata checks, and rolls the trigger/ledger change back
  together. It replaces only `session_events_policy_insert`.
- `packages/server/src/session-log/log.ts` — construction installs ledger 40 after global 33; v3
  append descriptors resolved atomically inside the event transaction; published snapshot
  validated before insert; actual `requiredVersion` returned by `read()` and thrown by
  `subscribe()`; v3 read projection with current registry; `AppendOptions.eventVersion` 1/2/3.
- `packages/server/src/session-log/excerpt.ts` — pure `projectQueueV3Data`: per-item
  current-registry projection, exact `excerptBytes`, marker-safe excerpt bound, content-free
  fail-closed for late inline expansion above 16 KiB or rewritten opaque identifiers; no blob IO.
- `packages/server/src/session-log/routes.ts` — max3 REST/SSE, actual required 2/3 in refusals,
  export minimum-version body 1/2/3 and pre-body 406 for a smaller maximum.
- `packages/web/src/features/inspector/*`, `packages/web/src/lib/locale.ts` — inspector requests
  `eventVersion=3`, stream max3 and `exportVersion=3`; one bounded row per queue item, plural
  artifact metadata, tail absent, EN/RU queue labels; no new UI primitive or token.
- `packages/server/src/native-agent/service.ts` — one type/compatibility guard so legacy progress
  ignores seeded v3 queue snapshots. Producer, native routes/plugin/UI and CLI remain v1.
- `packages/server/src/external-agents/service.ts` — type-only explicit `agent.plan` status
  annotation, required because the widened `SessionAppendData` conditional lost contextual
  literal narrowing there. Shared edit; no runtime change.
- New tests: `session-log-queue-v3-contract.test.ts` (9), `session-log-queue-v3-projection.test.ts`
  (5), `session-log-queue-artifacts.test.ts` (18 seeded SQLite/helper/routes/privacy tests),
  `packages/web/test/component/inspector-queue-v3.test.tsx` (4), and one browser queue test in
  `inspector.spec.ts`. Total **37 new test cases** authored; **14 pure cases run and green**,
  23 SQLite/component/browser cases UNRUN by this author.
- READMEs: `packages/server/src/session-log/README.md` and
  `packages/server/src/native-agent/README.md` describe the Q0 state and residuals.

## Regression envelope

Changed compatibility expectations, each documented in the test diff:

- `session-log-version-negotiation.test.ts`: `eventVersion=3` is now valid, so the invalid
  probe is `4`; the max-1 v2 required-2 evidence remains.
- `web/.../inspector.test.tsx` and `inspector-input-artifacts.test.tsx`: export link is
  `exportVersion=3`; incompatible fixtures describe supported 2 / required 3.
- `native-agent/input-artifacts.test.ts`: type narrowing only; the native producer remains v1 and
  its "keeps queued prompts inline" residual still applies.
- `native-agent/migration.test.ts`: the intentional global-31 fixture disables ledger-40
  installation because it predates the v33 artifact table/trigger.
- `external-agents/service.ts`: type-only annotation, no behavior change.

Author did not run the shared heavy envelope. Root/reviewer must run at least the plan command:

```sh
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  node --test packages/server/test/session-log-queue-artifacts.test.ts \
  packages/server/test/session-log-version-negotiation.test.ts \
  packages/server/test/session-log-routes.test.ts \
  packages/server/test/session-log-truncated-egress.test.ts \
  packages/server/test/egress-truncated-prefix.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/native-agent/review.test.ts \
  packages/server/test/native-agent/crash.test.ts \
  packages/cli/test/agent-exec.test.ts
```

The separate `native-agent/queue-artifacts.test.ts` is a Q1 native-consumer file and is not added
by Q0.

Then the full combined-pin gates: source-bound typecheck, lint, `npm test`, browser gate, build,
`lint:md`/links and `check:licenses`, one heavy command at a time. The browser gate is required
because Q0 changes TSX and locale keys.

## Checks run by the author (DSH, pure/scoped only)

- `node -e "console.log(require.resolve('@guanxi/contract'))"` → resolved inside this checkout
  (`.../packages/contract/src/index.ts`); root-installed `npm ci` was already present.
- `nice -n 10 node --test packages/server/test/session-log-queue-v3-contract.test.ts` → 9/9 pass,
  including the cold child import of both public entries and the v33→v40 trigger-clause check.
- `nice -n 10 node --test packages/server/test/session-log-queue-v3-projection.test.ts` → 5/5 pass.
- `nice -n 10 npx tsc --noEmit -p packages/contract/tsconfig.json` → exit 0.
- `nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json` → exit 0 (source and tests).
- `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` → exit 0.
- `nice -n 10 npx tsc --noEmit -p packages/cli/tsconfig.json` → exit 0.
- Scoped `npx eslint` over every changed TS/TSX file → exit 0.
- `nice -n 10 npx markdownlint-cli2 docs/plans/lanes/K4-queue-v3-Q0.handoff.md
  packages/server/src/session-log/README.md packages/server/src/native-agent/README.md` →
  0 errors.
- `nice -n 10 node scripts/check-doc-links.mjs` → 214 files, 693 links, 0 problems.
- No full `lint:md`/license/UI gate was run.

## Checks UNRUN (must not be called green)

- `session-log-queue-artifacts.test.ts` (all 18 seeded SQLite/helper/routes/privacy cases),
  `session-log-version-negotiation.test.ts`, `session-log-routes.test.ts`,
  `session-log-truncated-egress.test.ts`, `egress-truncated-prefix.test.ts`,
  `native-agent/input-artifacts.test.ts`, `native-agent/review.test.ts`,
  `native-agent/crash.test.ts`, `cli/agent-exec.test.ts`.
- Inspector component tests (`inspector-queue-v3.test.tsx`, `inspector.test.tsx`,
  `inspector-input-artifacts.test.tsx`) and the browser inspector spec.
- `npm test`, full `npm run typecheck`, `npm run build`, `npm run lint`, `npm run lint:md`,
  `npm run check:licenses`, `npm run ui:check`, `npm run test:web:browser`.
- No live model, provider, network, container, Docker, SSH, owner data or paid call was used.

## Compatibility

- v1/v2 event and export bodies are unchanged. Both default to version 1 when the query omits a
  version. v2 export bodies reject v3 events explicitly.
- A max-1 reader meeting v2 reports required 2; a max-2 reader meeting v3 reports required 3.
  REST refuses the page without a cursor; SSE emits preceding supported frames, then a
  `guanxi-error` with no event id, and leaves the last valid cursor; export refuses before a
  partial body. No hardcoded required 2 remains in the read/subscribe/route boundary.
- v3 queue is standard `agent.queue` only. Inline items are ≤16 KiB scrubbed UTF-8; artifact
  items are >16 KiB, text/plain UTF-8, exact SHA-256/reference and ≤8 KiB excerpt. Every item is
  projected independently. Queue ids are not rewritable by a late registration.
- Queue FTS remains `NULL`; queue search is not implemented and is asserted absent.
- Native producer, service semantics, plugin, routes, native UI and CLI remain v1. Q0 does not
  advertise progress2 or queue artifactization. Q1/Q2 remain separate clean rounds.
- The inspector now requires a node that accepts `eventVersion=3`/`exportVersion=3`; a max-2
  node is an unsupported mixed-version client pairing for the inspector. The later Q2
  old-POST-202 → progress1-406 → progress2 pairing is not implemented in Q0.
- Global `user_version` stays 33. Migrations 1–33, the `session_input_artifacts` table and
  independent ledgers 34–39 are untouched. Ledger 40 is `session_queue_migrations`.
- Q0 is unreleased and is not a native v3 rollback floor by itself.

## Rollback

Q0 is additive, but it installs an independent trigger replacement and ledger row at
`SessionLog` construction. A rollback of the running node requires a stopped, consistent
pre-upgrade SQLite/WAL backup plus the session-artifact directory backup, with its explicit
boundary: writes accepted after the backup are lost. Never downgrade the trigger or ledger under
a running node, and never restore a pre-Q0 DB over a live data directory.

The pre-change max-2 binary cannot parse stored v3 events and may report `stored_data_invalid`.
Native production is still v1 in Q0, so ordinary native writes remain old-binary-readable, but
any seeded/foreign v3 snapshot is not. There is no down migration; prefer a forward fix. A
rollback to before the compatibility release is not claimed as graceful v3 negotiation.

## Residuals

- Q1 native verified full-byte consumption/progress2/native UI/CLI and Q2 native v3 producer are
  not implemented. Legacy progress1 ignores v3 queue snapshots in the native service until Q1.
- Q1 restricted mutation 409 floor and Q2 old-POST-202→GET-406 pairing are future work.
- Legacy immutable v1 oversized inline snapshots remain; the inspector shows a bounded preview,
  not the full tail. No in-place rewrite or backfill exists.
- No queue FTS search, artifact download/hydration endpoint, per-blob GC, fragment dedupe or
  total-memory/streaming claim. Published orphan blobs remain until session deletion/reaping.
- The real SQLite migration/trigger, helper-backed artifact, REST/SSE, browser, reduced-motion,
  mobile and full-suite results are UNRUN by this author. Independent review is UNRUN.
- Shared edits: `packages/server/src/external-agents/service.ts` (type-only) and the one-line
  legacy-progress guard in `packages/server/src/native-agent/service.ts`; READMEs and test
  compatibility expectations as listed above.

## Next

Root/independent reviewer should inspect the four implementation/test commits plus this handoff,
run the SQLite/helper/native/browser envelope and the combined full gates on the final pin, and
fix findings in separate commits. Do not start Q1/Q2 until this Q0 round closes with those
results. Root updates `PHASE_STATUS`/`NEXT_AGENT_PROMPT` only after integration.
