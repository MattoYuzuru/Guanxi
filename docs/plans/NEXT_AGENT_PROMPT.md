# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-I — read-only Runtime Bar/resource projection

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
P1-A–P1-E реализовали durable Jobs, Chat detach/reattach и fail-closed startup
recovery. P1-F добавил typed process-local Resource Governor, P1-G — shared
`/api/ps` reconciliation и `GET /api/runtime`, P1-H — shared Apple host telemetry
и truthful observed/unknown current-fit explanation. Реализуй только slice
`P1-I read-only Runtime Bar/resource projection`. Не создавай subagents и не
делегируй работу.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract/store: `138fb5e`, `91cb21f`, `92b68f0`;
- P1-B store/service/tests: `56b2200`, `55351bc`;
- P1-C public API: `4b9d96a`, `0a06ea6`;
- P1-D contract/storage/execution/evidence: `da70576`, `08b3516`, `f33d5b9`;
- P1-E startup recovery/evidence: `22a1aff`, `6c748de`;
- P1-F Governor implementation/evidence: `a0bc047`, `ff96dc0`;
- P1-G runtime reconciliation/compatibility: `b8328bd`, `bd0d7a1`, `40a0de7`,
  `f53a868`;
- P1-H telemetry/fit/tests/docs: `df4d156`, `02acf72`, `a5df7c9`, `324e54a`,
  `66c23c0`;
- P1-H status/handoff: commit непосредственно перед этим prompt.

Не откатывай Error Boundaries, truthful Message terminal CAS, persisted
compaction fix, sampled runtime health/timeouts, SQLite migrations 1–5, scoped
Job idempotency, canonical state CAS, persisted-first subscription, strict public
Job schemas, pull-based HTTP backpressure, durable Chat privacy/chunking/terminal
transaction, disconnect-only semantics, Web reattach, P1-E pre-listen recovery,
P1-F tickets/leases/unload guard, P1-G single-flight/source semantics или P1-H
telemetry provenance/current-fit unknown states.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/PRODUCT.md` (`RES-003`, `RES-004`, `RES-008`), `docs/UX_IA.md`
   (`Persistent Runtime Bar`, responsive), `docs/DOMAIN_MODEL.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD, `docs/TESTING.md`,
   `docs/DEVELOPMENT.md`, accepted ADR-0001/0002/0003/0004,
   `docs/plans/OPEN_QUESTIONS.md` и принятые product decisions.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `frontend-agent:frontend-agent`, `frontend-agent:frontend-verification`,
   `product-agent:product-acceptance`, `sre-agent:verification-strategy`,
   `sre-agent:reliability-testing`, `sre-agent:finding-validation` и
   `sde-agent:implementation-evidence` без делегирования. Accepted UX уже задаёт
   visual direction, поэтому не расширяй slice новым redesign discovery.
4. До правок воспроизведи current state: exact P1-A–P1-H files дают 92/92;
   routes/Governor/concurrency — 28/28; runtime/provider — 19/19;
   fit/telemetry — 19/19; root — 210/210 server/CLI + 17/17 Web; mocked Chromium
   — 9/9. Проверь current `RuntimeStatus`, `useAsync`, `api.runtimeSnapshot`,
   locale/format helpers, component/browser fixtures и responsive shell.
5. До кода составь bounded plan с inventory всех current Runtime UI/API
   consumers, state table, polling/cancellation ownership, accessible structure,
   narrow/mobile layout, source/error mapping, locale keys, compatibility,
   capacity bound и exact validation commands.

## Scope P1-I

- заменить узкую `GET /api/models/running` projection в persistent
  `RuntimeStatus` на typed `api.runtimeSnapshot()`/`GET /api/runtime`. Не описывай
  shape вручную и не обходи Zod contract;
- сделать read-only Runtime Bar, который остаётся в application shell на
  Launcher, Model, Chat и Settings routes. Route change не отменяет Job, lease
  или другую resource operation;
- показать только факты, уже присутствующие в P1-H snapshot:
  - active lease: operation, model, owner kind и elapsed/acquired time;
  - FIFO queue: order, operation, model, owner kind, requested context и wait;
  - loaded runtime models, unknown-owner warning и active-not-observed decision;
  - host telemetry state, total/free/legacy estimate с source/confidence/basis;
  - per-model `observed | unknown` current fit, context/allocation/pressure basis;
  - sample time и независимое состояние Ollama/host sources;
- не выдавать Governor live queue за полный durable Jobs list. Snapshot содержит
  только one active lease/live waiters, а не terminal history или canonical Job
  phase. Если exact Job title/route неизвестны, показывай безопасный owner kind,
  не выдумывай navigation target;
