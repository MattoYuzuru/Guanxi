# Доменная модель

**Статус:** proposed  
**Проверено:** 2026-08-02  
**Назначение:** ограничить число понятий и разделить данные, UI и исполнение

## Главная граница

`Chat` — история общения. `Job` — исполняемая работа. `Workbench` — способ её
показать. Эти понятия не взаимозаменяемы.

## Пользовательские сущности

### Quick Run

Одноразовый запуск operation без обязательной истории. Примеры: диктовка,
транскрибация файла, один OCR, генерация изображения. Результат можно скопировать,
экспортировать либо явно сохранить в Project.

Default retention: metadata и временные файлы удаляются после ограниченного TTL,
если пользователь не выбрал `Save`. Окончательная policy требует решения
`Q-05`.

### Chat

Сохраняемая multi-turn Conversation с ordered entries. Chat может использовать
разные Jobs и typed Artifacts, но имеет один active context policy в момент хода.
Thinking хранится отдельно от visible answer и имеет отдельную privacy policy.

### Project

Пользовательский контейнер для Chats, Agent Runs, Recipes, Artifacts, files,
vocabulary и scoped permissions. Project не обязан соответствовать одной папке.

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

Специализация durable Job для многошаговой работы. Содержит plan, checkpoints,
budgets, approvals, verification gates и artifacts. Может использовать Chat или
Project как контекст, но имеет собственный lifecycle.

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

Наблюдаемая загруженная модель: digest, backend/device, context, VRAM/RAM,
expiry и source. Ollama остаётся фактическим владельцем instance; Alamo
согласует своё состояние через `/api/ps`.

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

Typed result: `text`, `transcript`, `audio`, `image`, `video`, `document`,
`structured`, `embedding`, `file`, `checkpoint` или `report`.

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

### Vocabulary

Список терминов/замен/языковых hints для transcription Recipe или Project.
Vocabulary не копируется в каждый Chat. Job сохраняет snapshot/version, чтобы
результат был воспроизводим.

## Persistence matrix

| Сущность              | Default                  | Retention/owner           |
| --------------------- | ------------------------ | ------------------------- |
| Project               | persistent               | пользователь              |
| Recipe                | persistent               | пользователь              |
| Chat                  | persistent               | до удаления/архива        |
| Quick Run             | ephemeral                | TTL, если не сохранён     |
| Job metadata/events   | persistent audit window  | policy проекта/настроек   |
| Agent Run/checkpoints | persistent               | до явного удаления        |
| Artifact              | по policy Recipe/Project | content-addressed store   |
| Capability evidence   | cache                    | fingerprint + freshness   |
| Resource lease        | transient + journal      | governor                  |
| Secrets               | protected store          | connection/settings owner |

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
10. Quick Run становится persistent только через явное сохранение.
11. Project deletion и Artifact garbage collection требуют preview и recoverable
    policy.
12. Brand name не является identity ключом доменной сущности.
