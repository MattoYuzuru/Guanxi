# Открытые продуктовые решения

**Статус:** question register; Q-01–Q-36 отвечены, открыты только sub-questions

**Проверено:** 2026-08-07

Ответы Q-01–Q-21 зафиксированы в
[decision log](../decisions/2026-08-02-product-decisions.md). Ни один исходный
вопрос больше не блокирует документирование архитектуры.

## Что осталось открытым

После owner session 2026-08-07 **ни один продуктовый вопрос не открыт и не
блокирует следующий slice**. Q-28a и Q-34a закрыты в той же сессии.

Единственный незакрытый пункт — **Q-27a**: `wrap up and report` требует нового
durable Job state, а не UI-флага, и нужно определить поведение при падении
process во время wind-down (иначе P1-E recovery отнесёт run к `interrupted` и
потеряет сам отчёт). Это design decision внутри Phase 5/8, к текущему slice
отношения не имеет; ждёт architecture review 2026-08-07.

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
| Q-17   | accepted: deliberate long-run profile; limits — см. Q-27        |
| Q-18   | accepted: MCP/Skills off by default and Project-scoped          |
| Q-19   | accepted: background service, shared settings, opt-in autostart |
| Q-20   | deferred: продолжаем с `Alamo`, см. Q-31                        |
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

## Resolved для Hugging Face import

### Q-25. Какие форматы импортировать с Hugging Face первыми?

**Accepted 2026-08-07:** только exact GGUF file/revision. Safetensors
conversion и GGUF adapters не входят в scope и остаются возможной поздней
capability, а не обещанием.

Следствия: HF slice **разблокирован**. Non-GGUF repository не должен выглядеть
importable — UI показывает explicit unsupported state, а не пустой список.
HF URL по-прежнему нельзя обещать как direct `ollama pull`: pipeline остаётся
metadata → exact GGUF → download/checksum → local Ollama import → probe
(см. `research/EVIDENCE.md`).

## Resolved для Add from Ollama

### Q-26. Что принимать в поле «Add from Ollama»?

**Accepted 2026-08-03:** model name (`qwen3:8b`) и URL официальной Ollama model
page. Preview показывает нормализованное имя; pull начинается только после
подтверждения.

Произвольный URL не передаётся Ollama и не используется для server-side fetch.
Это явно reconciled с accepted D-005 перед handoff P2-D. Q-25 закрыт 2026-08-07,
поэтому HF import больше не заблокирован.

## Resolved для autonomous agent safety

### Q-27. Какие limits нужны long-running Agent Run?

**Accepted 2026-08-07: только time-based control.** Memory, disk и output
ceilings явно **не** вводятся.

- пользователь задаёт expected duration до старта (например 8 часов);
- duration можно менять mid-run в обе стороны — продлить и сократить;
- hard interrupt доступен всегда;
- отдельное graceful `wrap up and report`: агент быстро сворачивается и отдаёт
  результат, вместо потери нескольких часов работы;
- ранний финиш нормален: 5 часов из 8 — это success, а не отклонение;
- нужен stall detector: ни input, ни output tokens не производятся.

Открытый sub-question **Q-27a**: `wrap up and report` — новое durable Job state,
а не UI-флаг. Точная граница state/transition и поведение при падении process
во время wind-down требуют design decision до реализации (см. architecture
review 2026-08-07).

### Q-28. Какая модель разрешений у agent filesystem access?

**Accepted 2026-08-07: три слоя scope.**

1. main folder, выбранная через UI, где стартует Run;
2. дополнительные folders, настраиваемые в UI;
3. per-prompt grants: пользователь в промпте называет конкретные paths или
   credentials; режим soft read/modify **без delete**.

Удаление секретов (например `.env`) запрещено. Внутри разрешённого scope агент
работает свободно — граница по scope, не по типу действия.

**Q-28a resolved 2026-08-07:** три слоя scope определяют, **где** агент работает,
и не отменяют approval за то, **что** он делает. Accepted ADR-0008/ADR-0010
границы сохраняются: `push`/`publish`/`deploy`, изменение service/login
configuration и расширение network allowlist по-прежнему требуют явного
подтверждения даже в auto mode, потому что эти действия выходят за пределы
файловой системы и не ограничиваются выбором папок.

