# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-K — prewarm low-priority lease/debounce

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
P1-A–P1-E реализовали durable Jobs, Chat detach/reattach и fail-closed recovery;
P1-F — typed process-local Resource Governor; P1-G — shared `/api/ps`
reconciliation; P1-H — truthful Apple host telemetry/current fit; P1-I —
persistent Runtime Bar; P1-J — conflict Queue/exact Job Stop decision. Реализуй
только slice `P1-K prewarm low-priority lease/debounce`. Не создавай subagents и
не делегируй работу.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract/store: `138fb5e`, `91cb21f`, `92b68f0`;
- P1-B store/service/tests: `56b2200`, `55351bc`;
- P1-C public API: `4b9d96a`, `0a06ea6`;
- P1-D contract/storage/execution/evidence: `da70576`, `08b3516`, `f33d5b9`;
- P1-E startup recovery/evidence: `22a1aff`, `6c748de`;
- P1-F Governor implementation/evidence: `a0bc047`, `ff96dc0`;
- P1-G runtime reconciliation: `b8328bd`, `bd0d7a1`, `40a0de7`, `f53a868`;
- P1-H telemetry/fit/tests/docs: `df4d156`..`66c23c0`;
- P1-I Runtime Bar behavior/tests/review: `6c297ce`..`11e516b`;
- P1-J conflict behavior/tests: `2e8dc47`, `dc3f992`;
- P1-J docs/status/handoff: commit непосредственно перед этим prompt.

