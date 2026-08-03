# Low-level design

**Статус:** mixed — current implemented, target accepted/not implemented

**Проверено:** 2026-08-03

## Current package design

### `packages/contract`

Исходник: [lld-contract.mmd](diagrams/lld-contract.mmd).

- `schemas.ts`: models, hardware fit, health, threads/messages, settings,
  workspaces, tool calls, approvals и durable Job/event records;
- `api.ts`: route paths и request/response Zod;
- `events.ts`: Chat SSE union, Job lifecycle envelope и private Chat replay
  output;
- `index.ts`: public exports.

Current capability enum: completion, tools, vision, insert, thinking, embedding.
Current thread mode: chat или agent. Message содержит content/thinking/tools/usage
и P0-B bridge fields `turnStatus/turnError/stopReason`. P1-D добавляет optional
`jobId`, который связывает durable Job с user/assistant pair. P0-D добавляет
source/time health, catalog freshness, sampled running rows и stable
connect/load/stream-idle error categories.

P1-G добавляет typed additive `RuntimeSnapshot`: один `observedAt`, source health,
current Governor admission projection, nullable observed models и stable
reconciliation decisions. `models: []` означает successful empty sample;
`models: null` — controlled unavailable/incompatible source. Runtime digest
остаётся observed `/api/ps` fact, а artifact identity явно `unknown`.

P1-H additive добавляет `host` с отдельными static profile/dynamic sample,
provenance/confidence и explicit available/missing fields, а каждой runtime row
— `currentFit`. `observed` означает только текущую exact loaded configuration
при достаточных Apple host facts; это не future admission guarantee. Production
Apple adapter пока публикует current fit как `unknown`, потому что официальный
pressure/available-memory source не подтверждён.

P1-K additive расширяет Governor operation/priority contract значениями
`model_prewarm`/`prewarm`, сохраняя parser compatibility для прежнего
normal-only snapshot. Strict request/response schemas для
`POST /api/models/:name/prewarm` фиксируют exact digest, Chat context, fit
level/basis, short `2m` keep-alive и typed warmed/reused/skipped/cancelled reason.
Settings получает additive `prewarmEnabled`; отсутствие старого key означает
`true`.

P1-L additive добавляет `ModelObservationKey` version 1 и
`complete | unavailable(reason)` projection в Runtime model/decision. Legacy
snapshots default-ятся в `legacy_snapshot`/`unknown`; complete key обязан
соответствовать `artifactIdentity: exact_digest`. Key компоненты — `ollama`,
normalized exact reference, artifact digest, context, sourced Ollama version и
stable local Apple hardware fingerprint без private CPU/device strings.

P1-M additive добавляет `positiveSafeIntegerSchema`, sourced
`ModelContextLimit` и controlled `context_limit_exceeded`. Thread/settings/model
query/warm/prewarm boundaries принимают любой positive JavaScript safe integer,
но sourced declared maximum отклоняет запрос без clamp; absent/conflicting
provider declarations остаются unknown. Legacy model responses получают
additive unknown default. P2-B freshness также defaults в unknown; SQLite
migration 7 используется только новым evidence store, старые clients её
игнорируют.

P2-A additive добавляет `InstalledModelDescriptor`: canonical/unknown Ollama
reference, exact/unknown artifact identity, installation observation и
source-preserving capability evidence. Legacy `LocalModel`/`ModelDetail`
ответы default-ятся в explicit unknown. Реализованы только provider states
`declared | degraded | unknown`; `verified/claimed/probe/override` остаются
target. Unknown enum не фильтруется в ложную пустую декларацию.

P1-A добавил canonical Job states, terminal states, kind, safe structured
error/outcome metadata и persisted event envelope. P1-C добавил strict public
create/query/cancel/path/cursor schemas, Job route constants, response schemas и
typed Job SSE event data. P1-D добавил optional Chat idempotency key, immutable
input snapshot и private typed Chat output внутри Job event. Public caller не
передаёт storage scope или privacy classification.

### `packages/server`

Исходник: [lld-server.mmd](diagrams/lld-server.mmd).

- `app.ts`: Hono composition, health, routes, SPA;
- `context.ts`: Ollama client, stores, tools, approvals, один
  `ResourceGovernor` и один `ChatJobExecutionOwner`;
- `runtime/resource-governor.ts`: typed immutable request/ticket, один
  process-local permit, normal-before-prewarm admission, active lease, bounded
  live snapshot/explanation, unload guard и graceful close;
- `runtime/prewarm.ts`: bounded exact selection/residency validation,
  lowest-priority admission, exact-owner abort и short-TTL Ollama warm;
- `runtime/observation-key.ts`: canonical exact-reference normalization,
  versioned hash components и typed unavailable reasons;
