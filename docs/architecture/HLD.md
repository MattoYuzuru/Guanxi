# High-level architecture

**Статус:** mixed — as-is implemented/locally validated, target accepted

**Проверено:** 2026-08-02  
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
Browser ─ REST + POST/SSE ─> Node/Hono server ─ HTTP/NDJSON ─> Ollama
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
SQLite хранит settings, threads/messages, workspaces, tool journal и calibration.
Active turns, approvals и часть streaming state существуют только в памяти.

### As-is execution boundary

Текущий `POST /threads/:id/messages` одновременно:

1. сохраняет user message;
2. захватывает in-memory lock только данного thread;
3. создаёт пустой assistant;
4. запускает Ollama stream;
5. владеет SSE connection;
6. обновляет assistant после окончания.

Browser disconnect/route change abort-ит server generation. После UI reload
потерянную phase/error восстановить нельзя. SSE event history отсутствует.

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
| Tool run record                      | SQLite                                  | persistent после выполнения |
| Active turn                          | server `Map<threadId, AbortController>` | process memory              |
| Pending approval                     | `ApprovalGate`                          | process memory              |
| SSE events                           | HTTP connection                         | не durable                  |
| Streaming projection                 | React `StreamBuffer`                    | page memory                 |
| Loaded model                         | Ollama                                  | external runtime            |
| Catalog response                     | remote/local/bundled aggregation        | ограниченный fallback       |
| Binary assets                        | отдельной canonical store нет           | partial/not implemented     |

### Основные current risks

1. Разные threads могут одновременно запустить разные модели.
2. `keep_alive: 10m` удерживает модели после turn; route не является unload.
3. UI route владеет работой, поэтому navigation destructive.
4. Пустой assistant создаётся до первого runtime event и не имеет status/error.
5. Current SSE не replayable, хотя типы создают такое впечатление.
6. Remote bind открывает filesystem/shell boundaries без реальной authentication.
7. Fit не описывает совместное размещение, current pressure и remote hardware.
8. Catalog upstream endpoint больше не является рабочим API.

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
