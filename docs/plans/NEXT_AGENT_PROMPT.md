# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-G — `/api/ps` reconciliation и runtime snapshot

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
P1-A–P1-E реализовали durable Jobs, Chat detach/reattach и fail-closed startup
recovery. P1-F заменил anonymous mutex typed process-local Resource Governor
foundation. Реализуй только slice `P1-G /api/ps reconciliation + runtime
snapshot`. Не создавай subagents и не делегируй работу.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract/store: `138fb5e`, `91cb21f`, `92b68f0`;
- P1-B store/service/tests: `56b2200`, `55351bc`;
- P1-C public API: `4b9d96a`, `0a06ea6`;
- P1-D contract/storage/execution/evidence: `da70576`, `08b3516`, `f33d5b9`;
- P1-E startup recovery/evidence: `22a1aff`, `6c748de`;
- P1-F Governor implementation: `a0bc047`;
- P1-F bounded core/inventory evidence: `ff96dc0`;
- P1-F docs/status: commit непосредственно перед этим handoff prompt.

Не откатывай Error Boundaries, truthful Message terminal CAS, persisted
compaction fix, sampled runtime health/timeouts, SQLite migrations 1–5, scoped
Job idempotency, canonical state CAS, persisted-first subscription, strict public
Job schemas, server-owned idempotency scopes, pull-based HTTP backpressure,
durable Chat privacy/chunking/terminal transaction, disconnect-only semantics,
Web reattach, P1-E pre-listen recovery или P1-F typed tickets/leases/unload guard.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD, `docs/DOMAIN_MODEL.md`,
   `docs/TESTING.md`, `docs/DEVELOPMENT.md`, `docs/PRODUCT.md`, `docs/UX_IA.md`,
   accepted ADR-0001/0002/0003/0004, `docs/plans/OPEN_QUESTIONS.md` и
   `docs/decisions/2026-08-02-product-decisions.md`.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `architecture-agent:architecture-agent`,
   `architecture-agent:architecture-migration`,
   `architecture-agent:architecture-capacity`,
   `sre-agent:verification-strategy`, `sre-agent:reliability-testing`,
   `sre-agent:finding-validation` и `sde-agent:implementation-evidence` без
   делегирования.
4. До правок воспроизведи current state: exact Job/Governor files дают 72/72;
   routes/Governor/concurrency — 28/28; runtime/provider — 19/19. P1-F имеет
   один `context.governor`, typed FIFO tickets/leases и safe unload guard, но его
   snapshot не знает ни одного `/api/ps` row.
5. До кода составь bounded plan с inventory всех current `/api/ps` consumers,
   owner/identity reconciliation table, success/empty/failure/stale semantics,
   concurrent snapshot rules, cancellation/timeouts, unload interaction,
   compatibility/migration и exact validation commands.

## Scope P1-G

- добавить один application reconciliation boundary между existing validated
  `OllamaClient.ps()`/`ModelService.ps()` и `context.governor`; routes, Web и
  будущий Runtime Bar не создают собственные runtime ownership projections;
- ввести additive contract и public `GET /api/runtime` для единого sampled
  snapshot. Он должен включать current Governor admission state и `/api/ps`
  observation, но не private prompts, output, reasoning, tool/provider body,
  secret или filesystem path;
- сохранить existing `GET /api/models/running` compatibility. Допустимо
  реализовать его поверх общей reconciliation boundary, если status/error shape
  не меняется; strict existing Web client не ломать;
- каждая reconciliation получает одно `observedAt`, source и health. Успешный
  empty `/api/ps` — наблюдаемое пустое множество; timeout/unavailable/malformed
  response — unavailable/incompatible observation, а не empty success;
- сопоставлять active Alamo lease с runtime row только по exact нормализованной
  Ollama model reference и доступным identity facts. Совпадение имени без digest
  не превращать в доказанный artifact identity;
- runtime row, не сопоставленная exact active lease, получает owner state
  `unknown`, не `external` как установленный факт. Источник `/api/ps` доказывает
  residency sample, но не клиента, который её создал;
- active lease без соответствующего runtime row остаётся видимой как
  `requested/not_observed`; не считать это unload, load failure или race без
  дополнительного evidence;
- expose narrow decision/explanation codes для: matched active lease,
  active-not-observed, observed-unknown-owner, empty sample и source failure.
  Codes стабильны и локализуемая copy остаётся будущим UI scope;
- snapshot должен быть internally consistent при enqueue/acquire/release во
  время `/api/ps` request. Зафиксируй один явный linearization rule и докажи его
  test: например capture Governor state после provider observation с одним
  общим `observedAt`;
- concurrent callers не должны создавать unbounded provider fan-out или
  in-memory history. Допустим process-local single-flight для одного текущего
  sample; caller abort не должен отменять shared sample для остальных либо эта
  semantics должна быть явно иной и доказана;
- не заявлять continuous truth. Snapshot — sample с timestamp; следующий call
  может показать drift. Не добавлять background polling без измеренной причины;
- сохранить P1-F default policy: один permit, priority `normal`, FIFO. Runtime
  observation ничего не разрешает parallel и не меняет admission автоматически;
- сохранить unload guard active lease. P1-G не должен auto-unload unknown-owner
  rows. Existing explicit Stop после отсутствия active owner может остаться
  явным user action; если reconciliation меняет этот contract, нужен отдельный
  accepted decision, его нельзя угадывать;
- P1-E startup ordering сохранить. Unsafe/cancelling recovery не создаёт
  runtime ownership. Untouched queued Chat проходит Governor только после full
  reconciliation pass; `/api/ps` sampling не запускает adapter;