- `runtime/reconciliation.ts`: process-local shared `/api/ps`, `/api/tags`,
  `/api/version` + host telemetry single-flight, common timestamp linearization,
  exact artifact matching, independent source failure redaction, current fit
  explanation и compatibility projection;
- `http/runtime-routes.ts`: additive `GET /api/runtime` sampled query;
- `http/models-routes.ts`: list/show/pull/delete/explicit warm/prewarm/unload/
  running;
- `http/threads-routes.ts`: CRUD, durable Chat command/compatibility SSE, stop,
  compact;
- `http/workspaces-routes.ts`: current filesystem workspace CRUD;
- `models/service.ts`: installed `/api/tags`, sampled `/api/ps`, sourced
  `/api/version`, digest-aware LRU на 64 normalized references и не более четырёх
  параллельных `/api/show` workers на installed-list projection;
- `models/catalog.ts`: validated stale local cache + dated bundled snapshot,
  без remote request;
- `hardware/probe.ts` и `fit.ts`: legacy local profile/estimate и static fit;
- `hardware/telemetry.ts`: один injectable host boundary; bounded Apple Silicon
  `vm_stat` adapter, strict parser и explicit unsupported/partial/failure states;
- `agent/loop.ts`: ordered turn/tool loop;
- `store/db.ts`: `node:sqlite` migrations;
- migration 3: nullable Message terminal bridge с evidence-based legacy backfill;
- migration 4: additive `jobs`/`job_events`, scoped idempotency, per-Job sequence
  и unique terminal event constraint;
- migration 5: additive `messages.job_id`, private `chat_job_inputs` и optional
  classified private output в `job_events`;
- migration 6: additive exact-key `model_calibration_observations`; legacy
  `model_calibration` остаётся readable, но не участвует в measured fit;
- migration 7: additive `installed_model_evidence_cache` с safe normalized JSON,
  exact identity, original observation, validation/expiry/stale timestamps и
  no-backfill rollback compatibility;
- `store/calibration.ts`: complete-key-only record и same-artifact/runtime/
  hardware context curve; changed identity получает отдельную row;
- `store/jobs.ts`: atomic create + initial event, ordered replay page, event
  sequence CAS, canonical non-terminal state + lifecycle event CAS и terminal
  state + event CAS;
- `jobs/lifecycle.ts`: exact non-terminal/terminal edges из canonical diagram;
- `jobs/service.ts`: application create/get/transition/append/terminal boundary и
  persisted-first `AsyncIterable` subscription с bounded SQLite pages, terminal
  close и canonical cancel operation;
- `jobs/chat-execution.ts`: process-local Chat Job owner, request fingerprint,
  canonical state progression, persisted output/chunking и cancellation
  acknowledgement;
- `jobs/chat-recovery.ts`: pre-listen recovery coordinator, stable keyset scan,
  recovery-only terminal edges и bounded latest-pending Message reducer;
- `http/jobs-routes.ts`: public create/query/replay/cancel boundary, server-owned
  idempotency scope, controlled error mapping и pull-based Job SSE;
- `store/threads.ts`: atomic pending-to-terminal compare-and-set и compaction
  boundary по persisted `seq`;
- `tools/*`: jail, filesystem и bash.

### Current installed-model fact inventory

| Fact/surface | Source и observation | Confidence/identity | Staleness/failure | Current consumer |
| --- | --- | --- | --- | --- |
| Installation/name/size/details/digest | local `/api/tags`, request completion time | observed installation; digest exact либо unknown | no persistent cache; route failure controlled | installed list, detail, fit, descriptor |
| Capability field | `/api/tags`, тот же installation sample | provider-declared; exact digest basis возможен | missing/malformed/future value → unknown | legacy capabilities и descriptor |
| Architecture/capability detail | local `/api/show`, first response time | provider-declared; exact cache write only after tags/version revalidation | LRU 64 + SQLite v7; 15m fresh, 7d stale/offline; four workers + per-key flight | context limit, fit, detail, descriptor |
| Loaded instance | local `/api/ps`, sampled time | observed runtime row; exact only through P1-L reconciliation | failure remains `models:null`; no history | Runtime Bar, fit/calibration |
| Runtime version | local `/api/version`, response time | observed runtime fingerprint либо unknown | request-scoped, failure independent | observation key и descriptor basis |
| Catalog claim | local stale cache or dated bundled snapshot | claimed/bundled, not runtime fact | explicit stale/fallback/unavailable | Marketplace only, P2-A unchanged |
| Legacy `capabilities` | filtered known `/api/tags` values | compatibility projection, not evidence decision | unknown/malformed → empty legacy array | old Web/clients |
| Context facts | `/api/tags`/`/api/show` declarations | declared maximum либо unknown/conflict | LRU time preserved; no guessed ceiling | settings/list/detail/validation |
| Canonical reference | P1-L normalizer over provider name | registry/name/tag/digest syntax preserved | invalid/duplicate → unknown/ambiguous | descriptor/cache/observation key |
| Web evidence projection | additive REST descriptor | declared/degraded/unknown + fresh/stale/offline/unknown | loading/empty/error remain separate | installed card/profile, locale keys |

