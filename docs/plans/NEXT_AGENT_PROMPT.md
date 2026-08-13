# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-14

**Назначение:** продолжить Phase 3 bounded slice P3-M — заменить destructive
Chat compaction на видимый non-destructive context checkpoint, сохраняя исходные
Messages byte-exact и не расширяясь в generic Artifact/blob foundation

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0002/0005, `plans/PHASE_STATUS.md`,
`plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted owner decisions.

Зафиксируй clean starting revision/status и latest commits. P3-L завершён как
independently verified slice: migration 23, exact immutable Recipe revision →
queued Job snapshot, strict REST и confirmed Web read/reload. Review fixes
`2401db1`/`10f8cb9` закрывают raw-SQL guard, no-model, English/layout и visible
focus assertion gaps. Не выдавай synthetic SQLite/jsdom/mocked Chromium за
production, real assistive technology или live Ollama/GPU/network validation.

## Критический defect и orientation gate

`WORK-007` требует, чтобы context compaction создавала видимый checkpoint/
summary и не стирала исходную историю. Текущий
`ThreadStore.replaceWithSummary` сначала выполняет
`DELETE FROM messages ... seq <= upToSeq`; `store.test.ts` и repeated-compaction
tests закрепляют это противоположное поведение. Это P0 correctness gap, а не
косметический feature.

До edits составь exact inventory:

- migration 1 `messages`, unique `(thread_id, seq)`, Message/Job/reasoning/tool
  ownership и delete cascades;
- `compactionCandidates`, `replaceWithSummary`, route `/compact`, Governor
  admission, abort/failure handling и repeated compaction;
- `runTurn` history projection, reusable-prefix/KV explanation и context token
  calculation;
- Thread/Project Chat GET contracts, `useChat` reload и `MessageView` legacy
  `isCompaction` projection;
- legacy databases, где source rows уже были удалены: их нельзя восстановить или
  описать как preserved.

Не решай defect копированием source rows с последующим DELETE: original Message
identity, reasoning Artifact, Chat Job association и tool journal должны
остаться на месте. Generic Artifact/blob store — следующий отдельный slice.

## Bounded outcome P3-M

- Добавь append-only migration 24 для immutable versioned
  `context_checkpoints`: checkpoint ID, exact Thread, monotonically advanced
  source boundary `up_to_seq`, optional previous checkpoint link/version,
  summary UTF-8 bytes/hash/size, source count, created timestamp и explicit
  legacy/source-preservation state. Новые canonical checkpoints всегда
  `source_preserved`; legacy summary Messages могут быть отражены только как
  `legacy_source_unavailable`, без invented source history.
- Замени destructive write на одну `BEGIN IMMEDIATE` transaction, которая
  revalidate-ит Thread, exact existing boundary и expected previous checkpoint,
  затем вставляет checkpoint. Она не UPDATE/DELETE-ит `messages`, reasoning,
  Jobs/events, Chat inputs или tool runs. Empty/malformed/stale/injected failure
  оставляет zero checkpoint rows и все source bytes без изменений.
- Раздели **stored history** и **active model context**. Public Chat history
  возвращает все original Messages в исходном порядке плюс отдельную typed
  checkpoint projection. Следующий Ollama turn получает только latest summary
  как system context + original Messages после boundary; source history до
  boundary не отправляется модели повторно. Context token projection считается
  по active context, не по всей сохранённой истории.
- Repeated compaction использует latest checkpoint summary + новый tail,
  продвигает boundary по persisted `messages.seq`, не суммирует старые original
  rows заново и не создаёт duplicate/stale checkpoint при two-connection race.
- Добавь strict read projection к legacy и nested Project Chat GET без удаления
  или переименования existing fields. Unknown/future/corrupt checkpoint fail-
  closed; projectless/Project history не смешивается.
- Обнови localized Chat timeline/Context surface: видимый checkpoint marker с
  summary, boundary/source count/time и truthful distinction «история сохранена,
  active context использует summary». Original Messages остаются доступны после
  compaction и hard reload. Все новые strings идут через locale keys.
- Сохрани Governor contract: планирование только после admission, one lease,
  abort/provider/persistence failure освобождает lease. Не добавляй durable Job,
  background execution, provider retry, filesystem/blob или cleanup effects.

## Non-goals

- generic Artifact metadata/content-addressed blob store, attachments/export;
- Recipe/Quick Run execution, routing или retention cleanup;
- Agent Run checkpoint/resume и durable Maintenance Job;
- восстановление уже удалённых pre-v24 source Messages;
- изменение Message IDs/seq, Job/Reasoning lifecycle, Retention/Trash semantics;
- automatic compaction policy, hidden thresholds, new context ceilings;
- live Ollama/GPU/network либо multi-process deployment guarantee.

## Обязательные assertions

- migration 24 fresh/v23→v24/reopen/retry/true rollback с exact v23 bytes и
  honest legacy-source-unavailable projection;
- после canonical compaction every original `messages` row (включая IDs, seq,
  roles, content, thinking/tool/usage/terminal/job fields), reasoning Artifact,
  Job/input/event и tool journal byte-exact сохранён; ни один count не уменьшен;
- checkpoint immutable/restrictive, exact boundary существует в том же Thread,
  source count/hash/size exact; wrong Thread/boundary/previous/stale/corrupt row
  fail-closed;
- injected insert failure и provider empty/error/abort дают zero partial
  checkpoints, unchanged history и released Governor lease;
- repeated checkpoint input = previous summary + only new original tail;
  boundary monotonic, unique и based on persisted seq; true two-connection stale
  race даёт один winner без duplicate;
- next turn request содержит latest summary ровно один раз, не содержит original
  pre-boundary content и сохраняет ordered post-boundary tail; public GET/UI
  одновременно содержит original pre-boundary history и visible checkpoint;
- hard reload, nested Project scope, legacy compaction row, reasoning/final
  answer separation и Chat retention/Trash regressions;
- Web loading/error/retry/focus, English fallback/curated Russian, no duplicate
  checkpoint marker, keyboard, 390 px/200%, forced colors и reduced motion;
- zero new Job/Ollama call beyond the explicit summarization already requested,
  zero tool/filesystem/provider-unload/Artifact/Quick Run/Recipe effects.

Выполни mutation checks минимум для source DELETE, active-context filtering,
checkpoint immutability/boundary, repeated-summary uniqueness, transaction
rollback, legacy truth, public history presence и visible Web marker count.

## Gates и handoff

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

После implementation запусти отдельную read-only independent verification по
`plans/WORKFLOW.md`; findings исправляет автор отдельным commit. Обнови
current-state docs, `PHASE_STATUS.md` с new/regression envelope и перепиши этот
prompt на следующий bounded slice. Если migration 24 не может честно отделить
legacy loss от new preservation либо active context от stored history, оставь
P3-M blocked с exact conflict/recovery steps — не скрывай DELETE за новой
терминологией.
