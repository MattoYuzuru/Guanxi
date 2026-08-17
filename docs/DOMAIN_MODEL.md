# Доменная модель

**Статус:** mixed — accepted target, current P1/P2/P3 subsets implemented

**Проверено:** 2026-08-18
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

P3-J реализует minimal canonical Quick Run metadata отдельно от `Thread`:
immutable identity, operation, nullable restrictive Project ownership, created/
updated timestamps и sourced Retention Policy version 1. Projectless и
Project-owned Quick Runs используют один default `7 days`; create/list/read и
policy update доступны через exact scoped REST boundary. Execution/streaming,
durable Job association, Result/Artifact persistence, cleanup и Session
completion/enforcement ещё не реализованы и так же проецируются клиенту.

Accepted target D-022: Quick Run Session заканчивает успешный outcome
`completed` либо явная команда Finish. Остальные terminal outcomes сами Session
не завершают. Finish intent во время active Job ждёт terminal state; затем
Quick Run попадает в recoverable Trash на 24 часа.

### Chat

Сохраняемая multi-turn Conversation с ordered entries. Chat может использовать
разные Jobs и typed Artifacts, но имеет один active context policy в момент хода.
Thinking хранится отдельно от visible answer и имеет отдельную privacy policy.
Chat содержит editable `retentionPolicy` и `notificationPolicy`.

Target archive — nullable `archivedAt`: он скрывает Chat из active Project list,
но сохраняет history/Jobs/Artifacts и допускает Unarchive. Project-scoped search
индексирует только user prompts и final assistant answers; title,
reasoning/tool/private content и attachment bytes исключены.

### Project

Пользовательский контейнер для Chats, Agent Runs, Recipes, Artifacts, files,
vocabulary и scoped permissions. Project не обязан соответствовать одной папке.

Presentation metadata: локализуемое display name, icon key и accessible color
token. Они не влияют на identity, routing или permissions.

Текущая code-сущность `Workspace` означает разрешённый filesystem root для agent
tools. P3-A реализовал независимую Project identity/name/timestamps и additive
one-to-one **Filesystem Binding** для каждого legacy Workspace. P3-B добавил
versioned `iconKey` из canonical Lucide subset и `colorToken` из встроенной
accessible palette; оба поля изменяются отдельно от identity/binding. P3-C
добавил nullable immutable ownership `Thread.project_id`: existing Threads
остаются projectless, а новый Project Chat создаётся и читается только через
versioned Project-scoped boundary. Project можно создать без binding; path не
является identity, а Project Chat сохраняет `workspaceId=null` без отдельного
выбора filesystem scope. Legacy Workspace API/table и raw Thread REST response
сохранены byte-compatible. P3-K добавил immutable nullable Project ownership
для Recipe; Project defaults, Artifact ownership и final client cutover ещё не
реализованы.

Accepted target Project defaults охватывает preferred model/routing, Recipe,
retention, context/export, versioned vocabulary и integration bindings. Default
применяется только к новым entities; effective Job policy сохраняется immutable
snapshot. Global → Project → Recipe → Job наследование может сужать permissions,
а расширение требует explicit user grant.

P3-D–P3-I добавили к current `Thread` versioned Chat-only retention boundary.
Новый projectless и Project Chat получает одинаковый rolling `7 days`; existing
rows проецируются как explicit `Keep / legacy_compatibility`, поэтому migration
сама не делает старую историю eligible. Server хранит sourced create/user-message
activity и вычисляет exact expiry. Один startup/periodic Maintenance owner
переводит due TTL Chat и Session Chat с durable explicit leave basis в scoped
Trash после recheck всех canonical Jobs. Restore и смена policy на Keep/7 days
восстанавливают metadata; для Session server показывает exact 24-hour recovery
deadline. После deadline тот же Maintenance owner атомарно сохраняет
content-free deletion audit и удаляет Session Thread с его directly owned
SQLite rows; durable Jobs и Job events переживают Chat. Generic Artifact/blob
GC, filesystem cleanup и TTL Trash hard deletion не реализованы.

P3-M добавляет current Thread-owned **Context Checkpoint**. Он хранит summary,
exact persisted Message boundary/source count, previous link, size/hash и время,
но не заменяет original Messages. Stored history и active context расходятся
явно: UI/GET показывают всю историю и marker, Ollama получает latest summary +
tail. Новые checkpoint rows имеют `source_preserved`; старые destructive summary
Messages проецируются только как `legacy_source_unavailable`. Это ещё не generic
Artifact/blob store.

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

P3-K реализует canonical Recipe identity отдельно от `Thread` и `Quick Run`:
mutable normalized name, immutable projectless/Project ownership и immutable
numbered configuration revisions. Revision version 1 хранит closed operation,
explicit Ollama model reference либо truthful `not_selected`, instructions,
canonical JSON default parameters и Retention Policy snapshot. Server сохраняет
canonical UTF-8 bytes, byte size и SHA-256; create атомарно создаёт revision 1,
revise использует expected-revision CAS, а rename revision не создаёт. Старые
revisions читаются exact и не переписываются.