`/api/tags` и `/api/show` declaration не являются runtime proof. Name-based
`/api/show` lookup не выполняется для duplicate normalized references; даже при
одной row transient detail declaration имеет `detail_not_bound_to_digest`.
P2-B exact cached projection получает digest basis только после bounded
before/after validation; identity change не пишет row. Store принимает только
allowlisted capability/context/architecture values. Full history, controlled
probes и registry service не реализованы.

`ChatJobExecutionOwner` ограничивает один active Chat Job на thread и владеет
Stop controller, включая ожидающий Job. `activeTurns` остаётся compatibility
mirror, но routes не используют его как lifecycle owner. Application-wide
exclusion принадлежит одному `context.governor`. Его lease используют Chat,
compaction, explicit model warm/load и automatic prewarm; unload отклоняется при
exact active lease и консервативно при любом другом active single-lane owner.
Normal intent отменяет queued prewarm либо вызывает abort hook только exact
active prewarm owner и ждёт release. Prewarm не допускается при normal work и не
abort-ит normal owner. Tickets, leases, `ApprovalGate` и controllers не durable.

Один `RuntimeReconciliationService` входит в application context рядом с
Governor. `GET /api/runtime` и `GET /api/models/running` используют этот service,
поэтому overlapping callers создают не больше одного `/api/ps` request и одного
host probe. Caller abort прекращает только его ожидание. Provider и host sample
стартуют вместе; после завершения обоих выбирается общий `observedAt` и
синхронно снимается Governor snapshot — это linearization point. Ошибка одного
source не уничтожает факты другого. Completed result не кэшируется; stale state
не публикуется, следующий call делает новые samples.

Один `JobStore`, `JobService` и `ChatJobExecutionOwner` входят в application
context; public Job и Chat routes используют один service. Store синхронно
сериализует writers через SQLite `BEGIN IMMEDIATE`; Job create и terminalization
откатываются целиком, если event insert не состоялся; то же верно для
non-terminal transition, включая `startedAt`. Первый успешный выход из `queued`
задаёт `startedAt`, поздние transitions его сохраняют. Одинаковая пара
`idempotency_scope/idempotency_key` возвращает canonical Job. Event metadata
ограничена плоскими JSON scalars и не предназначена для prompt, reasoning,
secrets или workspace content.

Chat create расширяет эту границу: одна transaction создаёт Job/initial event,
user/pending-assistant pair и immutable private input association. Server-owned
scope содержит thread ID; SHA-256 fingerprint связывает key с canonical input.
Duplicate возвращает ту же association, а conflicting input не пишет ничего.
Private Chat output хранится отдельно от safe metadata и читается только через
typed `privacyClassification: private_chat` boundary.

`JobService` проверяет terminal edge до store CAS. Subscription регистрирует
process-local wake-up до replay, но всегда отдаёт сами events из SQLite по
sequence. Wake-ups coalesced, поэтому slow subscriber не блокирует writer и не
накапливает unbounded event queue; AbortSignal удаляет только listener.

Job HTTP handler валидирует UUID и decimal safe-integer cursor до subscription.
`after` и `Last-Event-ID` могут совпадать, но conflict даёт `400`. Каждый SSE
frame получает `id`, равный persisted sequence, и полный `jobStreamEventSchema` в
`data` с additive private output. `ReadableStream.pull` ограничивает буфер одним
frame. Terminal replay
закрывает stream, включая reattach после terminal tail; cancel/disconnect stream
не вызывает Job cancel command.

Public create всегда использует `local-api:v1`: duplicate key возвращает тот же
Job без второго initial event. Public cancel reason ограничена
`user_requested`. Queued cancel фиксирует `cancelling → cancelled`; active Job
остаётся `cancelling` до execution-owner acknowledgement. P1-D Chat owner такое
acknowledgement выполняет; generic Job без adapter остаётся `cancelling`.
Terminal и уже cancelling ответы идемпотентны.

Chat owner persist-ит output event до wake-up, делит UTF-8 delta на chunks не
больше 16 KiB и не держит in-memory output queue. Terminal Chat transaction
одновременно обновляет pending assistant, Job и terminal event/output. Stop из
thread route и cancel из Job route сходятся в owner; `cancelling` фиксируется до
abort, а `cancelled` — после его подтверждения. Subscriber abort owner не
останавливает.

### `packages/web`

Исходник: [lld-web.mmd](diagrams/lld-web.mmd).

- `App.tsx`: application health gate, degraded Ollama notice, persistent sampled
  Runtime Bar и Models/Chat/Settings shell;
