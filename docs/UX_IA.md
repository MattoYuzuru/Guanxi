# UX и информационная архитектура

**Статус:** mixed — accepted direction, current P3 subsets implemented

**Проверено:** 2026-08-18
**Направление:** Warm Instrument Panel

## Цель интерфейса

Интерфейс должен одновременно давать короткий путь к работе и правдивую
операционную картину. Пользователь не обязан понимать Ollama API, но всегда видит
`что выполняется → на какой модели → в какой phase → что будет с памятью`.

## Навигация

```text
Work
  Chats
  Projects
  Agent

Create
  Recipes
  Attachments

Manage
  Models
  Marketplace

System
  Settings
```

Desktop использует compact rail и command palette. На узком экране rail
становится drawer; список Chats/Projects не должен просто исчезать.

### Persistent Runtime Bar

Видим на всех основных экранах:

- active и queued Jobs;
- phase и elapsed time;
- loaded/loading/unloading models;
- RAM/VRAM status с `observed/estimated/unknown`;
- context usage активного Job;
- действия `Open`, `Cancel`, `Queue`;
- предупреждение о внешней модели, найденной через `/api/ps`.

Runtime Bar — projection Job/Governor state, а не локальный React state страницы.

## Ответственность экранов

### Models

Только установленные artifacts и runtime:

- table/grid с search/sort;
- крупный focused inspector вместо карусели как единственной навигации;
- variant, digest, quantization, disk size, capabilities и provenance;
- load/prewarm, unload, delete, default Recipe;
- measured fit, context и calibration history;
- running badge, lease owners и expiry.

Удаление показывает, какие Recipes/Chats ссылаются на model reference, но не
удаляет историю.

Provider `template`/`Modelfile` показываются как техническая metadata с
объяснением. Пользовательские повторно используемые prompts называются Recipe и
не смешиваются с raw prompt template модели.

### Marketplace

- источники и freshness видимы;
- faceted filters: task, input/output modality, tools/thinking, context range,
  memory range, fit on this device, quantization, installed/cloud, license;
- filter chips можно комбинировать и сохранить;
- compare variants до install;
- неизвестный fit не скрывается как «не подходит»;
- Ollama full catalog не scrape-ится: доступны local/curated data и внешний link;
- `Add from Ollama` принимает model name/page URL и показывает normalized preview;
- `Add from Hugging Face` позволяет выбрать exact GGUF/revision, license, size,
  fit и import progress. **Current state (P2-M):** отдельная секция Marketplace
  ищет repositories, показывает metadata, gated/license state, GGUF inventory и
  explicit `supported | unsupported | unknown` вердикт. Для supported exact
  revision пользователь явным действием подтверждает один файл и видит свежие
  size/license/gated facts и preliminary fit только по заявленному размеру с
  hardware provenance. Truncated/malformed inventory и unknown/unsupported rows
  не дают Select. После confirmed target отдельная explicit Download показывает
  preparing/downloading/verifying, truthful known/unknown progress и typed
  terminal result. Success назван verified staging artifact и показывает
  checksum/GGUF/provenance; один download ещё не означает Installed/runtime-ready.
  Только для current completed staging artifact показывается отдельный target
  input и confirmation. UI различает create/observation/probe phases,
  validation/failure/conflict/cancel, возвращает keyboard focus на retry и
  показывает Installed/runtime verified только после exact tags + fresh probe.
  Client abort после старта консервативно показывает unknown outcome, поскольку
  закрытый stream не может получить server reconciliation.

Для сотен моделей используется pagination/virtualization, а не бесконечная
carousel с dot на каждую карточку.

### Chats

- persistent conversations, search, rename, archive и Project grouping;
- явная команда `Quick Run`;
- model/Recipe selector по operation/capability;
- Markdown answer и отдельный collapsible Thinking panel;
- inputs и Artifacts в timeline;
- status каждого turn восстанавливается после reload;
- sidebar/drawer доступен на mobile.
- Project search ищет user prompts и final model answers. Active/Archived —
  явный filter; Archive скрывает Chat из active list, но оставляет Unarchive,
  history и running Jobs. Title/reasoning/tool/private content не индексируются.
- Chat Info объединяет rename/delete, retention, notification policy, generated
  answers и reasoning Artifacts. Current P3-I показывает эти списки раздельно,
  exact effective expiry, size/checksum и scoped copy/export text; после Save
  retention Artifact projection перечитывается. Loading, empty/error/retry и
  explicit reasoning refresh доступны. UI сообщает об active server-owned
  automatic deletion; после cleanup reasoning получает отдельный empty state,
  а generated answer остаётся видимым.