P3-L умеет явно материализовать exact immutable Recipe revision в один
canonical `inference` Job со статусом `queued`. Private snapshot фиксирует
Recipe/Project scope, operation, explicit/no-model state, canonical
configuration bytes, SHA-256/size и source revision. Поздний rename либо revise
N+1 не меняет старый Job. Snapshot не является Chat input и не публикуется в
safe Job/event metadata.

Текущий Recipe всё ещё не исполняется: automatic routing, adapter dispatch,
Artifact result, input/output schemas, attachments, vocabulary и integration
grants остаются `not_implemented`. Существующий arbitrary public Job input не
считается Recipe snapshot.

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

P2-L добавляет transient connection-owned `HuggingFaceDownload` и managed
staging artifact, но не `Installation`, `ModelVariant` registry или durable
`Job`. Terminal completed provenance связывает exact HF identity/commit/path,
fresh license/gated claims, expected/observed size, observed SHA-256 relation,
bounded GGUF header result, server-generated artifact id и observation time.
SQLite row не создаётся; UI reload/process restart не replay/resume-ит download.
Cancel/error удаляет только owned partial, а hard process crash всё ещё может
оставить orphan partial для будущей retention policy.

P2-M добавляет transient `HuggingFaceImport`, но не durable `Job` или persistent
`Installation` entity. Command связывает process-owned artifact UUID с
нормализованной loopback Ollama target и context. Terminal provenance включает
P2-L source, documented create evidence, fresh exact target/digest/runtime,
non-historical controlled probe и cleanup state. Create status отдельно не
является Installation. Success не replay-ится: повтор требует живого artifact и
новых provider observations. Unknown/cancel/failure сохраняет staging; restart
теряет registry и attempt memory, а уже созданная Ollama model остаётся обычной
provider-owned установкой без автоматического rollback/delete.

P2-E добавляет variant-first projection текущего local/bundled Marketplace, но
не persistent `ModelVariant` registry. Каждая валидная catalog row получает
server-derived exact normalized target, собственный claimed-size fit и exact
installation projection из sampled `/api/tags`. Duplicate/malformed target,
unknown size и unavailable/ambiguous installation остаются typed unknown;
family-level `installed` и largest-variant `fit` сохранены только как legacy
compatibility projections. Выбор и pull transient; только post-success
Installed refresh подтверждает exact digest. Mutable catalog tag всё ещё не
является immutable artifact revision.

P2-H добавляет transport/render pagination, но не новую persistent catalog
entity. Explicit new client передаёт `page + pageSize`; server после P2-E
normalization применяет global duplicate-target fail-closed, P2-F filtering и
locale-independent stable order, считает exact matching model rows и только
затем возвращает slice. Default 12 и maximum 100 ограничивают одну response/
render page, а не общий catalog. Legacy request без обоих keys по-прежнему
получает полный list с additive `legacy` metadata. Web хранит не более двух
exact comparison row snapshots между pages; query/filter/context/source basis
change очищает их явно. Page, selection и active connection-owned pull остаются
transient page/request state без DB history, provider snapshot или durable Job.

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
application policy, а не свидетельство одного accelerator device. P2-G может
наблюдать все rows одного local Linux/NVIDIA query, но это sampled device list,
а не topology, scheduler capacity или связь конкретного Model Instance с GPU;
на остальных adapters device cardinality остаётся unknown.

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

Current P2-I добавляет `overridden` как отдельное visible состояние: user может
явно утвердить одну capability для exact `(canonical reference, digest, sourced
runtime version)`. Assertion хранится отдельной append-only row, переживает
restart, экспортируется как safe typed JSON и показывается в отдельном UI-регионе
рядом с provider declarations и completion probe — она их не переписывает, не
объединяется с ними и не красит declaration в verified. Реализовано только
positive `present`: negative `unsupported`, confidence и free-form capability не
введены, поэтому отсутствие assertion оставляет capability в прежнем состоянии, а
не делает её unsupported. Assertion не наследуется другим digest, другой runtime
version, другой моделью или Marketplace row; старая row может остаться как
non-active data, но current descriptor её не показывает. Полный Capability
Registry, OperationResolution/Task Adapter wiring и generic precedence resolver
остаются target.

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