- `components/ErrorBoundary.tsx`: root, keyed Chat и Runtime containment с diagnostics;
- `lib/router.tsx`: custom History API routing;
- `lib/api.ts`: REST, compatibility POST/SSE и canonical Job GET/GET SSE/cancel;
- `lib/sse.ts`: frame parser с Chat `seq` и Job `sequence` cursor;
- `lib/locale.ts`: locale keys для boundary с English fallback/Russian;
- `features/health/RuntimeContext.tsx`: один persistent shell owner shared
  Runtime projection;
- `features/health/RuntimeStatus.tsx`: typed read-only lease/FIFO/runtime-model/
  host/current-fit projection с compact disclosure и feature containment;
- `features/health/useRuntimePolling.ts`: один abortable HTTP wait, один timer,
  active/queued 2 s, idle 10 s, hidden pause, visible refresh без overlap и
  caller-scoped fresh wait без abort shared request;
- `features/chat/useChat.ts`: page projection, caller-supplied per-send UUID key,
  HTTP command acceptance и durable Job discovery/reattach;
- `features/chat/useModelPrewarm.ts`: exact-selection debounce, visibility/
  setting/normal-work cleanup и caller-owned bounded prewarm request;
- `features/chat/ResourceConflictDecision.tsx`: sampled conflict state machine,
  safe Queue default, exact Job revalidation/cancel/terminal acknowledgement,
  bounded own reads и localized accessible dialog;
- `features/chat/streamBuffer.ts`: rAF-buffered content/thinking;
- `features/chat/ChatPage.tsx`: create, timeline, composer, context/tool UI и
  one-intent conflict dispatch boundary с exact custom context validation;
- `features/launcher`/`models`: installed/catalog/profile, preset suggestions,
  keyboard custom context, sourced maximum/unknown explanation и P2-A installed
  evidence state/source/time; Marketplace projection не менялась;
- `features/context`: usage, cache, speed и compact;
- `features/agent`: workspace/approval/tool cards;
- `features/settings`: runtime/tool/theme fields и exact positive safe-integer
  default agent context без UI maximum.
- `test/component` и `test/browser`: P0-A cleanup/boundary/first-stream, P0-B
  terminal/error/reload, P0-D health, P1-I Runtime Bar/polling и P1-J
  conflict/TOCTOU/idempotency/accessibility, P1-K debounce/cleanup/priority и
  P1-M no-artificial-caps/P2-A descriptor regression; browser использует
  deterministic mocked REST/SSE/runtime snapshots.

### `packages/cli`

Исходник: [lld-cli.mmd](diagrams/lld-cli.mmd).

CLI parses port/host/no-open, проверяет existing health, запускает server в
foreground и открывает browser. Durable service lifecycle/TUI/API client нет.

## Current sequence и Governor limits

1. Chat command атомарно создаёт queued Job, initial event, private input и
   Message pair до начала execution.
2. Application owner резервирует per-thread controller, переводит Job в
   `reserving` и ждёт typed process-local lease; Chat, compaction и explicit
   model warm/load выполняются в normal FIFO, а auto prewarm — в lowest-priority
   lane того же permit.
3. Lifecycle и private output persist-first; HTTP subscribers читают SQLite по
   sequence и не владеют execution.
4. Client crash/navigation только disconnect-ит subscriber; remount/hard reload
   находит Job по pending Message и replay-ит его с sequence 0.
5. Provider error и EOF без terminal chunk сохраняются как `failed`; partial
   content/thinking остаются в atomic terminal Message/Job projection.
6. Explicit Stop/cancel сначала сохраняет `cancelling`, затем единственный
   cancelled terminal outcome; disconnect не является cancel.
7. Connect заканчивается при response headers; load ждёт первый валидный stream
   event или non-stream model response; idle обновляется каждым валидным event.
8. Timeout сохраняет точный safe error, а explicit Stop остаётся authoritative
   cancellation; lease освобождается в обоих случаях.

`OllamaClient` пробрасывает signal abort для cancellation classification и
оборачивает прочие ошибки чтения body как provider failure. Если terminal
rehydrate падает, `useChat` сохраняет live partial buffer в idle state с явной
неподтверждённой меткой и accessible alert.

Migration 3 оставляет старые rows без usage в `NULL`, а usage-backed rows
backfill-ит как `completed/legacy_terminal_chunk`. Terminal update меняет только
`pending`, поэтому повторный late completion не перезаписывает failure/cancel.
Если запись terminal state падает, completed SSE не отправляется; `pending`
остаётся наблюдаемым recovery state.

P0-A по-прежнему отвечает за безопасный effect и root/Chat Error Boundaries.
P1-F lease освобождается после terminal/error/abort/generator return. Повторная
compaction выбирает prefix после admission и использует реальный persisted
`seq`. P0-D добавляет sampled `/api/ps` projection, но не ownership, lease или
доказательство unload между observations.

