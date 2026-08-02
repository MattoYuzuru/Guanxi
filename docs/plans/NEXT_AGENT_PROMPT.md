# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-E — startup recovery и interrupted reconciliation

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
P1-A реализовал durable Job/event store, P1-B — canonical transitions и
persisted-first subscription, P1-C — public create/query/replay/cancel API, P1-D
— durable Chat execution owner, private output replay и Web detach/reattach.
Реализуй только slice `P1-E startup recovery and interrupted reconciliation`.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract/store: `138fb5e`, `91cb21f`, `92b68f0`;
- P1-B store/service/tests: `56b2200`, `55351bc`;
- P1-C public API: `4b9d96a`, `0a06ea6`;
- P1-D contract/storage: `da70576`;
- P1-D execution/Web: `08b3516`;
- P1-D deterministic evidence: `f33d5b9`;
- P1-D docs/status: commit непосредственно перед этим handoff prompt.

Не откатывай Error Boundaries, truthful Message terminal CAS, process-local
exclusive inference bridge, persisted compaction fix, sampled runtime
health/timeouts, SQLite migrations 1–5, scoped Job idempotency, canonical state
CAS, persisted-first subscription, strict public Job schemas, server-owned
idempotency scopes, pull-based HTTP backpressure, durable Chat output privacy,
16 KiB output chunking, atomic Job↔Message terminal transaction, disconnect-only
subscriber semantics или Web reattach без localStorage truth.

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
   `sre-agent:verification-strategy`, `sre-agent:reliability-testing`,
   `sre-agent:finding-validation` и `sde-agent:implementation-evidence` без
   обязательного делегирования.
4. До правок воспроизведи P1-D current state: exact durable Job/Chat files дают
   57/57; navigation detach и replay проходят, но новый application process не
   сканирует v5 non-terminal Chat Jobs. Не оставляй старый owner выполняться во
   время restart fixture: моделируй crash через закрытую DB/отдельный fixture,
   без настоящего signal или user DB.
5. До кода составь bounded plan с таблицей startup states, доказательством
   side-effect safety, Job↔Message/output projection reducer, transaction/CAS
   границами, scan pagination, startup ordering, repeated/crash-during-recovery,
   graceful shutdown semantics, privacy/redaction и точными validation commands.

## Scope P1-E

- добавить один application startup recovery boundary для Chat Jobs v5. Он
  выполняется после открытия/migration SQLite, но до listen/accept новых HTTP
  commands и до публикации healthy application state;
- scan только Job с durable Chat association. Generic public Jobs без typed
  adapter не запускать и не изображать recovered execution;
- читать non-terminal Chat Jobs bounded pages в стабильном порядке. Не загружать
  все Jobs/events/output в память и не создавать второй store/service/owner;
- выполнить reconciliation до scheduling: ни один recovered Job не должен начать
  Ollama, пока unsafe rows текущего startup ещё выглядят ghost-running;
- safe-to-start policy должна быть доказательной. Нормальный `queued` Chat Job с
  immutable input, pending assistant, `startedAt=null` и без execution/output
  evidence можно передать существующему owner ровно один раз. Не replay-ить
  model/tool side effects для `reserving`, `loading`, `prefill`, `thinking`,
  `generating`, `waiting_tool`, `waiting_approval` или `finalizing`;
- unsafe executing Chat Job после restart terminalize-ить как Job
  `interrupted`, как требует ADR-0004/RUN-007. Добавить только необходимые exact
  recovery terminal edges и matrix tests; не разрешать эти edges обычному
  runtime execution path через ad-hoc bypass;
- persisted `cancelling` означает уже принятую cancel command. После исчезновения
  process-owned adapter подтвердить её как один `cancelled`, не запускать Ollama
  и не добавлять второй cancel/terminal event;
- для `interrupted` Job existing Message contract может оставаться user-visible
  `failed/internal_error`, если это явно документировано как projection, а
  canonical Job остаётся `interrupted`. Не выдавать restart за user cancel или
  provider error. Если для truthful UX нужен новый Message outcome/error code,
  изменить contract/server/web согласованно и additive; не угадывать новый
  product flow;
