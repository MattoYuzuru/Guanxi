# V1-b handoff — per-project glossary store, revisions and voice marker

**Status:** locally validated on `codex/v1b-glossary-store` (base `c115dc45`).
**V1 is not complete:** this slice adds the glossary sidecar, effective-set service and the
voice-origin marker model. It does not wire a plugin, route, contract, web editor or STT
adapter.

## What exists

- `packages/server/src/voice/store.ts`: `GlossaryStore` over a separate `voice.sqlite` sidecar
  (WAL, `foreign_keys=ON`, frozen `v1_migrations` version 1). `create`, `update`, `deactivate`,
  `reactivate`, `revert`, `history`, `list` and `onChange`. Every mutation is one transaction
  that appends one revision row; validation failure rolls the row and revision back. Validation
  compiles each stored entry alone and every affected effective set. Project canonicals override
  account canonicals for that project; other key collisions are rejected. Entry-scoped account
  mismatches raise typed `GlossaryStoreError` codes.
- `packages/server/src/voice/service.ts`: `GlossaryService.effective` returns project entries
  (`created_at`, `id`), then non-overridden account entries, with revisions attached; `apply`
  returns the V1-a `ReplaceResult`. Compiled glossaries are cached per (account, project) and
  invalidated by committed account or project mutations.
- `packages/server/src/voice/marker.ts`: `VoiceOrigin`, `VoiceConfidenceSpan`,
  `VoiceReplacement`, `validateVoiceOrigin`, `voiceBlock` and `glossaryRevisionHash`. The final
  text is retained only as a non-enumerable in-process symbol so low-confidence fragments can be
  quoted without serialising prompt contents.
- `packages/server/test/voice/glossary-store.test.ts` and `voice-marker.test.ts`: 31 new tests.
- `packages/server/src/voice/README.md`: appended V1-b store/service/marker contract.

## Commands and evidence

- `nice -n 10 node --test packages/server/test/voice/*.test.ts`: `tests 122`, `pass 122`,
  `fail 0` (91 existing V1-a cases + 31 new).
- `nice -n 10 npx tsc --noEmit -p packages/server`: exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/voice/README.md docs/plans/lanes/V1-b.handoff.md`:
  `Summary: 0 error(s)`.
- No `npm test`, browser gate, server or network: this lane runs the targeted envelope only.

## Envelope

- **New:** 31 tests — 18 store/service (migrations, revision chain, reverts, collision rollback,
  overrides, isolation, inactive filtering, cache/invalidation) and 13 marker (validation
  classes, block bound/content/caps, hash stability/sensitivity).
- **Regression envelope:** all `packages/server/test/voice/*.test.ts` (122 tests, including the
  91 V1-a golden/unit cases) plus `tsc -p packages/server`. No broader suite was run.

## Verification

- A separate read-only reviewer sub-agent was started with the five files, ADR-0028 and the two
  runnable checks. It did not return a report in this session, so no independent finding is
  claimed. The author then re-read the diff line by line against the lane contract and re-ran
  both commands with no open finding. Cross-family review remains an integrator duty.
- The four commits are the implementation, not a substitute for cross-family review.

## Judgement calls

- `deactivate`/`reactivate`/`revert` record `source = 'user'`; `update` and `create` take the
  caller's source. Deactivate and reactivate revisions snapshot the entry so the chain is
  self-contained.
- Revert restores the previous revision's entry and its active state; reverting a lone `create`
  deactivates, and repeated reverts toggle the last state.
- Updating an inactive entry is rejected (`entry_inactive`); reactivate first. Deactivating an
  inactive entry or reactivating an active one is also a typed error, not a silent no-op.
- `list(accountId, { projectId })` returns account rows plus that project's rows; without
  `projectId` it returns all of the account's rows.
- Effective entries expose `revision`; the array and entries are frozen because the service
  returns its cached value directly.

## Residuals

- Plugin wiring is absent; no server assembly imports the store, service or marker.
- Routes, contract types and the web glossary editor are absent.
- STT adapters with capability evidence (biasing method, languages, streaming, diarization, max
  duration, audio destination) are absent; so is mapping glossary entries to backend biasing.
- The `voice.flag_term` tool is absent.
- The D-157 per-connection cloud-consent flag is absent.
- The owner's 100–150-recording eval set and the V1 exit gate (term F1 +≥10 points, U-WER +≤1)
  are not measurable in this repository slice.
- The README append supersedes the V1-a-only limits text but the original status line still says
  `V1-a`; the integrator may reconcile it.

V1 remains in progress; this slice is not the V1 exit gate.
