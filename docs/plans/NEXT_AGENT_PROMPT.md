# Handoff следующему агенту

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 2, slice P2-B — persistent installed evidence cache,
freshness и offline fallback

## Prompt

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Сначала полностью прочитай
корневой `AGENTS.md` и выполни его. Не создавай subagents и не делегируй работу.

Phase 0/1 independently verified. P2-A commits `d750a3e`, `6a5c43d`, `d42b791`
и `282c82e` additive ввели transient `InstalledModelDescriptor` через installed
list/detail и localized Web projection. Реализуй только bounded P2-B:
persistent safe cache для installed provider evidence, explicit freshness и
offline fallback. Не начинай import, controlled probes, full Capability Registry
API либо Marketplace rewrite.

### Обязательное чтение и readiness

1. Прочитай полностью:
   - `docs/NAVIGATION.md`;
   - `docs/PRODUCT.md`, особенно `MOD-001..007` и `RES-008..010`;
   - `docs/DOMAIN_MODEL.md`, Model Reference/Variant/Installation/Runtime
     Instance/Observation Key/Context Limit/Capability Evidence;
   - `docs/UX_IA.md`, Models/Marketplace и source states;
   - `docs/DEVELOPMENT.md` и `docs/TESTING.md`;
   - `docs/architecture/HLD.md`, `LLD.md` (включая P2-A fact inventory) и
     `RUNTIME_LIFECYCLE.md`;
   - `docs/plans/PHASE_STATUS.md`, Phase 2/exit gate в `ROADMAP.md`;
   - `docs/plans/OPEN_QUESTIONS.md`, Q-25/Q-26 не закрывай;
   - `docs/decisions/2026-08-02-product-decisions.md`;
   - ADR-0002, ADR-0003 и ADR-0008.
2. Используй `architecture-agent:architecture-agent`,
   `architecture-agent:architecture-migration`,
   `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `product-agent:product-acceptance`, `sre-agent:verification-strategy`,
   `sre-agent:finding-validation`, `sde-agent:implementation-evidence` и
   `frontend-agent:frontend-verification` без делегирования.
3. До правок воспроизведи baseline:
   - typecheck;
   - P1 exact 98/98;
   - P1-L+M key/cache/runtime 32/32;
   - prewarm 7/7;
   - routes/Governor/concurrency 33/33;
   - runtime/provider 19/19;
   - fit/telemetry 19/19;
   - P2-A descriptor 9/9;
   - core 257/257, Web 51/51, Chromium 18/18;
   - build, markdownlint и diff check.
4. До реализации составь cache/readiness inventory:
   - current `/api/tags`, `/api/show`, `/api/version` request order и failure;
   - P2-A descriptor evidence/basis, observation times и legacy defaults;
   - process LRU 64, digest replacement и ambiguous reference policy;
   - SQLite migrations 1–6, store/composition patterns и rollback behavior;
   - installed list/detail Web loading/empty/error/unknown/degraded copy;
   - catalog stale-cache semantics, но не переиспользуй catalog claim как
     installed evidence;
   - safe fields, которые можно persist-ить, и поля, которые нельзя: raw body,
     endpoint credential, path, template/system prompt, license text, private
     prompt/reasoning/workspace content.
5. Зафиксируй acceptance до кода: cache key/version, TTL/stale window, exact
   invalidation, read/write transaction, offline semantics, migration rollback,
   cancellation, concurrency/single-flight и data minimization.

## Scope P2-B

- Добавь append-only migration 7 только если inventory подтверждает
  необходимость. Не переписывай migrations 1–6. Persistent row хранит только
  нормализованное safe evidence, schema/cache version, exact installed identity
  basis, provider/runtime basis, original observed time, fetched/validated time
  и expiry/stale metadata. Не сохраняй raw `/api/show` response.
- Cache key обязан различать provider, canonical exact reference, installed
  digest, relevant runtime version и evidence schema/version. Missing либо
  ambiguous identity не получает exact cache hit. Same-name replacement B
  никогда не читает row digest A.
- `/api/show` не возвращает digest. Перед exact persistent write докажи, что
  installed `/api/tags` identity не изменилась во время detail request, например
  bounded before/after validation. Если этого нельзя доказать, сохрани transient
  unknown/degraded и не записывай exact row.
- Выбери один документированный TTL/stale policy как explicit application
  policy, не provider truth. Fresh/stale/offline должны быть typed и объяснимы.
  Cache hit не переписывает исходный `observedAt`; access time не становится
  observation.
- Fresh request может использовать validated cache без provider call. Expired
  row требует bounded refresh; при unavailable provider допустим safe stale
  fallback в ограниченном stale window. После stale window evidence остаётся
  visible unknown/degraded, не supported/verified. Malformed/conflicting current
  provider data не маскируется старым convenient claim.
- Concurrent list/detail callers для одного exact key не создают unbounded
  duplicate `/api/show` work. Сохрани максимум четыре installed-detail workers;
  caller abort прекращает только его wait либо exact owned request согласно
  выбранной single-flight semantics. Новые waits bounded/cancellable.
- Process LRU 64 может остаться front-cache поверх persistent store, но его
  semantics должны совпадать с durable row. Restart/reopen должен читать только
  compatible non-expired/stale rows и не оживлять changed digest/runtime/schema.
- Legacy model response parsing, legacy `capabilities`, `contextLength`,
  `contextLimit`, REST paths и current clients остаются compatible. Migration
  rollback допускает старый code, игнорирующий новую table; данные не требуют
  destructive downgrade.
- Installed card/profile показывает fresh/stale/offline/unknown source state и
  observation time через locale keys: English source/fallback, curated Russian.
  Provider declaration остаётся outline/yellow, не verified-green. Marketplace
  projection не меняй.
- Provider failure не стирает installed row. Empty `/api/tags` остаётся healthy
  installed-empty; `/api/tags` failure не превращается в cached installation
  fact без явной accepted policy.
- Не сохраняй semantic quality, tool reliability, media support, output limit,
  hardware fit или runtime verification из имени/tag substring. Не вводи новые
  UI ceilings.
- Сохрани P1-L digest-aware identity/calibration, P1-M custom context, P1-K
  prewarm priority/TTL, P1-J Queue/Stop, P1-I polling и P1-E recovery.

## Required behavior model

```text
installed /api/tags row at digest A
  → canonical exact cache key + runtime/schema version
  → persistent lookup
      ├─ fresh compatible row → return original evidence/time
      ├─ stale row → bounded refresh
      │    ├─ exact before/after identity + valid response → replace safely
      │    └─ unavailable → typed stale/offline fallback within policy
      └─ miss/incompatible/too old → bounded provider collection
           ├─ exact identity remains A → safe normalized write
           └─ changed/ambiguous/malformed → no exact write; unknown/degraded