**Current P3-G subset:** version 1 `reasoning` Artifact хранится как SQLite UTF-8
text с exact byte size/SHA-256 и immutable source Chat/Message/Job. Один terminal
Job/Message имеет не более одного canonical row. Final answer остаётся отдельным
Message content; legacy `messages.thinking` читается без destructive backfill.
Project/projectless ownership immutable, active read exact-Chat scoped. Seven-day
и shorter-current-parent expiry исполняются одним server-owned bounded
Maintenance owner. Due Artifact удаляется атомарно вместе с redacted audit row;
final answer, Message/Job и literal legacy thinking не удаляются. Enforcement
projection имеет отдельную strict version и fail-closed для malformed/future
input. Generic Artifact/blob GC и hard deletion для не-Session Chat не
реализованы.

**Current P3-N generic foundation:** version 1 metadata хранится отдельно от
`reasoning_artifacts` и ссылается на server-derived content-addressed blob.
Artifact и source Project/Job/parent immutable; одинаковые bytes разделяют blob,
но не metadata identity. Generic retention пока только `Keep`, reference state —
`referenced`, а GC честно `not_implemented`. Writer принимает explicit storage
policy bound, вычисляет hash/size сам и не принимает path/storage key/checksum как
факт. Crash между no-overwrite publish и SQLite commit оставляет нечитабельный
orphan, наблюдаемый bounded inventory; cleanup owner ещё не реализован.

**Current P3-O attachment transport:** attachment — immutable presentation
metadata поверх generic `file` Artifact, а не новый blob/path или model input.
Display name хранится отдельно, строго ограничен contract/SQLite и никогда не
задаёт storage identity. Stable UUID intent, exact Project/projectless ownership
и server-derived bytes/hash сохраняют retry детерминированным. Transfer policy
имеет source/time/byte/admission limits и явно не является model capability.
Export перепроверяет blob и возвращает safe download headers; Range, preview,
generic deletion/GC и подключение к Chat/Recipe execution не реализованы.

**Current P3-P locale boundary:** UI locale — server-owned Settings value, а не
browser locale, DOM guess или Project property. Version 1 поддерживает exact
`en | ru`; missing legacy value даёт sourced English default, malformed stored
value fail-closed. English и Russian catalogs, Glossary definitions и already-
localized presentation errors остаются Web data, не Job/Artifact payload.
Переключение locale не меняет canonical Project, Chat, Job, Recipe, Artifact или
provider content и не создаёт runtime work.

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

Global default нового Chat — `{ mode: "ttl", expiresAfterDays: 7,
refreshOn: "user_activity" }`. Accepted target разрешает Project предвыбрать
`Keep`, `7 days` или `Session` для новых Project Chats/Quick Runs; explicit user
choice имеет приоритет, а существующие entities не переписываются.

P3-J current implementation использует тот же versioned policy object и global
default для Quick Run metadata. Quick Run TTL/Session cleanup пока не реализован.
Accepted target заканчивает Session успешной Job или explicit Finish; неуспешный
terminal outcome оставляет Session открытой. Cleanup ждёт terminal state и
использует 24-hour recoverable Trash.

Session Chat переходит в Trash только после подтверждённой команды Leave session
и terminal state всех canonical Jobs. Reload/reconnect, transport abort,
visibility change и restart не завершают Session. Durable leave basis переживает
restart; Trash recovery — ровно 24 часа от server-owned tombstone time. Restore
или policy change на Keep/7 days до deadline очищает leave basis. At/after
deadline Restore закрыт; Maintenance удаляет Session Chat metadata только
после повторной проверки policy, tombstone, deadline и terminal state всех
canonical Jobs. Policy управляет stored
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

Global delivery default — `when_background`, а sound enable default — `false`;
Chat override поддерживает inherit/off/when_background/always. Каждая новая terminal Job создаёт exact one durable
content-free row независимо от delivery policy; historical rows не backfill-ятся.
Effective policy фиксируется в terminal transaction. Global `readAt` отделён от
per-channel at-most-once claim. Sound принадлежит только Web browser и доступен
после explicit permission action; service/CLI/TUI silent. См.
[ADR-0014](decisions/0014-notification-persistence-and-delivery.md).

## Persistence matrix

| Сущность              | Default                      | Retention/owner               |
| --------------------- | ---------------------------- | ----------------------------- |
| Project               | persistent                   | пользователь                  |
| Recipe                | persistent                   | пользователь                  |
| Chat                  | rolling user TTL 7 days      | Keep/TTL/Session              |
| Quick Run             | explicit retention           | Keep/TTL/Session              |
| Reasoning Artifact    | TTL 7 days                   | shorter parent policy wins    |
| Job metadata/events   | persistent audit window      | policy проекта/настроек       |
| Agent Run/checkpoints | persistent until terminal GC | explicit/run policy           |
| Artifact              | parent/Recipe policy         | content-addressed store       |
| Notification          | one row per new terminal Job | policy + read/delivery claims |
| Capability evidence   | latest safe projections      | fingerprint + freshness       |
| Resource lease        | transient + journal          | governor                      |
| Secrets               | protected store              | connection/settings owner     |

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
