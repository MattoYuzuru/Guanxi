# Prompt следующему агенту

**Назначение:** Phase 0, slice P0-B — Truthful turn terminal state
**Статус:** ready
**Проверено:** 2026-08-02

Скопируйте текст ниже в новую coding-agent сессию.

---

Работай в репозитории Alamo UI. Продолжи текущую Phase 0, но реализуй только
bounded slice `P0-B Truthful turn terminal state`.

P0-A уже независимо проверен в commits `f038b5c` и `d05a906`: не откатывай
streaming effect fix, root/Chat Error Boundaries или web test harness.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 0 в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD и accepted ADR-0004.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo` или реальные Ollama models.
3. Используй:
   - `sde-agent:implementation-planning` и `sde-agent:sde-agent` как owner;
   - `architecture-agent:architecture-migration` для append-only SQLite bridge,
     backfill/recovery и compatibility;
   - `frontend-agent:frontend-agent` для truthful Chat projection и
     accessibility failure states;
   - `sre-agent:verification-strategy` и `sre-agent:finding-validation` для
     независимой проверки terminal invariants и regression.
4. До правок воспроизведи current empty-assistant/missing-terminal paths и
   составь bounded implementation plan с state model, migration, rollback,
   failure cases и точными validation commands.

Scope P0-B:

- добавить совместимый transition bridge для текущего turn/message: observable
  non-terminal state и terminal `completed`/`failed`/`cancelled` outcome,
  безопасный error и stop reason;
- изменить runtime contract, append-only SQLite migration, stores, server route,
  SSE projection, web Chat и tests согласованно;
- не считать пустой assistant успешным только потому, что POST/SSE закончился;
- считать EOF без обязательного terminal Ollama chunk protocol failure;
- сохранять provider error, explicit stop и connection abort с правдивым
  terminal outcome; partial output не должен терять failure status;
- после reload показывать outcome/error/stop reason, а не ambiguous empty
  assistant;
- определить совместимое чтение legacy rows. Не переписывать применённые
  migrations и не помечать старые ambiguous empty rows как подтверждённый
  success без evidence;
- добавить deterministic store/route/web tests для success, provider error,
  missing terminal chunk, stop/abort, partial output и reload projection;
- сохранить P0-A Error Boundaries, keyboard, screen-reader, narrow viewport и
  reduced-motion behavior.

Non-goals:

- не реализовывать durable Job Engine, отдельный create Job API, replayable GET
  SSE, idempotency или restart recovery из ADR-0004;
- не делать disconnect независимым от работы и не менять navigation semantics
  шире необходимой truthful terminal persistence;
- не реализовывать P0-C global inference mutex или compaction sequencing;
- не реализовывать P0-D runtime/catalog health и P0-E полный browser gate;
- не менять product IA/theme, branding, Marketplace, media или Agent features;
- не удалять/переименовывать public API/DB/localStorage identifiers без
  compatibility plan.

Failure cases, которые должны иметь evidence:

- Ollama недоступна до первого chunk;
- assistant создан, но provider stream завершился без terminal chunk;
- content/thinking частично получены, затем provider error;
- explicit Stop и connection abort;
- DB update terminal state падает;
- reload читает pending/failed/cancelled/legacy ambiguous row;
- новый optional contract field не ломает совместимое чтение;
- повторная terminalization не превращает failure/cancel в completed.

Validation:

- targeted contract/store/route/parser/web component tests;
- deterministic browser failure/reload projection, если harness позволяет без
  расширения в P0-E;
- fresh DB и upgrade с предыдущей schema version во временной директории;
- `npm run test:web:browser`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`, self-review и independent migration/frontend/SRE review;
- не использовать live model или пользовательскую DB для обязательных tests.

После успешной проверки:

- обнови current-state docs и только строку P0-B в `PHASE_STATUS.md`, со ссылками
  на commits и точными tests;
- оставь Phase 0 незавершённой;
- зафиксируй residual risks: POST/SSE всё ещё connection-owned и не replayable,
  navigation всё ещё может cancel, global concurrency ещё не ограничена;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий незавершённый slice
  `P0-C Exclusive inference bridge`, включая skills, scope, non-goals,
  concurrency validation и ожидаемое обновление только P0-C;
- сделай небольшие conventional commits для migration/behavior, tests и docs.

Если P0-B заблокирован или обязательная проверка не прошла, не переключай handoff
на P0-C: оставь `NEXT_AGENT_PROMPT.md` на P0-B и добавь blocker, evidence,
затронутую migration/version и безопасные recovery steps.

В финале сообщи commits, migration/version, доказательства, непройденные проверки,
остаточные риски и slice, для которого подготовлен `NEXT_AGENT_PROMPT.md`.

---
