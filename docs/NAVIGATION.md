# Навигация по документации

**Статус:** implemented  
**Проверено:** 2026-08-03
**Назначение:** канонический индекс без дублирования содержания

## Быстрый маршрут

| Задача                             | Читать                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Понять продукт                     | [PRODUCT](PRODUCT.md) → [DOMAIN_MODEL](DOMAIN_MODEL.md)                                                  |
| Понять термины UI                  | [GLOSSARY](GLOSSARY.md)                                                                                  |
| Спроектировать экран или flow      | [UX_IA](UX_IA.md) → [PRODUCT](PRODUCT.md)                                                                |
| Изменить API или storage           | [HLD](architecture/HLD.md) → [LLD](architecture/LLD.md)                                                  |
| Работать со streaming/jobs         | [RUNTIME_LIFECYCLE](architecture/RUNTIME_LIFECYCLE.md)                                                   |
| Добавить capability/model provider | [LLD](architecture/LLD.md) → [ADR-0003](decisions/0003-capability-manifest-and-adapters.md)              |
| Менять модельную память/очередь    | [RUNTIME_LIFECYCLE](architecture/RUNTIME_LIFECYCLE.md) → [ADR-0002](decisions/0002-resource-governor.md) |
| Добавить MCP/tool/agent            | [PRODUCT](PRODUCT.md) → [LLD](architecture/LLD.md) → [ROADMAP](plans/ROADMAP.md)                         |
| Настроить окружение                | [DEVELOPMENT](DEVELOPMENT.md)                                                                            |
| Проверить изменение                | [TESTING](TESTING.md)                                                                                    |
| Продолжить реализацию              | [PHASE_STATUS](plans/PHASE_STATUS.md) → [WORKFLOW](plans/WORKFLOW.md) → [ROADMAP](plans/ROADMAP.md)      |
| Передать следующему агенту         | [NEXT_AGENT_PROMPT](plans/NEXT_AGENT_PROMPT.md)                                                          |
| Проверить принятые решения         | [Product decisions](decisions/2026-08-02-product-decisions.md) → [ADR](decisions/README.md)              |
| Понять внешние ограничения         | [EVIDENCE](research/EVIDENCE.md)                                                                         |

## Канонические документы

| Документ                                                       | Статус            | Владеет                                     |
| -------------------------------------------------------------- | ----------------- | ------------------------------------------- |
| [README](../README.md)                                         | implemented       | текущее пользовательское введение и запуск  |
| [AGENTS](../AGENTS.md)                                         | implemented       | краткие правила работы агента               |
| [PRODUCT](PRODUCT.md)                                          | mixed             | vision, границы, требования и outcomes      |
| [DOMAIN_MODEL](DOMAIN_MODEL.md)                                | accepted target   | понятия, ownership и инварианты             |
| [GLOSSARY](GLOSSARY.md)                                        | proposed copy     | user-facing English/Russian vocabulary      |
| [UX_IA](UX_IA.md)                                              | accepted target   | навигация, workbenches, визуальная система  |
| [DEVELOPMENT](DEVELOPMENT.md)                                  | implemented       | структура, команды и change protocol        |
| [TESTING](TESTING.md)                                          | implemented       | фактическое покрытие и целевая матрица      |
| [HLD](architecture/HLD.md)                                     | mixed             | текущая и целевая архитектура               |
| [LLD](architecture/LLD.md)                                     | mixed             | компоненты, контракты и данные              |
| [RUNTIME_LIFECYCLE](architecture/RUNTIME_LIFECYCLE.md)         | mixed             | jobs, leases, память и recovery             |
| [ADR index](decisions/README.md)                               | mixed             | архитектурные решения и их статус           |
| [Product decisions](decisions/2026-08-02-product-decisions.md) | accepted          | ответы владельца и разрешённые противоречия |
| [ROADMAP](plans/ROADMAP.md)                                    | accepted          | фазы, зависимости и exit gates              |
| [PHASE_STATUS](plans/PHASE_STATUS.md)                          | implemented       | mutable tracker текущего slice              |
| [WORKFLOW](plans/WORKFLOW.md)                                  | accepted          | протокол реализации и review                |
| [NEXT_AGENT_PROMPT](plans/NEXT_AGENT_PROMPT.md)                | ready             | bounded prompt для P1-C                     |
| [OPEN_QUESTIONS](plans/OPEN_QUESTIONS.md)                      | proposed          | решения, требующие подтверждения            |
| [EVIDENCE](research/EVIDENCE.md)                               | locally validated | внешние факты, риски и источники            |

## Диаграммы

Исходники Mermaid хранятся отдельно, чтобы их могли проверять и переиспользовать
агенты:

- [as-is system](architecture/diagrams/hld-system-as-is.mmd);
- [target system](architecture/diagrams/hld-system-target.mmd);
- [runtime sequence](architecture/diagrams/hld-runtime-target.mmd);
- [contract LLD](architecture/diagrams/lld-contract.mmd);
- [server LLD](architecture/diagrams/lld-server.mmd);
- [web LLD](architecture/diagrams/lld-web.mmd);
- [CLI LLD](architecture/diagrams/lld-cli.mmd);
- [target Agent LLD](architecture/diagrams/lld-agent-target.mmd);
- [target Service LLD](architecture/diagrams/lld-service-target.mmd);
- [domain ER](architecture/diagrams/domain-er.mmd);
- [job states](architecture/diagrams/job-state.mmd);
- [model lease states](architecture/diagrams/model-lease-state.mmd);
- [retention states](architecture/diagrams/retention-state.mmd).

## Правило актуализации

- Current-state меняется вместе с кодом.
- Target-state меняется через ADR либо явно отмеченное product decision.
- Roadmap ссылается на требования и ADR, но не дублирует их.
- Исследовательский факт содержит источник, дату и ограничение.
- Устаревший документ получает `superseded` и ссылку на замену; история решения
  не удаляется.
