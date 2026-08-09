# Architecture Decision Records

**Статус:** mixed decision index

**Проверено:** 2026-08-09

ADR фиксируют целевые решения. `accepted` означает выбранное target-поведение, но
не его наличие в текущем коде.

| ADR                                              | Статус      | Решение                                               |
| ------------------------------------------------ | ----------- | ----------------------------------------------------- |
| [0001](0001-local-modular-monolith.md)           | accepted    | local-first modular monolith                          |
| [0002](0002-resource-governor.md)                | accepted    | global Resource Governor и model leases               |
| [0003](0003-capability-manifest-and-adapters.md) | accepted    | evidence-based capabilities и task adapters           |
| [0004](0004-durable-jobs-and-events.md)          | accepted    | durable Job + replayable events                       |
| [0005](0005-unified-work-entities.md)            | accepted    | Quick Run, Chat, Project, Recipe, Agent Run, Artifact |
| [0006](0006-catalog-sources-and-compliance.md)   | accepted    | providers, manual references, no live scraping        |
| [0007](0007-brand-portability.md)                | accepted    | brand manifest и compatibility migration              |
| [0008](0008-agent-execution-and-integrations.md) | superseded  | прежний external-agent-first proposal                 |
| [0009](0009-application-service-lifecycle.md)    | accepted    | background service, settings и opt-in autostart       |
| [0010](0010-first-party-coding-agent.md)         | accepted    | независимый first-party coding agent                  |
| [0011](0011-server-owned-feature-flags.md)       | implemented | typed process-start flags и redacted read projection  |
| [0012][adr-0012]                                 | implemented | read-only explainable estimated pair verdict          |

[adr-0012]: 0012-estimated-parallel-admission-verdict.md

Принятые продуктовые ответы: [итерация 2026-08-02](2026-08-02-product-decisions.md).

## Статусы ADR

- `proposed` — обсуждается;
- `accepted` — решение принято;
- `implemented` — основная архитектурная обязанность существует в code;
- `validated` — подтверждена эксплуатацией;
- `superseded by ADR-NNNN` — заменена, но история сохранена;
- `rejected` — рассмотрена и не выбрана.

## Шаблон изменения

Каждый ADR содержит context, decision, invariants, consequences, alternatives и
validation. Существенное изменение accepted ADR создаёт новый record и
supersedes старый.
