# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-B — Job service transitions и persisted-first subscription

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate,
а P1-A независимо проверил durable Job/event-store foundation. Реализуй только
slice `P1-B Job service transitions и persisted-first subscription`.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract: `138fb5e`, `91cb21f`;
- P1-A migration/store/races: `92b68f0`;
- P1-A docs/status: возьми commit из текущего `git log` после handoff.

Не откатывай Error Boundaries, Message terminal CAS, process-local exclusive
inference bridge, persisted compaction fix, truthful runtime health/timeouts,
SQLite migration 4, scoped Job idempotency, per-Job sequence ownership и atomic
terminal transaction.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD, `docs/DOMAIN_MODEL.md`,
   `docs/TESTING.md`, accepted ADR-0001/0002/0004 и
   `docs/plans/OPEN_QUESTIONS.md`.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй:
   - `sde-agent:implementation-planning` и `sde-agent:sde-agent` как owner;
   - `architecture-agent:architecture-agent` для service/store boundary;
   - `sre-agent:verification-strategy` для canonical transition/subscription
     matrix;
   - `sre-agent:reliability-testing` для replay/live race, subscriber cleanup и
     transaction failure envelope;
   - `sre-agent:finding-validation` и `sde-agent:implementation-evidence` для
     независимой проверки.
4. До правок воспроизведи current state: migration 4 и `JobStore` существуют,
   create/append/terminal races зелёные, но general state-transition primitive,
   application `JobService`, persisted-first subscription и Job HTTP routes
   отсутствуют. Current Chat POST/SSE остаётся connection-owned.
5. До кода составь bounded plan с canonical transition matrix из
   `job-state.mmd`, store/service ownership, commit-before-publish ordering,
   replay/live gap strategy, slow-subscriber policy, cancellation cleanup,
   compatibility, failure injection и точными validation commands.

Scope P1-B:

- добавить store primitive для compare-and-set перехода между canonical
  non-terminal Job states с atomic state update + lifecycle event;
- использовать только transitions из
  `docs/architecture/diagrams/job-state.mmd`; не добавлять `running` или другие
  альтернативные states;
- сохранять `startedAt` один раз при первом успешном выходе из `queued`, не
  переписывать его при следующих transitions;
- invalid edge, stale expected state или terminal Job не должны менять Job,
  sequence или events и должны возвращать controlled result/error;
- сохранить terminal CAS P1-A и применять terminal edge validation на уровне
  application service согласно canonical diagram;
- реализовать in-process `JobService` поверх `JobStore` для create/get,
  transition, append safe event, terminalize и subscription;
- subscription принимает `afterSequence`, сначала читает persisted events,
  затем продолжает live tail; replay/live handoff не теряет и не дублирует
  committed sequence;
- event всегда commit-ится до publish; failed/rolled-back mutation никогда не
  broadcast-ится;
- disconnect/AbortSignal удаляет только subscriber и никогда не меняет Job;
- slow subscriber не блокирует writer: при локальном gap он дочитывает bounded
  page из SQLite вместо unbounded in-memory buffering;
- несколько subscribers видят одну canonical sequence; terminal event
  публикуется один раз;
- restart нового `JobService` теряет только live listeners, но replay из SQLite
  после last sequence остаётся полным;
- интегрировать `JobService` в application context и exports, не подключая его к
  current Chat route;
- согласованно обновить store/service tests и current-state docs только в
  пределах этого service foundation.

В этом slice не добавляй public REST/SSE Job API и не выдавай internal
subscription за HTTP reattach. Эти routes — следующий отдельный slice.

Required deterministic evidence:

- каждый разрешённый canonical non-terminal edge имеет state + event одной
  transaction;
- representative invalid/reverse/skipped edges отклоняются без записи;
- stale expected-state CAS не создаёт event;
- transition event insert failure откатывает state, `startedAt` и sequence;
- первый выход из `queued` задаёт `startedAt`, дальнейшие transitions его
  сохраняют;
- terminal edge validation соответствует diagram и P1-A single terminal
  transaction остаётся единственным terminal outcome;
- subscription после `N` отдаёт persisted `N+1..M`, затем live `M+1` без gap и
  duplicate;
- event, committed во время replay/live handoff, наблюдается ровно один раз;
- mutation failure не попадает subscriber;
- два subscribers получают одну ordered sequence;
- AbortSignal/disconnect очищает subscriber без Job state change;
- slow subscriber не блокирует producer и восстанавливает sequence из DB;
- новый service instance replay-ит persisted tail после simulated restart;
- malformed stored data остаётся controlled failure;
- P1-A migration/idempotency/append/terminal race tests и P0-C/P0-D/P0-E gates
  остаются зелёными.

Non-goals:

- не добавлять POST/GET/cancel routes, HTTP SSE headers или web client;
- не подключать current Chat execution/messages к Job;
- не добавлять worker, scheduler, queue admission, Resource Governor, leases,
  prewarm, unload или measured parallelism;
- не реализовывать startup recovery non-terminal Jobs;
- не менять connection ownership текущего Chat POST/SSE;
- не строить Runtime Bar, Jobs UI, notification flow или background service;
- не менять model catalog/capabilities, Agent/MCP/Skills, retention, branding,
  locale или product IA;
- не добавлять migration 5 без нового persistence requirement;
- не переписывать SQLite migrations 1–4;
- не использовать live Ollama, реальную модель, public network или user DB.

Validation:

```bash
npm run typecheck
node --test packages/server/test/job-contract.test.ts \
  packages/server/test/job-migration.test.ts \
  packages/server/test/job-store.test.ts \
  packages/server/test/job-service.test.ts
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

В финальном evidence укажи exact test counts, replay/live fixtures и число
повторений race tests. Не называй unit subscription HTTP SSE или durable Job
Engine.

После успешной независимой проверки:

- обнови current-state runtime/LLD/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0 и P1-A evidence, добавь только P1-B;
- не отмечай всю Phase 1 завершённой;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под P1-C public Job command/query/
  replay/cancel API либо оставь P1-B с blocker/recovery;
- сделай небольшие conventional commits для store/service, tests и docs.

Если canonical transition, replay/live gap ownership или bounded slow-subscriber
policy нельзя реализовать без нового product decision, не угадывай. Оставь P1-B
blocked, укажи конфликтующие источники, failing test/command и безопасные
recovery steps.

В финале сообщи status `successful` либо `blocked`, commits, transition/service
invariants, replay/live evidence, exact tests, failures, residual risks и что
`NEXT_AGENT_PROMPT.md` полностью переписан.