Thinking рендерится как отдельно очищенный Markdown. На desktop его можно открыть
в side inspector, на mobile — в sheet. UI явно показывает, сохраняется ли этот
channel и когда истекает его default 7-day diagnostic retention.

Retention control — простой segmented switch:

```text
[ Keep | 7 days | Session ]
```

Exact expiry видим рядом. Policy меняется isolated действием `Save retention`;
pending cleanup можно отменить до окончания Trash/recovery. Global default нового
Chat — `7 days`; Project может предвыбрать policy только для новых entities.
TTL продлевает только user activity. Для
сохранённой policy Session Chat Info показывает отдельную confirmation-команду
Leave session; reload/reconnect/закрытие вкладки её не подменяют. Pending basis и
active-Job blocker видимы после reload. После Maintenance tombstone UI показывает
exact 24-hour recovery deadline; после него Restore недоступен, а Trash item
остаётся `deletion pending` до sourced server refresh. Только успешный response,
в котором item уже отсутствует и есть scoped deletion audit, переводит UI
в `deleted`. Refresh failure сохраняет pending item, показывает focused alert
и retry. UI не заявляет blob GC: для current SQLite-only boundary он
`not_applicable`.

После explicit context compaction Chat timeline не скрывает и не заменяет
исходные сообщения. На их boundary появляется focusable checkpoint marker с
summary, source count и временем; copy объясняет, что история сохранена, а
active context использует summary. Context panel требует confirmation, держит
ошибку и retry доступными с клавиатуры, а ambiguous transport outcome
reconcile-ит по exact intent. Hard reload показывает marker ровно один раз.
Token/cache bar относится к active context и измеренному post-checkpoint tail,
не к общему размеру stored history.

### Projects

Один экран объединяет:

- overview и recent Jobs;
- files и produced Artifacts;
- Chats и Agent Runs;
- Recipes и vocabulary;
- filesystem bindings;
- MCP/Skills/Tools и effective permissions;
- defaults: routing, retention, context и export.
- preferred Recipe/model, versioned vocabulary и integration bindings;

Project не обязан быть папкой на диске. Привязка filesystem имеет отдельный
allowed root и security state.

Project header имеет editable name, icon и color. Icon picker:

- одна визуально согласованная библиотека;
- search и categories;
- compact grid;
- небольшая pagination вместо длинного linear scroll;
- keyboard navigation и accessible names;
- color palette с проверенным contrast.

Current P3-C projection показывает bounded Chat group на Project card и ведёт
`New Chat`/hard reload через sourced Project route. Она не является final
overview/navigation shell и пока не включает search, move/reparent, retention,
Trash или Project deletion.

### Attachments

Current P3-O standalone `/attachments` library выбирает exact projectless либо
существующий Project scope, показывает source/time/maxBytes storage policy и
bounded first page с честным `truncated` состоянием. Pick/drop принимает один
локальный файл; upload имеет progress, cancel, same-intent retry и focused error.
Committed item показывает media type, size, checksum, time и download/export.
Hard reload перечитывает server rows; double activation/lost response не создают
второй item, а download запускается один раз. UI прямо сообщает, что attachment
не добавлен в model context и не запускал Recipe/Job. Preview, search, delete,
generic GC, Range и фактическое model consumption остаются отдельными slices.

### Recipes

Gallery встроенных и пользовательских задач:

- Dictation/Transcription;
- Chat/Document Batch;
- TTS;
- OCR/Vision;
- Image generation;
- Agent/Deep Research;
- generic custom adapter.

Карточка Recipe показывает operation, accepted inputs, output artifacts,
предпочтительную модель и ограничения. Editor имеет Simple и Advanced sections.

Current P3-L surface `/recipes` — минимальная scoped gallery, а не весь target
editor. Она разделяет projectless и exact Project, показывает loading/empty/
error/retry, создаёт Recipe, выводит current revision и canonical SHA-256/byte
provenance, отдельно переименовывает identity metadata и явно создаёт следующую
revision через expected-revision. Conflict сохраняет данные server-а, переводит
фокус на alert и предлагает reload. Отдельная two-step confirmation создаёт
только exact queued Job snapshot, сохраняет UUID при retry и показывает
server-sourced Job ID, revision/hash и `execution: not_implemented`; hard reload
читает association с server, а не доверяет URL payload. English fallback и
curated Russian, visible focus, keyboard flow, 390 px/200%, forced colors и
reduced motion покрыты mocked Chromium. Surface явно сообщает, что execution и
automatic routing не реализованы; accepted inputs/output artifacts и Advanced
sections пока не проецируются.

