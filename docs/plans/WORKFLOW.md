# Как вести разработку по фазам

**Статус:** accepted working protocol  
**Проверено:** 2026-08-02

## Короткий ответ

Можно написать агенту: «Продолжи текущую фазу по документации». Благодаря
`AGENTS.md`, `NAVIGATION.md`, `ROADMAP.md` и `PHASE_STATUS.md` он должен найти
первый незавершённый slice.

Надёжнее указывать конкретно:

```text
Продолжи Phase 0, slice P0-A. Прочитай AGENTS.md и канонические документы,
используй implementation/front-end/SRE skills, реализуй slice, независимо
проверь exit criteria, обнови PHASE_STATUS и сделай conventional commits.
```

Один prompt должен закрывать bounded vertical slice, а не всю платформу.

## Цикл одного slice

### 1. Orientation

- прочитать `AGENTS.md` и маршрут из `NAVIGATION.md`;
- проверить `git status`, current phase и принятые ADR;
- сопоставить docs с code/tests/runtime;
- не трогать unrelated/untracked user files.

### 2. Implementation plan

- outcome и non-goals;
- затронутые contracts/stores/components;
- failure/concurrency/security risks;
- migration и rollback;
- test matrix;
- validation commands.

Для нетривиального slice план должен быть записан до большого edit.

### 3. Vertical implementation

Рабочий порядок:

```text
contract/migration
→ server/application behavior
→ client projection
→ failure states
→ tests
→ docs/status
```

Не оставлять новый contract реализованным только с одной стороны.

### 4. Independent verification

Implementation self-review и независимая verification — разные действия.

- happy path;
- error/cancel/reload/restart;
- concurrency/idempotency;
- accessibility/responsive для UI;
- security/allowed roots для tools;
- regression commands;
- residual risks.

### 5. Documentation and commits

- current docs отражают только реализованное;
- ROADMAP scope не переписывается под удобный результат;
- PHASE_STATUS содержит evidence;
- NEXT_AGENT_PROMPT переписан под следующий незавершённый slice;
- generated artifacts не коммитятся;
- conventional commits разделяют поведение, tests/migrations и docs, когда это
  улучшает review/recovery.

`NEXT_AGENT_PROMPT.md` — обязательный handoff artifact, а не статичный пример.
После успешного slice агент полностью актуализирует его scope, skills, non-goals,
validation и ожидаемый следующий status update. Если slice заблокирован или
проверка не пройдена, файл остаётся на текущем slice и объясняет blocker и
recovery. Prompt переходит в следующую фазу только после её exit gate.

Примеры:

```text
fix(web): prevent chat stream render crash
test(web): cover first chat turn recovery
feat(runtime): persist durable job events
feat(agent): enforce project tool policy
docs: record phase 1 verification evidence
```

## Какие skills подключать

| Работа                         | Рекомендуемые skills                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Любая нетривиальная реализация | `sde-agent:implementation-planning`, `sde-agent:sde-agent`, `sde-agent:implementation-evidence` |
| React/UX/accessibility         | `frontend-agent:frontend-agent`, `frontend-agent:frontend-verification`                         |
| Job/recovery/DB migration      | `architecture-agent:architecture-migration`, `sre-agent:verification-strategy`                  |
| Resource Governor/performance  | `sre-agent:performance-analysis`, `sre-agent:reliability-testing`                               |
| Agent/tools/MCP                | `sre-agent:defensive-security-review`, `sre-agent:finding-validation`                           |
| Release/phase exit             | `sre-agent:release-readiness`                                                                   |
| Документационный drift         | `cleaner-agent:documentation-reconciliation`                                                    |

Не нужно включать все plugins в каждый prompt. Один implementation owner и один
независимый verification lane обычно достаточны.

## Когда можно сказать «следующая фаза»

Только если:

1. все slices текущей фазы имеют implementation evidence;
2. exit gate ROADMAP проверен целиком;
3. SRE/release review не нашёл blocking finding;
4. migrations/recovery проверены;
5. PHASE_STATUS и current docs обновлены;
6. NEXT_AGENT_PROMPT указывает на первый slice следующей фазы;
7. worktree имеет понятные commits.

Иначе команда «продолжай» означает следующий slice той же фазы.

## Оценка количества prompt-сессий

Под `prompt` здесь понимается полноценная автономная сессия: orientation, edit,
tests, review и commit, а не короткий вопрос.

| Scope              | Primary implementation prompts |
| ------------------ | -----------------------------: |
| Phase 0            |                            2–4 |
| Phase 1            |                            5–8 |
| Phase 2            |                            5–8 |
| Phase 3            |                            5–8 |
| Phase 4            |                            4–7 |
| Phase 5            |                           8–12 |
| Phase 6            |                           6–10 |
| Phase 7            |                            5–8 |
| Phase 8            |                           8–14 |
| Phase 9            |                           6–10 |
| **Полное видение** |                      **54–89** |

Добавьте примерно 20–30% на независимые review/repair sessions:

- стабильный text/core до Phase 3: примерно 20–35 серьёзных сессий;
- background service + coding Agent MVP до Phase 5: примерно 35–60;
- всё описанное видение: ориентировочно 65–115.

Это диапазон сложности, не срок. Он уменьшится, если вертикали окажутся проще, и
увеличится после реального multi-platform/media/security testing. Попытка
уместить всё в 10–15 prompts почти наверняка создаст широкий, но ненадёжный
prototype.
