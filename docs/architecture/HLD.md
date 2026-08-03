# High-level architecture

**Статус:** mixed — as-is implemented/locally validated, target accepted

**Проверено:** 2026-08-03
**Решение:** сохранить local-first modular monolith

## Обозначения

- **As-is** — поведение, подтверждённое кодом и локальным аудитом.
- **Target** — принятая архитектура; её компоненты ещё нельзя считать
  реализованными.
- **Ollama host** — процесс/runtime Ollama; может быть локальным или удалённым.
- **Application host** — процесс Alamo server/daemon.

## As-is

Исходник диаграммы: [hld-system-as-is.mmd](diagrams/hld-system-as-is.mmd).

```text
Browser ─ REST + POST/GET SSE ─> Node/Hono server ─ HTTP/NDJSON ─> Ollama
                                  │
                                  ├─ SQLite ~/.alamo/alamo.db
                                  ├─ workspace filesystem
                                  └─ local shell

CLI ─ foreground start/open ──────┘
Contract package ─ Zod types ─ browser + server
```

Это локальный модульный монолит из четырёх npm workspaces:

| Компонент  | Ответственность                                    |
| ---------- | -------------------------------------------------- |
| `contract` | Zod domain/API/event schemas                       |
| `server`   | Hono composition, stores, Ollama, agent и tools    |
| `web`      | React UI и typed REST/SSE client                   |
| `cli`      | foreground launcher и reuse уже запущенного server |

Ollama — отдельный runtime и фактический владелец model weights/RAM/VRAM.
SQLite хранит settings, threads/messages, workspaces, tool journal, calibration,
`jobs`/`job_events` и P1-D private Chat input association. Message bridge хранит
`pending/completed/failed/cancelled`, safe error, stop reason и `jobId`. Public
Job API читает canonical records, replay-ит persisted events через GET SSE и
выполняет explicit cancel поверх одного `JobService`. Chat execution подключён
к тому же service через один application `ChatJobExecutionOwner`; controller,
subscriber wake-ups, typed Resource Governor tickets/leases и approvals остаются
в памяти, но command intent, lifecycle и replay output находятся в SQLite. P1-E
startup coordinator bounded-страницами reconciles v5 Chat associations до HTTP
listen.

### As-is execution boundary

Текущий `POST /threads/:id/messages`:

1. валидирует thread, immutable input и optional UUID idempotency key;
2. одной transaction создаёт queued Chat Job, initial event, private input и
   user/pending-assistant pair;
3. передаёт Job application execution owner, который один владеет controller;
4. возвращает compatibility SSE subscription на persisted Job events.

Owner проходит canonical states, создаёт immutable admission request и ждёт
одну process-local Resource Governor lease, запускает Ollama stream и сначала
persist-ит каждый private output event. Тот же `context.governor` выдаёт lease
для compaction и explicit model warm/load. Второй Chat Job имеет durable
ID/events и продолжает работу после subscriber disconnect, но tickets/leases
всё ещё process-local и не восстанавливаются при restart.

Browser disconnect/route change закрывает только subscription. При возврате Web
находит `jobId` в pending assistant, читает canonical Job и replay-ит ordered
private output из SQLite. Explicit Stop и public cancel проходят через owner:
durable `cancelling`, provider abort, затем один `cancelled/stopped_by_user`.
Assistant projection и terminal Job/event commit-ятся атомарно; injected failure
не публикует completed.

После открытия/migration SQLite, но до публикации HTTP health, startup recovery
сначала сканирует все non-terminal typed Chat Jobs в стабильном порядке. Unsafe
executing states становятся `interrupted`, persisted `cancelling` подтверждается
как `cancelled`, и только untouched `queued` без execution/output evidence
schedule-ится существующим owner. Partial Message собирается из ordered private
output; Message, Job и terminal output commit-ятся одной transaction. Malformed
association/output или storage failure закрывает DB и не начинает listen.

Provider adapter ограничивает connect, load и stream-idle отдельно. Валидный
stream progress обновляет только idle deadline; timeout сохраняет failed partial
outcome и освобождает active lease. Caller-owned Stop/disconnect имеет
приоритет над совпавшим deadline.

