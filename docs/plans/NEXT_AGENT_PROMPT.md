# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-L — context/model/digest-aware observation keys

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
P1-A–P1-E реализовали durable Jobs, Chat detach/reattach и fail-closed recovery;
P1-F–P1-H — process-local Governor, runtime reconciliation и Apple telemetry;
P1-I/P1-J — persistent Runtime Bar и conflict Queue/exact Stop; P1-K — typed
lowest-priority prewarm. Реализуй только slice `P1-L context/model/digest-aware
observation keys`. Не создавай subagents и не делегируй работу.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A–P1-E: `138fb5e`..`6c748de`;
- P1-F Governor: `a0bc047`, `ff96dc0`;
- P1-G runtime reconciliation: `b8328bd`, `bd0d7a1`, `40a0de7`, `f53a868`;
- P1-H telemetry/fit: `df4d156`..`66c23c0`;
- P1-I Runtime Bar: `6c297ce`..`11e516b`;
- P1-J conflict behavior/tests: `2e8dc47`, `dc3f992`;
- P1-K policy/server/Web/tests: `811f7fa`, `ed26445`, `ddb78d0`, `60693ea`;
- P1-K docs/status/handoff: commit непосредственно перед этим prompt.

Не откатывай P0 Error Boundaries, truthful Message terminal CAS, provider
deadlines, migrations 1–5, scoped Job idempotency, canonical state CAS,
persisted-first subscription, durable Chat privacy/chunking/recovery, P1-F one
permit/unload guard, P1-G source semantics, P1-H truthful unknown fit, P1-I
polling/accessibility, P1-J one-intent/exact-owner/focus semantics или P1-K
normal-before-prewarm/exact-owner cleanup/short-TTL semantics.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/PRODUCT.md` (`RES-001..008`, `MOD-002/003`), `docs/UX_IA.md` model/
   Runtime sections, `docs/DOMAIN_MODEL.md`, Runtime Lifecycle (`Resource
   Governor`, `Memory model`, `Observability contract`), HLD, LLD,
   `docs/TESTING.md`, `docs/DEVELOPMENT.md`, accepted ADR-0001/0002/0003/0004,
   `OPEN_QUESTIONS.md` и accepted product decisions D-002/D-003.
2. Проверь Git status; сохрани unrelated/untracked user files. Не изменяй
   `.idea`, `~/.alamo`, реальные Ollama models или workspace-файлы.
3. Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `product-agent:product-acceptance`, `sre-agent:verification-strategy`,
   `sre-agent:reliability-testing`, `sre-agent:finding-validation` и
   `sde-agent:implementation-evidence` без делегирования. Frontend skills нужны
   только если после inventory действительно меняется UI.
4. До правок воспроизведи baseline: P1 exact 96/96; prewarm service 6/6;
   routes/Governor/concurrency 30/30; runtime/provider 19/19; fit/telemetry
   19/19; root 223/223 server/CLI + 43/43 Web; Chromium 16/16.
5. Инвентаризируй `model_calibration` schema/store/callers, `ModelService`
   `/api/show` cache, installed `/api/tags` digest, running `/api/ps` identity,
   `RuntimeModelObservation/currentFit`, hardware/profile facts,
   `PrefillTracker`, warm/prewarm paths и all places, где observation сейчас
   ключуется одним model name. До кода составь key-readiness table, legacy data
   policy, migration/rollback plan и exact validation matrix.

## Scope P1-L

- Введи один versioned typed observation-key boundary. Для evidence, которое
  влияет на measured fit/reuse/cache claim, key должен различать как минимум
  provider, normalized exact model reference, artifact digest, context length,
  runtime/backend fingerprint и hardware fingerprint. Не собирай ad-hoc string
  keys независимо в разных modules.
- Раздели `key complete` и `key unavailable` typed reason. Missing digest,
  context, runtime/backend version или required hardware facts не заменяй model
  name, family, size либо optimistic default. Unknown остаётся unknown/estimated.
- Исправь current `model_calibration`, который ключуется `(model,
  context_length)`: measured sample одного digest/hardware/backend не должен
  применяться к другому. Старые name-only rows не выдавай за exact measured
  evidence.
- Если нужна durable schema, добавь только forward migration 6 либо следующий
  свободный номер. Не переписывай migration 1 и не делай недоказуемый backfill
  digest/fingerprint. Сохрани legacy table/data readable и опиши rollback/
  recovery; partial migration должна атомарно откатываться.
- Исправь `/api/show` cache: смена installed digest под тем же name не должна
  reuse старые architecture facts. Cache остаётся bounded либо получает explicit
  invalidation; unbounded history новых digests не вводи.
- Runtime reconciliation может публиковать observation key только для exact
  однозначной row. Duplicate normalized references, missing digest/context или
  incompatible source дают typed unavailable reason, а не первую строку как
  identity. `observedAt`, source и confidence сохраняются.
- Calibration record разрешён только при доказанном соответствии installed
  artifact и running instance. Name-only `/api/ps` match, stale tag или changed
  digest не создаёт measured sample. Одно observation не становится future
  admission guarantee.
- Context является частью key. Sample 8k не перезаписывает/не masquerade-ится как
  32k; одновременно не вводи UI ceiling или whitelist context sizes.
- Hardware fingerprint строится из стабильных sourced facts, а не raw private
  host strings. Не логируй serial/user/path. Remote/unsupported/partial hardware
  не превращай в локальный verified fingerprint без явной policy.
- Runtime/backend fingerprint должен иметь источник и version semantics. Если
  current Ollama boundary не даёт достаточно фактов без дополнительного
  unbounded probe, оставь key unavailable с reason либо введи один bounded shared
  source. Не используйте timestamp как fingerprint.
- Реши судьбу `PrefillTracker` по evidence: либо переведи его baseline на тот же
  exact key, если execution уже знает необходимые facts, либо явно оставь
  heuristic name-scoped state вне measured observation contract. Не расширяй
  Chat storage/command только ради красивого key без compatibility plan.
- P1-K exact resident reuse остаётся name+digest+context current-sample decision.
  Не ослабляй normal-before-prewarm, cleanup, 2m TTL или explicit warm 10m.
  Если shared observation key безопасно переиспользуется, докажи, что missing
  backend/hardware не блокирует уже корректный current-residency exact match без
  причины.
- Public contract меняй additive. Legacy Runtime snapshots, settings и current
  model API должны parse/read как раньше; новые fields optional/defaulted только
  там, где это не создаёт ложный complete key.
- User-facing projection, если добавляется, показывает components/source/time и
  unavailable reason через English locale source/fallback и curated Russian.
  IDs/digests/fingerprints не переводятся. Не добавляй UI только для отображения
  внутренней hash-строки.
- Все provider/DB waits bounded/cancellable. Safe errors не раскрывают raw
  Ollama body, endpoint credentials, host-private strings, paths или prompts.
- Не добавляй arbitrary context/model-size/output caps. Следующий отдельный audit
  no-artificial-caps остаётся впереди.
- Обнови current-state docs и Mermaid только если boundary действительно
  изменилась.

## Required key/readiness model

```text
installed artifact + runtime row + requested/observed context + host/backend facts
  → normalize exact reference
  → prove one artifact digest and one runtime instance
      ├─ any required component missing/ambiguous → key unavailable(reason)
      │      → no measured calibration/cache/reuse claim from that observation
      └─ all components sourced → versioned observation key
             → exact-key calibration read/write
             → exact-key cache/read projection
             → changed digest/context/backend/hardware → distinct key/miss