P1-D отделяет Chat execution от POST/SSE connection и подключает Message bridge
к durable Job records/replay/cancel. Generic public create без Chat adapter
остаётся `queued`. P1-E сканирует только durable Chat associations после SQLite
migration и до listen. `reserving/loading/prefill/thinking/generating/
waiting_tool/waiting_approval/finalizing` получают recovery-only
`interrupted`, `cancelling` — `cancelled`; untouched `queued` schedule-ится
существующим owner после полного reconciliation pass.

P1-G/P1-H сохраняют консервативный P1-F Governor, но добавляют sampled
reconciliation, host facts и explanation, не admission automation. Active lease
сопоставляется только с первой row по exact normalized Ollama reference;
ambiguous duplicates оставляют current fit unknown. Отсутствие lease digest не доказывает
artifact identity. Unmatched row получает owner `unknown`, active lease без row
— `active_not_observed`. Само observation state не запускает load/unload и не
меняет admission. Production pressure/available-memory observation, durable
observation keys/history, lease journal, measured parallelism и multi-process
lock отсутствуют.

P1-I заменяет Web compatibility projection `/api/models/running` на typed
`api.runtimeSnapshot()`. Persistent shell component показывает только один live
lease, FIFO waiters, sampled models, independent Ollama/host states и
observed/unknown current fit; это не durable Jobs history и не admission owner.
Refresh не очищает confirmed sample. Navigation/unmount отменяет только текущий
HTTP wait; resource action не вызывается. Compatibility route и contract
остаются для старых clients.

P1-J сохраняет один poller в `RuntimeProvider`; on-demand `refresh(..., true)`
либо делит pending request, либо после него делает один новый sample. Abort
dialog caller прекращает только его wait. Composer создаёт intent UUID до
проверки и повторно использует его при explicit Queue retry. Exact Stop делает
fresh Runtime verify, `GET Job`, не более одного `POST cancel`, bounded terminal
poll и затем не более одного Chat POST. Stale/operation/unknown/changed owner не
отменяется. Серверный Governor остаётся единственным admission/FIFO owner.

P1-K New Chat вычисляет exact operation context до model query, поэтому fit и
prewarm request относятся к одному context. `useModelPrewarm` ждёт 600 ms
стабильного Chat selection, требует exact installed digest и green/yellow fit,
не запускается hidden/disabled/normal-busy и очищает timer/controller на
selection, mode, visibility или route change. Server заново проверяет installed
facts, setting, sampled runtime и Governor в точке admission. Exact один
resident name+digest+context даёт reuse без Ollama call; ambiguous identity —
skip. Bounded warm использует `2m` и не меняет explicit warm response/`10m`.
Runtime Bar показывает operation/priority как process operation; P1-J игнорирует
prewarm-only conflict и никогда не предлагает из-за него Stop current Job.

Current admission request фиксирует owner (`jobId` либо process-local operation
ID), `chat | compaction | model_warm | model_prewarm`, exact Ollama model name,
requested context, priority `normal | prewarm` и enqueue time. Ticket проходит
`queued → active → released` либо `queued → cancelled`; release/cancel/close
идемпотентны. Snapshot хранит
только live queue, одну active lease и одну последнюю decision, поэтому
diagnostics не растут с числом завершённых operations. P1-L сохраняет только
один pending reconciliation Promise, но exact calibration samples пишет через
migration 6. Legacy rows не backfill-ятся, потому что digest/runtime/hardware
для них недоказуемы. Rollback code может перестать читать новую table, а schema
и rows остаются forward-compatible; failed migration transaction сохраняет
`user_version=5`, после устранения conflicting schema повторный open применяет
её заново. Lease journal, durable runtime sample history и client-side resource
lock не вводились.

## Target module boundaries

### Application command/query API

Первые четыре Job routes ниже implemented в P1-C; `GET /api/runtime` implemented
в P1-G. Current P1-K route — `POST /api/models/:name/prewarm`; target
`/api/runtime/models/:id/prewarm` ниже остаётся proposed и не является alias.
Остальные route names остаются proposed до соответствующего ADR/API review.

```text
POST /api/jobs
GET  /api/jobs/:jobId
GET  /api/jobs/:jobId/events?after=:sequence
POST /api/jobs/:jobId/cancel
POST /api/jobs/:jobId/approvals/:approvalId

GET  /api/runtime
GET  /api/runtime/models
POST /api/runtime/models/:id/prewarm
POST /api/runtime/models/:id/unload

GET  /api/models/installed
GET  /api/marketplace
GET  /api/capabilities/:fingerprint
POST /api/capabilities/:fingerprint/probes

CRUD /api/projects
CRUD /api/chats
CRUD /api/recipes
GET  /api/artifacts/:id

POST /api/models/imports/ollama-reference
POST /api/models/imports/hugging-face
GET  /api/models/imports/:jobId

GET  /api/service
POST /api/service/restart
GET  /api/notifications
POST /api/notifications/:id/read
```

