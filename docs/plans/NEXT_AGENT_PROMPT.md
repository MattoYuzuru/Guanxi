# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-11

**Назначение:** продолжить Phase 3 bounded slice P3-E — применить rolling TTL
через bounded Maintenance и recoverable Trash; не расширять slice до hard
deletion/blob GC, Session leave detection или reasoning Artifact retention

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0005/0007,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decisions D-009/D-010/Q-22–Q-24.

Зафиксируй clean starting revision/status и последние commits. P3-D реализован
commits `c9913c8`, `5c6670b`, review fix `cc41001`: **7 new / 580 core**, **6 new
/ 191 Web**, **1 new / 32 mocked Chromium**. Full typecheck, tests, browser gate,
build, markdownlint и diff-check прошли; independent reviewer после review-fix
дал PASS. Это local/mock evidence, не production migration corpus,
concurrent-client, real screen-reader/device или live Ollama/GPU validation.

## Bounded outcome P3-E

Добавить recoverable enforcement только для уже canonical `7 days` Chat policy:

- append-only migration начинается поверх v14 и не переписывает migrations
  1–14;
- server хранит explicit `active | trash` lifecycle, sourced tombstone time и
  reason; существующие rows остаются `active`;
- expired TTL определяется только из stored server activity basis + exact seven
  days, без browser clock, `updated_at`, model/tool/background events или
  Project/Workspace inference;
- один server-owned Maintenance owner при startup и периодически обрабатывает
  stable bounded batches; повторный запуск идемпотентен и не создаёт второй
  scheduler/owner;
- active/non-terminal Chat Job блокирует tombstone; terminal state разрешает
  следующий pass;
- eligible TTL Chat атомарно переводится в Trash, но metadata, Messages, Jobs,
  Artifacts и blobs физически не удаляются в этом slice;
- Chat в Trash исчезает из active projectless/Project lists и появляется в
  versioned sourced Trash boundary без cross-Project leakage;
- explicit Restore возвращает Chat в active state и задаёт новый rolling basis
  только как user-owned restore action; изменение policy на Keep/7 days до hard
  deletion также восстанавливает record;
- Keep и Session не выбираются TTL maintenance. Session остаётся configured, но
  не enforced до отдельного leave/presence slice;
- UI показывает bounded Trash list, exact reason/time, Restore loading/error/
  retry и truthful `hard deletion not implemented` state;
- raw legacy Thread payload shape остаётся byte-compatible; additive lifecycle
  доступен только через versioned boundaries;
- EN source/fallback и curated RU проходят locale keys; keyboard/focus/mobile/
  200%/forced-colors/reduced-motion states доступны.

До edits инвентаризируй startup recovery order, application context ownership,
JobStore non-terminal query, все active Chat list/read paths и shutdown/timer
cleanup. Зафиксируй clock injection, batch/cursor semantics и visibility policy.
Не вводи произвольную Trash grace для TTL: accepted 24 часа относятся к Session,
а hard deletion в этом slice отсутствует.

## Non-goals

- hard deletion metadata, Message/Job removal, blob reference GC и disk reclaim;
- TTL Trash grace duration без отдельного принятого решения;
- Session leave/presence detection и 24-hour Session recovery countdown;
- reasoning Artifact retention или отделение thinking от final answer;
- Quick Run retention до canonical Quick Run persistence;
- manual Chat delete/archive/search, Project delete или move/reparent;
- Project defaults, Recipe/Artifact/file ownership и notification policy;
- final navigation shell, legacy Workspace/Thread API cutover, brand rename;
- Phase 4 service/CLI/TUI и live model/GPU/network calls.

Не называй hard cleanup реализованным: P3-E только делает expired TTL Chat
recoverably tombstoned и видимым в Trash.

## Обязательные assertions

Минимум должны падать при нарушении:

- fresh, v14→next, reopen и retry создают lifecycle schema ровно один раз;
- mid-migration failure откатывает schema/data, а recovery сохраняет exact
  Threads/messages/Projects/bindings/retention payload;
- existing rows остаются active; Keep/Session и unexpired TTL не попадают в
  eligibility query;
- boundary case `expiry == now` определён явно и одинаков для Project/
  projectless Chat;
- maintenance использует injected server clock, stable bounded batch/cursor и
  convergence без duplicate tombstone/audit effects;
- startup и periodic trigger используют одного owner; close очищает timer и не
  оставляет post-close pass;
- non-terminal Job каждого canonical active state блокирует tombstone; terminal
  Job разрешает его на следующем pass;
- tombstone transaction не изменяет activity basis/policy, ownership,
  Workspace/binding, Messages, Jobs/events/inputs, tools, settings или provider;
- injected failure откатывает lifecycle/audit целиком, а retry сходится один раз;
- active lists исключают Trash exact count/order, Trash boundary включает его
  ровно один раз и не смешивает два Project scope;
- Restore атомарно возвращает active, сдвигает basis/expiry один раз и не
  создаёт Message/Job/provider work; repeated activation даёт одну mutation;
- policy change из Trash на Keep/7 days восстанавливает Chat, а malformed/future
  request ничего не меняет;
- raw legacy create/list/read/update JSON shape остаётся literal compatible;
- hard reload восстанавливает active/Trash projection; UI показывает exact
  sourced time/reason и честно говорит, что hard deletion не реализовано;
- failure получает focused safe error и explicit retry; long title, 390 px,
  200%, keyboard, forced colors и reduced motion не дают horizontal overflow;
- maintenance/read/restore не запускают Ollama, Governor, tool, filesystem,
  network provider, analytics или hard-delete side effects.

Сделай mutation checks минимум для migration rollback, Keep/Session leakage,
active-Job guard, batch bound, active-list duplicate/leakage, Restore repeated
activation и legacy bytes. Каждое свойство, заявленное в docs/ROADMAP, должно
иметь direct assertion.

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
`plans/WORKFLOW.md`: reviewer проверяет exact diff, migration/rollback,
eligibility boundary, single-owner scheduler, active-Job guard, Trash isolation,
restore/idempotency, legacy compatibility и Web accessibility. Findings
исправляет автор отдельным `fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: contract/migration/application,
Web/tests, review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real
new/regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; при blocker оставь P3-E
с exact evidence и recovery steps.
