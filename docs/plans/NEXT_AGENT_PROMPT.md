# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-F — Resource Governor admission/lease foundation

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
P1-A–P1-C реализовали durable Job store/service/public API, P1-D — durable Chat
execution и Web detach/reattach, P1-E — fail-closed startup recovery до listen.
Реализуй только slice `P1-F Resource Governor admission/lease foundation`.
Не создавай subagents и не делегируй работу.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract/store: `138fb5e`, `91cb21f`, `92b68f0`;
- P1-B store/service/tests: `56b2200`, `55351bc`;
- P1-C public API: `4b9d96a`, `0a06ea6`;
- P1-D contract/storage/execution/evidence: `da70576`, `08b3516`, `f33d5b9`;
- P1-E startup recovery: `22a1aff`;
- P1-E deterministic evidence: `6c748de`;
- P1-E docs/status: commit непосредственно перед этим handoff prompt.

Не откатывай Error Boundaries, truthful Message terminal CAS, persisted
compaction fix, sampled runtime health/timeouts, SQLite migrations 1–5, scoped
Job idempotency, canonical state CAS, persisted-first subscription, strict public
Job schemas, server-owned idempotency scopes, pull-based HTTP backpressure,
durable Chat privacy/chunking/terminal transaction, disconnect-only semantics,
Web reattach или P1-E pre-listen recovery.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD, `docs/DOMAIN_MODEL.md`,
   `docs/TESTING.md`, `docs/DEVELOPMENT.md`, `docs/PRODUCT.md`, `docs/UX_IA.md`,
   accepted ADR-0001/0002/0004, `docs/plans/OPEN_QUESTIONS.md` и
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
4. До правок воспроизведи current state: P1-A–P1-E exact files дают 66/66;
   routes/exclusive/concurrency дают 26/26; P0-C bridge сериализует Chat,
   compaction и warm/load, но не имеет typed request, lease, explanation,
   ownership snapshot или unload guard.
5. До кода составь bounded plan с inventory всех current local model-affecting
   entry points, admission/lease state table, fairness/order, cancellation,
   timeout/release, shutdown/restart, unload conflict, observability,
   compatibility/migration и exact validation commands.

## Scope P1-F

- заменить `ExclusiveInferenceBridge` как canonical owner одним application
  `ResourceGovernor` foundation. Может остаться временный compatibility adapter,
  но Chat, compaction и explicit model warm/load обязаны использовать один и тот
  же governor instance из composition context;
- не создавать второй queue/permit/owner внутри routes, model service, React или
  recovery coordinator. Один `context.governor` владеет admission и active
  leases для всех участвующих current entry points;
- default policy остаётся ровно одним local accelerator permit. Не добавлять
  measured parallelism или hardware heuristics. Сильное железо не даёт скрытого
  исключения;
- определить typed immutable admission request минимум с owner identity,
  operation kind, exact model reference, requested context, priority и enqueue
  time. Для durable Chat owner identity — canonical `jobId`; compatibility
  operations получают безопасный process-local operation ID, а не fake Job;
- ввести typed admission ticket и idempotent active lease. Lease содержит owner,
  model/context request, acquired/released timestamps и state, но не prompt,
  output, reasoning, tool/provider body, secret или filesystem path;
- deterministic order должен быть доказан. Для первого slice допустим FIFO
  внутри единственного supported priority, либо accepted target priorities с
  явной starvation policy. Не вводить сложный scheduler без тестируемой причины;
- cancellation waiting ticket удаляет только этого waiter. Cancellation после
  acquire принадлежит execution owner; lease release идемпотентен и происходит
  на completed/failed/cancelled/interrupted/storage/provider/timeout/shutdown и
  generator return;
- Chat Job остаётся `queued` до начала admission claim, затем canonical
  `reserving`; `loading` начинается только после получения lease. Не использовать
  `reserving` как доказательство фактической model residency;
- P1-E startup ordering сохранить: сначала reconciles весь unsafe startup set,
  затем schedule-ит untouched queued в стабильном `(createdAt,id)` order. Новый
  governor не должен запустить queued adapter до завершения reconciliation;
- generic public Job без typed adapter остаётся queued и не получает ticket;
- два Chat Jobs одного thread и разные threads не входят в Ollama одновременно.
  Compaction и warm/load не обходят Chat lease, а Chat не обходит уже active
  compaction/warm lease;
- explicit unload/stop model не должен уничтожать модель, пока governor видит
  active lease этого exact model либо current conservative single-lane owner.
  Вернуть controlled safe conflict; не притворяться, что external Ollama clients
  уже известны;
- дать узкую internal snapshot/explanation boundary для tests и следующего API
  slice: queued tickets, active lease, decision code, observedAt и policy basis.
  Это application observation, не hardware fit и не `/api/ps` fact;
- snapshot не должен расти без границ: released tickets/leases удаляются либо
  сохраняются только bounded diagnostic window. Не добавлять новый arbitrary UI
  ceiling;
- graceful shutdown перестаёт принимать новые tickets, abort-ит current owners,
  освобождает lease/controller и сохраняет P1-E truthful interrupted/cancelled
  projection. Новые acquire после close получают controlled failure;
- current application один process. Не заявлять host-wide/multi-process safety:
  внешний Ollama client и второй Alamo process этот foundation ещё обходят;
