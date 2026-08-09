# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-10

**Назначение:** продолжить Phase 3 bounded slice P3-B — Project presentation
metadata и accessible built-in picker; не расширять slice до Project ownership,
retention или всей navigation shell

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
ADR-0005/0007, `plans/PHASE_STATUS.md`, `plans/ROADMAP.md`,
`plans/OPEN_QUESTIONS.md` и accepted owner decisions D-008/D-019/Q-32.

Зафиксируй clean starting revision/status и последние commits. P3-A реализован
commits `0e00ee3`, `6f68501`, review fix `ba63ff4`: **12 new / 558 core**, **4
new / 177 Web**, **1 new / 29 mocked Chromium**. Full gates прошли; independent
review после трёх исправлений дал PASS. Это local/mock evidence, не production
migration, real mobile или screen-reader validation.

## Bounded outcome P3-B

Добавить Project presentation metadata, принятую в D-008/Q-32:

- `iconKey` из одной встроенной однородной icon library;
- `colorToken` только из versioned accessible palette;
- оба поля редактируемы и не влияют на Project ID, binding, routing или
  permissions;
- migration append-only поверх v10 с deterministic defaults/backfill;
- strict additive contract/store/service/REST и текущая `/projects` Web
  projection;
- compact picker с search/categories, bounded grid/page и keyboard navigation;
- English source/fallback и curated Russian locale keys;
- старые Project clients, legacy Workspace API/data и no-path Project behavior
  остаются compatibility-safe.

До edits инвентаризируй существующие icon dependencies/assets/tokens. Не добавляй
произвольную коллекцию либо цветовые значения: зафиксируй versioned manifest с
stable keys, accessible names и documented license/source. Если подходящего
allowlisted asset source в repository нет, проведи bounded primary-source
research и сохрани evidence; не копируй случайные SVG из Web.

## Non-goals

- custom SVG/image upload, arbitrary icon URL и user-provided color;
- Project defaults, Chats/Recipes/Artifacts/files/vocabulary/permissions;
- filesystem binding editor, additional roots и Agent tool scope;
- Chat reparent/move, retention/Trash/reasoning TTL и maintenance Jobs;
- target navigation-shell redesign, final Project overview или card polish;
- удаление/rename legacy Workspace API/table/path/localStorage;
- brand rename, Phase 4 service/CLI/TUI и live Ollama/hardware changes.

## Обязательные assertions

Минимум должны падать при нарушении:

- fresh, v10→v11, reopen и retry сохраняют deterministic default icon/color и
  не дублируют Project/binding;
- migration failure откатывает schema/data целиком и повторный startup
  восстанавливается;
- invalid/unknown/future icon key, color token, extra field и oversized input
  отклоняются до DB mutation;
- edit меняет только presentation metadata/`updatedAt`, но не ID/name,
  Workspace path/binding, threads, Jobs или permissions;
- Project без filesystem binding получает и меняет icon/color;
- legacy/current Project response compatibility следует явной additive/versioned
  strategy; старый Workspace raw JSON остаётся literal byte-compatible;
- manifest keys уникальны и stable, palette tokens имеют подтверждённый contrast
  в light/dark themes, icons имеют accessible names EN/RU;
- picker search/category/page использует bounded DOM и один canonical manifest;
- Arrow/Home/End/Page navigation, Enter/Space selection, Escape/close, initial/
  return focus и screen-reader name/state проверены;
- loading/empty/error/retry, long names, 390 px, 200%, reduced motion и
  forced-colors не создают horizontal document overflow;
- repeated Save/keyboard activation создаёт одну mutation;
- read/edit не запускают Ollama, Governor, Job, tool, filesystem/network provider
  или analytics side effects.

Сделай mutation checks минимум для migration rollback, unknown manifest key,
presentation-vs-identity separation, legacy compatibility и repeated activation.
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
screen-reader, production palette audit или user validation.

## Workflow и handoff

После implementation запусти отдельную read-only independent verification по
`plans/WORKFLOW.md`: migration/contract и Web/a11y reviewers проверяют точный
diff и заявленные properties. Findings исправляет автор отдельным
`fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: manifest/contract/migration, Web/tests,
review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real
new/regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; при blocker оставь P3-B
с exact evidence и recovery steps.
