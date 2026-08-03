# Доменная модель

**Статус:** accepted target model, not implemented

**Проверено:** 2026-08-02  
**Назначение:** ограничить число понятий и разделить данные, UI и исполнение

## Главная граница

`Chat` — история общения. `Job` — исполняемая работа. `Workbench` — способ её
показать. Эти понятия не взаимозаменяемы.

## Пользовательские сущности

### Quick Run

Одноразовый запуск operation без обязательного диалога. Примеры: диктовка,
транскрибация файла, один OCR, генерация изображения. Result/Artifact можно
скопировать, экспортировать или связать с Project.

Quick Run использует тот же трёхрежимный Retention Policy, что Chat. Отдельная
кнопка `Save` не создаёт новый тип данных.

### Chat

Сохраняемая multi-turn Conversation с ordered entries. Chat может использовать
разные Jobs и typed Artifacts, но имеет один active context policy в момент хода.
Thinking хранится отдельно от visible answer и имеет отдельную privacy policy.
Chat содержит editable `retentionPolicy` и `notificationPolicy`.

### Project

Пользовательский контейнер для Chats, Agent Runs, Recipes, Artifacts, files,
vocabulary и scoped permissions. Project не обязан соответствовать одной папке.

Presentation metadata: локализуемое display name, icon key и accessible color
token. Они не влияют на identity, routing или permissions.

Текущая code-сущность `Workspace` означает разрешённый filesystem root для agent
tools. В target model это **Filesystem Binding** внутри Project, а не синоним
Project. Переименование требует миграции API/DB/UI, а не мгновенной замены.

### Recipe

Повторно используемая конфигурация задачи:

- operation;
- preferred model либо routing policy;
- system/task instructions;
- input/output schema;
- default и advanced parameters;
- dictionary/vocabulary/knowledge attachments;
- tool, MCP и Skill bindings;
- retention/export policy;
- проверенная compatibility evidence.

`Dictation`, `Transcription`, `TTS`, `OCR`, `Image Generate` и
`Document Batch` — Recipes/operations, а не новые разновидности Chat.

### Agent Run

Специализация durable Job для многошаговой coding-first работы. Содержит plan,
checkpoints, watchdog limits, approval mode, verification gates и artifacts.
Может использовать Chat или Project как контекст, но имеет собственный lifecycle.

Approval mode: `manual` или `auto_within_policy`. Effective policy фиксируется
snapshot в Run.

## Исполняемые сущности

### Job

Единственная единица исполнения. Job существует независимо от browser route и
содержит:

- `id`, `kind`, `operation`, `status`, `phase`;
- input references и requested parameters;
- selected model/adapter snapshot;
- project/chat/recipe references;
- idempotency key;
- priority и queue order;
- resource request/lease;
- event sequence;
- output artifacts;
- terminal error/stop reason;
- created/started/finished timestamps.

Типы Job описывают форму исполнения (`inference`, `agent`, `tool`, `pipeline`),
но не создают отдельную модель хранения.

### Job Event

Append-only наблюдение с монотонным `sequence`. Event предназначен для replay и
UI projection, а не заменяет итоговое состояние Job. Основные channels:

- lifecycle: queued/reserving/loading/running/terminal;
- output: thinking/content/segment/preview;
- tool: call/approval/result;
- resource: lease/model/memory/context;
- usage;
- warning/error/checkpoint.

### Pipeline

Зависимости Jobs для составной операции. Например voice input:

```text
capture audio → STT Job → text draft → Chat Job
```

Scheduler не обязан держать обе модели одновременно. Output одного Job становится
typed input следующего.

## Модели и capabilities

### Model Reference

Каноническая ссылка `provider + modelId`; сама по себе не гарантирует, что artifact
можно скачать или выполнить.

### Model Variant

Конкретный artifact/quantization с digest, format, size, source и license facts.
Fit и calibration относятся к Variant, а не к абстрактному model family.

### Model Installation

Локально доступный Variant в конкретном Ollama runtime. Содержит installed state
и runtime fingerprint, но не означает, что модель загружена.

