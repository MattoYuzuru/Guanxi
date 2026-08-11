# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-11

**Назначение:** продолжить Phase 3 bounded slice P3-D — добавить canonical Chat
retention policy, одинаковый 7-day default и sourced activity/expiry projection;
не расширять slice до cleanup/Trash, Session leave detection или reasoning TTL

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
ADR-0005/0007, `plans/PHASE_STATUS.md`, `plans/ROADMAP.md`,
`plans/OPEN_QUESTIONS.md` и accepted owner decisions D-009/D-010/Q-22–Q-24.

Зафиксируй clean starting revision/status и последние commits. P3-C реализован
commits `c3521ed`, `71a48fa`, test hardening `0d01fbe`, review fix `99cc556` и
follow-up test `83dafbc`: **8 new / 573 core**, **4 new / 185 Web**, **1 new /
31 mocked Chromium**. Full typecheck, tests, browser gate, build, markdownlint и
diff-check прошли; independent reviewer дал PASS. Это local/mock evidence, не
production migration, concurrent-client, real mobile/screen-reader или live
Ollama/GPU validation.

## Bounded outcome P3-D

Добавить минимальную retention foundation, одинаковую для Project и projectless
Chat и достаточную для будущего Maintenance/Trash slice:

- canonical policy использует только accepted `Keep | 7 days | Session`;
- любой новый Chat получает `7 days`, включая Chat внутри Project;
- append-only migration начинается поверх v13 и не переписывает migrations
  1–13;
- existing Threads не становятся cleanup-eligible молча: выбери explicit
  compatibility projection, которая сохраняет данные, и зафиксируй её в docs;
- server хранит policy и sourced last user activity; create time является
  initial user-owned basis до первого сообщения;
- rolling 7-day expiry меняется только от принятой user activity. Model, tool,
  maintenance, background event, reload и reconnect не продлевают TTL;
- exact expiry вычисляется server-side из stored basis, возвращается как sourced
  ISO timestamp и не зависит от browser clock/timezone;
- strict versioned contract/store/application/REST boundary не добавляет поля в
  raw legacy Thread responses;
- retention change из Chat Info является одной isolated mutation и одинаково
  работает для projectless и Project Chat;
- UI правдиво различает configured policy/expiry от enforcement: cleanup и Trash
  ещё не реализованы и не должны отображаться как работающие;
- EN source/fallback и curated RU проходят locale keys; keyboard/focus/error/
  retry/mobile states остаются доступны.

До edits инвентаризируй оба Chat create path, Message/Job acceptance transaction,
all Thread list/read/update responses, Project Chat versioned boundary и current
Chat info/settings surfaces. Запиши explicit compatibility strategy для existing
Threads и legacy clients. Не используй Project ownership, Workspace/path, model
events или `updated_at` как замену user activity.

## Non-goals

- удаление данных, Maintenance Job, scheduler, Trash/grace и restore;
- завершение Session при уходе, route/navigation presence или active Job wait;
- reasoning Artifact retention и отделение thinking от final answer;
- Chat delete/archive/search, Project delete или move/reparent;
- Quick Run retention до появления canonical Quick Run persistence;
- Project defaults, Recipe/Artifact/file ownership;
- notification policy, final Chat Info redesign или navigation shell;
- legacy Workspace/Thread API cutover, brand rename, Phase 4 service/CLI/TUI;
- live model/GPU/network calls.

Не называй policy enforcement реализованным: этот slice хранит policy и честно
показывает basis/expiry, а физический cleanup остаётся следующим lifecycle slice.

## Обязательные assertions

Минимум должны падать при нарушении:

- fresh, v13→next, reopen и retry создают retention schema ровно один раз;
- mid-migration failure откатывает schema/data целиком и recovery сохраняет все
  existing Threads/messages/ownership;
- existing Chat compatibility state не делает историю eligible для удаления;
- Project и projectless create получают exact один и тот же `7 days` default;
- default записывается один раз без дополнительного Message/Job/provider call;
- accepted user message сдвигает activity basis/expiry ровно один раз в той же
  durable command boundary; duplicate idempotency key не сдвигает повторно;
- assistant/model/tool/background/maintenance events, reload и reconnect не
  меняют activity basis или expiry;
- `Keep`, `7 days` и `Session` round-trip strict contract/store/API; unknown,
  nested extra/future fields и malformed timestamps отклоняются до mutation;
- retention PATCH меняет только policy/retention timestamp, не ownership,
  Project/Workspace/binding, model/options/messages, Job, settings или runtime;
- projectless и два Project scopes не смешивают policy/activity/expiry;
- raw legacy Thread create/list/read/update bytes остаются literal compatible;
- exact expiry использует stored server timestamp + seven days и одинаков при
  browser timezone/clock drift;
- repeated keyboard/form activation делает одну mutation; failure получает
  focused safe error и явный retry;
- Chat Info показывает current policy, sourced expiry и truthful not-enforced
  state при hard reload, long name, 390 px, 200%, reduced motion/forced colors
  без horizontal overflow;
- retention read/edit не запускает Ollama, Governor, Job, tool, filesystem,
  network provider или analytics side effects.

Сделай mutation checks минимум для migration rollback, Project-vs-projectless
default drift, background-event TTL extension, legacy byte compatibility и
repeated Save. Каждое свойство, заявленное в docs/ROADMAP, должно иметь direct
assertion.

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
default parity, activity semantics, idempotency и Web accessibility. Findings
исправляет автор отдельным `fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: contract/migration/application,
Web/tests, review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real
new/regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; при blocker оставь P3-D
с exact evidence и recovery steps.
