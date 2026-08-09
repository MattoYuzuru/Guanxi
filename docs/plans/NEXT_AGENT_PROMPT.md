# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-09

**Назначение:** начать Phase 3 bounded slice P3-A — logical Project identity и
additive Workspace compatibility bridge; не расширять slice до всей Phase 3

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0001/0004/0005/0007,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decisions D-008/D-019.

Зафиксируй clean starting revision/status и последние commits. Phase 2 exit
закрыт mocked/local evidence: **0 new test cases + 2 strengthened direct
assertions / 546 core regression envelope**, **0 new / 173 Web envelope**,
**0 new / 28 mocked Chromium envelope**. `aaaf7b7` добавляет прямые assertions
для Installed/Marketplace separation и полного HF staged-source provenance;
обе assertions проверены failing mutation. Final independent review — PASS.
Это не live Ollama/GPU, production provider или deployment validation.

Release audit также исправил ложный blocker: accepted Marketplace fit остаётся
claimed-size preview, а exact calibration — отдельное installed/runtime
evidence. Ни один Phase 2 exit bullet не требует объединённого fit. Не возвращай
этот вопрос как blocker без нового owner requirement/ADR.

## Bounded outcome P3-A

Ввести Project как логический контейнер, который может существовать без
filesystem root, и сохранить compatibility текущего Workspace API/data. Slice
должен быть vertical: additive contract + append-only migration/store/service +
REST + минимальная Web projection + failure/migration tests + current docs.

До edits сопоставь текущие `Workspace` schemas/routes/store/UI и accepted target.
Если существующая identity допускает безопасный one-to-one bridge, сохрани ID и
создай additive Project/binding rows без удаления либо переименования старых
tables, public routes, localStorage keys и paths. Если identity неоднозначна,
оставь exact migration blocker вместо guessing.

Минимальные свойства:

- Project имеет stable ID, editable non-empty name и timestamps;
- Project создаётся без filesystem binding;
- legacy Workspace может быть связан с Project как optional filesystem binding,
  но path не становится Project identity;
- reopen/restart сохраняет Project и связь;
- повторный migration/backfill идемпотентен и не дублирует Project/binding;
- broken/duplicate legacy rows fail controlled и rollback transaction целиком;
- legacy Workspace REST/client остаётся byte-compatible по текущему contract;
- server владеет SQLite/filesystem boundary; Web не читает их напрямую;
- Project UI имеет loading/empty/error/retry, keyboard/focus, 390 px, 200% и
  reduced-motion assertions;
- новые strings идут через English source/fallback и curated Russian locale keys.

## Non-goals

- icon library, color palette и final Project picker polish — отдельный P3 slice;
- Recipe/Artifact persistence, attachment blobs и Project vocabulary;
- Chat reparent/move, retention/Trash/reasoning TTL и maintenance Jobs;
- filesystem tools/allowed roots, MCP/Skills и Agent permissions;
- target navigation shell redesign;
- удаление/rename legacy Workspace API, table, package, path или localStorage;
- Phase 4 service/CLI/TUI и любые live Ollama/hardware changes.

## Обязательные assertions

Минимум должны падать при нарушении:

- logical Project создаётся и читается без path/binding;
- exact legacy Workspace получает ровно один Project и ровно одну binding row;
- fresh DB, upgrade DB, reopen и повторный migration дают одинаковую projection;
- injected mid-migration failure оставляет предыдущую schema/data без partial
  Project rows, а повторный startup восстанавливается;
- два Workspace с distinct identity не сливаются по name/path normalization;
- старые Workspace REST responses и current Web flow не меняются;
- invalid/empty/oversized input отклоняется до DB mutation;
- rename меняет только Project metadata и не переписывает Workspace path;
- Project-less legacy fixture остаётся читаемым через compatibility boundary;
- UI различает loading/empty/error и не создаёт Project повторным activation;
- никакой Project read/create не запускает Ollama, Governor, Job, tool, network
  provider или filesystem mutation.

Сделай mutation checks минимум для duplicate backfill, Project-without-path,
transaction rollback и legacy response compatibility. Каждое свойство, заявленное
в docs/ROADMAP, должно иметь direct assertion.

## Gates

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Browser gate обязателен, если P3-A меняет Web. Не выдавай mocked SQLite/Web
fixtures за production migration validation.

## Workflow и handoff

После implementation запусти отдельную read-only independent verification по
`plans/WORKFLOW.md`: migration/contract reviewer и Web/a11y reviewer проверяют
точный diff и заявленные properties. Findings исправляет автор отдельным
`fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: contract/migration/server, Web/tests,
review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real
new/regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; если migration semantics
заблокированы, оставь P3-A с exact blocker и recovery steps.
