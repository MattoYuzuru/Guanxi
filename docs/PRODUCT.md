# Product brief и требования

**Статус:** mixed — direction/ADRs accepted, requirements not implemented

**Проверено:** 2026-08-18
**Горизонт:** от стабилизации alpha до локальной model workbench platform

Принятые ответы владельца проекта:
[decision iteration 2026-08-02](decisions/2026-08-02-product-decisions.md).

## Vision

Alamo UI должен стать local-first рабочей средой для моделей, которая позволяет
использовать максимум возможностей конкретной модели и одновременно не скрывает
ограничения устройства. Пользователь должен понимать:

- какая операция будет выполнена и почему она доступна;
- какая модель сейчас загружается или работает;
- сколько памяти, контекста и времени используется;
- продолжится ли задача после ухода со страницы;
- где хранится результат и можно ли его воспроизвести;
- какие capability подтверждены runtime, заявлены автором или только
  предполагаются.

Это не «ещё один ChatGPT поверх Ollama». Предлагаемое позиционирование —
**resource-aware local model workbench и control plane**. Chat остаётся важным
experience, но не определяет всю предметную модель.

## Пользователи и задачи

### Основной пользователь

Технически уверенный владелец Mac на Apple Silicon или Linux/NVIDIA workstation
с локальным Ollama, который:

- пробует разные quantization и modality;
- хочет избежать OOM, swap и скрыто загруженных моделей;
- использует локальность ради приватности, цены или независимости;
- ожидает удобство GUI, но иногда предпочитает CLI/TUI;
- готов настраивать advanced-параметры, если simple mode остаётся простым.

### Ключевые jobs-to-be-done

1. Найти совместимую модель под задачу и устройство.
2. Установить вариант и увидеть реальное состояние загрузки.
3. Быстро получить одноразовый результат без создания мусорной истории.
4. Вести сохраняемый диалог с Markdown, thinking и artifacts.
5. Организовать долгую работу в Project с файлами, recipes и permissions.
6. Запустить длительную agent-задачу, уйти со страницы и безопасно продолжить.
7. Превратить audio/image/document input в удобный typed output.
8. Управлять тем же приложением через стабильный CLI и интерактивный TUI.
9. Использовать независимого coding agent без Claude Code/Codex dependency.
10. Получить ненавязчивое уведомление, когда долгая работа закончилась.

## Продуктовые принципы

1. **Правда важнее уверенного UI.** `unknown` лучше ложного capability или fit.
2. **Работа принадлежит Job, не странице.** Навигация не должна быть механизмом
   отмены.
3. **Ресурс один на весь host.** Все вкладки, чаты, modalities и prewarm делят
   общий governor.
4. **Simple by default, explicit advanced.** Частый flow имеет короткий путь;
   специфичные параметры доступны в раскрываемой панели.
5. **Artifacts first.** Transcript, audio, image, video, JSON и files — типизированные
   результаты, а не случайные строки в сообщении.
6. **Specialized common path, schema fallback for long tail.** Частые операции
   получают качественный UI; неизвестная operation — честную generic-форму.
7. **Local-first не означает insecure.** Remote mode, shell, MCP и secrets имеют
   отдельные trust boundaries.
8. **Никакой скрытой магии.** Автоматический unload, compaction, routing и probes
   объясняются и могут быть переопределены.
9. **Название заменяемо.** Рабочий brand не должен определять storage/API навсегда.
10. **Один фундамент для Web, CLI и TUI.** Интерфейсы не реализуют отдельные
    lifecycle semantics.
11. **High-end hardware не искусственно урезается.** Context, thinking, output и
    число devices ограничиваются подтверждёнными runtime/adapter/policy facts, а
    не прошитым в UI предположением о среднем ноутбуке.

## Scope

### Core

- installed models и runtime management;
- capability registry с provenance;
- fit/compatibility и model variant selection;
- durable Jobs, queue, cancellation, events и recovery;
- Quick Run, Chat, Project, Recipe, Agent Run и Artifact;
- text/thinking/Markdown, attachments и document work;
- последовательное добавление STT/TTS, vision/OCR и image operations;
- CLI commands и TUI поверх общего API;
- first-party coding Agent API/CLI;
- локальные MCP, skills и tools с permissions.
- English и curated Russian UI с glossary.
- in-app и optional sound completion notifications.

### Не является ближайшей целью