Application shell остаётся доступным при degraded Ollama. `/api/version`,
локальный catalog cache/bundled snapshot и `/api/ps` публикуются как раздельные
sampled observations с source/time. Installed state приходит из `/api/tags`;
loaded rows — только из `/api/ps`. P1-G добавил один application
`RuntimeReconciliationService`: `GET /api/runtime` и compatibility
`GET /api/models/running` делят pending provider sample. После его завершения
service одним `observedAt` снимает Governor state и классифицирует exact
normalized active reference, unmatched active lease и unknown-owner runtime
rows. Completed sample/cache/history не хранится и background polling нет.

### As-is deployment

- CLI запускает application server в foreground;
- server раздаёт API и production SPA с одного loopback origin;
- Vite в dev проксирует API;
- daemon/PID/control socket нет;
- bind на non-loopback технически возможен, но security profile не реализован.

### As-is data ownership

| Состояние                            | Владелец                                | Durability                  |
| ------------------------------------ | --------------------------------------- | --------------------------- |
| Threads/messages/settings/workspaces | SQLite stores                           | persistent                  |
| Message terminal bridge              | SQLite `messages` v3 columns            | persistent                  |
| Job/event/output store               | SQLite `jobs`/`job_events` v5           | persistent                  |
| Chat input/Message association       | SQLite `chat_job_inputs`/`messages`     | persistent                  |
| Chat execution owner                 | application `ChatJobExecutionOwner`     | process memory, intent в DB |
| Chat startup recovery                | application startup coordinator         | bounded scan, truth в DB    |
| Job HTTP subscription listeners      | application `JobService`                | process memory, events в DB |
| Tool run record                      | SQLite                                  | persistent после выполнения |
| Active/waiting Chat controller       | `ChatJobExecutionOwner`                 | process memory              |
| Resource admission/active lease      | application `ResourceGovernor`          | process memory              |
| Runtime reconciliation/sample        | `RuntimeReconciliationService`          | process memory, без history |
| Pending approval                     | `ApprovalGate`                          | process memory              |
| Chat/Job SSE output                  | SQLite event output + HTTP subscription | persistent private replay   |
| Streaming projection                 | React `StreamBuffer`                    | page memory                 |
| Loaded model                         | Ollama                                  | external runtime            |
| Catalog response                     | stale local cache/bundled snapshot      | sampled fallback            |
| Binary assets                        | отдельной canonical store нет           | partial/not implemented     |

### Основные current risks

1. Process-local Governor показывает sampled `/api/ps` drift, но не координирует
   внешний Ollama client или второй Alamo process и не считает неизвестного
   владельца внешним установленным фактом.
2. P1-F поддерживает только один `normal` FIFO lane без priority/backpressure;
   bounded timeout освобождает request, но не координирует provider вне этого
   application process.
3. `keep_alive: 10m` удерживает модели после turn; route не является unload.
4. P1-E восстанавливает single-process Chat truth после restart, но не даёт
   checkpoint/resume executing inference и не координирует второй process.
5. Generic public Job без Chat adapter остаётся queued и не исполняется.
6. Private input/output находится в локальной SQLite без отдельного encryption
   boundary; plaintext settings уже остаются известным долгом.
7. Remote bind открывает filesystem/shell boundaries без реальной authentication.
8. Fit не описывает совместное размещение, current pressure и remote hardware.
9. `/api/runtime` не содержит host telemetry/fit и не является continuous truth.
10. Catalog не имеет разрешённого live provider; local cache и bundled snapshot
   могут отставать.

Подробности: [RUNTIME_LIFECYCLE](RUNTIME_LIFECYCLE.md).

## Target

Исходник: [hld-system-target.mmd](diagrams/hld-system-target.mmd).

### Архитектурный стиль

Сохраняется один application process и SQLite. Внутри процесса вводятся
application modules с явными контрактами:

```text
Web / CLI / TUI / Agent CLI
       │
API + event subscriptions
       │
Background Application Service
├── Project / Chat / Recipe
├── Job Engine + Event Store
├── Resource Governor
├── Capability Registry
├── Adapter Registry
├── Catalog Service
├── Agent Engine
├── Maintenance / Notifications
├── Integration Policy
└── Artifact Service
       │
Infrastructure adapters
├── SQLite
├── content-addressed artifact store
├── Ollama
├── host telemetry
├── filesystem/sandbox
└── allowed external providers
```

Microservices, network broker и distributed database не нужны текущему
single-user scale. Модульные границы нужны для correctness и разных клиентов, а
не для разнесения процессов.

### Target components

