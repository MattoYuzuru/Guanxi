# ADR-0005: Ограниченный набор рабочих сущностей

**Статус:** accepted

**Дата:** 2026-08-02

## Context

Voice dictation, saved chat, temporary chat, document workspace, image studio,
agent и template легко превратить в десятки несовместимых «типов чата».

## Decision

Использовать шесть пользовательских понятий:

- Quick Run — one-shot с явной retention policy;
- Chat — persistent conversation;
- Project — контейнер work/context/permissions;
- Recipe — reusable operation configuration;
- Agent Run — durable multi-step execution;
- Artifact — typed input/output.

Job остаётся внутренней универсальной execution entity. Workbench — renderer, не
данные. Current filesystem Workspace мигрирует в Project binding. Project имеет
presentation metadata: display name, icon key и color token.

## Invariants

- Recipe не хранит conversation history;
- Job snapshot сохраняет версию Recipe;
- Quick Run и Chat используют Keep/TTL/Session, а не type-changing Save;
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
- maintenance должен корректно различать user activity, navigation и reconnect.

## Alternatives

- отдельный chat type на каждую modality: быстро фрагментирует продукт.
- всё как Chat: плохо для one-shot/artifact/batch.
- всё как Project: тяжёлый common path.

## Validation

- dictation, persistent chat, OCR batch и agent mapping не вводят новую top-level
  entity;
- user testing различает Quick Run/Chat/Project/Recipe;
- retention каждого flow предсказуем.
- user glossary различает сущности на English и curated Russian.
