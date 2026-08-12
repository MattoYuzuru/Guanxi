# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-13

**Назначение:** продолжить Phase 3 bounded slice P3-J — ввести
canonical Quick Run identity/persistence и общую с Chat retention-policy boundary,
не подменяя one-shot work Chat и не закрывая неопределённую Session
completion semantics без owner decision

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0005/0007, `plans/PHASE_STATUS.md`,
`plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted owner decisions.

Зафиксируй clean starting revision/status и latest commits. P3-I завершён
как independently verified slice: migration 20, exact Session metadata deletion,
content-free audit, strict scoped projection и truthful Web. Evidence и residual
limits зафиксированы в `PHASE_STATUS.md`; не выдавай synthetic SQLite,
jsdom и mocked Chromium за production, real device/screen reader или live
Ollama/GPU/network validation.

## Orientation gate и open decision

До edits составь exact inventory current `Thread`/Job/Artifact/retention APIs и
проверь, есть ли accepted ответ на вопрос:

> Какое явное событие заканчивает `Session` для one-shot Quick Run?

D-009/Q-23 определяют explicit Leave для Chat, но не Quick Run. Не считай
Job completion, navigation, reload или export новым Session leave без accepted
decision. Если ответа нет, реализуй только общую identity/policy
foundation с truthful `session_enforcement: not_implemented`, добавь в
`OPEN_QUESTIONS.md` узкий owner question и не создавай automatic deletion path.

## Bounded outcome P3-J

- Добавь append-only migration 21 для minimal canonical Quick Run metadata:
  immutable id, operation, optional Project ownership, timestamps и explicit retention
  policy/source. Не переиспользуй `threads` как скрытый Quick Run type.
- Используй один contract-level `Keep | 7 days | Session` policy shape и
  один default `7 days` для projectless/Project Quick Run. Не делай
  type-changing `Save`; policy меняется isolated mutation.
- Добавь strict versioned create/read/list/update boundary с exact Project или
  projectless scope. Project не требует filesystem binding; cross-scope и
  future/malformed input fail closed.
- Сохранить operation как typed allowlist из уже accepted product model;
  не создавать по одной таблице/странице на modality.
- Добавь minimal Web Quick Run surface для create/list и retention control
  только если он не обещает ещё не реализованное execution. Явно
  показывай ready/empty/error и effective retention source/state.
- Не запускать Ollama/Job из metadata/retention routes. Любой будущий
  Quick Run execution должен использовать canonical durable Job, но это
  отдельный slice.

## Non-goals

- Quick Run model execution, streaming, Artifact media/blob storage и export;
- invented Session completion/leave, TTL/Session cleanup для Quick Run;
- Recipe snapshots, attachments, document batch, audio/image/OCR flows;
- Chat schema/lifecycle или P3-I deletion semantics;
- Project/Workspace deletion, service/CLI/TUI и live provider behavior.

## Обязательные assertions

- migration 21 fresh/v20→v21/reopen/retry/true rollback с exact v20 bytes;
- Quick Run не `Thread`, а Project ownership immutable/restrictive и projectless
  не смешивается с Project scope;
- default `7 days` одинаков, Keep/TTL/Session round-trip strict, unknown/
  future/extra fields отклоняются;
- retention update делает ровно одну mutation и не меняет identity,
  operation, Project, Job, Artifact или filesystem state;
- нет `Save` conversion и нет optimistic execution/cleanup claim;
- Web loading/empty/error/retry, exact scope/count, keyboard/focus, EN fallback/RU,
  390 px/200%, forced colors и reduced motion имеют direct assertions;
- zero Ollama/Governor/tool/filesystem/provider/network/model-unload effects.

Выполни mutation checks минимум для default, scope, Project FK,
one-mutation update, strict version, no-Save UI и no-effect boundary.

## Gates и handoff

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

После implementation запусти отдельную read-only independent verification
по `plans/WORKFLOW.md`; findings исправляет автор отдельным commit.
Обнови current-state docs, `PHASE_STATUS.md` с new/regression envelope и
перепиши этот prompt на следующий bounded slice. Если orientation gate
блокирует более узкую foundation, оставь P3-J с exact blocker и
recovery steps, а не изобретай owner decision.
