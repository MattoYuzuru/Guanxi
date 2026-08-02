# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-D — durable Chat execution owner и compatibility bridge

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate,
P1-A реализовал durable Job/event store, P1-B — canonical transitions и
persisted-first subscription, P1-C — public create/query/replay/cancel API.
Реализуй только slice `P1-D durable Chat execution owner and compatibility
bridge`.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract/store: `138fb5e`, `91cb21f`, `92b68f0`;
- P1-B store/service/tests: `56b2200`, `55351bc`;
- P1-C public API: `4b9d96a`, `0a06ea6`;
- P1-C docs/status: возьми commit из текущего `git log` после handoff.

Не откатывай Error Boundaries, truthful Message terminal CAS, process-local
exclusive inference bridge, persisted compaction fix, sampled runtime
health/timeouts, SQLite migrations 1–4, scoped Job idempotency, canonical state
CAS, persisted-first subscription, strict public Job schemas, server-owned
`local-api:v1`, pull-based HTTP backpressure, terminal SSE close или cancel
semantics.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD, `docs/DOMAIN_MODEL.md`,
   `docs/TESTING.md`, accepted ADR-0001/0002/0004 и
   `docs/plans/OPEN_QUESTIONS.md`.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `architecture-agent:architecture-agent`, `sre-agent:verification-strategy`,
   `sre-agent:reliability-testing`, `sre-agent:finding-validation` и
   `sde-agent:implementation-evidence` без обязательного делегирования.
4. До правок воспроизведи current state: exact P1-A/P1-B/P1-C files дают 44/44,
   public Job SSE replayable и disconnect-safe, но новый public Job остаётся
   `queued`; current Chat POST/SSE всё ещё connection-owned и navigation abort
   terminalize-ит Message как `cancelled/connection_aborted`.
5. До кода составь bounded plan с data/transaction table, Job↔Message ownership,
   idempotency/fingerprint policy, lifecycle mapping, output-event privacy,
   compatibility flow, cancellation races, disconnect/reconnect, failure
   injection и точными validation commands.

Scope P1-D:

- добавить один application-level Chat Job execution owner в server composition;
  task/AbortController принадлежат ему по `jobId`, а не HTTP handler, React route
  или SSE subscriber;
- current Chat dispatch создаёт durable Job до исполнения и запускает его ровно
  один раз в текущем application process;
- public P1-C generic `POST /api/jobs` не должен сам изображать runnable command:
  без typed Chat input он остаётся queued;
- bridge current `POST /api/threads/:threadId/messages` к create + attach semantics
  с additive compatibility. Новый Web client передаёт stable idempotency key;
  повтор того же submit не создаёт второй Job, user Message, assistant Message или
  Ollama call;
- server определяет Chat idempotency scope из thread/operation; client не задаёт
  storage scope;
- добавить только необходимую additive migration 5 для durable Job↔Message/input/
  projection association. Не переписывать migrations 1–4. Fresh, v4→v5,
  interrupted migration/reopen и legacy rows обязательны;
- private prompt, reasoning, tool/provider body, secret и workspace content не
  помещать в `safeJobMetadata`. Если replay требует output payload, ввести
  отдельный typed contract/storage boundary с явной privacy classification и
  backward-compatible `null`/legacy form;
- Job event/output сначала сохраняется в SQLite, затем становится доступен live
  subscriber. Reconnect по sequence восстанавливает gap без duplicate output;
- terminal Job + terminal Message projection должны быть согласованы одной
  transaction либо иметь доказанный recovery-safe protocol, который никогда не
  показывает completed Job с pending/false-success Message;
- execution owner, а не subscriber, ждёт существующий P0-C exclusive inference
  permit и освобождает его на completed/provider/protocol/storage/cancel path;
- отобразить current Chat phases на canonical Job states без skipped/reverse edge.
  Новый Job начинает `queued`; admission/load/prefill/generation/finalization и
  terminal event остаются правдивыми, provider phase может жить отдельно;
- browser disconnect, route change и отмена GET SSE освобождают только subscriber.
  Inference продолжает выполняться, пока Job не terminal либо не получен explicit
  cancel;
- current `/threads/:id/stop` и новый Job cancel сходятся в один cancel owner.
  Cancel до admission не вызывает Ollama; active cancel сначала фиксирует
  `cancelling`, затем abort-ит adapter и только после подтверждённой остановки
  terminalize-ит `cancelled`; repeated cancel не добавляет event;
- reconnect/reload должен найти Job через persisted Thread/Message projection,
  attach к public GET SSE после last applied sequence и сверить terminal Job +
  Message через canonical GET. Не хранить canonical active Job только в React или
  localStorage;
- сохранить legacy Thread/history compatibility: pre-v5 rows читаются, старые
  clients не получают ad-hoc shape, а новый `jobId` additive/defaulted;
- использовать один `context.jobService` и один execution owner; не создавать
  route-local JobService/store/history/broadcast queue;