Layer 3 задаётся текстом промпта, поэтому граница безопасности определяется
естественным языком, который читает сама модель. Из этого следует обязательное
требование: grant принимается только от пользовательского ввода, никогда из
содержимого файлов, tool output или repository. Path traversal (`..`, symlink,
hardlink, case-insensitive macOS paths) резолвится до проверки. `no delete` в
soft-режиме обязан покрывать эквиваленты удаления — truncate к нулю, overwrite
пустым и rename-away, иначе гарантия только номинальная.

## Resolved, не блокируют ранние фазы

### Q-29. Completion sound default

**Accepted 2026-08-07:** sound по умолчанию **выключен**. Звук допустим только
когда Job фоновая либо вкладка закрыта; для открытой Job звука нет. Нужен
короткий явно лицензированный sound; reduced-motion/sensory preferences
уважаются, visual equivalent обязателен.

### Q-30. Русская метка `Recipe`

**Accepted 2026-08-07:** `Сценарий`. `Профиль` и `Шаблон` не используются как
отдельные сущности; glossary объясняет, что это сохранённая настройка задачи.

### Q-31. Новое название

**Accepted 2026-08-07 как осознанная отсрочка:** продолжаем с `Alamo`. Имя пока
не выбрано, поэтому главное требование — сохранять лёгкую заменяемость: ADR-0007
central brand manifest, никаких новых hardcoded вариантов имени.

### Q-32. Custom Project icons

**Accepted 2026-08-07:** только большая встроенная searchable icon library и
accessible palette. Upload custom SVG/image не делаем — sanitation/storage risks
без потребности.

## Resolved: процесс и платформа

### Q-33. Нужен ли CI сейчас?

**Accepted 2026-08-07: пока нет.** Проект ещё не привязан к remote; первым будет
GitHub. До привязки все gates остаются ответственностью агента и владельца.

Явный остаточный риск: без CI статус `independently verified` не имеет
механизма, а browser gate легко пропустить. Поэтому protocol требует reviewer
subagent и видимый review-fix commit (`plans/WORKFLOW.md`). CI добавляется сразу
после привязки к GitHub.

### Q-34. Где живёт feature-flag infrastructure?

**Accepted 2026-08-07:** это отдельный slice, а не побочный эффект другой работы.
Владелец считает слой важным и требующим research.

Мотивация владельца — не generic flagging, а возможность на достаточно мощной
машине одновременно вести generation/research flow и держать speech-to-text
модель (STT дешёвая по compute). Это RES-009 measured parallelism.

**Q-34a resolved 2026-08-07:** разделяем на две независимые вещи.

**Estimated admission (можно делать без нового железа).** Владелец указал, что
решение о втором слоте можно принимать по уже известным фактам: сколько модель
потребляет и что известно про host. Такие факты в коде уже есть — declared model
size, `estimateKvCacheBytes`/`computeFit` (`packages/server/src/hardware/fit.ts`),
observed `/api/ps` VRAM в `CalibrationStore` и host memory sample. Поэтому Alamo
может суммировать их и выдавать **estimated** вердикт о параллельном запуске.

Жёсткое ограничение: такой вердикт остаётся `estimated` с источником и никогда
не публикуется как `measured` или как гарантия будущего admission. Это прямое
следствие текущего инварианта AGENTS.md — capability/fit не выводится как факт
без источника и уровня уверенности. Apple current pressure остаётся `unknown`
(`research/EVIDENCE.md`), значит estimated-решение обязано быть conservative и
объяснимым.

**Measured parallelism (только после Phase 4).** Подтверждение реальным
замером, RES-009 pin/TTL policy и second verified tier ждут живого железа
(Q-35). Flag infra не должна обещать measured там, где есть только estimate.

Мотивация владельца — параллельный generation/research + STT. STT относится к
Phase 6, а cross-phase rule запрещает audio до exit gate текстового фундамента.
Поэтому flag slice отделяется от STT-цели: инфраструктура и estimated policy
делаются раньше, а конкретный LLM+STT сценарий включается в свою фазу.

### Q-35. Когда проверяем живой Ollama и Linux/NVIDIA?

**Accepted 2026-08-07: после завершения Phase 4.** Linux+NVIDIA машина у владельца
есть, но использоваться будет только тогда; live-Ollama и Linux tests
проводятся вместе, на Mac и Linux.

Следствие: `PLAT-002` verified tier и любые hardware claims не могут входить в
exit gate Phase 2. До Phase 4 все tests остаются mocked, и это не production
validation.

### Q-36. Судьба `dev:mock`

**Accepted 2026-08-07:** если fixture server не нужен агентскому flow — удалить
script и убрать упоминания из docs, а не держать сломанным. Починка оправдана
только при реальном использовании.