```

Legacy calibration policy должна быть явной: preserve rows, no invented digest,
no destructive rewrite, no silent measured credit.

## Required deterministic evidence

- contract fixtures принимают legacy Runtime/model responses, round-trip complete
  observation key, отклоняют malformed/unknown version и сохраняют unavailable
  reason без fabricated components;
- key builder даёт одинаковый key для одинаковых canonical inputs и разные keys
  при изменении каждого digest/context/backend/runtime/hardware component;
- normalization не объединяет разные registries/names/tags/digests и не использует
  fuzzy family match;
- migration fresh/current previous/reopen/failed+reopen проходит атомарно; legacy
  name-only calibration сохраняется, но не читается как exact measured sample;
- calibration store не смешивает два digest одного name, два contexts, два
  hardware/backend fingerprints; concurrent/upsert semantics deterministic;
- `/api/show` cache hit только для того же installed digest; digest replacement
  вызывает новый bounded show и не оставляет unbounded retained entries;
- `/api/tags`↔`/api/ps` exact/ambiguous/missing digest/context matrix доказывает,
  когда sample записывается и когда остаётся unavailable/estimated;
- current fit не становится measured при missing/legacy/cross-key sample и не
  обещает future admission;
- P1-K exact reuse, normal-prewarm races, explicit warm response/TTL и P1-J
  conflict behavior остаются без regression;
- safe errors/redaction и AbortSignal cleanup доказаны для нового source/store
  boundary;
- если UI не меняется, browser 16/16 остаётся regression evidence и не получает
  ложный credit за observation-key semantics. Если UI меняется, добавь literal
  Chromium actions с 390 px, 200%, keyboard и reduced motion;
- P1-D detach/reattach, P1-E recovery, P1-F cleanup, P1-G source, P1-H fit,
  P1-I polling, P1-J conflict и P1-K priority/debounce suites остаются зелёными.

## Non-goals

- не добавлять safe parallel/additional permits, memory-pressure admission,
  external-client control или multi-process lock;
- не делать durable Runtime history/metrics dashboard, generic cache service,
  full Jobs UI или lease journal;
- не менять Job state machine, Chat replay/recovery, P1-J Queue/Stop или P1-K
  prewarm priority/TTL;
- не добавлять pin, generic TTL/LRU eviction, auto-unload либо background probes;
- не внедрять capability registry/import/Marketplace provider работу Phase 2;
- не добавлять Project/Recipe/Artifact/retention/notifications, Agent/MCP/Skills,
  service/daemon, CLI/TUI или rebranding;
- не использовать live Ollama, реальную model, user DB, workspace files или
  public network в deterministic suite.

## Validation

Сохрани новые exact counts и отдельно regression counts:

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
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Повтори новые key/migration/cache/concurrency races 10 раз, P1-K server priority/
abort group 10 раз, P1-K debounce file 10 раз, P1-J conflict file 10 раз, P1-I
polling file 10 раз и P1-E recovery file 10 раз. Первый flaky/failing result
сохрани, диагностируй и исправь до полного gate; не скрывай повторным green run.

В evidence перечисли exact key components/version, complete/unavailable reasons,
legacy-data policy, migration number/rollback, cache bounds, changed-component
miss matrix, source/time/confidence и реальные test counts. Отдельно назови, что
live hardware/Ollama, production residency, continuous observation, safe
parallel, external-client identity, multi-process safety и generic eviction не
проверены.

После успешной независимой проверки:

- обнови current-state docs и `docs/TESTING.md`;
- в `PHASE_STATUS.md` сохрани P0/P1-A–P1-K evidence и добавь только P1-L;
- не отмечай Phase 1 завершённой: no artificial caps audit и возможные remaining
  exit-gate slices ещё впереди;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий bounded Phase 1 slice
  либо оставь P1-L с blocker/recovery steps;
- сделай небольшие conventional commits для contract/key policy, storage/
  behavior, tests и docs.

Если exact runtime/backend/hardware facts нельзя получить без ложного identity
claim или unsafe migration, не маскируй name-only key hash-строкой. Оставь P1-L
`blocked` с доказанным gap, сохранённым legacy data и конкретным recovery plan.

В финале сообщи status `successful` либо `blocked`, commits, exact tests,
failures, residual risks и что `NEXT_AGENT_PROMPT.md` полностью переписан.