- собственный inference runtime вместо Ollama;
- облачный multi-tenant SaaS;
- поддержка каждого вида ML-модели специализированным экраном;
- автоматическое определение качества модели по её размеру или тегам;
- distributed scheduler до появления нескольких реальных inference hosts;
- бесконтрольный автономный агент без budgets, approvals и audit;
- scraping закрытых или запрещающих автоматизацию каталогов;
- одновременный feature parity с LM Studio, Open WebUI, Jan и AnythingLLM.
- video workbench до отдельного нового product decision.
- Windows/WSL support без реального пользователя.

## Outcome metrics

До сбора baseline это направления измерения, а не обещанные числа:

| Outcome                          | Локальный сигнал                                               |
| -------------------------------- | -------------------------------------------------------------- |
| Надёжный первый turn             | доля `send → first event → terminal event` без reload          |
| Нет «пустых ответов без причины» | каждый assistant/result имеет terminal status или явную ошибку |
| Ресурсная предсказуемость        | OOM/forced swap, ошибочный fit, внеплановые parallel loads     |
| Наблюдаемость                    | доля времени Job с известной phase и model lease               |
| Recoverability                   | Jobs, восстановившие status и events после reload/restart      |
| Быстрый common path              | действия до запуска Quick Run/Chat/STT                         |
| Каталожное доверие               | доля claims с provenance и freshness                           |
| Agent safety                     | tool calls с известным policy decision и audit record          |
| Long-run progress                | checkpoints с новым evidence и отсутствие repeated no-progress |
| Background awareness             | завершённые Jobs с доставленным локальным notification state   |

Телеметрия по умолчанию остаётся локальной. Экспорт или отправка наружу требует
явного opt-in.

## Требования

Приоритеты: `P0` — фундамент/стабильность, `P1` — основное ценностное предложение,
`P2` — расширение, `P3` — долгий горизонт.

### Надёжность и Jobs

| ID      | Pri | Требование                                                                                                                |
| ------- | --: | ------------------------------------------------------------------------------------------------------------------------- |
| RUN-001 |  P0 | Создание работы возвращает стабильный `jobId`; UI отдельно подписывается на события.                                      |
| RUN-002 |  P0 | Job хранит status, phase, timestamps, error, stop reason и связь с output.                                                |
| RUN-003 |  P0 | Повтор с тем же idempotency key не создаёт второй Job.                                                                    |
| RUN-004 |  P0 | Reload/navigation позволяют reattach и replay с последнего event sequence.                                                |
| RUN-005 |  P0 | Cancel идемпотентен и приводит к наблюдаемому terminal state.                                                             |
| RUN-006 |  P0 | Падение UI никогда не превращает ошибку runtime в обычный пустой assistant.                                               |
| RUN-007 |  P1 | После server restart незавершённый Job становится `interrupted` либо возобновляется только поддерживающим resume adapter. |
| RUN-008 |  P1 | Thinking, content, tool и usage являются разными event/output channels.                                                   |

### Ресурсы и модельный lifecycle

| ID      | Pri | Требование                                                                                                              |
| ------- | --: | ----------------------------------------------------------------------------------------------------------------------- |
| RES-001 |  P0 | Один host-level governor принимает все local inference Jobs.                                                            |
| RES-002 |  P0 | Default policy допускает один accelerator Job; остальные ставятся в очередь.                                            |
| RES-003 |  P0 | Runtime bar показывает Jobs, queue, loaded models, lease и RAM/VRAM confidence.                                         |
| RES-004 |  P0 | Навигация не unload-ит модель и не отменяет Job.                                                                        |
| RES-005 |  P1 | Новый конфликтующий Job предлагает queue, stop-and-switch или safe parallel, если fit подтверждён.                      |
| RES-006 |  P1 | Prewarm — low-priority cancellable lease с debounce и коротким idle TTL.                                                |
| RES-007 |  P1 | Governor сверяет своё состояние с Ollama `/api/ps`, включая внешние клиенты.                                            |
| RES-008 |  P1 | Fit различает `observed`, `estimated` и `unknown` и показывает hardware/context basis.                                  |
| RES-009 |  P2 | Advanced policy позволяет pin, TTL и measured parallelism без изменения safe defaults.                                  |
| RES-010 |  P2 | High-memory workstation использует подтверждённые большие context/output и несколько devices без искусственного UI cap. |