- generic public Job без typed adapter остаётся queued и не получает ticket,
  lease или runtime owner;
- migration 6 не нужна для sampled process-local state. Если вводится durable
  observation/cache, migration только additive с fresh/v5→v6/failed+reopen,
  explicit TTL/staleness и rollback note. Не создавай table без требования;
- обновить current-state docs и Mermaid/source diagram, если component/data
  boundary изменилась.

## Runtime result P1-G

```text
validated /api/ps sample or controlled source failure
→ one application reconciliation boundary
→ capture one Governor snapshot
→ classify active lease and observed rows without invented ownership
→ additive GET /api/runtime response with source + observedAt + decisions
```

P1-G остаётся sampled single-process reconciliation. Он не доказывает hardware
fit, continuous residency, external client identity или multi-process safety.

## Required deterministic evidence

- exact inventory test доказывает, что `/api/runtime` и `/api/models/running`
  используют одну reconciliation boundary; прямой второй `/api/ps` projection
  не появляется в routes/Web;
- contract round-trip покрывает active/queued admission, matched row,
  active-not-observed, unknown-owner row, empty sample и source failure;
- exact active lease/model/context и matching `/api/ps` row дают matched
  explanation без ложного digest/hardware claim;
- loaded row без active lease и second loaded row рядом с active lease остаются
  `unknown` owner, не `external` fact;
- active lease + successful empty sample остаётся active-not-observed; empty не
  освобождает lease и не запускает unload;
- unavailable, timeout и malformed `/api/ps` сохраняют Governor queue/lease в
  response и не публикуют `models: []` как healthy observation;
- provider error не содержит raw provider body, prompt, secret, endpoint
  credentials или path;
- enqueue/acquire/release, происходящие во время pending `/api/ps`, дают ровно
  документированную linearization semantics и один coherent `observedAt`;
- минимум два concurrent snapshot caller получают bounded provider-call count и
  независимую cancellation semantics; после completion live diagnostic state не
  растёт;
- unload exact active/conservative owner остаётся rejected до Ollama call;
  observed unknown-owner row не auto-unload-ится;
- P1-E recovered stable Job order и unsafe/cancelling no-ticket fixtures остаются
  зелёными;
- P1-F Chat/compaction/warm matrix, waiting/active cancellation, 1000 cleanup и
  10x release/cancel/close остаются зелёными;
- P1-D duplicate submit/cancel/detach/reattach, P1-E startup repeats,
  P1-A–P1-C store/subscription и P0-D timeout gates остаются зелёными;
- browser gate остаётся существующим mocked P0/P1-D smoke, если Web projection
  не меняется. Не называй его `/api/ps`, Governor UI или hardware test.

## Non-goals

- не добавлять continuous poller, SSE runtime feed, telemetry collection,
  RAM/VRAM reservation, Apple/NVIDIA fit или remote hardware profile;
- не добавлять measured parallelism, multiple permits, co-residency decision,
  priority scheduling/preemption, prewarm, pin, idle TTL/LRU или auto-unload;
- не идентифицировать внешний process/client по одному `/api/ps` row;
- не добавлять полный Runtime Bar, Jobs screen, queue dialog или новый IA;
- не добавлять durable lease journal, checkpoint resume, generic worker registry,
  arbitrary public Job execution, retry/scheduler policy или multi-process lock;
- не добавлять Application Service/daemon, CLI/TUI Job commands или autostart;
- не добавлять catalog/capability/import, retention, notification, Project,
  Recipe, Artifact, Agent/MCP/Skills, branding или locale expansion;
- не использовать live Ollama, реальную модель, public network, user DB или
  реальные workspace files в deterministic suite;
- не называть fake `/api/ps` hardware validation, sampled snapshot continuous
  truth или process-local reconciliation host-wide safety.

## Validation

Уточни новый reconciliation test filename в плане и сохрани exact counts:

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
  packages/server/test/runtime-reconciliation.test.ts
node --test packages/server/test/routes.test.ts \
  packages/server/test/exclusive-inference.test.ts \
  packages/server/test/inference-concurrency.test.ts
node --test packages/server/test/catalog.test.ts \
  packages/server/test/runtime-contract.test.ts \
  packages/server/test/runtime-routes.test.ts \
  packages/server/test/ollama-client.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

В финальном evidence укажи exact counts, observation/owner states, source failure
semantics, concurrent call bound, linearization rule, какие routes реально
подключены и какие browser actions реально проверены. Отдельно назови, что live
hardware/Ollama, continuous observation, external-client identity и
multi-process safety не проверены и не реализованы.

После успешной независимой проверки:

- обнови current-state runtime/HLD/LLD/development/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A–P1-F evidence и добавь только P1-G;
- не отмечай всю Phase 1 завершённой: host telemetry/fit, prewarm/unload policy,
  Runtime Bar и resource UX ещё впереди;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий bounded Phase 1 slice
  host telemetry interface + Apple Silicon observed/unknown fit либо оставь P1-G
  с blocker и recovery steps;
- сделай небольшие conventional commits для contract/reconciliation, tests и
  docs.

Если runtime owner classification, explicit unload semantics или durable cache
требует нового product decision, не угадывай. Реализуй меньший truthful sampled
snapshot, а спорную часть оставь residual scope; P1-G блокируй только при
конкретном несовместимом invariant и failing fixture.

В финале сообщи status `successful` либо `blocked`, commits, exact tests,
failures, residual risks и что `NEXT_AGENT_PROMPT.md` полностью переписан.
