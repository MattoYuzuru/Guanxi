# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-13

**Назначение:** продолжить Phase 3 bounded slice P3-K — ввести canonical Recipe
identity и immutable revision snapshots, не подключая execution/routing и не
расширяя scope до attachments, vocabulary или integration policy

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0005/0007/0008,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decisions.

Зафиксируй clean starting revision/status и latest commits. P3-J завершён как
independently verified slice: migration 21, canonical Project/projectless Quick
Run metadata, shared retention policy и truthful no-execution Web surface.
Q-37 блокирует только Quick Run Session enforcement, не Recipe foundation.
Не выдавай synthetic SQLite, jsdom и mocked Chromium за production, real
device/screen reader или live Ollama/GPU/network validation.

## Orientation gate

До edits составь exact inventory current Job command snapshot, operation/model
contract, Project ownership и retention types. Отдели три понятия:

- mutable Recipe identity/presentation metadata;
- immutable numbered Recipe revision с canonical configuration bytes;
- будущий Job snapshot/reference.

Не считай существующий arbitrary Job `input` готовым Recipe snapshot без typed
contract и provenance. Если accepted docs не определяют конкретный routing policy
shape, сохрани strict minimal `operation` + explicit model reference boundary и
пометь advanced routing как `not_implemented`; не изобретай scoring/auto-select.

## Bounded outcome P3-K

- Добавь append-only migration 22 для canonical Recipe identity и immutable
  revisions: id, optional Project ownership, name, timestamps, revision number,
  typed operation, explicit model reference либо truthful no-model state,
  instructions/default parameters и retention policy snapshot.
- Project ownership identity immutable/restrictive; projectless и Project scope
  разделены. Project по-прежнему не требует filesystem binding.
- Create записывает identity и revision 1 атомарно. Edit создаёт revision N+1,
  не переписывая старую revision; concurrent expected-revision conflict
  fail-closed. Rename presentation metadata не меняет configuration revision.
- Добавь strict versioned create/list/read/revise boundary и read exact historical
  revision. Unknown operation, future version, malformed/extra fields и
  cross-scope access отклоняются.
- Добавь minimal localized Web Recipes surface: scoped loading/empty/error/retry,
  create, current revision view и explicit revise action с conflict handling.
  Покажи revision/provenance; не обещай execution, routing или Job attachment.
- Не запускай Ollama/Job и не меняй existing Job schema в этом slice. Следующий
  slice может материализовать exact Recipe revision в canonical Job snapshot и
  добавить routing после отдельной inventory/decision проверки.

## Non-goals

- Recipe execution, automatic routing/model selection и Job snapshot wiring;
- Quick Run execution/cleanup или решение Q-37;
- attachments, vocabulary/dictionary, schemas, MCP/Skill/tool grants;
- Artifact/blob storage, export, document/audio/image/OCR flows;
- Project/Workspace deletion, service/CLI/TUI и live provider behavior.

## Обязательные assertions

- migration 22 fresh/v21→v22/reopen/retry/true rollback с exact v21 bytes;
- identity/project ownership immutable и restrictive, exact projectless/Project
  scope, Recipe не Thread и не Quick Run;
- create атомарно даёт ровно revision 1; revise даёт ровно N+1, stale expected
  revision проигрывает без partial row, historical bytes остаются exact;
- rename не создаёт revision, revise не меняет identity/Project;
- strict version/operation/model/defaults/retention round-trip и fail-closed
  unknown/future/extra fields;
- Web loading/empty/error/retry/conflict, exact scope/count/revision, keyboard/
  focus, EN fallback/RU, 390 px/200%, forced colors и reduced motion;
- zero Ollama/Governor/tool/filesystem/provider/network/model-unload/Job effects.

Выполни mutation checks минимум для atomic revision 1, immutable history,
expected-revision CAS, Project FK/scope, rename-vs-revise, strict version и
no-effect boundary.

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
prompt на следующий bounded slice. Если orientation обнаружит действительно
неопределимый minimal revision contract, оставь P3-K с exact blocker и recovery
steps, а не изобретай owner decision.
