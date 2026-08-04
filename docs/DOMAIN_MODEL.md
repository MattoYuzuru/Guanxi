# Доменная модель

**Статус:** mixed — accepted target, current P1/P2 subsets implemented

**Проверено:** 2026-08-04
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

Current P2-A/P2-B additive `InstalledModelDescriptor` отделяет canonical Ollama
reference, exact installed digest либо explicit unknown, observation установки
из `/api/tags` и capability declarations. Legacy `LocalModel.capabilities` и
`contextLength` сохранены как compatibility projection. Descriptor не является
persistent registry. P2-B сохраняет только exact safe provider evidence в
SQLite migration 7: cache key включает canonical reference, installed digest,
Ollama version и evidence schema version. Freshness — application policy
15 минут fresh + 7 дней stale/offline, а не provider truth. Исходный
`observedAt` не меняется от cache hit.

P2-C не встраивает runtime proof обратно в provider declaration. Он хранит
отдельную latest projection одного explicit `completion` probe для exact
canonical reference + digest + Ollama version + context + probe-definition
version. Historical reuse сохраняет исходное observation time; force создаёт
новое observation для того же exact key.

P2-D добавляет transient `OllamaReferencePreview`, но не новую persistent domain
entity. Preview различает только model name и official page URL, хранит safe
display value и canonical lower-case name с explicit tag. Он не является Model
Variant, Installation, capability claim или availability proof. Confirmed pull
остаётся connection-owned operation; только последующий `/api/tags` sample может
создать observed Installation/digest fact. Import Job, resume, checksum,
provenance record и recent catalog entry ещё не реализованы.

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

### Model Context Limit

Current P1-M boundary различает только provider-declared limit и `unknown`.
Declared evidence содержит positive safe-integer value, источник
`/api/tags` либо `/api/show`, observation time и confidence. Отсутствующие или
противоречащие declarations остаются unknown и не превращаются в guessed
universal ceiling.

Запрошенный context — отдельный exact параметр operation. Defaults `8192`/`32768`
и UI presets являются стартовыми значениями/подсказками, а не capability.
Значение выше sourced declared maximum отклоняется без clamp; при unknown
maximum валидный custom value сохраняется через REST, SQLite, Governor, Ollama,
fit и prewarm. Legacy `LocalModel.contextLength` остаётся compatibility
projection; новые решения используют `contextLimit`.

### Resource Lease

Право Job, prewarm или explicit probe удерживать Model Instance. Lease имеет
purpose, priority, TTL и owner. Модель выгружается только при отсутствии leases
и выполнении idle/pressure policy. Current один permit — консервативная
application policy, а не свидетельство одного accelerator device; device
cardinality пока unknown.

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

Current P2-A/P2-B реализует `declared | degraded | unknown` descriptor subset
для documented local Ollama responses. `/api/tags` declaration может быть связана с
exact installed digest; `/api/show` вызывается по имени и не возвращает digest,
поэтому её artifact basis остаётся `detail_not_bound_to_digest`. Duplicate
canonical reference, неизвестное capability value, malformed/missing field и
provider failure не выбирают удобный aggregate claim. P2-B выполняет bounded
`/api/show`, затем повторно проверяет exact `/api/tags` identity и runtime
version до persistent write. Изменившаяся/неоднозначная identity остаётся
unknown/degraded. Stale exact row используется только при unavailable detail в
7-дневном window и маркируется offline; malformed/conflicting current response
не маскируется старым cache. Raw response, endpoint/credentials, paths,
template/system/license и private content не persist-ятся.

P2-C отдельно реализует user-triggered completion-probe evidence со status
`verified | degraded | unknown | cancelled | skipped`. Verified требует exact
identity до/после и terminal non-whitespace response bounded server-owned probe
version 1. Failure, cancel, unsafe fit/context и identity drift не становятся
`unsupported`. Persisted row содержит только normalized outcome, safe reason,
timing и exact key — без prompt, response или reasoning. Это не semantic quality,
tool/media reliability или generic Capability Registry resolution.

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
| Capability evidence   | latest safe projections      | fingerprint + freshness    |
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
16. Positive probe evidence записывается только после exact before/after
    identity match; historical observation не выдаётся за новый runtime fact.