### Models и Marketplace

| ID      | Pri | Требование                                                                                                                |
| ------- | --: | ------------------------------------------------------------------------------------------------------------------------- |
| MOD-001 |  P0 | Installed Models отделены от Marketplace и дают inspect/load/unload/delete.                                               |
| MOD-002 |  P1 | Variant выбирается до install; fit считается для выбранного digest/quantization.                                          |
| MOD-003 |  P1 | Capability claim содержит source, confidence, observed time и runtime fingerprint.                                        |
| MOD-004 |  P1 | Поиск фильтрует task, modality, capability, context, memory, fit, installed/cloud/source и license.                       |
| MOD-005 |  P1 | Пользователь видит stale/offline/claimed/runtime-verified состояние источника.                                            |
| MOD-006 |  P1 | Неизвестные capabilities не интерпретируются как unsupported.                                                             |
| MOD-007 |  P2 | Controlled probes можно запустить вручную или по safe policy; результат кэшируется по fingerprint.                        |
| MOD-008 |  P2 | User override видим, экспортируем и не маскируется под автоматическое определение.                                        |
| MOD-009 |  P1 | `Add from Ollama` принимает model name/page URL, показывает normalized preview и запускает local pull после confirmation. |
| MOD-010 |  P1 | HF import позволяет выбрать exact GGUF/revision, увидеть license/size/fit, скачать и импортировать с provenance.          |

### Рабочие сущности

| ID       | Pri | Требование                                                                                              |
| -------- | --: | ------------------------------------------------------------------------------------------------------- |
| WORK-001 |  P1 | Quick Run использует явную retention policy; Session заканчивает successful Job или команда Finish.     |
| WORK-002 |  P1 | Chat хранит multi-turn history, typed artifacts и Markdown.                                             |
| WORK-003 |  P1 | Project группирует work и задаёт defaults для routing/Recipe, retention, context, export и bindings.    |
| WORK-004 |  P1 | Recipe хранит operation, routing, defaults, prompt, schema и persistence policy.                        |
| WORK-005 |  P1 | Artifact имеет type, provenance, storage reference, preview и export actions.                           |
| WORK-006 |  P1 | Project Chat ищется по user/final-assistant text и имеет active/archive разделы с unarchive.            |
| WORK-007 |  P2 | Context compaction создаёт видимый checkpoint/summary и не стирает исходную историю.                    |
| WORK-008 |  P1 | Chat Info даёт трёхпозиционный retention control: Keep, 7 days, Session.                                |
| WORK-009 |  P1 | Maintenance Job применяет expiry при startup и периодически, используя Trash/grace перед blob deletion. |
| WORK-010 |  P1 | Thinking хранится отдельным diagnostic Artifact 7 дней и удаляется независимо от final answer.          |
| WORK-011 |  P2 | Project имеет редактируемые name, searchable icon и accessible color.                                   |
| WORK-012 |  P1 | Новый Chat получает global rolling 7-day default либо explicit Project retention default.               |
| WORK-013 |  P1 | Session Chat после ухода хранится в Trash 24 часа для восстановления.                                   |

### Workbench и modalities

| ID     | Pri | Требование                                                                                                                              |
| ------ | --: | --------------------------------------------------------------------------------------------------------------------------------------- |
| WB-001 |  P1 | Workbench выбирается по operation descriptor, а не только по имени модели.                                                              |
| WB-002 |  P1 | Common operations имеют typed inputs, progress, outputs и Advanced panel.                                                               |
| WB-003 |  P1 | Неизвестная operation с parameter schema получает generic schema form.                                                                  |
| WB-004 |  P2 | STT поддерживает upload/record, segment progress, copy/export, language и vocabulary.                                                   |
| WB-005 |  P2 | Voice input для Chat выполняется отдельным Job и планируется тем же governor.                                                           |
| WB-006 |  P2 | TTS выдаёт audio artifact с play/seek/speed/download.                                                                                   |
| WB-007 |  P2 | Vision/OCR принимают image/document, показывают extracted typed output и provenance.                                                    |
| WB-008 |  P2 | Image generation показывает count/seed/size/progress/gallery/download, если adapter это подтверждает.                                   |
| WB-009 |  P3 | Video остаётся deferred и не получает implementation phase без нового product decision.                                                 |
| WB-010 |  P3 | Forecasting, ranking/recommendation и другой long tail используют versioned adapter и structured Artifact без новой top-level taxonomy. |
| WB-011 |  P2 | STT Workbench разделяет model-native raw/normalized modes и LLM cleanup/summary stages.                                                 |
| WB-012 |  P3 | System-wide voice hotkey поддерживает toggle и hold-to-talk через platform integration.                                                 |

