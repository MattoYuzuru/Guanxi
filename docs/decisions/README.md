# Architecture Decision Records

**Статус:** proposed index  
**Проверено:** 2026-08-02

ADR фиксируют целевые решения. До явного подтверждения пользователем их статус
`proposed`; наличие файла не означает acceptance или implementation.

| ADR                                              | Статус   | Решение                                               |
| ------------------------------------------------ | -------- | ----------------------------------------------------- |
| [0001](0001-local-modular-monolith.md)           | proposed | local-first modular monolith                          |
| [0002](0002-resource-governor.md)                | proposed | global Resource Governor и model leases               |
| [0003](0003-capability-manifest-and-adapters.md) | proposed | evidence-based capabilities и task adapters           |
| [0004](0004-durable-jobs-and-events.md)          | proposed | durable Job + replayable events                       |
| [0005](0005-unified-work-entities.md)            | proposed | Quick Run, Chat, Project, Recipe, Agent Run, Artifact |
| [0006](0006-catalog-sources-and-compliance.md)   | proposed | provider adapters без запрещённого scraping           |
| [0007](0007-brand-portability.md)                | proposed | централизованный brand и compatibility migration      |
| [0008](0008-agent-execution-and-integrations.md) | proposed | durable bounded agents и scoped integrations          |

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
