# ADR-0001: Local-first modular monolith

**Статус:** accepted

**Дата:** 2026-08-02

## Context

Проект single-user, запускается рядом с Ollama и должен управлять локальными
filesystem/tools/models. Главная сложность — correctness lifecycle и памяти, а не
сетевой throughput. Текущий monorepo уже имеет contract/server/web/CLI и SQLite.

## Decision

Сохранить один application process с модулями и явными interfaces. Ollama остаётся
внешним inference runtime; SQLite — source of truth metadata/events; большие
Artifacts — локальный content-addressed store.

Не вводить microservices, message broker, distributed database или Kubernetes для
локального режима. Web, CLI и TUI обращаются к общим application services через
один API.

## Invariants

- module не обходит public application boundary ради удобства;
- infrastructure adapter не определяет product entity;
- process restart учитывается Job recovery;
- remote deployment является отдельным security profile;
- второй inference host не моделируется до реального use case.

## Consequences

Плюсы:

- простая установка и диагностика;
- транзакции Job/event в одной SQLite;
- низкая операционная стоимость;
- текущий код эволюционирует без rewrite.

Минусы:

- synchronous SQLite work может блокировать event loop;
- один process требует дисциплины модульных границ;
- daemon lifecycle нужно реализовать явно;
- multi-host потребует будущего coordinator design.

## Alternatives

- Electron/Tauri desktop shell: возможно позднее, но не решает Job/Governor.
- Microservices: не соответствуют scale и усложняют локальный запуск.
- Только browser-to-Ollama: теряет durable state, filesystem policy и governor.

## Validation

- vertical Chat Job работает через public interfaces;
- server restart восстанавливает state;
- CLI и Web наблюдают один Job;
- packaged local install не требует внешней инфраструктуры.
