# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-02
**Назначение:** Phase 1, slice P1-A — Durable Job/event-store foundation

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
Начни Phase 1, но реализуй только slice
`P1-A Durable Job/event-store foundation`.

Phase 0 независимо проверена следующими commits:

- P0-A: `f038b5c`, `d05a906`;
- P0-B: `c673227`, `21115c5`, `ad6c2b4`, `7721ca0`;
- P0-C: `0ca72d8`, `7a626f6`;
- P0-D: `edf737d`, `5454fc7`;
- P0-E: `55b8048`, `b2b3088`.

Не откатывай Error Boundaries, deterministic Web harness, SQLite migration 3,
Message terminal CAS, truthful Chat projection, process-local exclusive
inference bridge, persisted-seq compaction fix, sourced runtime health и
provider timeout semantics.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1 и её exit gate в
   `docs/plans/ROADMAP.md`, `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD,
   `docs/DOMAIN_MODEL.md`, `docs/TESTING.md`, accepted ADR-0001/0002/0004 и
   `docs/plans/OPEN_QUESTIONS.md`.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй:
   - `sde-agent:implementation-planning` и `sde-agent:sde-agent` как owner;
   - `architecture-agent:architecture-agent` для границ contract/store;
   - `architecture-agent:architecture-migration` для forward-only migration;
   - `sre-agent:verification-strategy` для Job/event state matrix;
   - `sre-agent:reliability-testing` для transaction/race/failure envelope;
   - `sre-agent:finding-validation` и `sde-agent:implementation-evidence` для
     независимой проверки.
4. До правок воспроизведи current state: migrations заканчиваются на версии 3,
   durable `jobs`/`job_events` отсутствуют, а текущий Chat POST/SSE принадлежит
   соединению. Зафиксируй baseline P0-C/P0-D/P0-E tests.
5. До schema/API правок составь bounded plan с state transitions, idempotency
   scope, transaction boundaries, event sequence ownership, compatibility,
   migration/recovery tests и точными validation commands.

Scope P1-A:

- определить additive contract для durable Job record, Job state и persisted
  event envelope по ADR-0004 и Runtime Lifecycle;
- не придумывать альтернативные state names или terminal semantics без
  отдельного ADR;
- добавить только forward-only SQLite migration 4 для `jobs` и `job_events`;
- обеспечить scoped idempotency: один idempotency key создаёт одну Job, а
  повторный create возвращает тот же canonical record;
- создавать Job и начальный event в одной transaction;
- выдавать event sequence монотонно внутри Job под transaction и unique
  constraint;
- реализовать store primitives для create/read, ordered event page после
  sequence и terminal compare-and-set;
- фиксировать terminal Job state и единственный terminal event одной
  transaction; повторная или конкурирующая terminalization не создаёт второй
  terminal outcome;
- хранить только безопасный structured error/outcome metadata; не логировать и
  не дублировать private prompt, reasoning, secrets или workspace content;
- согласованно изменить contract, store, migrations, exports, tests и
  current-state docs только в объёме persistence foundation;
- сохранить public identifiers и возможность прочитать существующую v3 DB.

В этом slice не подключай новый store к текущему Chat execution path и не
выдавай foundation за работающий durable Job Engine.

Required deterministic evidence:

- fresh DB создаёт migration 4 ровно один раз;
- v3 fixture обновляется до v4 без изменения существующих threads/messages;
- повторное открытие v4 DB идемпотентно;
- create атомарно пишет Job и initial event;
- одинаковый scoped idempotency key возвращает один Job при
  sequential/concurrent create;
- разные scopes/keys создают разные Jobs;
- event sequence монотонна, уникальна и replay page строго ordered;
- transaction failure не оставляет Job без initial event или terminal state без
  terminal event;
- concurrent terminal CAS создаёт ровно один terminal state/event;
- non-terminal event после terminal отклоняется;
- unknown/malformed stored data даёт controlled failure, а не ложный success;
- P0-B migration/CAS, P0-C mutex/release, P0-D timeout/health и P0-E browser
  regressions остаются зелёными.

Non-goals:

- не добавлять worker, scheduler, Resource Governor, queue admission, leases,
  priorities, prewarm, unload или measured parallelism;
- не добавлять POST Job command, replayable GET SSE, cancel route или Chat
  migration в этом foundation slice;
- не менять connection ownership текущего POST/SSE и не изображать reattach;
- не реализовывать startup recovery non-terminal Jobs;
- не строить Runtime Bar, Jobs UI, notification flow или application service;
- не менять product IA/theme, model catalog, capability probes, Agent/MCP/Skills,
  retention, branding или locale architecture;
- не переписывать SQLite migrations 1–3;
- не использовать live Ollama, реальную модель, публичную сеть или
  пользовательскую DB в обязательном suite.

Validation:

```bash
npm run typecheck
node --test <exact new contract/migration/store test files>
node --test packages/server/test/exclusive-inference.test.ts \
  packages/server/test/inference-concurrency.test.ts
node --test packages/server/test/catalog.test.ts \
  packages/server/test/runtime-contract.test.ts \
  packages/server/test/runtime-routes.test.ts \
  packages/server/test/ollama-client.test.ts \
  packages/server/test/inference-concurrency.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Не оставляй placeholder `<exact ...>` в финальном evidence: замени его реальными
путями и точными counts.

После успешной независимой проверки:

- обнови current-state contract/storage/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0 evidence и запиши только bounded evidence
  P1-A; не отмечай всю Phase 1 завершённой;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий доказанно
  незавершённый Phase 1 slice;
- сделай небольшие conventional commits для contract, migration/store tests и
  docs.

Если migration semantics, idempotency scope или terminal transaction остаются
неопределёнными, не угадывай и не расширяй schema. Оставь P1-A blocked, укажи
конкретный blocker, противоречащие источники, failing test/command и безопасные
recovery steps.

В финале сообщи commits, Job/event schema и transaction invariants, migration
evidence, test counts, непройденные проверки, residual risks и slice, для
которого подготовлен `NEXT_AGENT_PROMPT.md`.
