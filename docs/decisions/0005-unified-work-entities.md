# ADR-0005: Ограниченный набор рабочих сущностей

**Статус:** proposed  
**Дата:** 2026-08-02

## Context

Voice dictation, saved chat, temporary chat, document workspace, image studio,
agent и template легко превратить в десятки несовместимых «типов чата».

## Decision

Использовать шесть пользовательских понятий:

- Quick Run — ephemeral one-shot;
- Chat — persistent conversation;
- Project — контейнер work/context/permissions;
- Recipe — reusable operation configuration;
- Agent Run — durable multi-step execution;
- Artifact — typed input/output.

Job остаётся внутренней универсальной execution entity. Workbench — renderer, не
данные. Current filesystem Workspace мигрирует в Project binding.

## Invariants

- Recipe не хранит conversation history;
- Job snapshot сохраняет версию Recipe;
- Quick Run persistent только после Save;
- dictionary принадлежит Recipe/Project;
- Project не обязан быть filesystem directory;
- media result — Artifact, не special message blob.

## Consequences

Плюсы:

- покрывает voice/image/document/agent без taxonomy explosion;
- понятная retention;
- reuse Recipe;
- единая организация папок/проектов.

Минусы:

- пользователю нужно объяснить Recipe;
- current Workspace/Thread terminology потребует migration;
- граница Quick Run history требует product decision.

## Alternatives

- отдельный chat type на каждую modality: быстро фрагментирует продукт.
- всё как Chat: плохо для one-shot/artifact/batch.
- всё как Project: тяжёлый common path.

## Validation

- dictation, persistent chat, OCR batch и agent mapping не вводят новую top-level
  entity;
- user testing различает Quick Run/Chat/Project/Recipe;
- retention каждого flow предсказуем.