- собрать partial final Message из persisted classified private output, а не из
  потерянной памяти. Reducer читает ordered bounded pages, применяет только output
  текущего/latest pending assistant после соответствующего `start.messageId` и
  сохраняет content, thinking, tool calls и usage без duplicate/truncation.
  Ранее terminalized tool-step Messages не переписывать;
- terminal recovery одной transaction/CAS согласует pending Message, terminal
  Job и ровно один terminal event/output. Crash до commit оставляет исходное
  non-terminal состояние для следующего startup; crash после commit повторно
  ничего не пишет;
- recovery terminal output остаётся typed `private_chat`, а safe Job metadata
  содержит только bounded machine facts вроде previous state/recovery reason.
  Prompt, partial output, reasoning, tool/provider body, secrets и paths не
  копировать в metadata, HTTP error или logs;
- malformed/incomplete Chat association, отсутствующий pending Message,
  malformed private output или permanent storage failure не должны приводить к
  healthy startup с ghost-running Job. Верни controlled/redacted startup failure,
  закрой DB/listener resources и не начинай HTTP accept; оставь durable rows для
  повторного безопасного recovery;
- два startup attempts и recovery после injected mid-scan/mid-terminal failure
  должны сходиться к одной terminal truth без duplicate sequence/output;
- при нескольких queued Chat Jobs сохранить один process-local inference lane и
  не выполнять два Job одного thread одновременно. Опиши deterministic ordering;
- исправить graceful server close/SIGTERM, если он сейчас записывает ложный
  `user_requested/stopped_by_user`. Внутренний shutdown должен bounded abort-ить
  owner и сохранить truthful `interrupted` (либо уже persisted cancellation), не
  притворяясь пользовательской командой. HTTP disconnect всё ещё не cancel;
- Web после restart читает canonical Job `interrupted`/`cancelled`, replay-ит
  сохранённый partial terminal output и rehydrate-ит согласованный Message. Не
  добавлять automatic retry/resubmit; retry остаётся новой явной attempt/key;
- сохранить один `context.jobService`, один execution owner и существующий P0-C
  permit. Recovery coordinator может быть отдельным узким module, но не generic
  worker registry, daemon или Resource Governor;
- migration 6 не нужна, если v5 хранит все необходимые факты. Если всё же нужна
  новая durable recovery data, migration только additive: не переписывать 1–5,
  обязательно fresh/v5→v6/failed+reopen/legacy fixtures и recovery note.

## Startup result P1-E

```text
open DB + migrations
→ bounded scan of v5 Chat associations
→ reconcile unsafe execution to interrupted
→ confirm persisted cancelling as cancelled
→ fail closed if any row cannot be reconciled safely
→ schedule only proven untouched queued Chat Jobs
→ start HTTP listener
→ Web GET Job + replay shows one canonical terminal/continued projection
```

P1-E выполняет honest single-process startup recovery, а не произвольный resume.
Он не превращает foreground CLI в background Application Service и не решает
multi-process ownership. Полный Resource Governor остаётся следующим slice.

## Required deterministic evidence

- fixture предыдущего process содержит каждый relevant non-terminal Chat state,
  partial output, pending Message и durable input association;
- untouched queued Job после startup вызывает один adapter call, продолжает
  canonical states и terminalize-ится; repeated recovery не запускает его второй
  раз;
- `reserving/loading/prefill/thinking/generating/waiting_tool/waiting_approval/
  finalizing` не вызывают Ollama/tools и становятся одним `interrupted` Job;
- persisted `cancelling` не вызывает Ollama и становится одним `cancelled` Job;
- terminal Jobs остаются byte-for-byte/event-count unchanged;
- partial token/thinking/tool/usage текущего assistant восстанавливаются из
  ordered SQLite output без duplicate; earlier tool-step Messages не меняются;
