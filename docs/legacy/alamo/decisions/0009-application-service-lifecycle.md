# ADR-0009: Background Application Service и shared control plane

**Статус:** accepted  
**Дата:** 2026-08-02

**Уточнено:** exact control, identity, stop/restart, clients и native platform
adapters определены в [ADR-0013](0013-phase-4-service-control-and-clients.md).

## Context

Текущий CLI держит server в foreground. Пользователь хочет закрыть terminal,
сохранить работу Jobs, использовать Web/TUI/CLI с общими settings и опционально
запускать приложение после login. Ollama является отдельным внешним сервисом.

## Decision

Ввести Guanxi Application Service как отдельный background process:

- single-instance process identity и control endpoint;
- `start --detach`, `status`, `stop`, `restart`, `open`;
- opt-in login autostart на macOS и Linux;
- graceful Job shutdown/recovery;
- одна SQLite/settings store для Web, CLI и TUI;
- restart plan для settings, требующих перезапуска;
- Ollama daemon lifecycle не принадлежит Guanxi.

No-args CLI — TUI-клиент, а не сам service. Scriptable commands и JSON output
остаются первичным automation contract.

## Platform adapters

- macOS: user-level launch service;
- Linux: `systemd --user` на Ubuntu/Fedora без custom fallback supervisor;
- Windows: out of scope.

UI показывает `unsupported`, если native adapter недоступен, а не симулирует
autostart.

## Invariants

- один data directory имеет не более одного writer service;
- stale process identity восстанавливается безопасно;
- закрытие terminal не останавливает service;
- `Exit Guanxi` не останавливает Ollama;
- restart не теряет durable queue/events;
- Web/CLI/TUI не имеют разных копий settings;
- autostart только opt-in и обратим.

## Consequences

Плюсы:

- background Jobs действительно независимы от terminal/browser;
- единый lifecycle и settings;
- predictable startup после login;
- foundation для system-wide hotkey и notifications.

Минусы:

- platform-specific install/uninstall;
- нужны stale lock, upgrade и crash recovery;
- browser не может сам завершить service без control API;
- settings migration и permissions требуют UX.

## Alternatives

- Foreground process: не удовлетворяет background/autostart.
- Запускать отдельный server из каждого client: создаёт multiple writers.
- Управлять Ollama как child: ломает другие локальные consumers.

## Validation

- terminal закрывается, active Job и Web остаются доступны;
- повторный start подключается к existing service;
- power/login startup opt-in работает на macOS и Linux;
- stop/restart имеют deterministic exit/status и recovery;
- Ollama продолжает работать после остановки Guanxi.
