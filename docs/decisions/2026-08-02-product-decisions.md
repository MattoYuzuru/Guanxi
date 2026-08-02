# Продуктовые решения — итерация 2026-08-02

**Статус:** accepted, кроме явно отмеченных unresolved деталей  
**Источник:** ответы владельца проекта на Q-01–Q-21  
**Область:** product direction, runtime, catalog, retention, agents, CLI и UX

Этот документ является канонической фиксацией второй итерации. Исходные вопросы
сохранены в Git-коммите `7212ca8`; актуальный нерешённый реестр находится в
[`OPEN_QUESTIONS.md`](../plans/OPEN_QUESTIONS.md).

## D-001. Собственное позиционирование

Alamo не копирует Open WebUI или LM Studio и не ставит feature parity целью.
Принято исходное направление: собственный resource-aware local model workbench
и control plane.

Generic Chat нужен как качественный фундамент, но differentiator — наблюдаемая
работа, безопасная память, capabilities с evidence и расширяемые workbenches.

## D-002. Background Jobs и навигация

Job продолжает выполняться после перехода в другой Chat, Project или экран.
Навигация не спрашивает подтверждение и не отменяет inference.

Вопрос появляется только при dispatch конфликтующего Job. Default action —
поставить в очередь. Stop-and-switch доступен явно.

## D-003. Concurrency

Default policy — один accelerator Job. Измеренный parallel mode добавляется
позднее для сильного железа.

Governor может разрешить параллельные Jobs, включая короткий STT во время долгой
LLM-задачи, только если:

- известны exact variants и runtime instances;
- fresh telemetry показывает достаточный запас;
- суммарная reservation укладывается в policy;
- active Job не получает опасный memory pressure;
- пользователь разрешил measured parallelism.

Это не исключение UI и не эвристика «компьютер мощный», а решение Governor.

## D-004. Граница сервисов

Alamo Application Service и Ollama daemon — разные процессы и объекты управления.

- Alamo может запускаться, останавливаться и стартовать при login.
- Loaded Ollama models управляются через Resource Governor.
- Внешний Ollama daemon не завершается вместе с Alamo без отдельной команды и
  подтверждения.
- Web, CLI и TUI используют одну settings store и один Job API.

## D-005. Ollama Marketplace без live scraping

Проект не запрашивает permission на полный Ollama catalog API и не строит live
scraper.

Принятые способы добавить Ollama model:

1. пользователь вставляет model name или URL страницы Ollama;
2. приложение нормализует reference и показывает preview;
3. documented local Ollama API выполняет pull по подтверждённому имени;
4. model появляется в Installed Models и локальном recent/curated Marketplace;
5. владелец проекта может вручную поддерживать датированный curated snapshot.

Предложение об одноразовом автоматическом scrape не принимается: однократность и
личное использование не отменяют актуальные ограничения upstream Terms. Ручная
курация и user-supplied reference дают нужный flow без этой зависимости.

## D-006. Hugging Face discovery и import

Официальный Hugging Face API используется для поиска, metadata и скачивания.
Первый import scope — exact GGUF:

1. вставить HF model/file URL либо выбрать результат поиска;
2. получить repo, revision, files, size, license/gated state;
3. выбрать конкретный GGUF variant;
4. выполнить dry-run/fit до download;
5. скачать resumable/cache-aware;
6. проверить checksum/format;
7. создать локальную Ollama model через supported GGUF import;
8. probe и сохранить provenance.

Наличие model card или `apps=ollama` остаётся hint. Safetensors conversion,
adapters и arbitrary executable model code не входят в первый import slice.

Пользователь может импортировать любой валидный GGUF, но UI не называет его
проверенным до runtime probe и показывает license/gated information.

## D-007. Platform matrix

- Первый verified tier: macOS на Apple Silicon.
- Второй verified tier: Linux на NVIDIA, прежде всего Ubuntu и Fedora family.
- Windows/WSL не входит в план до появления реального пользователя/требования.

UI не вводит artificial ceilings для high-memory workstation или нескольких
devices.

## D-008. Project identity

Project — логический контейнер, а не обязательная папка.

Project получает:

- редактируемое название;
- одну иконку из большой однородной searchable library;
- цвет из accessible palette;
- compact picker с search/categories и небольшой pagination/grid;
- опциональные filesystem bindings.

Icon/color — presentation metadata, не business identity и не permission.

## D-009. Chat retention

Кнопка `Save` для временного Chat не вводится. В Chat Info используется простой
трёхпозиционный retention control:

- `Keep` — хранить до явного удаления;
- `7 days` — удалить через семь дней после последней user activity;
- `Session` — после ухода пользователя перевести в recoverable deletion flow.

Retention можно менять в любой момент. Cleanup — системный maintenance Job,
который выполняется при старте и периодически, пока сервис работает.

Default любого нового Chat — `7 days`, в том числе внутри Project. Project не
делает Chat бессрочным автоматически; для этого пользователь выбирает `Keep`.

Reload/reconnect не завершают `Session`. После ухода из Chat и завершения
связанной активной Job Chat переводится в Trash на 24 часа. В течение grace
пользователь может восстановить Chat или сменить policy на `7 days`/`Keep`;
после grace maintenance окончательно удаляет metadata и unreferenced blobs.