### Agent, tools, MCP и skills

| ID      | Pri | Требование                                                                                          |
| ------- | --: | --------------------------------------------------------------------------------------------------- |
| AGT-001 |  P1 | Tool/MCP/Skill bindings задаются global → Project → Recipe → Job с видимым effective policy.        |
| AGT-002 |  P1 | Mutating action имеет allow/deny/remember scope, durable audit и cancellation semantics.            |
| AGT-003 |  P2 | Agent Run хранит plan, checkpoints, artifacts, budgets, approvals и verification status.            |
| AGT-004 |  P2 | Deliberate weak-model strategy выбирается явно, а не выводится из parameter count.                  |
| AGT-005 |  P2 | Долгий Agent Run переживает уход со страницы и безопасно восстанавливается.                         |
| AGT-006 |  P2 | Tools работают в allowed roots; remote profile не наследует local shell permissions.                |
| AGT-007 |  P1 | Alamo предоставляет независимый first-party coding Agent API/CLI без branded external dependency.   |
| AGT-008 |  P1 | Coding agent читает/изменяет code/config/docs, запускает commands/tests и сохраняет evidence.       |
| AGT-009 |  P1 | Agent Run выбирает Manual approvals или Auto within explicit policy.                                |
| AGT-010 |  P2 | MCP/Skills выключены по default, включаются на Project и могут временно меняться на конкретном Run. |
| AGT-011 |  P2 | Deliberate profile оптимизирует 4–6+ hour run по качеству с checkpoints, review и watchdog.         |

### CLI, service и branding

| ID      | Pri | Требование                                                                                            |
| ------- | --: | ----------------------------------------------------------------------------------------------------- |
| CLI-001 |  P1 | Существуют scriptable `start/status/stop/open` с exit codes и JSON output.                            |
| CLI-002 |  P1 | Alamo service, Ollama service и loaded model — разные объекты управления.                             |
| CLI-003 |  P2 | No-args TUI вызывает те же команды и показывает текущий service state.                                |
| CLI-004 |  P2 | Phase 4 CLI поддерживает models, jobs, chat и config; agent добавляется в Phase 5.                    |
| CLI-005 |  P2 | UI Exit завершает только Alamo service; остановка внешнего Ollama требует отдельного подтверждения.   |
| CLI-006 |  P1 | Background service переживает закрытие terminal и поддерживает opt-in login autostart на macOS/Linux. |
| CLI-007 |  P1 | Web/CLI/TUI используют одну settings store и controlled restart для restart-sensitive changes.        |
| BRD-001 |  P0 | Новые UI/package/storage identifiers не размножают рабочее название.                                  |
| BRD-002 |  P2 | Rename использует manifest, aliases и data migration, сохраняя старые installs.                       |

### Localization, glossary и notifications

| ID       | Pri | Требование                                                                                           |
| -------- | --: | ---------------------------------------------------------------------------------------------------- |
| I18N-001 |  P1 | English является primary locale; Russian — curated human-authored locale.                            |
| I18N-002 |  P1 | User-facing strings не hardcoded и имеют locale key/fallback.                                        |
| I18N-003 |  P1 | Settings содержит searchable glossary с простыми примерами.                                          |
| NOT-001  |  P1 | Каждая новая terminal Job создаёт exact one durable content-free notification; old Jobs не backfill. |
| NOT-002  |  P2 | Web даёт at-most-once short sound; service/CLI/TUI остаются silent.                                  |
| NOT-003  |  P2 | Default When background; Chat override — inherit, Off, When background или Always.                   |
| NOT-004  |  P2 | Notification не раскрывает prompt/result и уважает browser permission/accessibility preferences.     |

**Current P3-P:** I18N-001..003 реализованы для Web. Settings хранит exact
`en | ru` в server-owned store, English служит source/fallback, curated Russian
покрывает тот же key manifest, а searchable Glossary содержит 17 stable entries
с определениями и примерами. CLI/TUI locale и contextual Glossary help не входят
в этот current subset. Следующий slice P3-Q начинает только visual NOT-001;
sound/policy/permission NOT-002..004 остаются target Phase 4.