```

Evidence levels remain distinct:

```text
catalog claim ≠ provider declaration ≠ controlled probe ≠ runtime observation
```

## Required deterministic evidence

- migration 7 fresh/v6 upgrade/reopen/failure rollback проходит атомарно;
- legacy DB/code path продолжает работать, no destructive backfill;
- safe row serialization round-trips only allowlisted evidence fields;
- exact key changes for reference/digest/runtime/schema; A never serves B;
- restart reads fresh row and preserves original observation time;
- cache hit does not call `/api/show` or refresh timestamps;
- expiry triggers one bounded refresh; overlapping list/detail callers share or
  serialize exact work without exceeding four workers;
- before/after tags identity change prevents persistent write and returns
  visible degraded/unknown evidence;
- provider offline within stale window returns explicit stale/offline evidence;
  outside window stays unknown/degraded without erasing installed row;
- malformed/conflicting fresh data is visible and is not hidden by older cache;
- caller cancellation reaches owned provider request and never deletes a valid
  cache row or leaks a pending waiter;
- raw body, endpoint credentials, paths, template/system prompt, license text,
  private prompt/workspace/reasoning are absent from DB/public safe error;
- list/detail preserve P2-A exact/unknown basis, P1-M context behavior and legacy
  projections;
- Web covers loading, empty, fresh, stale/offline, unknown/degraded and retry;
  keyboard, focus, 390 px, 200%, no overflow и reduced motion remain safe;
- deterministic tests use temporary SQLite and fake transport only: no live
  Ollama/model, user DB, workspace/model store or public network.

## Non-goals

- не реализовывать controlled probes, user overrides или full registry history;
- не начинать `Add from Ollama`, HF/GGUF import или Q-25/Q-26;
- не менять Marketplace/search/filter/compare;
- не сохранять raw `/api/show` body, template/system/license content в cache;
- не добавлять Linux/NVIDIA telemetry, measured parallel, extra permits,
  generic eviction или auto-unload;
- не менять migrations 1–6, Job/Governor lifecycle, prewarm `2m`, explicit
  warm/turn `10m`, Queue/Stop или no-artificial-caps boundary;
- не начинать Project/Recipe/retention, Service/CLI/TUI, Agent, media или rebrand.

## Validation

Сохрани exact counts и отдельно regression counts. Минимум:

```bash
npm run typecheck
node --test packages/server/test/job-contract.test.ts \
  packages/server/test/job-migration.test.ts \
  packages/server/test/job-store.test.ts \
  packages/server/test/job-service.test.ts \
  packages/server/test/job-routes.test.ts \
  packages/server/test/chat-job-execution.test.ts \
  packages/server/test/chat-job-recovery.test.ts \
  packages/server/test/resource-governor.test.ts \
  packages/server/test/runtime-reconciliation.test.ts \
  packages/server/test/host-telemetry.test.ts
node --test packages/server/test/model-service.test.ts \
  packages/server/test/context-limits.test.ts \
  packages/server/test/observation-key.test.ts \
  packages/server/test/runtime-reconciliation.test.ts
node --test packages/server/test/prewarm.test.ts
node --test packages/server/test/routes.test.ts \
  packages/server/test/exclusive-inference.test.ts \
  packages/server/test/inference-concurrency.test.ts
node --test packages/server/test/catalog.test.ts \
  packages/server/test/runtime-contract.test.ts \
  packages/server/test/runtime-routes.test.ts \
  packages/server/test/ollama-client.test.ts
node --test packages/server/test/fit.test.ts \
  packages/server/test/host-telemetry.test.ts
node --test packages/server/test/model-descriptor.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Повтори новый persistent-cache/migration/concurrency group 10 раз, P2-A
descriptor group 10 раз, P1-L+M 10 раз, affected Web 10 раз, P1-K 10 раз, P1-J
10 раз, P1-I 10 раз и P1-E 10 раз. Первый failing/flaky result сохрани,
диагностируй и исправь; повторный green не скрывает первую ошибку.

## Completion and handoff

После независимой проверки:

- обнови current-state domain/HLD/LLD/development/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0/1/P2-A evidence и добавь только P2-B;
- Phase 2 оставь `in progress`, пока весь ROADMAP exit gate не доказан;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий незавершённый slice;
- сделай небольшие conventional commits для migration/store, server/contract,
  Web/tests и docs.

Если exact digest-safe persistence невозможно доказать на documented endpoints,
не кэшируй name-based declaration как exact. Оставь unknown/degraded и запиши
конкретный evidence gap. Если решение требует Q-25/Q-26, остановись: import не
входит в P2-B.

В финале сообщи `successful` либо `blocked`, commits, exact tests, первый failure
и исправление, residual risks и подтверждение обновления обоих handoff docs.
