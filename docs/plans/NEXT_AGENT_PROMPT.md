# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-J — resource conflict/queue action UX

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
P1-A–P1-E реализовали durable Jobs, Chat detach/reattach и fail-closed recovery;
P1-F — typed process-local Resource Governor; P1-G — shared `/api/ps`
reconciliation; P1-H — truthful Apple host telemetry/current fit; P1-I —
persistent read-only Runtime Bar с bounded adaptive polling. Реализуй только
slice `P1-J resource conflict/queue action UX`. Не создавай subagents и не
делегируй работу.

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
- P1-I Runtime Bar behavior/tests/review fix: `6c297ce`, `151fe07`, `11e516b`;
- P1-I docs/status/handoff: commit непосредственно перед этим prompt.

Не откатывай P0 Error Boundaries, truthful Message terminal CAS, persisted
compaction fix, provider deadlines, SQLite migrations 1–5, scoped Job
idempotency, canonical state CAS, persisted-first subscription, strict public
Job schemas, pull-based backpressure, durable Chat privacy/chunking/terminal
transaction, disconnect-only semantics, Web reattach, pre-listen recovery,
P1-F FIFO/leases/unload guard, P1-G single-flight/source semantics, P1-H
telemetry provenance/current-fit unknown states или P1-I polling/stale/source/
accessibility semantics.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/PRODUCT.md` (`RES-004`, `RES-005`), `docs/UX_IA.md` (`Переход во время
   генерации`, `Dispatch второго Job`), `docs/DOMAIN_MODEL.md`, Runtime Lifecycle,
   HLD, LLD, `docs/TESTING.md`, `docs/DEVELOPMENT.md`, accepted ADR-0001/0002/
   0004, `OPEN_QUESTIONS.md` и accepted product decisions D-002/D-003.
2. Проверь Git status; сохрани unrelated/untracked user files. Не изменяй
   `.idea`, `~/.alamo`, workspace-файлы или реальные Ollama models.
3. Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `frontend-agent:frontend-agent`, `frontend-agent:frontend-verification`,
   `product-agent:product-acceptance`, `sre-agent:verification-strategy`,
   `sre-agent:reliability-testing`, `sre-agent:finding-validation` и
   `sde-agent:implementation-evidence` без делегирования.
4. До правок воспроизведи baseline: P1-A–P1-H exact files 92/92;
   routes/Governor/concurrency 28/28; runtime/provider 19/19; fit/telemetry
   19/19; root 210/210 server/CLI + 27/27 Web; Chromium 10/10.
5. Инвентаризируй `ChatPage`/`useChat` dispatch ownership, idempotency key,
   Runtime Bar/polling ownership, `api.runtimeSnapshot`, public Job query/cancel,
   dialog primitives, focus management и current browser fixtures. До кода
   составь state/action table и exact validation plan.

## Scope P1-J

- При попытке отправить новый Chat turn, когда fresh typed Runtime snapshot
  показывает active lease или FIFO predecessor в conservative one-permit lane,
  покажи объяснимый conflict decision UI до dispatch. Простая навигация никогда
  не открывает dialog и ничего не отменяет.
- Default action — `Queue after current`: она создаёт текущий Chat Job ровно один
  раз через существующий idempotency path. Canonical server Governor остаётся
  владельцем admission/FIFO; UI snapshot не становится lock и не обещает exact
  start time.
- `Stop current and switch` доступен только когда snapshot даёт exact active
  owner `{kind:"job", jobId}` и public cancel semantics применимы. Сначала
  вызови typed `api.cancelJob(jobId)`, наблюдаемо обработай `cancelling`/
  terminal/conflict/failure, затем один раз dispatch новый Chat Job. Никогда не
  cancel operation owner по догадке и не подставляй current thread ID вместо
  owner Job ID.
- Если active owner — process-local operation, owner unknown, source stale или
  active Job уже terminal, stop-and-switch скрыт либо disabled с понятным
  основанием. `Queue after current` остаётся безопасным server-owned path, если
  Chat command сам валиден.
- Не придумывай `Open active Job/Chat`, если snapshot/public Job projection не
  содержит доказанного route. Можно дать non-destructive `Back`/`Keep current`
  и focus Runtime Bar; navigation target добавляй только после доказанного
  typed association.
- Различай one-permit queue conflict и model-fit claim. Даже same-model Job сейчас
  проходит один FIFO permit. Не предлагай parallel и не используй
  `currentFit.observed` как future-admission approval.
- Runtime snapshot — sampled query-time fact. Перед destructive Stop сделай
  fresh bounded refresh/query; обработай TOCTOU: changed/terminal/not-found/
  unavailable state не должен cancel другой Job или double-dispatch новый.
- Не создавай второй независимый polling loop в Chat. Если Chat нужен current
  snapshot, вынеси P1-I projection state в узкий shell provider/store либо
  добавь bounded on-demand query с явным ownership; докажи one-request bound и
  отсутствие retained timers/listeners.
- Conflict UI должен показывать active operation/model/owner kind, очередь и
  requested contexts только из contract. Он не является full durable Jobs list,
  не показывает private input и не выводит operation ID как user title.
- Queue/cancel errors получают stable localized human summary без raw endpoint,
  provider body, credentials, paths, prompt или reasoning. Retry не повторяет
  уже принятую mutating command автоматически.
- Dialog semantic/accessibility-first: named dialog, labelled description,
  initial focus на safe default Queue, keyboard Escape/close, Tab containment,
  background inert, focus restore в composer/send control, 44×44 mobile targets,
  no focus steal от Runtime polling и reduced-motion behavior.
- На narrow/200% dialog и Runtime Bar не перекрывают критичные actions, не имеют
  horizontal overflow и не создают nested inaccessible scroll trap.
- Все новые strings — locale keys: English source/fallback и curated Russian.
  Model names/IDs не переводятся; context/time используют common format helpers.
- Добавь feature Error Boundary только если новый dialog/provider создаёт новую
  failure boundary; не ослабляй current root/Chat/Runtime containment.
- Compatibility `/api/models/running` остаётся. Contract/server/storage migration
  не ожидаются. Если exact safe stop flow требует отсутствующий typed fact или
  command, сначала докажи gap; additive contract slice должен быть минимальным и
  сохранить старых clients.
- Обнови current-state docs и Mermaid только при реальном изменении boundary.

## Required state/action model

```text
send intent
  → no observed live conflict
      → dispatch once through existing Chat command
  → active/queued conservative conflict
      ├─ Queue after current (safe default)
      │    → dispatch once → canonical queued/running Job projection
      ├─ Stop current and switch (exact cancellable Job owner only)
      │    → fresh verify → cancel command once
      │    → cancellation acknowledged or controlled changed-state result
      │    → dispatch new Job once, or explicit recoverable failure
      └─ Back/keep current
           → no command and focus restored