Create Job принимает:

```ts
type CreateJobCommand = {
  idempotencyKey: string;
  kind: "inference" | "agent" | "tool" | "pipeline";
  operation: string;
  projectId?: string;
  chatId?: string;
  recipeId?: string;
  modelSelection: ModelSelection;
  inputs: ArtifactInput[];
  parameters: Record<string, unknown>;
  retention: RetentionPolicy;
  notificationPolicy?: NotificationPolicy;
};
```

Response `202` возвращает Job projection и event subscription URL. Validation
ошибка — до создания Job; runtime/admission ошибка — terminal Job с events.

### Job Engine

```ts
interface JobService {
  create(command: CreateJobCommand): Promise<Job>;
  get(jobId: string): Promise<Job>;
  cancel(jobId: string, reason?: string): Promise<Job>;
  approve(jobId: string, approval: ApprovalDecision): Promise<void>;
  recover(): Promise<RecoveryReport>;
}

interface JobEventStore {
  append(
    jobId: string,
    expectedNextSequence: number,
    event: NewJobEvent,
  ): Promise<JobEvent>;
  read(
    jobId: string,
    afterSequence: number,
    limit: number,
  ): Promise<JobEvent[]>;
  subscribe(
    jobId: string,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<JobEvent>;
}
```

Правило: event сначала durable, затем broadcast. Slow subscriber не блокирует
execution; он получает replay по sequence.

### Scheduler и Resource Governor

```ts
interface ResourceGovernor {
  enqueue(request: AdmissionRequest): Promise<AdmissionTicket>;
  acquire(ticket: AdmissionTicket, signal: AbortSignal): Promise<ResourceLease>;
  release(leaseId: string): Promise<void>;
  reconcile(): Promise<RuntimeSnapshot>;
  explain(ticketId: string): Promise<AdmissionExplanation>;
}

type AdmissionRequest = {
  jobId: string;
  model: ModelFingerprint;
  contextLength: number;
  parallelism: number;
  priority: "interactive" | "normal" | "background" | "prewarm";
  resourceHints: ResourceHints;
};
```

First implementation — single in-process scheduler. DB хранит Job/queue intent;
lease heartbeat/journal помогает recovery. Distributed locking не вводится.

### Capability Registry

```ts
interface CapabilityRegistry {
  describe(model: ModelFingerprint): Promise<ModelDescriptor>;
  addEvidence(evidence: CapabilityEvidence): Promise<void>;
  resolveOperation(
    model: ModelFingerprint,
    operation: string,
  ): Promise<OperationResolution>;
  invalidate(predicate: FingerprintPredicate): Promise<number>;
}
```

Resolution содержит `supported | degraded | unknown | unsupported`, evidence и
adapter candidates. `unknown` может предложить controlled probe, но не запускает
heavy load во время active Job.

### Adapter Registry

```ts
interface TaskAdapter {
  readonly id: string;
  readonly version: string;
  supports(descriptor: ModelDescriptor, operation: string): SupportDecision;
  validate(command: CreateJobCommand): ValidationResult;
  estimate(command: CreateJobCommand): ResourceHints;
  execute(context: AdapterExecutionContext): AsyncIterable<AdapterEvent>;
}
```

Adapter не пишет UI/DB напрямую. Он получает abort, lease, immutable Job snapshot
и artifact writer. Event mapper нормализует provider stream.

Первая последовательность adapters:

1. Ollama chat/completion/thinking/tools;
2. transcription как extensibility proof;
3. TTS/vision/OCR/image только с реальным provider contract;
4. generic JSON-Schema adapter.

### Catalog providers

```ts
interface CatalogProvider {
  readonly id: string;
  search(query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage>;
  resolve(
    reference: ModelReference,
    signal: AbortSignal,
  ): Promise<CatalogModel>;
}
```

Provider обязан сообщить legal/automation policy, source URL, fetchedAt, TTL,
schema version и pagination. Aggregator:

- применяет timeout/AbortSignal;
- ограничивает concurrency;
- валидирует данные;
- дедуплицирует, не теряя provenance;
- отдаёт stale cache при сбое;
- никогда не блокирует installed list.

Ollama Marketplace provider не scrape-ит human HTML.

#### Ollama reference import

Input принимает только:

- canonical model name;
- URL официальной model page, из которого parser локально извлекает canonical
  name.

Server не fetch-ит произвольный URL. После preview/confirmation Job вызывает
documented local pull. Recent reference может стать локальной catalog entry.

#### Hugging Face GGUF import