Accepted target уточнён решениями
[2026-08-18](decisions/2026-08-18-phase-3-4-decisions.md): Project defaults,
Quick Run Session, search/archive, service/CLI и notification delivery. Эти
решения ещё не означают current implementation.

### Platform support

| ID       | Pri | Требование                                                   |
| -------- | --: | ------------------------------------------------------------ |
| PLAT-001 |  P1 | macOS Apple Silicon — первый verified tier.                  |
| PLAT-002 |  P2 | Linux/NVIDIA на Ubuntu/Fedora family — второй verified tier. |
| PLAT-003 |  P3 | Windows/WSL остаётся out of scope до появления требования.   |

## Критические acceptance examples

### Первый Chat turn

```gherkin
Given Ollama доступен и модель установлена
When пользователь создаёт Chat и отправляет первое сообщение
Then route может измениться без падения React
And Job получает стабильный идентификатор
And UI показывает queued/loading/prefill/thinking/generating
And terminal state сохраняется
And reload восстанавливает user input, result либо явную ошибку
```

### Переход во время генерации

```gherkin
Given Job генерирует ответ
When пользователь открывает другой Chat
Then Job продолжает выполняться
And Runtime Bar продолжает показывать его
And отправка конфликтующего Job предлагает queue или stop-and-switch
And простая навигация не требует destructive confirmation
```

### Resource safety

```gherkin
Given одна модель держит accelerator lease
When другой Job требует несовместимую модель
Then governor не начинает optimistic parallel load
And показывает основание конфликта
And unload происходит только после release всех leases
And состояние сверяется с фактическим /api/ps
```

### Неизвестная модель

```gherkin
Given metadata модели неполна
When каталог строит карточку
Then UI показывает unknown и provenance доступных claims
And не обещает tools/thinking/media
And позволяет безопасный probe или user override
```

### Retention и model context

```gherkin
Given Chat имеет retention 7 days
When пользователь выгружает модель
Then сохранённая Chat history остаётся на диске
And transient KV cache может быть потерян
And следующий Job может заново собрать context из истории
And UI не обещает побитно тот же stochastic output
And maintenance показывает exact expiry до удаления
```

```gherkin
Given пользователь создаёт Chat внутри или вне Project
When пользователь явно не выбрал policy и Project не задаёт свой default
Then Chat получает global rolling retention 7 days
And expiry продлевается только пользовательской активностью
```

```gherkin
Given Project задаёт retention default Session
When пользователь создаёт новый Project Chat без explicit override
Then новый Chat получает Session
And существующие Chats не изменяются при последующей смене Project default
```

```gherkin
Given пользователь создаёт Quick Run metadata внутри или вне Project
When пользователь не выбирал другую retention policy
Then Quick Run получает Project default либо global 7 days без кнопки Save
And текущий foundation не запускает model, Job или cleanup
And target Session заканчивается successful Job либо explicit Finish
And failed, cancelled или interrupted Job не заканчивает Session автоматически
```

```gherkin
Given пользователь подтвердил явную команду Leave session для Session Chat
When связанная Job стала terminal
Then Chat попадает в Trash
And его можно восстановить в течение 24 часов
And reload, reconnect, закрытие вкладки или server restart сами по себе не завершают Session
```

### Background notification

```gherkin
Given Job выполняется в другом Chat
And его notification policy равна When background
When Job становится terminal
Then Runtime Bar и Chat получают badge
And разрешённый короткий sound воспроизводится один раз
And notification не содержит private prompt или answer
And старая terminal Job до cutover не создаёт backfill notification
```

## Зависимости и границы решения

- Полный live-каталог Ollama не входит в план; используются manual references,
  local data, HF API и curated snapshot без scraping.
- HF GGUF import — download/inspect/local import pipeline, а не гарантированный
  direct `ollama pull` по любой ссылке.
- Media UI зависит от adapter, который даёт operation и parameter schema.
- Background jobs требуют Run Engine до нового navigation behavior.
- Prewarm требует Governor; нельзя добавлять его отдельным UI-effect.
- Agent overnight mode требует durable events, checkpoints, security и watchdog
  limits; внешние branded agents не являются foundation.
- TUI строится после scriptable lifecycle commands, а не вместо них.
- Remote mode требует отдельного security design и не включается обычным bind.