- Job, Message и recovery terminal event согласованы одной transaction. Trigger
  failure не публикует terminal event и следующий startup успешно повторяет
  reconciliation;
- recovery, повторённый минимум 10 раз на cancel/interrupted/terminal race
  fixtures, всегда оставляет ровно один terminal Job event и одну terminal
  Message projection;
- malformed association/output и injected SQLite failure дают safe startup
  failure до listen без SQL, prompt, secret, provider body или filesystem path;
- bounded scan/output page limits доказаны fixture больше одной page; slow HTTP
  subscriber не участвует в recovery ownership;
- несколько queued threads после recovery всё ещё выполняются по одному через
  P0-C permit; два queued Jobs одного thread не запускаются одновременно;
- graceful close не записывает `stopped_by_user`, не оставляет ghost running и
  освобождает permit/controller; simulated hard crash обрабатывается новым
  startup path;
- GET Job/SSE и Thread history после restart показывают matching
  interrupted/cancelled/completed truth и terminal stream закрывается;
- duplicate submit/cancel/detach/reattach P1-D, P1-A–P1-C store/subscription,
  P0-C/P0-D/P0-E gates остаются зелёными;
- Chromium fixture детерминированно доказывает hard restart boundary только если
  она реально моделируется двумя server fixture instances. Обычный React remount
  не называть server restart; если fixture server restart непропорционален,
  оставить browser P1-D gate и доказать P1-E server integration tests.

## Non-goals

- не auto-resume executing inference, tool call, approval или mutating effect;
- не добавлять generic worker registry, arbitrary public operation execution,
  scheduler priority, retry policy или checkpoint protocol;
- не добавлять Resource Governor, leases, `/api/ps` reconciliation, prewarm,
  unload, measured parallelism или multi-process lock;
- не добавлять Runtime Bar, Jobs screen, notification flow или новый product IA;
- не добавлять Project/Recipe/Artifact service, retention, Agent/MCP/Skills,
  model catalog/capabilities, branding или locale expansion вне recovery state;
- не добавлять background daemon, CLI/TUI Job commands или login autostart;
- не использовать live Ollama, реальную модель, public network, user DB или
  реальные workspace files в deterministic suite;
- не называть DB reopen production crash test, hardware validation или
  multi-process proof.

## Validation

Уточни новый recovery test filename в плане и сохрани exact counts:

```bash
npm run typecheck
node --test packages/server/test/job-contract.test.ts \
  packages/server/test/job-migration.test.ts \
  packages/server/test/job-store.test.ts \
  packages/server/test/job-service.test.ts \
  packages/server/test/job-routes.test.ts \
  packages/server/test/chat-job-execution.test.ts \
  packages/server/test/chat-job-recovery.test.ts
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

В финальном evidence укажи exact test counts, fixture states/page sizes, число
recovery repeats, startup-before-listen boundary, queued-vs-interrupted policy,
partial-output reducer, Job↔Message transaction и какие browser actions реально
проверены. Не называй fake Ollama hardware validation и не называй
process-local recovery background service.

После успешной независимой проверки:

- обнови current-state runtime/HLD/LLD/development/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A/P1-B/P1-C/P1-D evidence и добавь
  только P1-E;
- не отмечай всю Phase 1 завершённой: Governor/leases/Runtime Bar ещё впереди;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий bounded Phase 1 slice
  Resource Governor foundation либо оставь P1-E с blocker/recovery steps;
- сделай небольшие conventional commits для lifecycle/recovery, tests и docs.

Если truthful interrupted Message projection или recovery edge действительно
требует нового product decision, не угадывай. Сопоставь ADR-0004, RUN-007,
current contract и code; оставь P1-E blocked только с конкретным конфликтом,
failing fixture и безопасными recovery steps.

В финале сообщи status `successful` либо `blocked`, commits, startup ownership,
queued/interrupted/cancelling invariants, exact tests, failures, residual risks и
что `NEXT_AGENT_PROMPT.md` полностью переписан.
