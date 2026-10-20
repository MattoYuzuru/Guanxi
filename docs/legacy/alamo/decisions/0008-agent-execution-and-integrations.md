# ADR-0008: Durable bounded agents и scoped integrations

**Статус:** superseded by ADR-0010

**Дата:** 2026-08-02

Предложение `external-agent-first` отклонено владельцем проекта. Общие требования
к durable bounded execution и scoped integrations сохранены и уточнены в
[ADR-0010](0010-first-party-coding-agent.md).

## Context

Планируются MCP, Skills, tools, deep research и долгий weak-model loop.
Текущие approvals in-memory, shell/filesystem имеют сильные эффекты, а контекст
может превышать возможности модели. Автоматическое определение «слабой модели»
ненадёжно.

## Decision

Сначала дать interop с внешними agents через совместимые Ollama endpoints. Свой
Agent Run строить поверх durable Job Engine с:

- explicit execution profile;
- plan и immutable checkpoints;
- bounded step/iteration/time/token/tool budgets;
- context compaction как Artifact;
- verifier gates;
- durable approvals/audit;
- scoped Tool/MCP/Skill bindings;
- resume как новый attempt от checkpoint.

`checkpointed_deliberate` — пользовательская/Recipe strategy, а не capability,
выводимая из parameter count.

Permissions наследуются Global → Project → Recipe → Job и могут сужаться. Remote
profile не наследует local shell/filesystem trust.

## Invariants

- model text не меняет permissions;
- mutating tool input digest фиксируется до approval;
- approval не переиспользуется при изменённом input;
- compaction не уничтожает source history;
- budget exhaustion terminal и видим;
- verification result хранится отдельно от model self-claim;
- secret content не попадает в prompt/log без явной policy.

## Consequences

Плюсы:

- долгий агент переживает UI navigation;
- слабая модель может работать малыми проверяемыми шагами;
- MCP/Skills не становятся global all-or-nothing;
- audit и recovery пригодны для ночных runs.

Минусы:

- собственный harness дорог и не ближайшая фаза;
- resume не универсален;
- security isolation требует platform work;
- качество weak-model strategy нужно измерять, а не предполагать.

## Alternatives

- сразу копировать Claude Code: scope и security слишком велики.
- in-memory autonomous loop: не recovery-safe.
- включать все MCP глобально: нарушает least privilege.

## Validation

- external agent launcher закрывает базовый coding use case;
- checkpointed prototype завершает bounded benchmark после restart;
- approval/audit восстанавливаются;
- adversarial model/tool content не расширяет policy;
- слабая стратегия сравнивается по качеству, времени и ресурсам.
