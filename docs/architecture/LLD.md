# Low-level design

**Статус:** mixed — current implemented, target accepted/not implemented

**Проверено:** 2026-08-02

## Current package design

### `packages/contract`

Исходник: [lld-contract.mmd](diagrams/lld-contract.mmd).

- `schemas.ts`: models, hardware fit, health, threads/messages, settings,
  workspaces, tool calls и approvals;
- `api.ts`: route paths и request/response Zod;
- `events.ts`: turn SSE union;
- `index.ts`: public exports.

Current capability enum: completion, tools, vision, insert, thinking, embedding.
Current thread mode: chat или agent. Message содержит content/thinking/tools/usage
и P0-B bridge fields `turnStatus/turnError/stopReason`. Эти поля описывают
connection-owned turn projection, но не durable Job/run id.

### `packages/server`

Исходник: [lld-server.mmd](diagrams/lld-server.mmd).

- `app.ts`: Hono composition, health, routes, SPA;
- `context.ts`: Ollama client, stores, tools, approvals, `activeTurns` и один
  `ExclusiveInferenceBridge`;
- `runtime/exclusive-inference.ts`: process-local one-owner FIFO admission без
  durability/priority/recovery;
- `http/models-routes.ts`: list/show/pull/delete/warm/unload/running;
- `http/threads-routes.ts`: CRUD, POST/SSE turn, stop, compact;
- `http/workspaces-routes.ts`: current filesystem workspace CRUD;
- `models/service.ts`: `/api/tags` + unbounded parallel `/api/show`;
- `models/catalog.ts`: defunct upstream search, local cache, bundled snapshot;
- `hardware/*`: local host probe и static fit model;
- `agent/loop.ts`: ordered turn/tool loop;
- `store/db.ts`: `node:sqlite` migrations;
- migration 3: nullable Message terminal bridge с evidence-based legacy backfill;
- `store/threads.ts`: atomic pending-to-terminal compare-and-set и compaction
  boundary по persisted `seq`;
- `tools/*`: jail, filesystem и bash.

`activeTurns` ограничивает одинаковый thread и хранит Stop/connection
controllers, включая ожидающий turn. Host-wide exclusion принадлежит отдельному
bridge. Его permit совместно используют turn, compaction и explicit model
warm/load; waiters, `ApprovalGate` и active controllers не durable.

### `packages/web`

Исходник: [lld-web.mmd](diagrams/lld-web.mmd).

- `App.tsx`: health gate и Models/Chat/Settings;
- `components/ErrorBoundary.tsx`: root и keyed Chat containment с diagnostics;
- `lib/router.tsx`: custom History API routing;
- `lib/api.ts`: REST + current POST/SSE;
- `lib/sse.ts`: frame parser;
- `lib/locale.ts`: locale keys для boundary с English fallback/Russian;
- `features/chat/useChat.ts`: page-owned turn state;
- `features/chat/streamBuffer.ts`: rAF-buffered content/thinking;
- `features/chat/ChatPage.tsx`: create, timeline, composer, context/tool UI;
- `features/launcher`/`models`: installed/catalog/profile;
- `features/context`: usage, cache, speed и compact;
- `features/agent`: workspace/approval/tool cards;
- `features/settings`: runtime/tool/theme fields.
- `test/component` и `test/browser`: P0-A cleanup/boundary/first-stream и P0-B
  terminal/error/reload regression; browser использует deterministic mocked
  REST/SSE.

### `packages/cli`

Исходник: [lld-cli.mmd](diagrams/lld-cli.mmd).

CLI parses port/host/no-open, проверяет existing health, запускает server в
foreground и открывает browser. Durable service lifecycle/TUI/API client нет.

## Current sequence и bridge limits

1. Turn request резервирует per-thread controller и ждёт process-local permit.
2. User row и empty assistant со status `pending` создаются только после
   admission.
3. Chat turn, compaction и model warm/load выполняются в одной FIFO lane.
4. Client crash/disconnect вызывает abort и P0-B сохраняет
   `cancelled/connection_aborted`.
5. Provider error и EOF без terminal chunk сохраняются как `failed`; partial
   content/thinking остаются в той же atomic terminal projection.
6. Reload показывает pending/completed/failed/cancelled либо legacy unknown.

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
P0-B не отделяет execution от POST/SSE connection: navigation всё ещё может
cancel. P0-C не меняет ownership, но отменяемый waiter не сохраняет rows до
admission, а permit освобождается после terminal/error/abort/generator return.
Повторная compaction выбирает prefix после admission и использует реальный
persisted `seq`.

Bridge не является Resource Governor: нет durable queue, leases, priorities,
timeouts, `/api/ps` reconciliation, restart recovery или measured parallelism.

## Target module boundaries

### Application command/query API

Ниже logical API. Имена routes остаются proposed до ADR/API review.

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

## Proposed persistence

Точные DDL и migration order определяются в implementation plan. Логические
таблицы:

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