### Agent

- queue и история Agent Runs;
- first-party coding Agent Chat/CLI, не wrapper branded external agent;
- plan/checkpoint timeline;
- current step и compacted context summary;
- file/config/docs changes и command/test evidence;
- tool calls, `Manual`/`Auto within policy` и watchdog limits;
- artifacts и verification;
- pause/cancel/resume только там, где adapter поддерживает semantics;
- explicit `Checkpointed deliberate` execution profile для слабой модели.

Нельзя обещать «модель думает», если доступен только generic token stream.

### Settings

- Ollama endpoints и runtime profile;
- safe scheduling policy, TTL/pin/parallel advanced;
- model routing;
- global MCP/Skills/Tools;
- voice input default Recipe;
- service/CLI lifecycle и opt-in login autostart;
- storage/retention/export;
- global completion notification/sound policy;
- single-profile service state, redacted restart preview и reversible native
  autostart adapter;
- Language: implemented P3-P English/Russian control и searchable Glossary;
- security profile;
- theme, font density, reduced motion и accessibility.

## Главные flows

### Создание Chat

1. `New` → `Chat`.
2. Выбор Recipe или operation.
3. Выбор retention через `Keep / 7 days / Session`.
4. Model selector показывает installed compatible models и fit basis.
5. При выборе idle модели Governor после debounce может запросить prewarm lease.
6. `Send` создаёт Job, после чего route и event subscription независимы.
7. UI последовательно показывает `Queued → Loading → Prefill → Thinking /
Generating → Finalizing`.
8. Reload восстанавливает projection из Job и events.

### Переход во время генерации

Открытие другого экрана ничего не отменяет. При попытке запустить несовместимый
Job диалог объясняет причину:

- `Queue after current` — default;
- `Stop current and switch`;
- `Run in parallel` — только если Governor разрешил по measured policy;
- `Open active job`.

Предупреждение привязано к resource-changing action, не к навигации.

### Voice input в Chat

1. Микрофон использует выбранную global/Project transcription Recipe.
2. Capture показывает понятную waveform/level animation и создаёт audio draft.
3. STT Job получает accelerator lease.
4. При конфликте Chat model можно временно выгрузить только по Governor policy.
5. Transcript появляется в composer как редактируемый input, а не отправляется
   автоматически.
6. После подтверждения создаётся обычный Chat Job.

### Dictation Quick Run

Default view: record или upload → progress → transcript → copy/export.

Advanced:

- language/hints;
- vocabulary;
- timestamps/speakers, если подтверждены adapter;
- подтверждённые model-native raw/normalized modes;
- cleanup/filler removal как отдельная видимая LLM stage;
- последующий summary как отдельный pipeline stage.

Quick Run использует выбранный retention mode. Отдельная кнопка Save не меняет
тип сессии; связь Artifact с Project — отдельное действие. Session заканчивается
при successful Job либо explicit `Finish Quick Run Session`. Failed/cancelled/
interrupted result оставляет Session для retry; Finish во время active Job
показывает pending terminal wait и только затем 24-hour recoverable Trash.

System-wide hotkey откладывается до platform integration и поддерживает два
режима: toggle recording и hold-to-talk.

### TTS

Text editor → voice/parameters → progress → audio player с play/pause, seek,
speed и download. Unsupported parameter не появляется из догадки UI.

### Image/Vision

Input dock принимает поддержанные media types. Output canvas показывает preview,
seed/size/variant, progress и download. OCR возвращает text/structured Artifact;
image generation — gallery Artifacts.

Video Workbench не входит в активный roadmap до нового product decision.

### Completion notification

1. Terminal Job создаёт in-app notification и badge.
2. `When background` сверяет visible exact Job/Chat между tabs одного browser
   profile; CLI/TUI не считаются browser foreground.
3. После explicit Enable/Preview permission Web claim-ит и воспроизводит sound
   не более одного раза; service/CLI/TUI остаются silent.
4. Notification ведёт к Job/Chat, не раскрывая prompt/result.
5. Global delivery default `When background` наследуется Chat и может быть
   изменён в Chat Info через inherit/off/when-background/always; сам sound по
   умолчанию выключен до explicit Enable/Preview.
6. `Off` сохраняет content-free row, но не показывает unread badge и не играет
   sound. Existing terminal Jobs до cutover не backfill-ятся.