### Runtime Instance

Наблюдаемая загруженная модель: digest, context, VRAM/RAM, expiry и source.
Ollama остаётся фактическим владельцем instance; Alamo согласует своё состояние
через `/api/ps`. Current `/api/ps` не публикует отдельный backend/device label,
поэтому P1-L связывает row с sourced Ollama version и локальным Apple hardware
profile, но не изобретает более точную backend identity.

### Model Observation Key

Current version 1 — typed `complete | unavailable` boundary. Complete key
включает provider, canonical exact model reference, artifact digest, context,
Ollama runtime/version fingerprint и локальный Apple hardware fingerprint.
Timestamp остаётся metadata observation, а не частью fingerprint. Missing либо
ambiguous component сохраняет reason и не получает measured credit.

Legacy `model_calibration(model, context)` сохраняется для совместимости, но не
считается exact evidence. Migration 6 пишет новые samples отдельно; changed
digest, context, runtime или hardware не перезаписывают друг друга.

### Resource Lease

Право Job или prewarm удерживать Model Instance. Lease имеет purpose, priority,
TTL и owner. Модель выгружается только при отсутствии leases и выполнении idle/
pressure policy.

### Operation Descriptor

Нормализованный исполняемый контракт:

```ts
type OperationDescriptor = {
  id: string;
  inputs: Array<
    "text" | "image" | "audio" | "video" | "document" | "structured"
  >;
  outputs: Array<
    "text" | "image" | "audio" | "video" | "embedding" | "structured" | "files"
  >;
  streaming: Array<"token" | "segment" | "waveform" | "preview" | "none">;
  parametersSchema?: JsonSchema;
  limits?: Record<string, unknown>;
};
```

Примеры operations: `chat`, `complete`, `embed`, `transcribe`,
`textToSpeech`, `ocr`, `caption`, `generateImage`, `generateVideo`, `agent`.
Long-tail adapters могут добавить `forecast`, `rank`, `recommend` или другую
structured operation без новой top-level пользовательской сущности.

`summarizeTranscript` обычно является Pipeline (`transcribe → summarize`), а не
нативной capability speech-модели.

Speech adapter может отдельно доказать native operation/mode `raw`,
`normalized` или `modelNativeSummary`. Это не позволяет автоматически приписать
модели произвольный cleanup.

### Capability Evidence

Каждый claim хранит:

- value;
- source: runtime declaration, provider, model card, bundled curation, probe или
  user override;
- confidence;
- observed time;
- model digest;
- Ollama/runtime version;
- backend/hardware fingerprint, если релевантно;
- probe id/version/result.

Состояния claim: `verified`, `declared`, `claimed`, `degraded`, `unknown`,
`overridden`. Отсутствие metadata не равно `unsupported`.

### Task Adapter

Код, связывающий Operation Descriptor, provider/runtime protocol, validation,
stream parser, output Artifact и Workbench renderer. Adapter version входит в
fingerprint Job.

## Результаты и интеграции

### Artifact

Typed result: `text`, `reasoning`, `transcript`, `audio`, `image`, `video`,
`document`, `structured`, `embedding`, `file`, `checkpoint` или `report`.

Artifact хранит media type, size, checksum, source Job, derivation chain,
storage reference, preview metadata и export options. Большие бинарные данные
предлагается держать в content-addressed filesystem; SQLite хранит metadata.

### Tool, MCP Connection и Skill

- **Tool** — конкретное callable действие с input/output schema и effect class.
- **MCP Connection** — источник tools/resources/prompts и credentials.
- **Skill** — reusable instructions/workflow, не автоматически trusted code.
- **Binding** — включение возможности на scope с policy.

Scope наследуется `Global → Project → Recipe → Job`, а effective policy всегда
видим. Более узкий scope может запретить, но не должен бесшумно расширять
permission без подтверждения.

MCP/Skills выключены по default. Job может запросить дополнительный binding через
явное user action; это создаёт новый policy snapshot.

### Vocabulary

