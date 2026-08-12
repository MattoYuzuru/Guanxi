# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-12

**Назначение:** продолжить Phase 3 bounded slice P3-H — реализовать explicit
Session leave и recoverable 24-hour Trash grace поверх P3-E, не расширяя slice
до Chat hard deletion, generic blob GC или background presence service

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0005/0007,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decision D-009/Q-23.

Зафиксируй clean starting revision/status и последние commits. P3-G реализован
commits `0551a3e`, `b4481cf`, review fixes `2d7b4bc`, `c6ba8a0`: **8 new / 606
core**, **1 new / 203 Web**, **0 new, 1 extended / 33 mocked Chromium**. Full
typecheck, tests, browser gate, build, markdownlint и diff-check прошли;
independent reviewer после fixes дал READY. Это synthetic/mock evidence, не
production DB corpus, OS-process crash, concurrent-client, real screen-reader/
device или live Ollama/GPU/network validation.

## Bounded outcome P3-H

Реализовать только accepted Session lifecycle до recoverable Trash:

- Session Chat становится eligible только после явного user leave и terminal
  состояния всех canonical Jobs этого Chat;
- reload/reconnect, transport abort, tab visibility change, server restart и
  background Job сами по себе не считаются leave;
- leave — strict versioned user command с exact Chat/Project scope, idempotency и
  server-owned observed time; malformed/future/cross-scope input fail closed;
- leave во время active Job сохраняет durable pending basis, но не tombstone;
  terminal transition либо следующий bounded Maintenance pass переводит Chat в
  Trash ровно один раз;
- один existing `RetentionMaintenanceOwner` исполняет Session eligibility, не
  создавай второй scheduler;
- Session Trash projection показывает exact 24-hour recovery deadline и sourced
  reason. Restore либо policy change на Keep/7 days до deadline возвращает Chat,
  очищает pending leave basis и создаёт ровно один audit effect;
- P3-H не удаляет metadata или blobs после 24 часов: projection честно сообщает,
  что hard deletion остаётся `not_implemented`;
- Project/projectless scope, current active/Trash order и raw legacy Thread REST
  остаются совместимыми;
- Web даёт explicit leave affordance только для Session Chat с confirmation,
  loading/error/retry, keyboard/focus, narrow/200%/forced-colors/reduced-motion и
  EN source/fallback + curated RU locale keys;
- leave/maintenance не вызывает Ollama, Governor, tools, workspace filesystem,
  provider network, analytics или reasoning/blob cleanup.

До edits явно зафиксируй semantic boundary user leave: какое observable действие
считается явным уходом, как command защищён от unload/reload ambiguity, как
pending leave переживает restart, где recheck active Jobs и как Restore/policy
change отменяет его. Если accepted docs недостаточно определяют user action,
остановись с blocker и предложи минимальные варианты владельцу, не закрывай
решение молча.

## Non-goals

- hard deletion после 24-hour grace, metadata purge и generic Artifact/blob GC;
- automatic leave по navigation, reload, disconnect, timeout или presence guess;
- изменение P3-G reasoning expiry либо удаление final answer/Message/Job;
- arbitrary Chat move/reparent, archive/search, Quick Run или Project defaults;
- daemon/multi-process ownership, notifications, Phase 4 service/CLI/TUI;
- live provider/model/GPU/network behavior.

## Обязательные assertions

Минимум должны падать при нарушении:

- append-only migration/reopen/retry и настоящий mid-migration rollback сохраняют
  existing retention/artifact/legacy payload byte-compatible;
- strict missing/malformed/future version и exact Project/projectless scope;
- explicit leave создаёт один durable sourced basis; repeated command
  idempotent, а reload/reconnect/abort/visibility/restart его не создают;
- каждый canonical non-terminal Job блокирует Session tombstone; каждый terminal
  state допускает один transition после leave;
- recovery→startup, periodic callback, coalescing, finite batches/order и shutdown
  доказаны через existing single owner без manual-run false positive;
- exact 24-hour recovery deadline имеет -1ms/at/+1ms assertions с injected clock;
  это recovery projection, не hard-delete claim;
- Restore и Keep/TTL policy change до deadline очищают leave basis и не дают
  stale Maintenance tombstone; repeated effects не дублируют audit;
- active/Trash, Project/projectless counts/order и neighboring Chat isolation;
- final answer, Message/Job, legacy thinking, reasoning Artifact/audit, compaction
  и non-lifecycle tables сохраняются exact;
- UI confirmation, pending/blocked/Trash/recovery states, focus/retry и EN/RU;
- no Ollama/Governor/tool/filesystem/provider-network/analytics/reasoning/blob
  cleanup effects имеют прямые assertions.

Сделай mutation checks минимум для leave source, reload-not-leave, active-Job
guard, terminal retry, 24-hour boundary, stale Restore/policy race, batch/order,
scope leakage и truthful no-hard-delete UI. Каждое свойство, заявленное в docs/
ROADMAP, должно иметь direct assertion.

## Gates

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Browser gate обязателен. Не выдавай jsdom/Chromium fixtures за real device,
screen-reader, production migration corpus или user validation.

## Workflow и handoff

После implementation запусти отдельную read-only independent verification по
`plans/WORKFLOW.md`: reviewer проверяет exact diff, semantic leave boundary,
contract/migration, reload-not-leave, restart/order, active-Job guard, 24-hour
projection, Restore/policy races, scope и Web truthfulness. Findings исправляет
автор отдельным `fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: contract/migration/Session lifecycle,
Web/tests, review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real
new/regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; при blocker оставь P3-H
с exact evidence и recovery steps.
