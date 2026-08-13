# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-14

**Назначение:** продолжить Phase 3 bounded slice P3-L — атомарно материализовать
exact immutable Recipe revision в canonical queued Job snapshot, не подключая
adapter execution, automatic routing/model selection или Artifact output

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0002/0005/0008,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decisions.

Зафиксируй clean starting revision/status и latest commits. P3-K завершён как
independently verified slice: migration 22, canonical scoped Recipe identity,
immutable numbered revisions, strict REST и truthful no-execution Web surface.
Review fix `97055f4` закрывает overlong-name persistence before-response failure.
Не выдавай synthetic SQLite, jsdom и mocked Chromium за production, real
device/screen reader или live Ollama/GPU/network validation.

## Orientation gate

До edits составь exact inventory:

- public arbitrary `POST /api/jobs`, `JobStore.create`, initial event и
  idempotency scope;
- private Chat-only `chat_job_inputs`, fingerprint и execution owner;
- P3-K canonical Recipe revision bytes/digest, exact scope и historical read;
- safe public Job/event metadata, startup recovery и queued generic Job cancel;
- accepted Job kind/operation/model snapshot requirements.

Не считай arbitrary public `operation: string` либо private Chat input готовым
Recipe snapshot. Не добавляй Recipe content в safe Job metadata/events и не
переиспользуй Chat association. Если accepted docs не определяют Job kind для
closed Recipe operations, зафиксируй exact blocker/варианты в
`OPEN_QUESTIONS.md`; не изобретай mapping молча. Automatic routing/scoring,
fallback model и capability selection не входят в slice: snapshot сохраняет
explicit model reference либо truthful no-model state из выбранной revision.

## Bounded outcome P3-L

- Добавь append-only migration 23 для immutable one-to-one Recipe Job snapshot,
  связанного restrictive FK с canonical Job, Recipe identity и exact numbered
  revision. Храни snapshot version, exact Recipe scope, operation/model state,
  canonical configuration bytes, byte size/SHA-256 и created timestamp.
- Добавь typed application command, который одной `BEGIN IMMEDIATE` transaction
  создаёт queued Job, initial lifecycle event и snapshot exact выбранной
  revision. Rename/current revise после linearization не меняют snapshot.
- Добавь strict versioned scoped REST create/read boundary. URL/body должны
  явно выбирать exact Recipe revision и UUID idempotency key; unknown/future/
  extra/malformed/cross-scope input отклоняется fail-closed.
- Идемпотентный repeat того же exact intent возвращает тот же Job/snapshot без
  второго event. Concurrent two-connection duplicate сериализуется; conflict
  или injected snapshot failure не оставляет partial Job/event/association.
- Добавь minimal localized Web action из exact current Recipe revision: explicit
  confirmation создаёт только queued Job snapshot и показывает sourced Job ID,
  Recipe revision/provenance и truthful `execution: not_implemented`. Покрой
  loading/error/retry/repeated activation/focus и hard reload/read association.
- Не enqueue-ить Resource Governor, не запускать Ollama/adapter/tool/provider,
  не создавать Artifact/Message/Thread/Quick Run и не изменять current Recipe.
  Existing public Job и Chat command остаются byte/behavior compatible.

## Non-goals

- Recipe execution, worker/adapter dispatch, automatic routing/model selection;
- Job result/Artifact persistence, attachments, schemas, vocabulary/dictionary;
- MCP/Skill/tool grants, integration policy, permissions inheritance;
- Quick Run execution/cleanup или решение Q-37;
- generic public Job API redesign, Chat input migration или Job state changes;
- Project/Workspace deletion, service/CLI/TUI и live provider behavior.

## Обязательные assertions

- migration 23 fresh/v22→v23/reopen/retry/true rollback с exact v22 bytes;
- restrictive immutable Job/Recipe/revision ownership и exact Project/
  projectless scope; snapshot не является Chat input или safe event metadata;
- one transaction даёт ровно один queued Job, sequence-1 lifecycle event и один
  snapshot; injected failure/invalid Recipe оставляет zero rows;
- exact historical canonical bytes/hash/model/operation переживают Recipe
  rename, revise N+1 и hard reload without drift;
- same UUID + exact intent idempotent; concurrent two-connection duplicate даёт
  один Job/event/snapshot; mismatched scope/revision fail-closed;
- strict version/path/body, malformed/extra/future fields и missing/no-model
  projection round-trip без invented fallback;
- Web confirmation/retry/repeated activation/focus/EN fallback/RU, exact
  Job/Recipe/revision/provenance, 390 px/200%, forced colors/reduced motion;
- zero Ollama/Governor/adapter/tool/filesystem/provider/model-unload/Artifact/
  Message/Thread/Quick Run effects и zero automatic transition beyond queued.

Выполни mutation checks минимум для transaction atomicity, exact historical
snapshot, Job/Recipe/revision FK, idempotency/concurrent duplicate, scope,
strict version/privacy и no-execution/no-effect boundary.

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
prompt на следующий bounded slice. Если orientation не подтверждает accepted
Job kind/privacy/idempotency contract, оставь P3-L с exact blocker и recovery
steps, а не расширяй generic Job или execution policy предположениями.
