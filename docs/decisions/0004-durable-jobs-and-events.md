# ADR-0004: Durable Job и replayable events

**Статус:** proposed  
**Дата:** 2026-08-02

## Context

Current turn принадлежит POST/SSE connection. Route change отменяет работу,
SSE history не сохраняется, empty assistant не имеет status/error, browser crash
невозможно восстановить.

## Decision

Conversation/thread хранит контекст, но execution принадлежит durable Job:

- POST command создаёт Job идемпотентно;
- GET SSE подписывается и replay events по sequence;
- status/error/stop reason сохраняются;
- explicit cancel отделён от disconnect;
- restart переводит unsafe executing Job в interrupted;
- output становится typed Artifact/message projection.

Event записывается до live broadcast. Terminal state и terminal event фиксируются
одной transaction.

## Invariants

- один idempotency key → один Job в scope;
- sequence уникален и монотонен;
- disconnect не cancel;
- ровно один terminal state/event;
- retry создаёт новый attempt;
- unsafe mutating action не replay-ится автоматически.

## Consequences

Плюсы:

- navigation/reload safe;
- UI/CLI/TUI видят одну работу;
- error и partial output объяснимы;
- foundation для agents/pipelines.

Минусы:

- event retention и compaction нужно проектировать;
- DB пишет больше строк;
- projection должен обрабатывать duplicate/gap;
- migration current messages/routes требует bridge.

## Alternatives

- WebSocket как единица работы: connection ownership остаётся проблемой.
- background React worker: не переживает page/process и не владеет Ollama.
- current POST/SSE + retries: риск duplicate generation.

## Validation

- browser disconnect во время generation не прекращает Job;
- reconnect с `after` воспроизводит пропущенные events;
- restart даёт interrupted, не ghost running;
- duplicate submit не создаёт второй inference.