- bounded output buffering не должен превращать SQLite/event loop в unbounded
  token queue. Зафиксируй выбранный chunk/page policy и проверь ordered replay;
- обновить contract/server/web и deterministic component/browser fixtures только
  в пределах current Chat bridge.

Lifecycle result P1-D:

```text
POST Chat submit with idempotency key
→ atomic/recovery-safe Job + Message association
→ execution owner starts once
→ persisted Job events → public GET SSE
→ POST compatibility subscriber may detach
→ execution continues
→ terminal Job + Message projection
→ reload discovers jobId and reattaches/rehydrates
```

Этот slice отделяет Chat execution от browser connection только пока жив
application process. Startup recovery non-terminal Jobs остаётся следующим
slice, если не требуется минимальная interrupted marking для честного чтения.
Не называй P1-D background Application Service: CLI process пока foreground и
закрытие server process прекращает execution.

Required deterministic evidence:

- fresh/v4→v5/reopen/failed migration сохраняет legacy threads/messages и Job
  schema;
- duplicate Chat submit с одним key даёт один Job, один initial event, одну пару
  Messages и один adapter call;
- malformed body/key/thread rejected до Job/Message mutation;
- Job association доступна после reload без localStorage как source of truth;
- disconnect после start очищает только subscriber, Job продолжает transitions и
  Message становится terminal;
- route navigation и hard reload reattach по persisted sequence без gap,
  duplicate token/tool/usage или второго inference;
- event, committed во время replay/live handoff, наблюдается ровно один раз;
- slow/reconnecting client не блокирует producer и дочитывает SQLite tail;
- explicit cancel до admission не вызывает provider; active cancel даёт
  `cancelling → cancelled` после abort confirmation; repeated cancel не пишет;
- disconnect/cancel/terminal race имеет ровно один terminal Job event и одну
  terminal Message projection;
- provider error, missing `done:true`, load/idle timeout и storage injection
  terminalize-ят Job/Message правдиво и освобождают P0-C permit;
- terminal persistence failure никогда не публикует completed и имеет безопасный
  observable recovery state;
- два threads по-прежнему не выполняют local inference одновременно;
- output event/storage/HTTP errors не попадают в logs/error metadata и не
  раскрывают prompt, reasoning, provider body, secret или filesystem path;
- P1-A/P1-B/P1-C route/store/subscription/races и P0-C/P0-D/P0-E gates остаются
  зелёными;
- обновлённый Chromium test детерминированно доказывает
  `send → detach/navigation → Job continues → reattach/reload → terminal output`.

Non-goals:

- не добавлять generic worker registry, scheduler priority или arbitrary public
  operation execution;
- не реализовывать startup recovery/resume всех non-terminal Jobs сверх честного
  state, необходимого для P1-D consistency;
- не добавлять Resource Governor, leases, `/api/ps` reconciliation, prewarm,
  unload или measured parallelism;
- не добавлять Runtime Bar, Jobs screen, notification flow или новый product IA;
- не добавлять Project/Recipe/Artifact service, retention, Agent/MCP/Skills,
  model catalog/capabilities, branding или locale work;
- не добавлять background daemon, CLI/TUI Job commands или multi-process lock;
- не использовать live Ollama, реальную модель, public network или user DB в
  deterministic suite;
- не называть mocked Hono/Chromium fixture production restart recovery.

Validation (уточни новые exact filenames в плане):

```bash
npm run typecheck
node --test packages/server/test/job-contract.test.ts \
  packages/server/test/job-migration.test.ts \
  packages/server/test/job-store.test.ts \
  packages/server/test/job-service.test.ts \
  packages/server/test/job-routes.test.ts \
  packages/server/test/chat-job-execution.test.ts
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

В финальном evidence укажи exact test counts, migration fixtures, число повторов
duplicate/cancel/terminal races, Job↔Message transaction boundary, detach/
reattach envelope и какие browser actions реально проверены. Не называй fake
Ollama hardware validation и не называй process-local owner background service.

После успешной независимой проверки:

- обнови current-state runtime/HLD/LLD/development/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A/P1-B/P1-C evidence и добавь только
  P1-D;
- не отмечай всю Phase 1 завершённой;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под P1-E startup recovery и
  interrupted reconciliation либо оставь P1-D с blocker/recovery;
- сделай небольшие conventional commits для contract/storage/execution, tests и
  docs.

Если atomic Job↔Message terminalization, persisted output privacy или backward-
compatible Chat idempotency требуют нового product decision, не угадывай. Оставь
P1-D blocked, укажи конфликтующие sources, failing fixture и безопасные recovery
steps.

В финале сообщи status `successful` либо `blocked`, commits, ownership/
idempotency/cancel invariants, detach/reattach evidence, exact tests, failures,
residual risks и что `NEXT_AGENT_PROMPT.md` полностью переписан.