- migration 6 не нужна, если queue intent остаётся canonical Job state, а leases
  process-local. Если вводится durable lease journal, migration только additive;
  обязательны fresh/v5→v6/failed+reopen fixtures, stale lease recovery и
  rollback note. Не добавлять migration только ради in-memory diagnostics;
- обновить current-state docs и Mermaid/source diagram, если component/state
  boundary изменилась.

## Admission result P1-F

```text
typed request
→ one application governor queue
→ deterministic admission decision/explanation
→ one active lease
→ model-affecting operation
→ idempotent release on every terminal/error/abort/shutdown path
```

P1-F — conservative single-process governor foundation. Он должен заменить
анонимный mutex typed ownership, но ещё не обещает фактический host fit,
resident-model truth или safe parallelism.

## Required deterministic evidence

- exact inventory test доказывает, что current Chat, compaction и warm/load
  используют один governor instance; ни один прежний bridge path не остаётся;
- два cross-thread Chat и два same-thread Chat вызывают fake Ollama максимум по
  одному, с deterministic enqueue/admit order;
- Chat ↔ compaction, Chat ↔ warm/load и compaction ↔ warm/load matrix не имеет
  overlap;
- waiting cancellation удаляет одного ticket, не abort-ит active owner и не
  теряет следующего waiter;
- active cancellation, connect/load/idle timeout, provider/protocol/storage
  failure, terminal CAS failure и generator return всегда освобождают lease;
- repeated release/cancel/close минимум 10 раз не передаёт permit дважды и не
  оставляет active/queued diagnostics;
- unload exact active model и conservative unknown-owner conflict отклоняются до
  Ollama stop call; после release unload проходит. Error не содержит model
  prompt/provider body/path/secret;
- snapshot/explanation показывает exact owner/job/operation/model/context,
  queue reason, policy basis и observedAt; не называет RAM/VRAM fit measured;
- bounded diagnostic retention доказан большим числом acquire/release без
  линейного роста live state;
- P1-E recovered queued order проходит через governor после полного
  reconciliation; unsafe/cancelling recovery не создаёт ticket/lease;
- graceful close не пишет `stopped_by_user` для internal shutdown, закрывает
  admission и освобождает active lease;
- duplicate submit/cancel/detach/reattach P1-D, P1-E startup repeats,
  P1-A–P1-C store/subscription и P0-D timeout gates остаются зелёными;
- browser gate остаётся существующим mocked P0/P1-D smoke, если public Web
  projection не меняется. Не называй React remount Governor или hardware test.

## Non-goals

- не добавлять `/api/ps` reconciliation, external-instance ownership, telemetry,
  RAM/VRAM reservation, Apple/NVIDIA fit или remote hardware profile;
- не добавлять measured parallelism, multiple accelerator permits, model
  co-residency, priority preemption, prewarm, pin, idle TTL/LRU или auto-unload;
- не добавлять полный Runtime API/Bar, Jobs screen, queue dialog или новый IA;
- не добавлять checkpoint resume, generic worker registry, arbitrary public Job
  execution, retry/scheduler policy или multi-process lock;
- не добавлять Application Service/daemon, CLI/TUI Job commands или autostart;
- не добавлять catalog/capability/import, retention, notification, Project,
  Recipe, Artifact, Agent/MCP/Skills, branding или locale expansion;
- не использовать live Ollama, реальную модель, public network, user DB или
  реальные workspace files в deterministic suite;
- не называть fake Ollama hardware validation, process-local lease host-wide
  safety или sampled snapshot continuous truth.

## Validation

Уточни новый Governor test filename в плане и сохрани exact counts:

```bash
npm run typecheck
node --test packages/server/test/job-contract.test.ts \
  packages/server/test/job-migration.test.ts \
  packages/server/test/job-store.test.ts \
  packages/server/test/job-service.test.ts \
  packages/server/test/job-routes.test.ts \
  packages/server/test/chat-job-execution.test.ts \
  packages/server/test/chat-job-recovery.test.ts \
  packages/server/test/resource-governor.test.ts
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

В финальном evidence укажи exact counts, request/ticket/lease states, ordering,
10x repeats, diagnostic bound, unload behavior, shutdown release, какие entry
points реально подключены и какие browser actions реально проверены. Отдельно
назови, что `/api/ps`, live hardware, external clients и multi-process safety не
проверены и не реализованы.

После успешной независимой проверки:

- обнови current-state runtime/HLD/LLD/development/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A–P1-E evidence и добавь только P1-F;
- не отмечай всю Phase 1 завершённой: `/api/ps` reconciliation, telemetry,
  prewarm/unload policy, Runtime Bar и resource UX ещё впереди;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий bounded Phase 1 slice
  `/api/ps` reconciliation + runtime snapshot либо оставь P1-F с blocker и
  recovery steps;
- сделай небольшие conventional commits для governor/lifecycle, tests и docs.

Если typed priority semantics, unload ownership или durable lease journal требует
нового product decision, не угадывай. Сначала реализуй меньший accepted
single-permit/FIFO foundation, а спорную часть оставь явным residual scope; P1-F
блокируй только при конкретном несовместимом invariant и failing fixture.

В финале сообщи status `successful` либо `blocked`, commits, admission/lease
ownership, exact tests, failures, residual risks и что `NEXT_AGENT_PROMPT.md`
полностью переписан.