- сохранить различие `models: []` (healthy empty) и `models: null` (source
  failure). Host `partial`, `unavailable`, `unsupported` и available-with-missing
  fields имеют разные понятные states. Failure одного source не скрывает другой;
- Apple system-free pages не подписывать как «доступно для новой модели».
  `legacyUsableMemoryBytes` показывать как estimate/compatibility, а unknown
  pressure/available/discrete VRAM — как unknown, без optimistic zero;
- `currentFit.observed` подписывать как current loaded configuration/residency,
  не «модель поместится». Всегда объяснять `futureAdmissionGuarantee:false`;
  stable unknown reasons отображать человекочитаемо, не raw enum-only UI;
- unknown-owner `/api/ps` row показывать как «owner unknown/external possible»,
  не как доказанный external client. Digest остаётся runtime observation, не
  proven artifact identity;
- добавить bounded adaptive polling без overlap: чаще при active/queued state,
  реже idle, pause либо существенно снизить frequency в hidden document,
  немедленно refresh при возвращении visibility. Один component не держит больше
  одного request; cleanup abort-ит только свой HTTP wait. Manual Retry остаётся;
- polling interval constants должны быть именованы и покрыты fake timers или
  injected scheduler. Не добавлять SSE/WebSocket runtime feed;
- обновление sample не должно очищать предыдущую readable projection обычным
  loading flash. Refresh/error должны быть observable; failed refresh может
  сохранить last confirmed sample с явной stale/error меткой, но не как fresh;
- все новые user-facing strings проходят locale keys: English source/fallback и
  curated Russian. Memory/date/duration/context используют общие format helpers;
- структура должна быть semantic/accessibility-first: named region/heading,
  status/alert только для реальных transitions, keyboard reachable disclosure,
  no focus steal, reduced-motion-safe refresh. Не announce-ить весь bar на каждом
  poll;
- desktop bar остаётся compact и не перекрывает main content. На narrow viewport
  он превращается в компактный expandable/bottom-sheet-like projection без
  horizontal overflow при 200% zoom. Не вводи произвольные context/memory caps;
- добавь feature-local Error Boundary либо докажи, что current root containment
  сохраняет usable shell при render failure; не ломай P0-A boundary semantics;
- compatibility `GET /api/models/running` route/contract остаётся. Если Web больше
  его не вызывает, server route всё равно должен проходить P1-G tests;
- server/contract/storage migration для этого slice не ожидаются. Если current
  snapshot реально недостаточен для обязательного read-only факта, сначала
  докажи gap; расширяй contract additive и узко, не добавляй speculative fields;
- обнови current-state Web/architecture/testing docs и Mermaid diagram только
  если boundary действительно изменилась.

## Runtime Bar state model

```text
initial load
  → current snapshot
      ├─ active lease + zero/more FIFO waiters
      ├─ no active lease + empty queue
      ├─ Ollama models [] | rows | unavailable
      └─ host available | partial | unavailable | unsupported
  → bounded refresh without blanking confirmed content
  → refreshed snapshot or stale-with-explicit-refresh-error
```

Runtime Bar — read-only projection. Он не владеет Jobs, leases, cancellation,
model loading или unload; navigation/unmount меняет только HTTP subscription.

## Required deterministic evidence

- inventory test доказывает, что Web Runtime Bar использует только
  `api.runtimeSnapshot`/contract schema и не вызывает `/api/ps`, host command,
  Ollama или filesystem напрямую;
- component fixtures round-trip через `runtimeSnapshotSchema` и покрывают active
  Job owner, operation owner, multiple FIFO waiters, idle/closed admission,
  loaded exact-owner row, unknown-owner row и active-not-observed decision;
- `models: []`, `models: null`, host available-with-missing fields, partial,
  unavailable и unsupported имеют разные accessible labels;
- observed fit показывает current-residency limitation; unknown
  digest/context/host/pressure reasons не превращаются в success;
- total unified memory, system-free bytes, legacy estimate, runtime allocation и
  accelerator allocation имеют разные labels/source/confidence; null не
  форматируется как zero;
- polling fake покрывает initial request, active/queued и idle intervals, no
  overlap, hidden/visible transition, manual retry, unmount abort и отсутствие
  retained timers/listeners;
- refresh не blank-ит confirmed sample; refresh failure получает explicit stale
  state без raw endpoint/body/credential/path/secret;
