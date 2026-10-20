# Product decisions: завершение Phase 3 и границы Phase 4

**Статус:** accepted
**Дата:** 2026-08-18
**Область:** Quick Run, Project, search/archive, Workbench, localization,
notifications, Application Service, CLI/TUI и autostart

Эта запись фиксирует ответы владельца 2026-08-18 и закрывает Q-37. Там, где
владелец делегировал выбор, ниже явно указано `implementation default`: такой
default можно уточнить внутри совместимой реализации, но нельзя молча менять
наблюдаемое product-поведение.

Запись уточняет D-009, D-018, D-019 и D-021 из
[решений 2026-08-02](2026-08-02-product-decisions.md). Текущий код остаётся
источником реализованного поведения; эта запись описывает accepted target.

## D-022. Окончание Quick Run Session

Session для Quick Run заканчивается двумя способами:

1. автоматически, когда связанная canonical Job успешно переходит в
   `completed`;
2. явной командой `Finish Quick Run Session`.

`failed`, `cancelled` и `interrupted` сами по себе Session не заканчивают: после
них пользователь может повторить запуск или закончить Session явно. Если
команда Finish дана во время non-terminal Job, server сохраняет намерение, но
начинает cleanup только после terminal state. Закрытие view, reload, disconnect
и export не являются Finish.

После окончания Quick Run использует ту же recoverable модель, что Session Chat:
Trash на 24 часа, Restore или перевод в `Keep`/`7 days` до deadline.
Это implementation default, выбранный для одной retention model; owner явно
зафиксировал оба события окончания.

## D-023. Notification rows без исторического backfill

- Каждая новая canonical Job при первом переходе в
  `completed | failed | cancelled | interrupted` создаёт ровно одну durable
  content-free Notification row.
- Старые terminal Jobs, существовавшие до migration/cutover, не backfill-ятся.
- Delivery policy не отменяет row. `off` выключает badge/announcement/sound, но
  сохраняет локальную историю исхода.
- `readAt` — глобальное durable состояние row; claim конкретного delivery
  channel хранится отдельно.

Exact storage, dedup и delivery semantics определяет
[ADR-0014](0014-notification-persistence-and-delivery.md).

## D-024. Project-scoped Chat search и простой archive

Первая версия поиска работает только внутри выбранного Project. Она индексирует:

- пользовательские prompts;
- финальные видимые ответы модели.

Title не участвует в полнотекстовом индексе первой версии. Reasoning/thinking,
tool output, private Job input, raw errors, attachment bytes, paths и secrets не
индексируются. Projectless Chats в эту версию поиска не входят.

Archive — nullable server-owned `archivedAt`. Архивация скрывает Chat из active
list, но не удаляет history, Jobs, Artifacts и ownership; доступен `Unarchive`.
Она не равна Trash и не останавливает Jobs. Поиск по умолчанию смотрит active
Chats, а явный filter переключает его на Archived. Это самый лёгкий полезный UI:
одна понятная секция без отдельной иерархии папок или нового lifecycle.

Project-only scope — ответ owner; indexed fields и `archivedAt` lifecycle —
делегированные implementation defaults.

## D-025. Project defaults применяются к каждой поддержанной группе

Project может задавать defaults для:

- preferred model/routing и Recipe;
- retention;
- context и export;
- versioned vocabulary;
- integration/tool/MCP/Skill bindings.

Это уточняет прежнее решение Q-22: global default нового Chat остаётся rolling
`7 days`, но Project теперь вправе предвыбрать `Keep`, `7 days` или `Session` для
**новых** Chats и Quick Runs. Пользователь может изменить выбор. Существующие
entities при изменении Project defaults не переписываются.

Effective defaults разрешаются при создании Job и попадают в immutable snapshot.
Bindings идут `global → Project → Recipe → Job`; наследник может сузить доступ,
а расширить — только явным user grant. MCP/Skills остаются выключены по default.
Exact snapshot и restrictive precedence — implementation defaults, сохраняющие
существующие security invariants.

## D-026. Phase 3 закрывает весь заявленный text foundation

До Phase 4 нужно закрыть весь оставшийся scope Phase 3, включая search/archive,
Project defaults/vocabulary/bindings, target navigation, notification visual
foundation и bounded Workbench/document batch foundation.

Делегированный implementation default — минимальная безопасная граница
Workbench:

- operation descriptor registry и текущий text-completion adapter;
- специализированный Chat/text renderer;
- generic form только для поддержанного безопасного JSON Schema subset;
- document batch из уже импортированных attachments с per-item status,
  частичным failure и Artifact results;
- unsupported schema/media/OCR явно показываются, а не угадываются.

PDF/OCR/media inference остаются в поздних фазах. Document batch не создаёт
скрытую media capability.

## D-027. Localization review не является отдельным gate

English source/fallback и curated Russian пишутся по ходу bounded slice. Exact
key parity, placeholders, hardcoded-copy inventory и EN/RU state assertions
обязательны. Отдельное human translation review не требуется; owner spot-check
доброволен и не блокирует Phase 3.

## D-028. Один service profile

Phase 4 поддерживает один user-level Application Service и один canonical data
directory. Параллельных profiles и нескольких service writers нет. Текущий
`--data-dir` сохраняется только как foreground/dev/test compatibility boundary,
а не как публичный parallel-profile contract.

## D-029. Canonical command и будущий rename

Accepted target canonical executable — `guanxi`. Текущий `guanxi` остаётся
compatibility alias после cutover и не считается новым visible brand.