#### Job Engine

- создаёт Job идемпотентно;
- персистит status и append-only events;
- отделяет execution от connection;
- поддерживает attach/replay/cancel;
- восстанавливает interrupted Jobs после restart;
- оркестрирует pipeline и tool checkpoints.

#### Resource Governor

- единственный admission point для local inference;
- держит global queue и accelerator permits;
- выдаёт model leases;
- согласует desired state с Ollama `/api/ps`;
- принимает host telemetry;
- выполняет preload/eviction/unload policy;
- объясняет решения UI.

#### Capability Registry

- нормализует model identity, variants, operations и evidence;
- сохраняет declared/inferred/probed/user claims;
- строит runtime fingerprint;
- не превращает unknown в unsupported;
- предоставляет descriptors Adapter Registry и Marketplace.

#### Adapter Registry

- маппит Operation Descriptor на provider protocol;
- валидирует input/parameters;
- переводит stream в нормализованные Job Events;
- создаёт typed Artifacts;
- сообщает renderer/schema/UI hints без hardcoded model-name branches.

#### Catalog Service

- агрегирует разрешённые providers;
- валидирует schemas;
- хранит cache/freshness/provenance;
- использует stale-while-revalidate;
- отделяет discovery claim от installability/runtime verification.
- нормализует user-supplied Ollama name/page URL;
- ищет и скачивает exact Hugging Face GGUF через официальный API;
- не выполняет Ollama catalog scraping.

#### Agent Engine

- предоставляет независимый coding-first API/CLI;
- ведёт plan, bounded steps, checkpoints и verification;
- исполняет Manual или Auto-within-policy runs;
- использует Project filesystem/MCP/Skills bindings;
- не зависит от Claude Code/Codex executable или protocol identity.

#### Artifact Service

- хранит metadata в SQLite;
- большие blobs — в content-addressed local filesystem;
- поддерживает derivation, preview, export, retention и garbage collection;
- не передаёт большие media через бесконечные JSON rows.

#### Integration Policy

- управляет Tools, MCP Connections и Skills;
- вычисляет effective permissions по scope;
- персистит approvals/audit;
- разделяет local и remote security profiles.

#### Maintenance и Notifications

- Maintenance Job применяет Chat/Artifact expiry при startup и по расписанию;
- Trash/grace отделяет expiry от окончательного удаления blobs;
- terminal Job создаёт local notification record;
- Web/TUI решают visual/sound delivery по policy и permissions.

### Clients

Web, non-interactive CLI, TUI и first-party Agent CLI используют один API и одни
application semantics. TUI не управляет процессом через scraping stdout.
Background Application Service имеет control surface для
`start/status/stop/restart/open`, переживает закрытие terminal и опционально
стартует при login. Ollama service остаётся отдельной сущностью.

## Ключевые flows

### Job create и subscription

Исходник: [hld-runtime-target.mmd](diagrams/hld-runtime-target.mmd).

1. Client отправляет validated create command с idempotency key.
2. Job Engine транзакционно создаёт Job и первый event.
3. Client получает `202 + jobId`.
4. Client подписывается `GET /jobs/:id/events?after=seq`.
5. Governor admitting Job выдаёт/ожидает resource lease.
6. Adapter исполняет operation через Ollama/другой allowed provider.
7. Events сохраняются до broadcast.
8. Output становится Artifact/message projection.
9. Terminal state и final event фиксируются атомарно.

Connection может исчезнуть между любыми шагами: Job продолжает выполняться, а
client позднее replay events.

### Составная voice-команда

```text
Audio Artifact
  → STT Job
  → Transcript Artifact/draft
  → user confirmation
  → Chat Job
  → Text Artifact/message
```

Governor может выгрузить speech model перед Chat model; Workbench показывает
pipeline progress, не притворяясь одним непрерывным model call.

### Import GGUF из Hugging Face

```text
HF URL/search
  → metadata + revision + file list
  → user selects GGUF
  → dry-run size/fit/license preview
  → resumable download
  → checksum/format inspection
  → local Ollama GGUF import
  → capability probe
  → installed descriptor with provenance
```

Никакой remote model code не исполняется. Safetensors conversion и adapters
требуют отдельных capabilities.

### Retention cleanup

