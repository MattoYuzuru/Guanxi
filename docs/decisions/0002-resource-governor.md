# ADR-0002: Global Resource Governor и model leases

**Статус:** proposed  
**Дата:** 2026-08-02

## Context

Текущий lock ограничивает один turn только внутри thread, а `keep_alive:10m`
позволяет нескольким моделям оставаться в памяти. UI navigation одновременно
отменяет generation, но не гарантирует unload. Ollama может также обслуживать
внешних клиентов.

## Decision

Все local inference Jobs проходят через один host-level Resource Governor.
Default — один accelerator permit. Governor владеет queue/admission policy,
выдаёт leases, reconciles `/api/ps`, использует host telemetry и объясняет решения.

Типы leases: active Job, pipeline, pinned и prewarm. Navigation никогда не
освобождает lease напрямую. Parallel inference доступен только как advanced policy
после измеренного fit.

## Invariants

- active Job сильнее prewarm;
- unload невозможен при active/pinned lease;
- external runtime state не игнорируется;
- estimate всегда содержит confidence/basis;
- remote runtime использует remote hardware profile;
- release/cancel идемпотентны.

## Consequences

Плюсы:

- предотвращение optimistic multi-model OOM;
- единый status для Web/CLI/TUI;
- same-model reuse и безопасный preload;
- тестируемая очередь.

Минусы:

- интерактивный второй Job может ждать;
- нужны platform telemetry adapters;
- state Ollama остаётся eventually consistent;
- advanced users могут считать default слишком консервативным.

## Alternatives

- довериться только Ollama scheduling: не даёт product Job ownership, host
  telemetry и объяснимого UI.
- unload на route change: destructive и не учитывает другие consumers.
- unlimited parallelism: небезопасен на 16 GB и не воспроизводим.

## Validation

- concurrent threads не обходят governor;
- model switch не загружает две несовместимые модели одновременно;
- same model reused;
- external `/api/ps` drift виден;
- Apple unified memory и NVIDIA fixtures дают честные confidence states.
