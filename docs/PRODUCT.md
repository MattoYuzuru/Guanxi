# Product brief и требования

**Статус:** proposed  
**Проверено:** 2026-08-02  
**Горизонт:** от стабилизации alpha до локальной model workbench platform

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

Технически уверенный владелец Mac или PC с локальным Ollama, который:

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
- локальные MCP, skills и tools с permissions.

### Не является ближайшей целью

- собственный inference runtime вместо Ollama;
- облачный multi-tenant SaaS;
- поддержка каждого вида ML-модели специализированным экраном;
- автоматическое определение качества модели по её размеру или тегам;
- distributed scheduler до появления нескольких реальных inference hosts;
- бесконтрольный автономный агент без budgets, approvals и audit;
- scraping закрытых или запрещающих автоматизацию каталогов;
- одновременный feature parity с LM Studio, Open WebUI, Jan и AnythingLLM.

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

| ID      | Pri | Требование                                                                                          |
| ------- | --: | --------------------------------------------------------------------------------------------------- |
| MOD-001 |  P0 | Installed Models отделены от Marketplace и дают inspect/load/unload/delete.                         |
| MOD-002 |  P1 | Variant выбирается до install; fit считается для выбранного digest/quantization.                    |
| MOD-003 |  P1 | Capability claim содержит source, confidence, observed time и runtime fingerprint.                  |
| MOD-004 |  P1 | Поиск фильтрует task, modality, capability, context, memory, fit, installed/cloud/source и license. |
| MOD-005 |  P1 | Пользователь видит stale/offline/claimed/runtime-verified состояние источника.                      |
| MOD-006 |  P1 | Неизвестные capabilities не интерпретируются как unsupported.                                       |
| MOD-007 |  P2 | Controlled probes можно запустить вручную или по safe policy; результат кэшируется по fingerprint.  |
| MOD-008 |  P2 | User override видим, экспортируем и не маскируется под автоматическое определение.                  |

### Рабочие сущности

| ID       | Pri | Требование                                                                           |
| -------- | --: | ------------------------------------------------------------------------------------ |
| WORK-001 |  P1 | Quick Run не сохраняет историю по умолчанию, но результат можно сохранить.           |
| WORK-002 |  P1 | Chat хранит multi-turn history, typed artifacts и Markdown.                          |
| WORK-003 |  P1 | Project группирует Chats, Jobs, Recipes, files, vocabulary и permissions.            |
| WORK-004 |  P1 | Recipe хранит operation, routing, defaults, prompt, schema и persistence policy.     |
| WORK-005 |  P1 | Artifact имеет type, provenance, storage reference, preview и export actions.        |
| WORK-006 |  P1 | Chats можно искать, переименовывать, архивировать и группировать внутри Project.     |
| WORK-007 |  P2 | Context compaction создаёт видимый checkpoint/summary и не стирает исходную историю. |

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
| WB-009 |  P3 | Video renderer появляется только после стабильного adapter contract и реального provider.                                               |
| WB-010 |  P3 | Forecasting, ranking/recommendation и другой long tail используют versioned adapter и structured Artifact без новой top-level taxonomy. |

### Agent, tools, MCP и skills

| ID      | Pri | Требование                                                                                         |
| ------- | --: | -------------------------------------------------------------------------------------------------- |
| AGT-001 |  P1 | Tool/MCP/Skill bindings задаются global → Project → Recipe → Job с видимым effective policy.       |
| AGT-002 |  P1 | Mutating action имеет allow/deny/remember scope, durable audit и cancellation semantics.           |
| AGT-003 |  P2 | Agent Run хранит plan, checkpoints, artifacts, budgets, approvals и verification status.           |
| AGT-004 |  P2 | Deliberate weak-model strategy выбирается явно, а не выводится из parameter count.                 |
| AGT-005 |  P2 | Долгий Agent Run переживает уход со страницы и безопасно восстанавливается.                        |
| AGT-006 |  P2 | Tools работают в allowed roots; remote profile не наследует local shell permissions.               |
| AGT-007 |  P2 | Сначала поддерживается interop с внешними agents; собственный harness требует отдельной валидации. |

### CLI, service и branding

| ID      | Pri | Требование                                                                                          |
| ------- | --: | --------------------------------------------------------------------------------------------------- |
| CLI-001 |  P1 | Существуют scriptable `start/status/stop/open` с exit codes и JSON output.                          |
| CLI-002 |  P1 | Alamo service, Ollama service и loaded model — разные объекты управления.                           |
| CLI-003 |  P2 | No-args TUI вызывает те же команды и показывает текущий service state.                              |
| CLI-004 |  P2 | CLI поддерживает models, jobs, chat, agent и config без зависимости от browser.                     |
| CLI-005 |  P2 | UI Exit завершает только Alamo service; остановка внешнего Ollama требует отдельного подтверждения. |
| BRD-001 |  P0 | Новые UI/package/storage identifiers не размножают рабочее название.                                |
| BRD-002 |  P2 | Rename использует manifest, aliases и data migration, сохраняя старые installs.                     |

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

## Зависимости и границы решения

- Полный live-каталог Ollama зависит от разрешённого официального API или
  письменного разрешения; scraping не является планом.
- Media UI зависит от adapter, который даёт operation и parameter schema.
- Background jobs требуют Run Engine до нового navigation behavior.
- Prewarm требует Governor; нельзя добавлять его отдельным UI-effect.
- Agent overnight mode требует durable events, checkpoints, security и budgets.
- TUI строится после scriptable lifecycle commands, а не вместо них.
- Remote mode требует отдельного security design и не включается обычным bind.