Не откатывай P0 Error Boundaries, truthful Message terminal CAS, provider
deadlines, migrations 1–5, scoped Job idempotency, canonical state CAS,
persisted-first subscription, strict public Job schemas, pull backpressure,
durable Chat privacy/chunking/terminal transaction, disconnect-only semantics,
Web reattach, pre-listen recovery, P1-F one-permit lease/unload guard, P1-G
single-flight/source semantics, P1-H provenance/current-fit unknown states,
P1-I polling/stale/accessibility или P1-J one-intent/fresh-owner/focus semantics.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/PRODUCT.md` (`RES-001`, `RES-002`, `RES-006`), `docs/UX_IA.md`
   (`Создание Chat`), `docs/DOMAIN_MODEL.md`, Runtime Lifecycle (`Resource
   Governor`, `Model lease lifecycle`, `Prewarm`), HLD, LLD, `docs/TESTING.md`,
   `docs/DEVELOPMENT.md`, accepted ADR-0001/0002/0004, `OPEN_QUESTIONS.md` и
   accepted product decisions D-002/D-003.
2. Проверь Git status; сохрани unrelated/untracked user files. Не изменяй
   `.idea`, `~/.alamo`, workspace-файлы или реальные Ollama models.
3. Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `frontend-agent:frontend-agent`, `frontend-agent:frontend-verification`,
   `product-agent:product-acceptance`, `sre-agent:verification-strategy`,
   `sre-agent:reliability-testing`, `sre-agent:finding-validation` и
   `sde-agent:implementation-evidence` без делегирования.
4. До правок воспроизведи baseline: P1-A–P1-H exact files 92/92;
   routes/Governor/concurrency 28/28; runtime/provider 19/19; fit/telemetry
   19/19; root 210/210 server/CLI + 37/37 Web; Chromium 14/14.
5. Инвентаризируй `ResourceGovernor` queue/admit/cancel/close, model warm route,
   Ollama `keep_alive`, ModelPage explicit warm, New Chat model selector,
   settings storage, Runtime provider, request AbortSignal ownership и fixtures.
   До кода составь state/action table, priority policy и exact validation plan.

## Scope P1-K

- Добавь `prewarm` как явно типизированный lowest priority Governor intent/
  lease. `normal` Chat/compaction/explicit warm остаются сильнее. Active normal
  work никогда не вытесняется prewarm и не ждёт новый prewarm.
- Prewarm стартует только после устойчивого выбора exact installed model variant
  в New Chat selector и bounded debounce. Hover, catalog card render, background
  tab и простая навигация не запускают warm.
- До команды должны быть известны exact Ollama model name, operation/context и
  существующий fit basis. Unknown-high-risk либо unavailable decision не
  превращай в optimistic load; покажи/сохрани truthful skipped reason.
- Server Governor остаётся canonical admission owner. UI debounce не является
  resource lock. Server должен повторно проверить policy/state в точке admission;
  клиентский sampled Runtime snapshot не разрешает load сам по себе.
- Если во время debounce выбор изменился, setting выключен, component unmount-нут,
  document hidden либо появился normal Job, старый prewarm отменяется. Отмена
  idемпотентна и не затрагивает Job/normal lease.
- Queued prewarm не обгоняет normal FIFO. Новый normal intent отменяет либо
  обходит queued prewarm по явно задокументированному policy. Если prewarm уже
  получил lease/load, normal intent может abort-нуть только exact prewarm owner,
  дождаться release и затем сохранить FIFO normal Jobs; active normal Job не
  preempt-ится.
- Совместимая уже resident exact model не должна получать повторный load только
  ради UI-effect. Не объявляй reuse по одному имени, если digest/config/context
  недостаточны; в ambiguous случае skip либо conservative prewarm без reuse
  claim согласно typed policy.
- Prewarm использует короткий централизованный idle `keep_alive`/TTL, отличный
  от current explicit warm/turn `10m`. Значение и basis должны быть видимы в
  config/constant и tests; navigation не вызывает explicit unload.
- Сохрани current explicit ModelPage `Прогреть` как user-command с priority
  `normal`; auto prewarm не должен менять его response/error semantics.
- Добавь user setting для отключения prewarm, если current settings boundary
  позволяет сделать это additive key/value без migration. Default, update/read
  semantics и locale должны быть явными; отсутствие старого key сохраняет
  backward-compatible default.
- Предпочти отдельный typed prewarm command либо минимальное additive поле над
  warm API — только после contract compatibility review. Не маскируй prewarm как
  normal в public Runtime snapshot: priority/purpose/explanation должны быть
  truthful для Runtime Bar и P1-J dialog.
- Все request waits имеют bounded deadline/AbortSignal. Route disconnect либо
  selector cleanup отменяет только exact prewarm owner. После response race
  stale completion не обновляет выбранную модель и не оставляет retained
  timer/listener/controller.
- Safe errors не показывают raw Ollama body, endpoint, credentials, paths или
  private input. Expected abort/skipped state не становится alarming failure.
- Все новые user-facing strings проходят locale keys: English source/fallback и
  curated Russian. Model names/IDs не переводятся.
- Не добавляй arbitrary context/model-size caps. Используй contract/provider/
  policy facts; unknown остаётся unknown.
- Contract/server/Web/tests меняй согласованно. SQLite migration не ожидается:
  settings уже key/value, а prewarm lease process-local. Если требуется durable
  schema, сначала докажи gap и опиши recovery/compatibility до migration.
- Обнови current-state docs и Mermaid только если реально изменишь boundary.

## Required state/action model

```text
exact model selection
  → debounce pending
      ├─ selection/settings/navigation/hidden change → cancel timer, no command
      └─ stable + eligible → typed prewarm request
           → Governor normal work present → skip/queue lowest priority
           → Governor idle → acquire prewarm lease → bounded short-TTL warm
                ├─ normal intent arrives → abort exact prewarm → release → normal
                ├─ selection/unmount abort → release, no Job effect
                └─ success → sampled runtime may later observe residency
