# Handoff: Phase 3 / P3-Q terminal Job notifications

**Статус:** ready for implementation
**Проверено:** 2026-08-18
**Назначение:** закрыть bounded visual subset NOT-001: каждый новый canonical
terminal Job создаёт durable content-free in-app notification, Runtime Bar
показывает badge/panel и ведёт к безопасной Job/Chat projection. Sound, browser
permission и policy inheritance остаются следующей фазе.

## Сначала прочитать

1. `AGENTS.md`, `docs/NAVIGATION.md`, `docs/plans/WORKFLOW.md`.
2. `docs/PRODUCT.md` (NOT-001..004), `docs/DOMAIN_MODEL.md`, `docs/UX_IA.md`.
3. `docs/DEVELOPMENT.md`, `docs/TESTING.md`, HLD/LLD,
   `docs/architecture/RUNTIME_LIFECYCLE.md` и Job-related ADR.
4. `docs/plans/PHASE_STATUS.md`, `docs/plans/ROADMAP.md`,
   `docs/plans/OPEN_QUESTIONS.md`, accepted D-021 и D-023/D-034,
   `docs/decisions/0014-notification-persistence-and-delivery.md`.
5. Current Job contract/store/service, Chat terminal/recovery transactions,
   Runtime Bar provider/polling и P3-P locale/error boundaries.

Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent` и
`sde-agent:implementation-evidence`; для Web также
`frontend-agent:frontend-agent` и `frontend-agent:frontend-verification`.
После candidate обязателен отдельный read-only reviewer; findings исправляются
отдельным commit.

## Current state и границы

- SQLite schema version 28; migrations только append-only. P3-Q вероятно
  использует migration 29, но номер сначала сверь с current HEAD.
- Canonical Job и ordered events уже durable. Chat owner атомарно terminalize-ит
  Message/Job/event; startup recovery сходится в terminal outcomes до listen.
  Notification entity/store/routes пока отсутствуют.
- P3-P независимо подтверждён на `789eaeb`: English/Russian locale, dynamic
  localized errors, Settings Language, Glossary и copy inventory являются
  current boundary. Новый user-facing copy проходит только через locale keys.
- Full P3-P baseline: core 669/669, Web 244/244, mocked Chromium 40/40; это
  regression envelope, не live Ollama/browser notification validation.
- D-021 принимает in-app notification и optional sound, но P3-Q реализует только
  NOT-001 visual state. NOT-002..004, browser permission и sound dedup входят в
  Phase 4 и не должны быть частично обещаны здесь.
- Q-37 закрыт: target Quick Run Session заканчивается successful Job либо
  explicit Finish. Это не блокирует P3-Q, потому что current Quick Run metadata
  ещё не создаёт Jobs и не подключается к execution.

## Bounded outcome P3-Q

- Добавь strict versioned public Notification projection и additive SQLite
  storage. Минимальный row: stable notification ID, exact Job ID, terminal Job
  state/outcome, created/read timestamps и safe navigation target. Prompt,
  result, reasoning, private error/body, filesystem path и secret не хранятся.
- Один canonical переход Job в `completed | failed | cancelled | interrupted`
  создаёт ровно одну notification. Повторная terminalization, cancel retry,
  subscriber reconnect, reload и startup recovery не создают duplicate;
  уникальность должна иметь DB-level owner, а не только process-local guard.
- Notification и terminal Job truth не могут расходиться. Предпочти общую
  transaction boundary/central terminalization hook; если текущие terminal paths
  различаются, инвентаризируй и докажи completed/failed/cancelled/interrupted,
  recovery и rollback. Failure notification insert не должен оставлять ложный
  terminal state, и наоборот.
- Migration не выдумывает историю: accepted policy D-023 запрещает backfill для
  existing terminal Jobs до feature cutover. Это должно быть явно
  документировано и заassertено на v28→v29.
- Добавь bounded newest-first list с explicit unread state/count и strict
  idempotent mark-read command. Cursor/order/tie-break должны быть deterministic;
  cross-Job/cross-row mutation и arbitrary fields fail-closed.
- Runtime Bar показывает exact unread badge и keyboard-reachable panel с
  terminal outcome/time и безопасным `Open`. Link ведёт к существующей Job/Chat
  projection только при доказанной association; generic Job без UI route не
  получает invented Chat link.
- Foreground/open Job и future `off` policy тоже создают durable row: P3-Q не
  вводит background detection/policy, но storage нельзя связать с delivery.
  Panel различает loading/empty/error/retry, stale refresh и
  mark-read failure; notification не исчезает оптимистично при failed mutation.
- Locale switch/reload сохраняют одну и ту же durable row, меняя только Web-owned
  localized presentation. Не сохраняй уже локализованный outcome text в SQLite.
- Сохрани persistent Runtime Bar semantics, focus, 390 px, 200%, forced colors,
  reduced motion и отсутствие horizontal overflow. Listing/read не запускают
  Ollama, Governor, model, tool, filesystem, workspace или external network.

## Non-goals

- sound, Web Notifications API, permission prompts, background-tab detection;
- Off / When background / Always и global/per-Chat policy inheritance;
- OS notification center, push, email, analytics или remote delivery;
- notification payload с prompt/result/reasoning/private error;
- Quick Run/Recipe execution либо implementation принятого Q-37 lifecycle;
- Phase 4 daemon/service, CLI/TUI notification client или multi-process owner;
- Chat rename/search/archive, Project policy/vocabulary и Workbench.

## Обязательные assertions

- strict contract отклоняет unknown/future/extra/malformed rows и unsafe target;
- migration 29: fresh/v28/reopen/retry/true late rollback, exact unchanged legacy
  payload и ноль retroactive notifications для old terminal Jobs;
- каждый canonical terminal outcome даёт exact one row; non-terminal states —
  zero; duplicate terminal/cancel/recovery/reload/concurrent retry остаются one;
- injected notification failure откатывает terminal transition целиком, а
  failed Job transition не оставляет notification;
- stable newest-first pagination/unread count/read timestamp, exact tie-break,
  idempotent repeated mark-read и cross-row isolation;
- public payload и exported diagnostics не содержат prompt, answer, reasoning,
  raw error, path, endpoint, secret или arbitrary event metadata;
- Web loading/empty/error/retry/unread/read/open states имеют direct EN/RU
  assertions; same persisted row re-localizes после delayed bootstrap;
- browser exact counts: одна terminal transition → один badge item; hard reload
  не дублирует; mark-read lost response/retry остаётся idempotent; open ведёт к
  exact safe target;
- badge/panel keyboard/focus/live semantics, 390 px, 200%, forced colors,
  reduced motion и exact no-overflow assertions;
- exact zero provider/Ollama/Governor/model/tool/workspace/filesystem/network
  effects и zero unexpected REST requests.

Mutation-check минимум: unique Job constraint, terminal-state filter, atomic
notification insert, unread predicate, stable ordering/tie-break, redaction,
mark-read idempotency и browser exact-count assertion.

## Gates и handoff

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

После independent `READY` обнови current-state docs и `PHASE_STATUS.md` с
new/regression envelope. Затем выбери следующий подтверждённый Phase 3 gap; не
объявляй Phase 3 завершённой и не переходи к Phase 4 до полного exit review.
Mocked Chromium не является production/user validation.