```ts
type HuggingFaceImportRequest = {
  repoId: string;
  revision: string;
  filename: string;
  targetModelName: string;
};
```

Pipeline:

1. resolve official HF metadata;
2. validate immutable revision и exact file;
3. dry-run size/cache/fit;
4. show license/gated status;
5. resumable download в managed staging;
6. checksum и GGUF format inspection;
7. generate internal Modelfile with staged local path;
8. create model through Ollama adapter;
9. probe/descriptor;
10. remove staging согласно cache policy.

Path не принимается напрямую от remote metadata. Gated token хранится в protected
secret adapter и не попадает в Job Events.

### Artifact Service

```ts
interface ArtifactWriter {
  begin(metadata: ArtifactDraft): Promise<ArtifactSink>;
  commit(sinkId: string): Promise<Artifact>;
  abort(sinkId: string): Promise<void>;
}
```

Blob пишется во временный файл, хэшируется и atomically перемещается. DB row
создаётся/финализируется после blob commit. Download проходит через validated
artifact id, а не произвольный filesystem path.

### Integration Policy

```ts
type Effect = "read" | "write" | "execute" | "network" | "secret";
type Scope = "global" | "project" | "recipe" | "job";

interface PolicyService {
  resolve(
    subject: IntegrationSubject,
    context: PolicyContext,
  ): Promise<EffectivePolicy>;
  decide(
    request: EffectRequest,
    decision: UserDecision,
  ): Promise<PolicyDecision>;
}
```

Approval имеет durable status, scope, requester, input digest, preview, decision,
time и executor result. Изменившийся input digest требует нового approval.

### First-party Agent Engine

Компоненты: [lld-agent-target.mmd](diagrams/lld-agent-target.mmd).

```ts
type AgentApprovalMode = "manual" | "auto_within_policy";

interface AgentEngine {
  start(command: StartAgentRunCommand): Promise<Job>;
  resume(checkpointId: string, overrides: RunOverrides): Promise<Job>;
  compact(runId: string): Promise<Artifact>;
  verify(runId: string, gate: VerificationGate): Promise<VerificationResult>;
}
```

Agent step сохраняет expected plan/checkpoint version до tool dispatch. Mutating
tool получает idempotency/effect record; после crash recovery effect не
повторяется без подтверждённого result.

Auto mode проверяет immutable policy snapshot на каждом tool call. Подключение
нового MCP/Skill создаёт новое user decision и snapshot version.

### Retention и Maintenance

Lifecycle: [retention-state.mmd](diagrams/retention-state.mmd).

Chat/Quick Run metadata:

```ts
type RetentionPolicy =
  | { mode: "keep" }
  | {
      mode: "ttl";
      expiresAt: string;
      refreshOn: "user_activity";
    }
  | { mode: "session"; sessionId: string };
```

Новый Chat всегда создаётся с TTL семь дней от последней user activity, включая
Chat внутри Project. `Keep` задаётся только явным изменением policy.

Нужны indexes по `expires_at`, `deleted_at` и live references. Maintenance Job
работает bounded batches:

```text
eligible → tombstoned → trash grace → metadata delete → orphan blob GC
```

User activity обновляет TTL; model/tool/maintenance/background events — нет.
Уход пользователя из Session Chat делает его eligible после terminal state
связанной Job; reload/reconnect не считаются уходом. Active/non-terminal Job
блокирует tombstone. Session Trash grace равен 24 часам. Policy change до hard
delete снимает tombstone.

Reasoning Artifact получает default `expires_at = created_at + 7 days`; shorter
parent retention wins.

### Notifications

Terminal Job transaction создаёт deduplicated notification row:

```ts
type Notification = {
  id: string;
  jobId: string;
  outcome: "completed" | "failed" | "cancelled" | "interrupted";
  policy: "off" | "when_background" | "always";
  createdAt: string;
  readAt?: string;
};
```

Client-local delivery state отдельно отмечает visual/sound channel. Повторный
SSE/reload не воспроизводит sound второй раз. Notification payload не содержит
prompt, reasoning или output content.

## Persistence status

Migrations 4–5 и `JobStore` реализуют `jobs`, `job_events`, private
`chat_job_inputs` и additive Message association. Остальные target tables ниже
не реализованы. Legacy `threads/messages/workspaces` сохранены без destructive
backfill или route cutover.

Логические таблицы:

| Table                   | Назначение                                        |
| ----------------------- | ------------------------------------------------- |
| `projects`              | project metadata/defaults                         |
| `chats`                 | persistent conversations                          |
| `chat_entries`          | user/assistant/artifact references и status       |
| `recipes`               | versioned reusable config                         |
| `jobs`                  | lifecycle, snapshot, idempotency, terminal result |
| `job_events`            | append-only replay sequence                       |
| `job_dependencies`      | pipeline DAG                                      |
| `artifacts`             | type/checksum/storage/derivation                  |
| `model_variants`        | provider/digest/quantization metadata             |
| `capability_evidence`   | provenance/confidence/fingerprint                 |
| `resource_observations` | measured memory/load/runtime                      |
| `resource_leases`       | recovery journal                                  |
| `integrations`          | MCP/skill/tool metadata without exposed secret    |
| `bindings`              | scoped enablement/policy                          |
| `approvals`             | durable effect decision                           |
| `notifications`         | terminal Job notification/read state              |
| `maintenance_runs`      | cleanup cursor/count/error evidence               |
| `service_state`         | install/schema metadata, не PID source of truth   |

Current `threads/messages/workspaces` нельзя просто удалить:

1. добавляются nullable `job_id`, status/error fields либо projection bridge;
2. new Job flow dual-reads existing history;
3. Workspace становится filesystem binding;
4. backfill выполняется bounded и restart-safe;
5. legacy routes сохраняются до client cutover;
6. cleanup — отдельная поздняя migration.

## Job state and transitions

Canonical diagram: [job-state.mmd](diagrams/job-state.mmd).

Terminal states: `completed`, `failed`, `cancelled`, `interrupted`.
`waiting_approval` не держит accelerator lease, если adapter может безопасно
checkpoint/release; иначе имеет timeout и явную resource cost.

`interrupted` не является обычной runtime failure edge. Current P1-E разрешает
её только recovery coordinator из `reserving/loading/prefill/thinking/
generating/waiting_tool/waiting_approval/finalizing`; обычный
`JobService.terminalize` эти edges отклоняет. Persisted `cancelling` остаётся
отдельной принятой user command и завершается как `cancelled`.

Недопустимо:

- `completed → running`;
- две terminal events;
- output success без terminal event;
- автоматический retry mutating tool;
- replay create command вместо reattach.

## Error taxonomy

| Category              | Пример                           | Retry                  |
| --------------------- | -------------------------------- | ---------------------- |
| `validation`          | input/schema/capability mismatch | после user change      |
| `admission`           | queue full/policy denied         | policy-dependent       |
| `resource`            | measured insufficient memory     | другой variant/context |
| `runtime_unavailable` | Ollama offline                   | bounded/background     |
| `runtime_protocol`    | EOF without terminal chunk       | bounded if safe        |
| `cancelled`           | user/preemption/shutdown         | explicit new Job       |
| `tool_denied`         | approval denied                  | workflow-dependent     |
| `tool_failed`         | executable/file/network failure  | effect-aware           |
| `storage`             | DB/blob commit failure           | recovery path          |
| `client_projection`   | React render/crash               | Job continues          |

UI показывает stable code, human message, retryability и Job ID. Raw prompt,
thinking, secrets и file content не включаются по умолчанию.

## Web projection

Target frontend layers:

```text
router/layout
  → query cache + Job event client
  → domain projections
  → feature screens
  → operation workbench registry
  → UI primitives/error boundaries
```

Event client:

- сохраняет last applied sequence;
- ignores duplicates;
- detects gaps и читает replay;
- подписка отменяется без cancel Job;
- explicit cancel вызывает command API;
- terminal projection затем сверяется с `GET /jobs/:id`.

Thinking renderer получает отдельную policy и Markdown sanitizer. Long stream
парсится incrementally/chunked; auto-scroll уважает user position.

## CLI/service design

Компоненты: [lld-service-target.mmd](diagrams/lld-service-target.mmd).

Stable non-interactive primitives предшествуют TUI:

```text
alamo status [--json]
alamo start [--detach] [--port ...]
alamo stop
alamo open
alamo models list|pull|load|unload
alamo jobs list|show|cancel|events
alamo chat
alamo agent
alamo config get|set
alamo service autostart enable|disable|status
```

No-args TUI вызывает их через shared client library. First-party `alamo agent`
создаёт Agent Run через тот же Job API и поддерживает slash command discovery.
Application service state определяется health/control API + process identity, не
только открытым портом. Stop Alamo не останавливает external Ollama по default.

Service control и settings:

- Web/CLI/TUI читают одну canonical store;
- restart-sensitive patch возвращает preview;
- controlled restart перестаёт принимать Jobs, checkpoint/cancel по policy,
  закрывает DB, перезапускает process и проходит health verification;
- macOS/Linux autostart adapters opt-in и имеют uninstall/rollback.

## Versioning

- REST/SSE schema: additive first, explicit compatibility window;
- DB: monotonic `user_version`;
- Recipe/adapter snapshot: adapter id+version;
- Model evidence: digest+Ollama version+backend+hardware+probe;
- Artifact: immutable checksum;
- brand/display name: config, не protocol identity;
- unknown upstream fields: preserve/ignore safely.