Rolling TTL обновляется только user activity. Model/tool/maintenance/background
events не продлевают срок.

## D-010. Thinking/reasoning retention

Thinking показывается live в отдельной раскрываемой панели и сохраняется отдельно
от final answer как diagnostic Artifact.

Default reasoning retention — 7 дней. Chat Info показывает:

- generated answers;
- reasoning Artifacts и срок удаления;
- copy/export;
- rename/delete;
- Chat retention и notification policy.

Удаление reasoning не удаляет final answer. Более короткий Chat retention имеет
приоритет над reasoning TTL. Секреты и tool credentials не должны попадать в
reasoning export.

## D-011. Локализация и glossary

- Primary UI language: English.
- Первый перевод: curated Russian, а не runtime machine translation.
- Все user-facing strings используют locale keys.
- Settings содержит Language и Glossary.
- Glossary объясняет термины простым языком и реальным примером.

Предлагаемые русские labels документированы в [`GLOSSARY.md`](../GLOSSARY.md) и
подлежат UX-проверке.

## D-012. Порядок modalities

1. Полностью стабилизировать text foundation.
2. Затем STT/Dictation.
3. Потом TTS по реальному adapter/provider.
4. Vision/OCR/image — позже.
5. Video отложено без planned implementation phase до смены приоритета.

## D-013. Voice capture и hotkey

Первый flow — browser record/upload с понятной waveform/status animation.

System-wide hotkey — отдельная desktop/service integration:

- configurable key combination;
- press-to-toggle и hold-to-talk;
- настройка в Web/CLI;
- platform-specific permission/status;
- одинаковая transcription Recipe.

## D-014. Raw STT и преобразования

Нативный output speech model и LLM post-processing разделяются.

Operation descriptor может заявить подтверждённый native mode, например raw,
normalized или model-native summary. Если cleanup/filler removal/summary делает
другая LLM, Workbench показывает отдельный pipeline stage и отдельный Job.

UI не приписывает speech model способность, доказанную только названием или
model card.

## D-015. First-party coding agent

Primary agent use case — coding:

- читать и изменять files/configs/docs;
- искать актуальную официальную документацию;
- запускать tests/build/Gradle и другие разрешённые команды;
- проверять endpoints и локальные data stores через tools;
- использовать Project Skills и MCP;
- вести plan, checkpoints, evidence и review.

Alamo строит независимый first-party Agent API и CLI. Он не маскируется под
Claude Code/Codex и не требует их executable. Optional interoperability может
появиться позже, но не является foundation.

Deep Research — Chat/Recipe capability, которая может переиспользовать durable
agent engine, а не primary coding-agent identity.

## D-016. Long-running deliberate agent

Explicit execution profile предназначен для задач длительностью 4–6 часов и
более, где качество важнее времени:

- bounded steps;
- repeated context reconstruction;
- plan/checkpoint Artifacts;
- tests/build/runtime evidence;
- self-review и отдельные verification gates;
- restart/resume;
- полный audit.

Под словом «budget» понимаются не деньги, а watchdog limits: wall time,
iterations, tool calls, disk/output и repeated-failure threshold. Их точные
defaults остаются Q-27; бесконечный незаметный loop не допускается.

## D-017. Approval modes, MCP и Skills

Agent Run имеет два понятных режима:

- `Manual approvals`;
- `Auto within policy`.

Auto mode не означает безграничный host access: пользователь заранее выбирает
allowed roots, command/network policy и integrations. Все effects остаются
видимыми и audit-able.

MCP и Skills:

- выключены по default;
- могут быть включены на Project;
- Recipe/Agent Run наследует и может сузить набор;
- в конкретном Agent Chat пользователь может временно включить дополнительный
  Skill/MCP;
- Skill загружается в контекст, но модель не обязана его применить;
- model/tool content не расширяет permissions.

## D-018. Application Service, TUI и autostart

- Terminal можно закрыть, Alamo Service продолжает работать.
- No-args CLI открывает интерактивный TUI.
- Scriptable commands остаются доступны для agents/automation.
- Login autostart поддерживается на macOS и Linux как opt-in setting.
- После restart компьютера Web может открыть уже поднятый service.
- Settings в Web, CLI и TUI общие; изменение restart-sensitive setting показывает
  preview и выполняет controlled restart.

## D-019. Branding

Новое имя пока не выбирается. Архитектура обязана сделать будущий rename
одноразовой migration-задачей, а не ручным редактированием проекта.

## D-020. Fonts

- JetBrains Mono — technical chrome, models, metrics, code и shortcuts.
- Читаемый document font — long Markdown, docs и большие ответы.
- Full-mono может быть отдельной preference.

## D-021. Completion notifications

Job completion может создать:

- in-app notification;
- короткий optional sound;
- badge в Runtime Bar/Chat.

Policy настраивается global и переопределяется Chat/Agent Run:

- off;
- only when not viewing this Job;
- always.

Notification содержит outcome и ссылку на Job, но не private prompt/result.
Browser audio/notification permission запрашивается только после user action.