```

Priority policy должен иметь deterministic tie-break. FIFO normal Jobs не должны
менять взаимный порядок из-за prewarm. Release/cancel/close повторяются безопасно.

## Required deterministic evidence

- contract fixtures принимают `normal` и `prewarm`, отклоняют unknown priority и
  сохраняют compatibility normal snapshot/API;
- Governor unit tests доказывают priority order, FIFO внутри normal, no prewarm
  admission при active/queued normal, cancellation exact queued/active prewarm,
  release before next normal и idempotent cancel/release/close;
- race: prewarm становится eligible одновременно с normal enqueue — normal
  выигрывает независимо от callback order, без двух active leases;
- current same/cross-thread Chat, compaction и explicit warm matrix остаётся
  one-permit; active normal никогда не получает abort от prewarm;
- prewarm HTTP route/service использует typed request, low priority, bounded
  deadline, exact AbortSignal и короткий keep-alive; disconnect/abort освобождает
  ticket/lease и не вызывает later stale success;
- explicit warm остаётся `normal`, использует прежний response и не наследует
  short prewarm TTL;
- already-compatible resident exact variant не получает duplicate prewarm;
  ambiguous identity не получает ложный reuse claim;
- New Chat selector debounce создаёт максимум один command для финального выбора;
  rapid A→B→C, rerender, StrictMode, route change, hidden document и setting off
  дают expected cancel/no command без retained timers/listeners;
- normal Chat send во время queued/active prewarm отменяет только prewarm и
  создаёт Chat Job ровно один раз с canonical P1-J idempotency key;
- P1-J conflict dialog не предлагает Stop current Job из-за prewarm race и не
  получает focus steal от prewarm/Runtime updates;
- Runtime Bar показывает prewarm purpose/priority/explanation из contract, без
  durable Job либо external-owner claim;
- setting round-trip/default/update проверен server/Web tests, новые strings —
  Russian и English fallback;
- Chromium буквально выбирает idle model, выдерживает fake-timer-controlled
  debounce, наблюдает один prewarm, затем отправляет Chat и доказывает prewarm
  abort/release до одного Chat dispatch. Отдельно проверяет rapid selection,
  navigation/hidden/settings-off, 390 px, 200%, keyboard и reduced motion;
- mocked browser не называется live Ollama/hardware/TTL validation;
- P1-D detach/reattach/Stop, P1-E recovery, P1-F FIFO/unload/cleanup, P1-G source,
  P1-H telemetry/fit, P1-I polling и P1-J conflict suites остаются зелёными.

## Non-goals

- не добавлять safe parallel, additional permits, measured joint-fit admission,
  normal Job preemption, pin, generic TTL/LRU eviction или auto-unload;
- не превращать prewarm в durable Job, full queue manager либо lease journal;
- не прогревать catalog cards, hover, каждую модель, каждый Chat route или hidden
  page;
- не считать successful warm гарантией будущего admission/fit;
- не менять Job state machine, Chat replay/recovery, public cancel semantics или
  P1-J Queue/Stop contract;
- не добавлять Runtime SSE/WebSocket, durable observation history/cache, metrics,
  multi-process lock или external-client control;
- не добавлять import/Project/Recipe/Artifact/retention/notifications,
  Agent/MCP/Skills, service/daemon, CLI/TUI или rebranding;
- не использовать live Ollama, реальную модель, user DB, workspace files или
  public network в deterministic suite.

## Validation

Сохрани новые exact counts и отдельно baseline/regression counts:

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

Повтори новые priority/debounce/abort race tests 10 раз, P1-J conflict file 10
раз, P1-I timer/visibility file 10 раз и P1-E recovery file 10 раз. Первый
flaky/failing result сохрани, диагностируй и исправь до полного gate; не скрывай
повторным green run.

В evidence укажи exact priority transitions, request/warm/abort/release counts,
debounce/TTL constants и owners, selection/settings/visibility rules, Runtime
projection и literal browser actions. Отдельно назови, что live hardware/Ollama,
production TTL/residency, continuous observation, safe parallel/future fit,
external-client identity, multi-process safety и generic eviction не проверены.

После успешной независимой проверки:

- обнови current-state docs и `docs/TESTING.md`;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A–P1-J evidence и добавь только P1-K;
- не отмечай Phase 1 завершённой: context/model/digest-aware observation keys,
  no artificial caps audit и возможные remaining exit-gate slices ещё впереди;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий bounded Phase 1 slice
  либо оставь P1-K с blocker/recovery steps;
- сделай небольшие conventional commits для contract/policy, behavior, tests и
  docs.

Если current warm API/request lifecycle не позволяет безопасно отменить exact
prewarm owner без затрагивания normal work, не симулируй priority на клиенте.
Сначала введи минимальную typed server boundary или оставь P1-K `blocked` с
доказанным invariant gap и recovery plan.

В финале сообщи status `successful` либо `blocked`, commits, exact tests,
failures, residual risks и что `NEXT_AGENT_PROMPT.md` полностью переписан.
