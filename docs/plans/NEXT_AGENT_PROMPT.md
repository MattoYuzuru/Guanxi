# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-12

**Назначение:** продолжить Phase 3 bounded slice P3-G — включить automatic
Reasoning Artifact expiry enforcement поверх P3-F, не расширяя slice до generic
blob GC, Chat hard deletion, Session leave detection или общего Artifact store

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0005/0007,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decision D-010/Q-10.

Зафиксируй clean starting revision/status и последние commits. P3-F реализован
commits `425f252`, `18d019c`, review fixes `7af5b86`, `d9333a3`: **9 new / 598
core**, **4 new / 202 Web**, **0 new, 1 extended / 33 mocked Chromium**. Full
typecheck, tests, browser gate, build, markdownlint и diff-check прошли;
independent reviewer дал READY. Это synthetic/mock evidence, не production DB
corpus, concurrent-client, real screen-reader/device или live Ollama/GPU/network
validation.

## Bounded outcome P3-G

Реализовать server-owned automatic deletion только для P3-F diagnostic
Reasoning Artifacts:

- current seven-day Artifact expiry и shorter **current** parent retention
  становятся исполняемой policy, а не только projection;
- один startup/periodic Maintenance owner выполняет stable bounded scan с
  injected clock, inclusive boundary, coalescing и shutdown cleanup; не создавай
  второй несогласованный scheduler, расширь current retention owner/service;
- eligible Artifact удаляется атомарно и ровно один раз; final answer,
  Message/Job, legacy thinking rows, Chat lifecycle и любые non-reasoning данные
  остаются неизменными;
- любой canonical non-terminal Job того же Chat блокирует destructive cleanup;
  retry после terminal state сходится без duplicate effect;
- Keep и Session без parent time expiry по-прежнему применяют собственные семь
  дней Artifact; TTL parent может только сократить effective expiry. Policy/user
  activity, изменившая current parent expiry до scan, учитывается заново;
- active и Trash Chat обрабатываются согласованно по effective expiry; Restore
  не возвращает уже истёкшие diagnostic bytes;
- удаление наблюдаемо без content leakage: durable metadata/audit либо другой
  crash-safe bounded evidence содержит reason, source identity, due/occurredAt,
  но не prompt, reasoning, final answer, tools, paths или secrets;
- Chat Info и contract правдиво сообщают active automatic deletion и после
  cleanup показывают отдельный empty reasoning state, сохраняя generated answer;
- versioned API не меняет смысл существующего strict version молча. До edits
  явно выбери и зафиксируй compatibility strategy для enforcement-state
  эволюции (additive versioned projection/field либо доказуемо совместимый
  boundary); malformed/future version fail closed;
- migration, если нужна persisted audit/checkpoint schema, только append-only
  поверх v16. Не переписывай migrations 1–16 и не backfill-ь legacy thinking в
  Artifact;
- Maintenance не вызывает Ollama, Governor, tools, workspace filesystem,
  provider network, analytics или generic blob cleanup.

Сначала инвентаризируй current `RetentionMaintenanceOwner`, ordering startup
recovery→maintenance, P3-F effective-expiry calculation, foreign keys/cascades,
raw Message projection и strict contract version semantics. Явно опиши crash
point, atomic delete/audit transaction, cursor/order и behavior при policy race.

## Non-goals

- generic content-addressed blob/file GC и другие Artifact types;
- удаление final answer, Message, Job, Chat metadata или legacy thinking;
- Chat TTL grace/hard delete, Session leave detection/24-hour recovery;
- arbitrary user delete/restore/rename Reasoning Artifact;
- Quick Run, Recipe, Project defaults, attachments, search/archive/move/reparent;
- изменение reasoning capture/checksum/storage format P3-F без доказанной
  необходимости;
- unrestricted export paths, credentials либо private Job input в audit/API;
- final navigation shell, brand rename, Phase 4 service/CLI/TUI и live provider.

Не называй generic Artifact GC или Chat hard deletion реализованными: P3-G
удаляет только due diagnostic Reasoning Artifact bytes и сохраняет final answer.

## Обязательные assertions

Минимум должны падать при нарушении:

- fresh, v16→next/reopen/retry и mid-migration rollback сохраняют exact P3-F и
  legacy payload; migration/schema создаются один раз;
- inclusive `effectiveExpiresAt <= now`, one millisecond before/at/after и
  injected clock проверены без wall-clock sleeps;
- Keep/Session используют own seven-day expiry; current TTL shorter wins;
  TTL→Keep/Session сбрасывает старый parent expiry, user activity race не удаляет
  Artifact по stale parent basis;
- stable exact order при equal expiry/id, finite batch cap, multiple batches,
  concurrent/repeated tick coalescing и restart convergence не пропускают и не
  дублируют effects;
- каждый canonical non-terminal Job state блокирует delete; после terminal retry
  удаляет один раз;
- delete и audit/evidence атомарны: injected failure не оставляет ни silent
  deletion, ни ложный success; retry converges;
- expired Artifact исчезает из list/read/raw compatibility thinking, но exact
  final answer, Message/Job, generated-answer count и compaction остаются;
- legacy `messages.thinking`, non-reasoning tables и соседние Chat/Project scopes
  byte-compatible; Chat A cleanup не затрагивает Chat B;
- active и Trash behavior, Restore after expiry и Project/projectless isolation
  имеют exact counts/order;
- audit/response не содержит prompt, reasoning, final answer, tool data,
  credentials, paths или arbitrary provider errors;
- version compatibility/future/malformed enforcement state fail closed;
- Chat Info показывает truthful automatic deletion, refresh после cleanup,
  empty reasoning при сохранённом generated answer, loading/error/retry и EN/RU;
- scheduler startup/periodic/shutdown и no Ollama/Governor/tool/filesystem/
  provider-network/analytics/generic-cleanup effects проверены прямо.

Сделай mutation checks минимум для inclusive boundary, stale parent expiry,
active-Job guard, batch cap/order, delete/audit atomicity, final-answer survival,
cross-Chat leakage и truthful UI enforcement/empty state. Каждое свойство,
заявленное в docs/ROADMAP, должно иметь direct assertion.

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
`plans/WORKFLOW.md`: reviewer проверяет exact diff, contract compatibility,
migration/rollback, effective-expiry races, bounded scheduler, active-Job guard,
atomic delete/evidence, final-answer survival, scope и Web truthfulness. Findings
исправляет автор отдельным `fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: contract/migration/maintenance,
Web/tests, review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real
new/regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; при blocker оставь P3-G
с exact evidence и recovery steps.