## Capability-driven Workbench

Workbench не хранится как доменная сущность. Shell состоит из:

```text
┌ Job/Recipe header ───────────────── Runtime status ┐
│ typed input dock                                   │
├ task canvas / conversation / media preview ────────┤
│ artifact timeline / outputs                        │
├ Advanced parameters ───────── Resource inspector ──┤
└ actions: run · queue · cancel · retain · export ────┘
```

Renderer выбирается adapter:

1. специализированный renderer для известной operation;
2. generic form по JSON Schema;
3. read-only descriptor + raw structured input, если schema неполна;
4. явное `unsupported by this adapter`, если безопасный запуск невозможен.

## Visual direction: Warm Instrument Panel

### Характер

Локальная лаборатория и приборная панель, а не generic SaaS dashboard:

- bone/parchment surfaces;
- ink/umber text;
- terracotta primary;
- amber для active/loading;
- muted sage только для подтверждённого healthy state;
- красный только для действия/ошибки, требующей внимания.

Sunset Atlas можно использовать в Marketplace для discovery; Ember Console —
опциональный dense/dark power-user mode.

### Типографика

- JetBrains Mono: brand, model names, metrics, status labels, shortcuts, code;
- оптимальный читаемый document font: длинные ответы, Markdown и документация;
- full-mono body — пользовательская настройка, а не обязательный default.

Рабочее название и font задаются theme/brand tokens, а не размножаются в
компонентах.

### Геометрия и motion

- 12-column desktop grid, resizable panels;
- thin separators и радиусы 6–10 px;
- pills только для tags/status;
- state transitions 120–180 ms;
- loading model показывает осмысленные phases, не бесконечный декоративный shimmer;
- `prefers-reduced-motion` отключает не только CSS, но и JS inertia/auto-animation.

## Состояния, обязательные для каждого data surface

- initial loading;
- empty;
- offline/stale cache;
- permission denied;
- unsupported/unknown;
- queued/loading/running;
- partial output;
- cancelled/interrupted/failed;
- recoverable retry;
- destructive confirmation;
- external state changed.

Ошибки имеют human summary, technical details/copy action и correlation Job ID.
Root Error Boundary всегда сохраняет navigation/reload/diagnostics вместо белого
экрана.

## Accessibility

- semantic controls и label/input association;
- keyboard access без зависимости от hover/title;
- видимый `focus-visible`;
- live regions для phase, error, copy и terminal state без token-by-token шума;
- modal/dialog делает background inert и восстанавливает focus;
- минимум 44×44 CSS px для primary touch targets на mobile;
- text масштабируется до 200% без потери действий;
- tablist используется только с корректными tabpanel/aria-controls;
- contrast проверяется для всех semantic token combinations;
- Thinking/stream pause доступны screen reader и reduced-motion users.
- completion sound имеет visual equivalent, preview/off и не является единственным
  сигналом.

## Localization

Current P3-P реализует Web-wide locale provider, сохранённый Language control и
Settings Glossary. Visible copy, aria labels, titles, placeholders, форматные
единицы и Web-owned errors используют keys; delayed Settings bootstrap меняет
locale без reload, потери focus или повторных screen/runtime запросов. Contextual
Glossary help и locale desktop clients остаются target.

- English locale — source copy и fallback;
- Russian — curated translation с product review;
- locale switch не требует restart;
- technical IDs/model names/commands не переводятся;
- даты, числа, memory и plural forms используют locale formatting;
- Glossary доступен из Settings и contextual help;
- неизвестный locale key заметен в development, а production использует English
  fallback без raw key.

## Responsive

- mobile navigation drawer;
- Chat history как drawer/route, а не `display:none`;
- Workbench перестраивается `canvas → status → parameters`, не сжимает три панели;
- Runtime Bar становится compact bottom sheet;
- media previews сохраняют aspect ratio;
- table имеет card projection либо horizontal detail view;
- filters открываются sheet с сохранённым применённым summary.

## Performance budgets и риски

- catalog: server pagination + bounded provider calls + virtualization;
- installed details: bounded `/api/show` concurrency и progressive rendering;
- long Chat: windowed timeline после измерения;
- streaming Markdown: не reparsing всей истории на каждый token;
- auto-scroll отключается, когда пользователь читает выше;
- routes/workbenches загружаются лениво;
- media artifacts не держатся полностью в React/SQLite;
- accessibility и progress не зависят от animation frame rate.

Текущий JS bundle не является главным риском: первым устраняется отсутствие
глобального resource owner и browser regression coverage.
