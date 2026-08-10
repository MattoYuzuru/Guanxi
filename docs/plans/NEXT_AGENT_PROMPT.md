# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-10

**Назначение:** продолжить Phase 3 bounded slice P3-C — связать Chat с logical
Project и показать Project grouping; не расширять slice до retention/Trash,
Project deletion или navigation-shell redesign

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
ADR-0005/0007, `plans/PHASE_STATUS.md`, `plans/ROADMAP.md`,
`plans/OPEN_QUESTIONS.md` и accepted owner decisions D-008/D-009/Q-22.

Зафиксируй clean starting revision/status и последние commits. P3-B реализован
commits `b8eec80`, `6557c86`, test hardening `29e75ba`, review fixes `4ab7a6a`
и `794fc64`: **7 new / 565 core**, **4 new / 181 Web**, **1 new / 30 mocked
Chromium**. Full gates прошли; independent review закрыл все findings и дал
PASS. Это local/mock evidence, не production migration, concurrent-client,
real mobile или screen-reader validation.

## Bounded outcome P3-C

Добавить минимальную persistent ownership-связь `Project → Chat`, необходимую
для WORK-003/WORK-006 и будущей проверки единого retention default:

- Chat может быть projectless либо принадлежать ровно одному logical Project;
- existing Threads остаются projectless, migration append-only поверх v11;
- Project Chat создаётся из явного Project context и остаётся обычным Chat с тем
  же durable Message/Job lifecycle;
- ownership не выводится из Workspace/path и не создаёт filesystem binding;
- association неизменяема в этом slice: move/reparent отсутствует, а не
  маскируется под rename/update;
- strict contract/store/application/REST и Web projection используют одну
  canonical ownership boundary;
- Project UI показывает bounded Chat group и явный `New Chat` flow; Chat UI
  правдиво показывает Project context и сохраняет его при create/redirect/reload;
- legacy projectless Thread REST bytes и current Chat execution остаются
  compatibility-safe.

До edits инвентаризируй Thread create/list/read/update paths, Chat route query/
redirect state, Project service и v1–v11 migrations. Запиши явную additive или
versioned response strategy: не добавляй поле в strict legacy output молча.
Project deletion ещё не реализован, поэтому не придумывай cascade/orphan UX;
выбери restrictive schema behavior и зафиксируй deferred deletion decision.

## Non-goals

- Chat move/reparent, bulk assignment, cross-Project drag-and-drop;
- Project deletion, archive, Trash и orphan recovery;
- Keep/7 days/Session, rolling TTL, maintenance cleanup и reasoning retention;
- Project defaults для model/context/Recipe/permissions;
- автоматическое наследование Workspace, filesystem roots, tools/MCP/Skills;
- Agent Run/Recipe/Artifact/file/vocabulary ownership;
- final Project overview, global Chat search или navigation-shell redesign;
- удаление/rename legacy Workspace API/table/path/localStorage;
- brand rename, Phase 4 service/CLI/TUI и live Ollama/hardware changes.

## Обязательные assertions

Минимум должны падать при нарушении:

- fresh, v11→v12, reopen и retry сохраняют nullable ownership без duplicate
  Project/Chat/binding и без переписывания existing Threads;
- mid-migration failure откатывает schema/data целиком, повторный startup
  восстанавливается, invalid Project reference не записывается;
- projectless legacy create/list/read/update raw JSON остаются по выбранной
  explicit compatibility strategy;
- Project Chat create связывает exact Project и Chat один раз; repeated keyboard/
  form activation не создаёт второй Thread, Message или Job;
- missing/malformed Project ID, extra/future fields и attempt reparent
  отклоняются до mutation;
- association не меняет Project identity/presentation, Workspace row/path/
  binding, Chat model/options/messages, Jobs, permissions или settings;
- Project без filesystem binding создаёт и читает Chat; `workspaceId` остаётся
  `null`, пока пользователь отдельно не выбрал разрешённый filesystem scope;
- projectless и два разных Project scopes не смешиваются; list order/count/
  empty state проверены exact assertions, не только visibility;
- Project list/read association не запускает Ollama, Governor, Job, tool,
  filesystem/network provider или analytics side effects;
- create использует существующий model/context validation ровно один раз и не
  меняет durable Chat/Job semantics;
- Project `New Chat` keyboard flow, initial/return focus, error/retry, long names,
  390 px, 200%, reduced motion и forced-colors не создают horizontal overflow;
- hard reload exact Project Chat route восстанавливает sourced ownership, а
  stale/deleted/mismatched Project reference показывает typed safe state, не
  угадывает ownership.

Сделай mutation checks минимум для migration rollback, cross-Project leakage,
ownership-vs-filesystem separation, legacy compatibility и repeated activation.
Каждое свойство, заявленное в docs/ROADMAP, должно иметь direct assertion.

## Gates

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Browser gate обязателен. Не выдавай jsdom/Chromium fixtures за real device,
screen-reader, production migration corpus или user validation.

## Workflow и handoff

После implementation запусти отдельную read-only independent verification по
`plans/WORKFLOW.md`: reviewer проверяет exact diff, migration/compatibility,
ownership isolation, idempotency и Web accessibility. Findings исправляет автор
отдельным `fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: contract/migration/application, Web/tests,
review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real new/
regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; при blocker оставь P3-C
с exact evidence и recovery steps.