- navigation между минимум Chat и Settings сохраняет Runtime Bar projection и не
  вызывает Job cancel, model stop или unload;
- component accessibility проверяет region/heading, disclosure keyboard, alert/
  status discipline и locale fallback/Russian strings;
- Chromium проверяет active+queued projection, independent degraded source,
  manual retry/recovery, navigation persistence, narrow viewport, 200% scaling,
  no horizontal overflow и reduced motion. Mocked browser test не является live
  Ollama/hardware validation;
- P1-D detach/reattach/Stop, P1-E recovered ordering, P1-F FIFO/unload/cleanup,
  P1-G source compatibility и P1-H telemetry/fit suites остаются зелёными;
- browser actions/count указаны буквально: какие routes открывались, какая
  mocked state transition выполнена и что не проверялось.

## Non-goals

- не добавлять Cancel/Open/Queue/Stop-and-switch/parallel actions или conflict
  dialog; это отдельный resource-action slice;
- не реализовывать prewarm, debounce warm, priority/preemption, additional
  permits, joint-fit admission, pin, TTL/LRU или auto-unload;
- не менять P1-F one-permit `normal` FIFO policy и unload guard;
- не добавлять full durable Jobs screen/history, generic Job worker/adapter,
  checkpoint resume, retry scheduler или lease journal;
- не добавлять runtime SSE/WebSocket, durable observation cache/history, metrics
  exporter, cloud telemetry или multi-process lock;
- не реализовывать новые Apple pressure heuristics либо Linux/NVIDIA/ROCm
  telemetry; unknown остаётся честным;
- не идентифицировать внешний process/client и не обещать future fit;
- не добавлять catalog/capability/import, Project/Recipe/Artifact, retention,
  notifications, Agent/MCP/Skills, service/daemon, CLI/TUI или rebranding;
- не использовать live Ollama, реальную модель, user DB, workspace files или
  public network в deterministic suite;
- не считать текущие 9 mocked Chromium tests доказательством нового Runtime Bar,
  пока не добавлены явные browser assertions этого slice.

## Validation

Сохрани новые exact counts и отдельно baseline/regression counts:

```bash
npm run typecheck
node --test packages/server/test/job-contract.test.ts \
  packages/server/test/job-migration.test.ts \
  packages/server/test/job-store.test.ts \
  packages/server/test/job-service.test.ts \
  packages/server/test/job-routes.test.ts \
  packages/server/test/chat-job-execution.test.ts \
  packages/server/test/chat-job-recovery.test.ts \
  packages/server/test/resource-governor.test.ts \
  packages/server/test/runtime-reconciliation.test.ts \
  packages/server/test/host-telemetry.test.ts
node --test packages/server/test/routes.test.ts \
  packages/server/test/exclusive-inference.test.ts \
  packages/server/test/inference-concurrency.test.ts
node --test packages/server/test/catalog.test.ts \
  packages/server/test/runtime-contract.test.ts \
  packages/server/test/runtime-routes.test.ts \
  packages/server/test/ollama-client.test.ts
node --test packages/server/test/fit.test.ts \
  packages/server/test/host-telemetry.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Повтори узкие timer/visibility tests 10 раз, а P1-E recovery file — 10 раз, если
Runtime Bar lifecycle затрагивает timing либо route navigation. Не скрывай flaky
failure повторным запуском: сначала сохрани cause/fix/evidence.

В финальном evidence укажи exact counts, Runtime Bar states/facts, polling
interval/call bound, cancellation/visibility rule, source independence,
accessibility/responsive checks и реальные browser actions. Отдельно назови, что
live hardware/Ollama, continuous observation, future admission fit,
external-client identity, multi-process safety и resource actions не проверены и
не реализованы.

После успешной независимой проверки:

- обнови current-state docs и `docs/TESTING.md`;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A–P1-H evidence и добавь только P1-I;
- не отмечай всю Phase 1 завершённой: queue/stop-and-switch UX, prewarm и другие
  resource-action slices ещё впереди;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий bounded Phase 1 slice
  resource conflict/queue action UX либо оставь P1-I с blocker/recovery steps;
- сделай небольшие conventional commits для Web behavior, tests и docs.

Если accepted UX требует факт, которого нет в P1-H snapshot, не угадывай и не
рисуй optimistic state. Реализуй меньшую truthful projection и оставь exact gap
residual scope; блокируй P1-I только при конкретном несовместимом invariant или
неустранимом failing fixture.

В финале сообщи status `successful` либо `blocked`, commits, exact tests,
failures, residual risks и что `NEXT_AGENT_PROMPT.md` полностью переписан.