Когда новое имя будет выбрано, оно заменяет `Guanxi` во всех видимых UI strings,
commands, docs, packages и assets через central brand/config boundary. Старые
CLI aliases, storage IDs и data paths могут временно оставаться только как
скрытый migration layer, чтобы не ломать installs. Простой destructive
search/replace storage identity запрещён ADR-0007.

## D-030. CLI/TUI surface Phase 4

Следующий surface — делегированный implementation default.

No-args `guanxi` подключается к service либо запускает default service, ждёт
readiness и открывает keyboard TUI. `guanxi open` открывает browser, а
`guanxi start --detach` остаётся явным automation command.

Phase 4 включает `service`, `models`, `jobs`, `chat` и `config`. `agent`
зарезервирован и честно unsupported до Phase 5. TUI показывает service state,
Jobs list/detail/cancel/events, model state/actions, Chats list/open/new/send и
config/restart preview. Shell completions генерируются для bash, zsh и fish, но
не устанавливаются автоматически.

Machine output имеет versioned JSON envelope; streaming использует NDJSON.
Implementation default для exit codes: `0` success, `2` usage, `3` service
unavailable/start failure, `4` not found, `5` conflict/busy, `6` denied,
`7` timeout, `8` operation failed и `130` user interrupt. Secrets не передаются
через argv и не возвращаются в JSON.

## D-031. Лёгкий local control plane и identity

Весь раздел — делегированный implementation default: клиенты переиспользуют
loopback HTTP Application
Service, а не вводят второй supervisor/socket protocol. Control API loopback-only
и использует per-install random bearer secret из owner-only file. Browser
mutation остаётся same-origin с HttpOnly SameSite session, Origin/CSRF checks и
JSON-only commands. Remote control в Phase 4 отсутствует.

Service lifetime защищён advisory lock. Identity record содержит PID, instance
UUID, start time, port и token reference. PID сам по себе никогда не является
основанием для kill. Stale record удаляется только после получения lock и
неуспешного authenticated handshake с exact instance ID.

Start/readiness timeout — 15 секунд. Состояния service:
`stopped`, `starting`, `recovering`, `running`, `degraded`, `stopping`, `failed`.

## D-032. Stop и controlled restart

Owner constraint: stop немедленно меняет status, ждёт response здоровой Job и
форсирует остановку нездоровой. Остальные детали раздела — implementation
defaults.

`stop` немедленно переводит service в `stopping` и прекращает admission новых
Jobs. Queued Jobs остаются durable queued для следующего старта.

Если active Job показывает здоровый runtime/progress, service ждёт bounded
graceful completion до 30 секунд. Если runtime unhealthy/stalled или deadline
истёк, Guanxi сохраняет `interrupted`, отменяет только принадлежащую ему работу и
завершает service. `--force` пропускает ожидание, но не пропускает durable
terminalization. Ollama daemon не останавливается.

Controlled restart использует ту же drain policy, сохраняет queue/events и не
обещает transparent continuation текущего inference. Затем применяет
restart-sensitive patch, закрывает DB и ждёт health нового process до 15 секунд.
При failure patch откатывается и делается одна попытка запуска со старым config;
дальше service остаётся `failed` с redacted diagnostics.

Restart-sensitive settings: bind host/port, Ollama/runtime endpoint и
service/autostart integration. Data directory не меняется обычной Phase 4
настройкой. Locale, theme, defaults, context/prewarm и notification policy
применяются live. Preview показывает redacted diff, влияние на active/queued
Jobs и restart plan.

## D-033. Platform adapters и evidence Phase 4

Platform/evidence details — делегированные implementation defaults.

- macOS: per-user LaunchAgent;
- Ubuntu/Fedora: `systemd --user` service;
- без `sudo` и без самодельного fallback supervisor;
- unsupported adapter показывается явно;
- enable/disable/status/uninstall обратимы и идемпотентны.

Phase 4 доказывает process lifecycle реальным child service и fake Ollama.
Live Ollama/GPU и Linux/NVIDIA verified tier остаются post-Phase-4 согласно Q-35.
Реализация Linux adapter не превращает `PLAT-002` в validated claim.

## D-034. Notification policy, background и sound

Это implementation-default refinement D-021 и Q-29; старый foreground sound
запрет сохраняется.

Global delivery policy default — `when_background`; Chat override:
`inherit | off | when_background | always`. Отдельный global
`soundEnabled=false` сохраняет Q-29: звук выключен, пока пользователь явно не
включил/preview-нул его. Effective policy фиксируется при terminal transition в
Notification row.

`background` в Phase 4 означает, что ни одна видимая Web tab текущего browser
profile не показывает exact Job/Chat. Tabs координируются через
`BroadcastChannel`. CLI/TUI не считаются foreground-view для browser delivery.

Sound принадлежит Web: без browser sound нет, service/CLI/TUI молчат. Permission
запрашивается только после явного Enable/Preview. `completed`, `failed` и
`interrupted` могут воспроизвести sound только в background; `cancelled`
остаётся visual-only. Exact Job/Chat в visible tab блокирует sound даже при
policy `always`; в этом случае `always` означает visual/unread/announcement.
Глобальный durable channel claim даёт at-most-once: crash после claim может
пропустить sound, но reload или другая tab не дублирует его. Visual equivalent
есть всегда и не содержит private content.

Подробности — [ADR-0014](0014-notification-persistence-and-delivery.md).

## D-035. Что остаётся открытым

Эти решения не закрывают Q-27a: durable `wrap up and report` state и recovery
длинного Agent Run требуют отдельного Phase 5/8 architecture decision. Других
открытых вопросов, блокирующих остаток Phase 3 или старт Phase 4, сейчас нет.
