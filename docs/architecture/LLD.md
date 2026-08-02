# Low-level design

**Статус:** mixed — current components implemented, target contracts proposed  
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
Current thread mode: chat или agent. Message содержит content/thinking/tools/usage,
но не durable execution status/run id/error.

### `packages/server`

Исходник: [lld-server.mmd](diagrams/lld-server.mmd).

- `app.ts`: Hono composition, health, routes, SPA;
- `context.ts`: Ollama client, stores, tools, approvals и `activeTurns`;
- `http/models-routes.ts`: list/show/pull/delete/warm/unload/running;
- `http/threads-routes.ts`: CRUD, POST/SSE turn, stop, compact;
- `http/workspaces-routes.ts`: current filesystem workspace CRUD;
- `models/service.ts`: `/api/tags` + unbounded parallel `/api/show`;
- `models/catalog.ts`: defunct upstream search, local cache, bundled snapshot;
- `hardware/*`: local host probe и static fit model;
- `agent/loop.ts`: ordered turn/tool loop;
- `store/db.ts`: `node:sqlite` migrations;
- `tools/*`: jail, filesystem и bash.

`activeTurns` ограничивает только одинаковый thread. `ApprovalGate` и active
controllers не durable.

### `packages/web`

Исходник: [lld-web.mmd](diagrams/lld-web.mmd).

- `App.tsx`: health gate и Models/Chat/Settings;
- `lib/router.tsx`: custom History API routing;
- `lib/api.ts`: REST + current POST/SSE;
- `lib/sse.ts`: frame parser;
- `features/chat/useChat.ts`: page-owned turn state;
- `features/chat/streamBuffer.ts`: rAF-buffered content/thinking;
- `features/chat/ChatPage.tsx`: create, timeline, composer, context/tool UI;
- `features/launcher`/`models`: installed/catalog/profile;
- `features/context`: usage, cache, speed и compact;
- `features/agent`: workspace/approval/tool cards;
- `features/settings`: runtime/tool/theme fields.

### `packages/cli`

Исходник: [lld-cli.mmd](diagrams/lld-cli.mmd).

CLI parses port/host/no-open, проверяет existing health, запускает server в
foreground и открывает browser. Durable service lifecycle/TUI/API client нет.

## Current sequence defects

1. User row сохраняется до inference.
2. Empty assistant row создаётся до Ollama `POST /api/chat`.
3. Client crash/disconnect вызывает abort.
4. Abort сохраняет empty assistant без error/status.
5. Reload показывает пустой ответ.

Кроме того, EOF без terminal Ollama chunk может пройти как успешный stop.
Повторная compaction вычисляет boundary по array length, а не реальному message
sequence. Это P0 defects, а не target semantics.

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

До разрешённого API Ollama Marketplace provider не scrape-ит human HTML.

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
```

No-args TUI вызывает их через shared client library. Application service state
определяется health/control API + process identity, не только открытым портом.
Stop Alamo не останавливает external Ollama по default.

## Versioning

- REST/SSE schema: additive first, explicit compatibility window;
- DB: monotonic `user_version`;
- Recipe/adapter snapshot: adapter id+version;
- Model evidence: digest+Ollama version+backend+hardware+probe;
- Artifact: immutable checksum;
- brand/display name: config, не protocol identity;
- unknown upstream fields: preserve/ignore safely.