Список терминов/замен/языковых hints для transcription Recipe или Project.
Vocabulary не копируется в каждый Chat. Job сохраняет snapshot/version, чтобы
результат был воспроизводим.

### Retention Policy

```ts
type RetentionPolicy =
  | { mode: "keep" }
  | {
      mode: "ttl";
      expiresAfterDays: 7;
      refreshOn: "user_activity";
    }
  | { mode: "session" };
```

Default любого нового Chat — `{ mode: "ttl", expiresAfterDays: 7,
refreshOn: "user_activity" }`, независимо от принадлежности Project. `Keep`
требует явного выбора пользователя.

Session Chat переходит в Trash после ухода пользователя и terminal state
активной Job. Reload/reconnect не завершают Session. Trash grace — 24 часа.
Policy можно изменить до окончательной очистки. Она управляет stored
Chat/Artifacts, но не model weights, loaded instance или transient KV cache.

### Maintenance Job

Системная Job operation:

- запускается при старте и периодически;
- выбирает expired records по индексу;
- сначала переводит их в Trash/tombstone;
- после grace удаляет blobs без живых references;
- пишет audit summary;
- идемпотентна и продолжает bounded batches после restart.

Maintenance не удаляет active Chat/Job и не обновляет user-activity TTL от своих
событий.

### Notification Policy

```ts
type NotificationPolicy = "off" | "when_background" | "always";
```

Global default наследуется Chat/Agent Run и может быть переопределён. Terminal
Job создаёт notification record; client решает, можно ли воспроизвести sound по
focus/permission/accessibility state. Доставка идемпотентна по Job и channel.

## Persistence matrix

| Сущность              | Default                      | Retention/owner            |
| --------------------- | ---------------------------- | -------------------------- |
| Project               | persistent                   | пользователь               |
| Recipe                | persistent                   | пользователь               |
| Chat                  | rolling user TTL 7 days      | Keep/TTL/Session           |
| Quick Run             | explicit retention           | Keep/TTL/Session           |
| Reasoning Artifact    | TTL 7 days                   | shorter parent policy wins |
| Job metadata/events   | persistent audit window      | policy проекта/настроек    |
| Agent Run/checkpoints | persistent until terminal GC | explicit/run policy        |
| Artifact              | parent/Recipe policy         | content-addressed store    |
| Notification          | local read/unread window     | settings policy            |
| Capability evidence   | cache                        | fingerprint + freshness    |
| Resource lease        | transient + journal          | governor                   |
| Secrets               | protected store              | connection/settings owner  |

## Связи

См. [domain-er.mmd](architecture/diagrams/domain-er.mmd).

```text
Project
├── Chats
├── Recipes
├── Agent Runs
├── Artifacts
├── Filesystem Bindings
└── Integration Bindings

Chat ── creates ──> Jobs ── produces ──> Artifacts
Recipe ── configures ──> Jobs
Job ── acquires ──> Resource Lease ── observes ──> Runtime Instance
Model Variant ── has ──> Capability Evidence
```

## Инварианты

1. Terminal Job неизменяем по status; retry создаёт новый Job с causal link.
2. Event sequence монотонен и уникален внутри Job.
3. UI disconnect не является cancel.
4. Assistant/output без terminal status не считается успешным.
5. Artifact derivation не меняется после создания.
6. Resource lease имеет ровно одного owner и освобождается идемпотентно.
7. Prewarm lease никогда не вытесняет active Job.
8. Capability claim без provenance не попадает в пользовательский факт.
9. Recipe snapshot фиксируется в Job; позднее изменение Recipe не меняет историю.
10. Quick Run и Chat подчиняются явной Retention Policy, а не кнопке Save.
11. Project deletion и Artifact garbage collection требуют preview и recoverable
    policy.
12. Brand name не является identity ключом доменной сущности.
13. Stored history и transient KV cache — разные данные и lifecycle.
14. Maintenance Job не удаляет active/non-terminal work.
15. Notification delivery не меняет terminal state Job и не раскрывает content.
