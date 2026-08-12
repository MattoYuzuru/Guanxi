# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-13

**Назначение:** продолжить Phase 3 bounded slice P3-I — реализовать server-owned
hard deletion metadata только для Session Chat после elapsed 24-hour recovery,
с durable content-free audit и referential-integrity envelope, не расширяя slice
до TTL hard deletion, generic Artifact/blob GC, attachments или Project delete

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0005/0007,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decision D-009/Q-23.

Зафиксируй clean starting revision/status и последние commits. P3-H реализован
commits `711dcde`, `13fd0da`, test hardening `aca57d0`, review fixes `e5703be` и
append-only review fixes `e1f9650`/`ca59918`: **8 new / 614 core**, **5 new / 208
Web**, **1 new, 1 extended / 34 mocked Chromium**. Full typecheck, tests, browser gate,
build, markdownlint и diff-check прошли; independent reviewer после fixes дал
финальный verdict в `PHASE_STATUS.md`. Это synthetic/mock evidence, не production
DB corpus, OS-process crash, concurrent-process, real screen-reader/device или
live Ollama/GPU/network validation.

## Bounded outcome P3-I

Реализовать только окончательное удаление current SQLite metadata для Session
Chat после уже реализованного recovery deadline:

- Session Trash становится hard-delete eligible только при
  `reason=session_left` и `observedAt >= tombstonedAt + 24h`;
- каждый canonical non-terminal Job этого Chat блокирует deletion и scan, и
  atomic CAS повторно проверяет lifecycle reason, tombstone timestamp, deadline
  и Job states;
- один existing `RetentionMaintenanceOwner` выполняет отдельные stable bounded
  hard-delete pages после tombstone/reasoning passes; второй scheduler или
  route-triggered `runOnce()` не создавай;
- deletion атомарно удаляет Thread metadata и только его directly owned SQLite
  rows по текущим FK/ownership contracts. До edits составь exact dependency
  inventory для Message, Job, job events/input, reasoning Artifact/audit,
  compaction/tool log и Project/Workspace neighbors; не полагайся на
  неподтверждённый cascade;
- новый append-only migration 20 создаёт durable content-free deletion audit,
  который переживает удаление Thread и не содержит message/reasoning/private
  input. Не переписывай migrations 1–19;
- Project/projectless identity и deletion reason/time/source остаются
  наблюдаемыми через bounded audit projection либо другой strict versioned
  boundary; malformed/future/cross-scope input fail closed;
- Restore/Keep/TTL до deadline всё ещё выигрывают у stale delete candidate;
  at/after deadline ручное Restore остаётся закрытым, а следующий owner pass
  удаляет запись ровно один раз;
- Web удаляет elapsed Session Trash item только после sourced server response/
  refresh и правдиво различает `deletion pending`, `deleted` и failure. Не
  показывай данные как удалённые, пока server mutation не committed;
- generic blob store для Chat сейчас отсутствует: не изобретай фиктивный GC и не
  заявляй unreferenced blobs collected. Зафиксируй `not_applicable`/remaining
  target только если это подтверждено current ownership inventory;
- deletion не вызывает Ollama, Governor, tools, workspace filesystem, provider
  network, analytics, model unload или unrelated reasoning/blob cleanup.

До edits явно зафиксируй destructive boundary: какие exact rows удаляются,
какие audit rows обязаны пережить parent deletion, как обрабатываются current FK
restrictions/cascades и как recovery/deletion race линеаризуется. Если current
schema не позволяет сохранить accepted audit без раскрытия private content или
неясно, должны ли durable generic Jobs пережить Chat deletion, остановись с
blocker и предложи владельцу минимальные варианты — не закрывай решение молча.

## Non-goals

- hard deletion для rolling TTL Trash или новый TTL grace;
- generic Artifact/blob/reference GC, attachment store или filesystem cleanup;
- Project/Workspace deletion, Chat move/reparent, archive/search или Quick Run;
- изменение P3-G reasoning expiry policy либо удаление unrelated Artifacts;
- daemon/multi-process ownership, notifications, Phase 4 service/CLI/TUI;
- live provider/model/GPU/network behavior.

## Обязательные assertions

Минимум должны падать при нарушении:

- migration 20 fresh/v19→v20/reopen/retry и настоящий late rollback сохраняют
  existing v19 lifecycle/audit/legacy payload byte-compatible;
- dependency inventory имеет exact assertions на все child/neighbor tables;
- -1ms не удаляет, at/+1ms удаляет ровно один раз по injected server clock;
- Keep/TTL/Session active, TTL Trash, Session Trash без valid basis и already
  deleted audit не выбираются;
- каждый canonical non-terminal Job блокирует scan и CAS, каждый terminal state
  допускает один delete после deadline;
- stale Restore/Keep/TTL, retombstone и Job-after-scan races проигрывают delete
  CAS без partial rows/audit;
- startup, periodic callback, coalescing, finite batches/order, retry after
  injected transaction failure и shutdown доказаны через existing owner;
- Project/projectless audit scope/order и neighboring Chat/Project/Workspace
  isolation точны;
- committed delete удаляет только documented owned metadata; durable audit не
  содержит final answer, thinking, reasoning, prompts, tool/private input или
  filesystem paths;
- UI pending/deleted/failure/retry, focus, exact counts, EN/RU, narrow/200%,
  forced-colors/reduced-motion и no-false-blob-GC copy имеют direct assertions;
- no Ollama/Governor/tool/filesystem/provider/analytics/model-unload/unrelated
  cleanup effects проверены injected counters/snapshots.

Сделай mutation checks минимум для deadline boundary, Session-only reason,
active-Job scan/CAS guards, stale Restore/policy race, delete+audit atomicity,
child/neighbor scope, batch/order и truthful committed-delete UI. Каждое
свойство docs/ROADMAP должно иметь assertion, который реально падает при мутации.

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
`plans/WORKFLOW.md`: reviewer проверяет exact diff, destructive/dependency
boundary, append-only migration, deadline/races, atomic audit, scope и Web
truthfulness. Findings исправляет автор отдельным `fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: contract/migration/deletion owner,
Web/tests, review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real
new/regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; при blocker оставь P3-I
с exact evidence и recovery steps.