```

Dialog close/navigation/unmount отменяет только его own read wait. Оно не
отменяет active Job и не снимает lease. Retry mutating action требует явного
нового user activation и idempotency protection.

## Required deterministic evidence

- inventory test доказывает: Chat conflict UI использует typed Runtime/Public Job
  API, не вызывает `/api/ps`, Ollama, host command, filesystem или Governor
  напрямую и не создаёт page-local resource owner;
- no-conflict send сохраняет current one-command/idempotency behavior;
- active Job owner + multiple FIFO waiters показывает exact operation/model/
  owner-kind/context/order без durable-history claim;
- Queue default создаёт один Job, закрывает dialog, восстанавливает observable
  composer state и не вызывает cancel/stop/unload;
- same-model active lease всё равно объясняется conservative one-permit FIFO, а
  observed current fit не включает Parallel;
- exact active Job Stop path вызывает один cancel для snapshot Job ID, обрабатывает
  `cancelling → cancelled`/already terminal и создаёт новый Job не более одного
  раза;
- operation owner, unknown owner, unavailable/stale verification, changed Job ID
  и cancel failure не приводят к guessed cancel или hidden dispatch;
- double click, Enter repeat, rerender, route change и response race не создают
  duplicate cancel либо Chat Job; existing idempotency key остаётся canonical;
- close/Escape не делает resource action; dialog focus trap/restore, inert,
  accessible names/descriptions/status/alert discipline и locale fallback/
  Russian strings проверены component tests;
- Runtime polling во время открытого dialog не сбрасывает focus/choice. Dialog
  закрывается или обновляет explanation явно при materially changed snapshot;
- Chromium выполняет literal flow: Job A active → открыть Chat B/send → conflict
  dialog → Queue → Job B queued; второй scenario — exact Job A → Stop-and-switch
  → cancellation acknowledgement → Job B dispatch. Затем navigation Chat ↔
  Settings не вызывает resource action;
- Chromium отдельно проверяет unsupported Stop для operation/unknown owner,
  cancel failure/retry, narrow 390 px, 200% scaling, no horizontal overflow,
  keyboard-only flow и reduced motion. Mocked browser не является live Ollama/
  hardware validation;
- P1-D detach/reattach/Stop, P1-E recovery, P1-F FIFO/unload/cleanup, P1-G source
  compatibility, P1-H telemetry/fit и P1-I polling/source/accessibility suites
  остаются зелёными.

## Non-goals

- не добавлять safe parallel action: P1-F поддерживает только one-permit `normal`
  FIFO, а P1-H current fit не является future admission guarantee;
- не реализовывать prewarm/debounce warm, priority/preemption, additional permits,
  joint-fit admission, pin, TTL/LRU или auto-unload;
- не менять Governor FIFO/lease/unload semantics и не делать client-side lock;
- не добавлять full Jobs screen/history, Job titles/routes, generic worker,
  checkpoint resume, retry scheduler или lease journal;
- не добавлять Runtime SSE/WebSocket, durable observation cache/history, metrics
  exporter, cloud telemetry или multi-process lock;
- не идентифицировать unknown-owner row как доказанный external client;
- не добавлять catalog/import/Project/Recipe/Artifact/retention/notifications,
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

Повтори новые dialog race/idempotency tests 10 раз, P1-I timer/visibility tests
10 раз и P1-E recovery file 10 раз. Первый flaky/failing result сохрани,
диагностируй и исправь до полного gate; не скрывай повторным green run.

В evidence укажи exact dialog states/actions, request/cancel/dispatch counts,
idempotency key ownership, stale/TOCTOU rules, focus/inert/keyboard behavior,
responsive viewports и literal browser actions. Отдельно назови, что live
hardware/Ollama, continuous observation, safe parallel/future admission,
external-client identity, multi-process safety, prewarm и full Jobs history не
проверены и не реализованы.

После успешной независимой проверки:

- обнови current-state docs и `docs/TESTING.md`;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A–P1-I evidence и добавь только P1-J;
- не отмечай Phase 1 завершённой: prewarm и другие remaining exit-gate slices
  ещё впереди;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий bounded Phase 1 slice
  prewarm low-priority lease/debounce либо оставь P1-J с blocker/recovery steps;
- сделай небольшие conventional commits для behavior, tests и docs.

Если public projection не позволяет безопасно определить cancellable current
Job или дождаться его acknowledgement, не угадывай route/owner. Реализуй Queue
path и truthful disabled Stop с exact residual gap; блокируй P1-J только при
конкретном несовместимом invariant либо неустранимом failing fixture.

В финале сообщи status `successful` либо `blocked`, commits, exact tests,
failures, residual risks и что `NEXT_AGENT_PROMPT.md` полностью переписан.
