# Prompt следующему агенту

**Назначение:** Phase 0, slice P0-C — Exclusive inference bridge
**Статус:** ready
**Проверено:** 2026-08-02

Скопируйте текст ниже в новую coding-agent сессию.

---

Работай в репозитории Alamo UI. Продолжи текущую Phase 0, но реализуй только
bounded slice `P0-C Exclusive inference bridge`.

P0-A независимо проверен в commits `f038b5c` и `d05a906`. P0-B реализован и
проверен в commits `c673227`, `21115c5`, `ad6c2b4` и `7721ca0`. Не откатывай
Error Boundaries, web test harness, SQLite migration 3, Message terminal CAS,
safe error/stop persistence или truthful Chat projection.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 0 в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD и accepted ADR-0002/0004.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй:
   - `sde-agent:implementation-planning` и `sde-agent:sde-agent` как owner;
   - `architecture-agent:architecture-capacity` для host-wide permit boundary,
     fairness assumptions и scale limits;
   - `sre-agent:verification-strategy`,
     `sre-agent:reliability-testing` и `sre-agent:finding-validation` для
     независимой concurrency/cancellation проверки;
   - `frontend-agent:frontend-agent` только если observable conflict state
     требует согласованной Chat projection.
4. До правок воспроизведи одновременный inference в двух threads, конфликт
   turn/compaction и повторную compaction sequence. Составь bounded plan с
   state/ownership model, release paths, failure cases и точными validation
   commands.

Scope P0-C:

- ввести один application-host-wide exclusive inference permit как временный
  safety bridge для всех текущих локальных inference entry points;
- убрать допущение, что `activeTurns` per-thread защищает host: два разных
  threads не должны одновременно войти в Ollama inference;
- определить observable совместимое поведение второго current request
  (bounded wait либо явный conflict) без изображения полноценной durable queue;
- не допускать compaction одновременно с active turn или другим inference,
  включая разные threads;
- исправить repeated compaction sequence: store/route должны использовать
  реальный persisted message `seq`, а не array length/index после предыдущего
  удаления/summary;
- гарантировать release permit после success, provider/protocol/storage error,
  explicit Stop, connection abort, client generator return и route failure;
- сохранить P0-B terminal truth: rejected/cancelled/failed request не становится
  completed и не оставляет новый ambiguous empty assistant;
- согласованно изменить composition context, runtime service/route, tests и
  current-state docs; contract/UI менять только если observable behavior этого
  требует;
- оставить loopback/security boundaries и текущие public API/DB/localStorage
  identifiers совместимыми.

Non-goals:

- не реализовывать Resource Governor, durable queue/Job Engine, leases,
  priorities, idempotency, replayable GET SSE или restart recovery;
- не разрешать measured parallelism и не вычислять hardware fit;
- не менять P0-B connection ownership: navigation пока может cancel current
  POST/SSE turn;
- не реализовывать P0-D runtime/catalog health, running-model panel или timeouts;
- не реализовывать P0-E полный browser release gate;
- не менять product IA/theme, branding, Marketplace, media, Agent policy или
  retention;
- не переписывать SQLite migrations 1–3 и не добавлять schema migration без
  доказанной необходимости.

Concurrency/failure evidence:

- два Chat turns в разных threads никогда не находятся внутри fake Ollama
  inference одновременно;
- second request получает документированное wait/conflict behavior без второго
  model load;
- turn и compaction в одном и разных threads не overlap;
- две compaction не overlap;
- permit освобождается после completed, provider error, missing terminal chunk,
  explicit Stop, connection abort и injected persistence/route failure;
- cancellation ожидающего request не отменяет owner и не оставляет permit;
- repeated compaction после уже созданной summary сохраняет уникальный реальный
  `seq`, правильный порядок history и следующий turn context;
- P0-B reload projection по-прежнему различает
  pending/completed/failed/cancelled/legacy;
- active permit не становится скрытым durable/background Job и не переживает
  process restart.

Validation:

- targeted mutex/admission unit tests и deterministic cross-thread route tests;
- deterministic turn/compaction/repeated-compaction store/route tests;
- cancellation/error release tests с fake Ollama, без live model;
- existing P0-B contract/migration/store/route/web regression;
- `npm run test:web:browser`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`, self-review и independent architecture/SRE concurrency
  review;
- не использовать пользовательскую DB или реальную модель для обязательных
  tests.

После успешной проверки:

- обнови current-state docs и только строку P0-C в `PHASE_STATUS.md`, со ссылками
  на commits и точными tests;
- оставь Phase 0 незавершённой;
- зафиксируй residual risks: bridge не является Governor/durable queue,
  POST/SSE всё ещё connection-owned и не replayable, navigation может cancel,
  measured parallelism отсутствует;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий незавершённый slice
  `P0-D Runtime/catalog health`, включая skills, scope, non-goals, health/timeout
  validation и ожидаемое обновление только P0-D;
- сделай небольшие conventional commits для behavior, concurrency tests и docs.

Если P0-C заблокирован или обязательная проверка не прошла, не переключай handoff
на P0-D: оставь `NEXT_AGENT_PROMPT.md` на P0-C и добавь blocker, evidence,
затронутые ownership paths и безопасные recovery steps.

В финале сообщи commits, permit/ownership model, concurrency evidence,
непройденные проверки, остаточные риски и slice, для которого подготовлен
`NEXT_AGENT_PROMPT.md`.

---
