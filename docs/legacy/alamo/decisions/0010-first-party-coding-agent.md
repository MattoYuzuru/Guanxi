# ADR-0010: Независимый first-party coding agent

**Статус:** accepted  
**Дата:** 2026-08-02  
**Заменяет:** ADR-0008 в части external-agent-first

## Context

Primary use case — coding и работа с project files. Зависимость от Claude Code,
Codex или другого branded executable может быть недоступна в окружении
пользователя и переносит чужую архитектуру/ограничения. Требуются MCP, Skills,
docs research, commands, tests, review и длительные checkpointed runs.

## Decision

Создать собственный Agent Engine и CLI поверх Guanxi Job API:

- independent protocol/identity;
- coding-first tool contract;
- Project filesystem bindings;
- plan/step/checkpoint/evidence model;
- Skills и MCP bindings;
- manual и auto-within-policy approvals;
- context reconstruction/compaction;
- verification gates;
- long-running deliberate profile.

Agent CLI может быть проще зрелых coding agents, но его contracts должны быть
расширяемыми. Optional external interoperability не определяет внутренний Job,
Tool, Approval или Artifact schema.

## Minimal coding tool surface

- list/search/read files;
- previewed create/edit/delete;
- repository-aware commands;
- test/build/lint invocation;
- Git read operations и явно разрешённые writes;
- official documentation/web research;
- local endpoint/process/database inspection через scoped adapters;
- MCP tools/resources;
- Skill discovery/loading.

Каждый tool объявляет effect, input/output schema, cancellation и evidence.

## Approval modes

### Manual approvals

Mutating/network/secret action ждёт user decision.

### Auto within policy

Run заранее получает:

- allowed filesystem roots;
- allowed command classes/working directories;
- network/provider allowlist;
- enabled MCP/Skills;
- secret access policy;
- destructive-action boundary.

Внутри этой policy действие выполняется автоматически и журналируется. Выход за
policy, credentials и material destructive operations требуют отдельного
решения.

## Deliberate profile

Оптимизируется для качества, а не latency:

- небольшие bounded steps;
- durable task brief и plan;
- evidence после каждого шага;
- context compaction/reconstruction;
- periodic independent review;
- repeated-failure detection;
- restart/resume;
- configurable watchdog limits.

Profile выбирается пользователем/Recipe, не определяется размером модели.

## Consequences

Плюсы:

- независимость от внешних branded agents;
- contracts соответствуют local resource model;
- единая observability для UI/CLI;
- можно оптимизировать слабые модели.

Минусы:

- большой security/reliability scope;
- собственная tool/patch/terminal UX;
- качество требует benchmark и множества итераций;
- нельзя обещать parity с Codex/Claude Code.

## Alternatives

- External-agent-first: отклонено как foundation; остаётся optional integration.
- Generic Chat с shell tool: недостаточно plan/recovery/evidence semantics.
- Unlimited autonomous loop: непредсказуем и не восстанавливается.

## Validation

- агент завершает bounded repository task с diff, tests и evidence;
- restart восстанавливает checkpoint без повторения mutating effects;
- auto mode не выходит за allowed roots/policy;
- manual mode корректно переживает длительный wait;
- 4–6+ hour benchmark измеряет качество, repeated failures и recovery.
