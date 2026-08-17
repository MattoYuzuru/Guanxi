# ADR-0013: Phase 4 service control, clients и platform adapters

**Статус:** accepted
**Дата:** 2026-08-18
**Уточняет:** [ADR-0009](0009-application-service-lifecycle.md)

## Context

ADR-0009 принял background Application Service, shared settings и opt-in
autostart, но намеренно не выбирал control transport, exact identity, stop,
restart, client или platform semantics. Без этих решений разные клиенты могут
создать нескольких SQLite writers, убить чужой PID или по-разному трактовать
active Job при остановке.

Phase 4 должна быть лёгкой: один локальный profile, никакого remote control и
никакого отдельного supervisor protocol.

## Decision

### Process и control boundary

- Ровно один user-level service владеет canonical data directory и SQLite.
- Service держит OS advisory lock на протяжении lifetime. Identity record
  содержит PID, instance UUID, start time, loopback port и token reference.
- Клиенты используют authenticated loopback HTTP API существующего application
  server. Per-install random bearer secret хранится в owner-only file.
- Browser commands требуют same-origin HttpOnly SameSite session, Origin/CSRF
  checks и JSON content type. Remote bind/control не входит в Phase 4.
- Stale identity можно удалить только после получения lock и проваленного
  authenticated exact-instance handshake. PID не является authority для kill.
- Readiness deadline по умолчанию 15 секунд.

### Client contract

- Target command — `alamo`; `alamo-ui` остаётся compatibility alias.
- No-args command attaches/starts service и открывает TUI. `open` открывает Web,
  `start --detach` остаётся явным automation command.
- Phase 4 команды: service, models, jobs, chat и config. Agent command
  зарезервирован до Phase 5.
- JSON output versioned; event stream — NDJSON. stdout содержит только machine
  payload, diagnostics идут в stderr. Secrets не принимаются через argv.
- TUI является API client, а не process owner и не парсит service stdout.

### Stop/restart

Stop сначала ставит `stopping` и закрывает admission. Healthy active work имеет
до 30 секунд на completion. Unhealthy/stalled work либо work после deadline
атомарно становится `interrupted`; force stop пропускает drain, но не persistence.
Queued Jobs остаются queued. Ollama не останавливается.

Controlled restart применяет ту же drain policy, сохраняет durable queue/events,
применяет patch и ждёт health нового process до 15 секунд. Failure откатывает
patch и допускает одну recovery start со старым config. Active inference не
выдаётся за transparent resume.

### Settings и states

Restart-sensitive: bind host/port, Ollama/runtime endpoint и service/autostart
integration. Data directory не является обычной mutable setting. Остальные UI
preferences и policy применяются live. Preview показывает redacted diff, impact
и restart plan.

Service states: `stopped`, `starting`, `recovering`, `running`, `degraded`,
`stopping`, `failed`.

### Platform adapters

- macOS использует per-user LaunchAgent.
- Ubuntu/Fedora используют `systemd --user`.
- Нет sudo и custom fallback supervisor; unsupported публикуется явно.
- Enable/disable/status/uninstall идемпотентны и обратимы.

Это следует native user-service boundary: Apple определяет LaunchAgent как
per-user process, живущий в logged-in user context, а systemd создаёт отдельный
user service manager. Linux linger не включается молча.

## Invariants

- один data directory — максимум один writer;
- ни stale recovery, ни stop не убивают process только по PID;
- stop/restart сначала закрывают admission и сохраняют truthful Job state;
- queued work и ordered events переживают service restart;
- Ollama lifecycle всегда отдельный;
- Web/CLI/TUI используют одну store и один API;
- diagnostic output не содержит prompts, reasoning, private paths или secrets;
- autostart только opt-in и полностью обратим.

## Failure и recovery

- Lock занят, handshake успешен: client attaches к existing instance.
- Lock занят, handshake неуспешен: fail closed; чужой/зависший PID не убивается.
- Lock свободен, identity stale: record можно заменить после bounded checks.
- New config не стартует: atomic rollback и одна попытка old config.
- Drain deadline истёк: active owned Job → `interrupted`, queue сохраняется.
- Platform manager недоступен: adapter → `unsupported`, foreground use остаётся.

## Compatibility и migration

- Existing `alamo-ui` command остаётся alias после появления `alamo`.
- Existing data directory обнаруживается через ADR-0007 compatibility migration;
  Phase 4 не делает destructive rename и не вводит parallel profiles.
- Текущий `--data-dir` остаётся dev/test/foreground boundary, но service install
  не публикует несколько profiles.

## Consequences

Loopback HTTP уменьшает число protocols, но требует строгой browser/session
защиты. Bounded drain проще durable resume, но long Job может стать
`interrupted`. Native adapters дают понятный lifecycle ценой двух реализаций.

## Alternatives

- Unix socket/custom supervisor: отклонено как второй control protocol.
- PID file без lock/handshake: отклонено как unsafe stale-process authority.
- Немедленный kill всех Jobs: отклонён, потому что теряет нормальный completion.
- Неограниченный drain: отклонён, потому что stop перестаёт быть bounded.
- Несколько profiles: отложены до явной потребности и ownership design.

## Validation

- реальный child service + fake Ollama переживает закрытие terminal;
- concurrent starts дают одного writer и один instance ID;
- stale/corrupt/foreign identity fail closed и не вызывает PID-only kill;
- healthy drain, timeout, unhealthy и force paths дают exact Job/queue states;
- failed restart patch откатывается и recovery start использует old config;
- JSON/NDJSON/exit-code contract стабилен и redacted;
- macOS adapter проверяется обратимо, Linux adapter — deterministic fixture;
- live Ollama/GPU и Linux/NVIDIA tier проверяются только после Phase 4.

## Platform references

- Apple: [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
  определяет per-user LaunchAgent lifecycle и `~/Library/LaunchAgents` boundary.
- systemd: [pam_systemd](https://www.freedesktop.org/software/systemd/man/latest/pam_systemd.html)
  описывает отдельный per-user service manager; [loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)
  определяет explicit linger, который Alamo не включает молча.