1. Startup/periodic trigger создаёт bounded Maintenance Job.
2. Job выбирает expired Chat/Artifacts, исключая active work.
3. Records получают tombstone/Trash timestamp.
4. После grace удаляются только blobs без живых references.
5. Audit event фиксирует count/bytes/errors; retry идемпотентен.

## Consistency и availability

Single process + SQLite даёт простую strongly consistent application state в
пределах процесса:

- создание Job + initial event — одна transaction;
- terminal state + terminal event — одна transaction;
- event sequence unique per Job;
- cancellation command идемпотентен;
- external Ollama state eventually reconciled через polling/events;
- filesystem blob commit использует temporary write + checksum + atomic rename,
  после чего metadata transaction;
- orphan blobs удаляются только safe garbage collector.

При недоступном Ollama UI остаётся доступным для истории/settings/catalog cache и
показывает degraded runtime. Недоступность внешнего catalog не блокирует
installed models.

## Capacity model

Это single-user, но memory-constrained system. Главные размеры:

- model artifact weights;
- KV cache от context × parallelism × cache type;
- multimodal projector/encoder;
- runtime/backend overhead;
- host reserve и текущая pressure;
- media artifacts и stream buffers.

Default — один local accelerator Job. Measured parallelism является accepted
поздней policy: Governor может допустить второй Job только по fresh joint
reservation. Масштабирование означает не высокий RPS, а:

- больше installed descriptors;
- более длинные contexts;
- более крупные models;
- очередь долгих Jobs;
- второй inference host в будущем.

Один high-memory host может иметь несколько devices и не получает искусственных
UI limits. Multi-host scheduler не проектируется до реального второго host и
измеренных требований. `Remote Ollama` использует telemetry удалённого host, а
не Mac клиента.

## Supported deployment tiers

- Tier 1: macOS Apple Silicon;
- Tier 2: Linux/NVIDIA, Ubuntu и Fedora family;
- Deferred: Windows/WSL;
- Application Service и autostart используют platform adapters;
- Ollama daemon остаётся externally managed на каждом tier.

## Security boundaries

### Local profile

- loopback-only;
- origin/CSRF checks для state-changing API;
- allowed filesystem roots;
- tool effect classification;
- Manual и Auto-within-policy approvals;
- secrets не возвращаются client;
- reasoning и file content редактируются в logs.

### Remote profile

Отдельный режим, а не `--host 0.0.0.0`:

- authentication и authorization;
- TLS либо trusted reverse proxy contract;
- secure secret store;
- restricted tools и filesystem roots;
- explicit CORS/origin;
- request/rate/size limits;
- SSRF egress allowlist;
- remote hardware profile;
- session revocation и audit.

До реализации remote profile non-loopback agent/tools deployment считается
unsupported.

### External content

Model cards, catalogs, MCP data, documents и tool outputs — недоверенный content.
Они не становятся system instructions и не расширяют permissions. Gated models и
licenses требуют явного user action.

## Observability

Локальный diagnostics bundle может включать:

- app/runtime versions и platform fingerprint;
- Job lifecycle без private prompt/reasoning по default;
- queue/lease decisions;
- Ollama request timing/error categories;
- model digest/context/resource observations;
- DB migration version;
- client crash/error boundary correlation ID.

Export выполняется только пользователем и показывает preview/redaction.

Current P0-A Web уже создаёт локальный client correlation ID и показывает
timestamp, route, error type и component stack в root/Chat Error Boundary.
Автоматический diagnostics bundle/export и корреляция с будущим `jobId` ещё не
реализованы.

P0-B Web показывает persisted Message outcome/error/stop reason, включая
partial failure, cancellation, pending и legacy unknown. Raw provider body и
endpoint credentials в persisted error не попадают. Если terminal rehydrate
не удался, live partial buffer остаётся видимым как неподтверждённый и не
изображается сохранённым success.

## Evolution

Переход выполняется вертикальными slices, а не big-bang:

1. стабилизировать текущий first-turn flow;
2. ввести durable Job для Chat;
3. поставить Resource Governor перед Chat;
4. перенести current events на replay subscription;
5. добавить Capability Registry/installed models;
6. ввести background service и scriptable CLI primitives;
7. построить first-party coding Agent MVP;
8. только после text/agent foundation добавлять STT, затем image;
9. long-running deliberate profile проходит отдельный benchmark;
10. remote/multi-host — отдельные поздние решения.

См. [ROADMAP](../plans/ROADMAP.md) и [ADR index](../decisions/README.md).
