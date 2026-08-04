# Открытые продуктовые решения

**Статус:** proposed question register after iteration 2026-08-02

**Проверено:** 2026-08-02

Ответы Q-01–Q-21 зафиксированы в
[decision log](../decisions/2026-08-02-product-decisions.md). Ни один исходный
вопрос больше не блокирует документирование архитектуры.

## Resolution Q-01–Q-21

| Вопрос | Результат                                                       |
| ------ | --------------------------------------------------------------- |
| Q-01   | accepted: собственный resource-aware workbench                  |
| Q-02   | accepted: Job продолжает работу при навигации                   |
| Q-03   | accepted: single lane default, measured parallel later          |
| Q-04   | accepted: Alamo service и Ollama daemon разделены               |
| Q-05   | resolved: no permission/no live scrape; manual references       |
| Q-06   | accepted: HF discovery и direct valid GGUF import               |
| Q-07   | accepted: macOS Apple Silicon + Linux NVIDIA                    |
| Q-08   | accepted: logical Project с filesystem bindings                 |
| Q-09   | accepted: 7-day default; Keep override; Session recovery 24h    |
| Q-10   | accepted: live reasoning + diagnostic retention 7 days          |
| Q-11   | accepted: English + curated Russian + glossary                  |
| Q-12   | accepted: full text foundation before STT                       |
| Q-13   | accepted: browser capture first, hotkey later                   |
| Q-14   | accepted: native STT и LLM post-processing разделены            |
| Q-15   | accepted: video deferred indefinitely                           |
| Q-16   | accepted with changed direction: first-party coding agent       |
| Q-17   | accepted: deliberate long-run profile; exact watchdog open      |
| Q-18   | accepted: MCP/Skills off by default and Project-scoped          |
| Q-19   | accepted: background service, shared settings, opt-in autostart |
| Q-20   | open: новое имя пока не выбрано                                 |
| Q-21   | accepted: JetBrains technical UI + document font                |

## Resolution Q-22–Q-24

### Q-22. Какой Chat retention является default?

**Accepted:** любой новый Chat получает `7 days`, включая Chat внутри Project.
Project не меняет default. Бессрочное хранение включается пользователем через
`Keep`.

### Q-23. Когда заканчивается `Session` Chat?

**Accepted:** уход пользователя из Chat завершает Session lifecycle. Reload или
reconnect сами по себе не считаются уходом. Пока связанная Job не terminal,
удаление откладывается. Затем Chat попадает в Trash на 24 часа и может быть
восстановлен или переведён в `7 days`/`Keep`.

### Q-24. TTL продлевается от создания или последней активности?

**Accepted:** rolling TTL считается от последней user activity. Model, tool,
maintenance и background events не продлевают TTL. UI показывает exact expiry.

## Блокируют Hugging Face import slice

### Q-25. Какие форматы импортировать с Hugging Face первыми?

**Рекомендация:** только exact GGUF file/revision. Safetensors conversion и GGUF
adapters — отдельные поздние capabilities.

Пользователь сообщил, что обычно выбирает проверенные GGUF; это делает первый
slice безопаснее и понятнее.

## Resolved для Add from Ollama

### Q-26. Что принимать в поле «Add from Ollama»?

**Accepted 2026-08-03:** model name (`qwen3:8b`) и URL официальной Ollama model
page. Preview показывает нормализованное имя; pull начинается только после
подтверждения.

Произвольный URL не передаётся Ollama и не используется для server-side fetch.
Это явно reconciled с accepted D-005 перед handoff P2-D; Q-25 остаётся открытым
и продолжает блокировать первый Hugging Face import slice.

## Блокируют autonomous agent safety

### Q-27. Какие watchdog limits нужны long-running Agent Run?

Это не денежный budget. Нужно предотвратить бесконечный одинаковый loop.

**Рекомендация:**

- user-configurable expected duration;
- hard wall-clock ceiling;
- repeated-failure/no-progress threshold;
- disk/output ceiling;
- pause on unavailable dependency;
- explicit `No time target`, но не `No safety limits`.

Точные значения следует выбрать после 4–6-hour benchmark.

### Q-28. Что auto mode всё равно никогда не делает без подтверждения?

**Рекомендация:** выход за allowed roots, credential access, изменение service/
login configuration, irreversible delete, push/publish/deploy и расширение
network allowlist.

Даже для личного MCP это защищает от ошибки модели, а не от недоверия к автору
MCP.

## Не блокируют ранние фазы

### Q-29. Completion sound default

**Рекомендация:** in-app notification включено; sound включён только для
background Job и выключен, когда Job открыт. Global + per-Chat override.

Нужно выбрать/создать короткий лицензированный sound и проверить reduced-motion/
sensory preferences.

### Q-30. Русская метка `Recipe`

**Рекомендация:** `Сценарий`; в glossary объяснить, что это сохранённая настройка
задачи.

Альтернативы: `Профиль`, `Шаблон`. Нельзя использовать все три как разные
сущности.

### Q-31. Новое название

Остаётся открытым без влияния на ранние фазы. До выбора действует ADR-0007.

### Q-32. Custom Project icons

**Рекомендация:** сначала большая встроенная searchable icon library и accessible
palette. Upload custom SVG/image — поздняя функция с sanitation/storage risks.
