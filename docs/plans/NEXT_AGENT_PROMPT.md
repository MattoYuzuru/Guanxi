# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-H — host telemetry interface и Apple Silicon
observed/unknown fit

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate.
P1-A–P1-E реализовали durable Jobs, Chat detach/reattach и fail-closed startup
recovery. P1-F добавил typed process-local Resource Governor. P1-G добавил один
sampled `/api/ps` reconciliation boundary и additive `GET /api/runtime`.
Реализуй только slice `P1-H host telemetry interface + Apple Silicon
observed/unknown fit`. Не создавай subagents и не делегируй работу.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract/store: `138fb5e`, `91cb21f`, `92b68f0`;
- P1-B store/service/tests: `56b2200`, `55351bc`;
- P1-C public API: `4b9d96a`, `0a06ea6`;
- P1-D contract/storage/execution/evidence: `da70576`, `08b3516`, `f33d5b9`;
- P1-E startup recovery/evidence: `22a1aff`, `6c748de`;
- P1-F Governor implementation/evidence: `a0bc047`, `ff96dc0`;
- P1-G runtime reconciliation: `b8328bd`, `bd0d7a1`, `40a0de7`;
- P1-G additive response compatibility: `f53a868`;
- P1-G docs/status: commit непосредственно перед этим handoff prompt.

Не откатывай Error Boundaries, truthful Message terminal CAS, persisted
compaction fix, sampled runtime health/timeouts, SQLite migrations 1–5, scoped
Job idempotency, canonical state CAS, persisted-first subscription, strict public
Job command schemas, server-owned idempotency scopes, pull-based HTTP
backpressure, durable Chat privacy/chunking/terminal transaction,
disconnect-only semantics, Web reattach, P1-E pre-listen recovery, P1-F typed
tickets/leases/unload guard или P1-G runtime single-flight/source semantics.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD, `docs/DOMAIN_MODEL.md`,
   `docs/TESTING.md`, `docs/DEVELOPMENT.md`, `docs/PRODUCT.md`, `docs/UX_IA.md`,
   accepted ADR-0001/0002/0003/0004, `docs/research/EVIDENCE.md`,
   `docs/plans/OPEN_QUESTIONS.md` и
   `docs/decisions/2026-08-02-product-decisions.md`.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `architecture-agent:architecture-agent`,
   `architecture-agent:architecture-capacity`,
   `sre-agent:verification-strategy`, `sre-agent:reliability-testing`,
   `sre-agent:finding-validation` и `sde-agent:implementation-evidence` без
   делегирования.
4. Для macOS/Node telemetry сначала проверь актуальные official Apple и Node.js
   contracts. Не превращай undocumented command output или remembered API в
   validated source; сохрани URL/date/limitations в research evidence, только
   если факт реально влияет на implementation.
5. До правок воспроизведи current state: exact Job/Governor/reconciliation files
   дают 82/82; routes/Governor/concurrency — 28/28; runtime/provider — 19/19;
   current `fit.test.ts` — 13/13. P1-G имеет один `context.runtime`, один pending
   `/api/ps` Promise, `models: []` только для healthy empty и `models: null` для
   source failure. Current `HardwareInfo.usableMemoryBytes` использует static
   70% Apple heuristic; это legacy estimate, не observed current availability.
6. До кода составь bounded plan с inventory всех hardware/fit consumers,
   static-profile/dynamic-sample table, source/confidence semantics, Apple
   success/partial/failure/unsupported states, sampling order/linearization,
   concurrency/cancellation/timeouts, compatibility/migration, command security,
   capacity bound и exact validation commands.

## Scope P1-H

- ввести один injectable `HostTelemetry` application/infrastructure interface;
  routes, Web, fit helpers и Governor не запускают `sysctl`, `vm_stat`,
  `memory_pressure` или другие host commands напрямую;
- добавить Apple Silicon implementation только для `darwin/arm64`. Используй
  documented/stable sources с bounded timeout/output и injected `execFile`-like
  runner. Не вызывай shell, не интерполируй user input и не включай command
  stderr/raw output в public response;
- разделить immutable/static host profile и dynamic telemetry sample. Каждое
  опубликованное поле имеет source, `observedAt` и confidence/state. Unknown или
  unavailable лучше 70% heuristic, выданной за current fact;
- additive расширить current `GET /api/runtime` host projection. P1-G top-level
  parser специально tolerant к additive fields; не ломай P1-G fields/codes и
  compatibility `GET /api/models/running`;
- сохранить legacy `/api/health.hardware` и `HardwareInfo` shape для current Web.
  Если 70% `usableMemoryBytes` остаётся там ради compatibility, явно маркируй его
  как legacy estimate в новом runtime contract/docs; не используй как observed
  pressure/available memory;
- минимум различать Apple host telemetry `available`, `partial`, `unavailable`
  и non-Apple `unsupported` либо эквивалентные narrow stable states. Partial
  обязан перечислять доступные facts и отсутствующие fields, а не заполнять их
  нулями;
- Apple unified memory не называть discrete VRAM. Если public source не даёт
  отдельной GPU-free memory, поле остаётся `null/unknown`; total unified memory,
  current available/pressure и `/api/ps size_vram` — разные факты;
- интегрировать telemetry в P1-G shared sample: overlapping `/api/runtime`
  callers создают bounded provider-call и telemetry-probe count. Caller abort не
  отменяет shared work для остальных. После completion live Promise/listeners не
  растут и следующий call делает новый sample;
- явно определить sampling/linearization. Допустимый rule: `/api/ps` и host
  telemetry запускаются вместе, после завершения обоих выбирается один root
  `observedAt`, затем синхронно capture-ится Governor. Это coherent application
  projection, но не atomic host/runtime truth;
- `/api/ps` и telemetry failures независимы: healthy runtime rows не исчезают
  из-за telemetry failure, а valid telemetry не превращает failed `/api/ps` в
  `models: []`. Общий route остаётся диагностируемым;
- добавить narrow current-fit projection только там, где evidence достаточно.
  `observed` означает ровно наблюдавшуюся loaded configuration на этом runtime
  и Apple host sample, а не future admission guarantee. Missing/mismatched
  context, missing telemetry, failed source или unverified host → `unknown`;
- runtime row digest остаётся provider observation; lease по-прежнему не имеет
  digest и не получает proven artifact identity. Host observation не доказывает
  external client identity;
- не считать current load безопасным только потому, что процесс не упал. Если
  pressure semantics не подтверждены официальным source/fixture, публикуй
  residency observed и fit unknown;
- не менять P1-F default policy: один permit, priority `normal`, FIFO. Telemetry
  и fit в P1-H read-only/explanatory; они не разрешают parallel, не preempt-ят,
  не auto-unload-ят и не меняют очередь;
- сохранить exact/conservative unload guard. Unknown-owner row не
  auto-unload-ится, active lease без row не освобождается;
- P1-E startup ordering сохранить. Startup не должен ждать live telemetry или
  Ollama сверх current recovery boundary; generic public Job не получает ticket,
  lease или runtime owner;
- migration 6 не нужна для process-local sampled telemetry. Если вводится
  durable cache, это scope expansion: нужен explicit TTL/staleness, additive
  fresh/v5→v6/failed+reopen test и rollback note. Предпочтительный P1-H cache не
  вводит;
- обновить current-state docs и Mermaid/source diagram, если component/data
  boundary изменилась.

## Runtime result P1-H

```text
validated /api/ps result or controlled failure
        +
bounded Apple host telemetry result or partial/unknown
→ one shared application sample
→ capture Governor after sources settle with one root observedAt
→ explain residency/current fit as observed or unknown
→ additive GET /api/runtime without admission side effects
```

P1-H остаётся sampled single-process observation. Он не доказывает continuous
memory state, future model fit, external process identity, Ollama scheduler
safety или multi-process ownership.

## Required deterministic evidence

- inventory test доказывает один injected telemetry boundary и отсутствие host
  command execution в routes/Web/Governor/fit helpers;
- contract round-trip покрывает Apple available/partial/unavailable, non-Apple
  unsupported, observed и unknown fit, а P1-G-shaped response с новым additive
  field остаётся parseable;
- Apple fixture фиксирует exact command/API inputs, bounded timeout/output и
  unit conversions; malformed/missing/extra output даёт partial/unknown, не
  optimistic zero;
- total unified memory, dynamic available/pressure, runtime allocation и legacy
  70% usable estimate имеют разные source/basis labels;
- Apple adapter не публикует discrete VRAM либо GPU-free bytes без реального
  source;
- `/api/ps` success + telemetry failure сохраняет models/owner decisions;
  `/api/ps` failure + telemetry success сохраняет host facts и `models: null`;
- matched active lease + exact runtime row + sufficient Apple sample даёт только
  разрешённый observed current-fit explanation; digest/context/host mismatch и
  missing pressure дают `unknown`;
- telemetry/provider calls, pending во время enqueue/acquire/release, дают ровно
  документированную common-timestamp linearization;
- минимум два concurrent callers, один caller abort и следующий post-completion
  call доказывают bounded call count, независимую cancellation и отсутствие
  retained history/listeners;
- telemetry timeout/runner failure не содержит raw stdout/stderr, hostname,
  username, endpoint credentials, path, prompt, reasoning или secret;
- unload exact/conservative guard, unknown-owner no-auto-unload и P1-G source
  failure semantics остаются зелёными;
- P1-E recovered stable order/unsafe no-ticket, P1-F Chat/compaction/warm matrix,
  1000 cleanup и 10x release/cancel/close остаются зелёными;
- P1-D duplicate/cancel/detach/reattach, P1-A–P1-C store/subscription, P0-D
  timeout gates и P0 browser smoke остаются зелёными;
- browser gate не получает credit за telemetry/fit UI: если Web projection не
  меняется, это прежний mocked P0/P1-D smoke.

## Non-goals

- не добавлять background polling, SSE runtime feed, durable telemetry history,
  metrics exporter или cloud telemetry;
- не реализовывать Linux/NVIDIA/ROCm adapter кроме explicit `unsupported/unknown`
  contract fixture;
- не вводить RAM/VRAM reservation, joint-fit admission, parallel permits,
  priority/preemption, prewarm, pin, idle TTL/LRU или auto-unload;
- не превращать static 70%, `os.freemem()`, model size или absence OOM в точный
  safe capacity без documented basis;
- не идентифицировать внешний process/client по `/api/ps` row;
- не добавлять полный Runtime Bar, Jobs screen, queue dialog или новый IA;
- не добавлять durable lease journal, checkpoint resume, generic worker registry,
  arbitrary public Job execution, retry/scheduler policy или multi-process lock;
- не добавлять Application Service/daemon, CLI/TUI Job commands или autostart;
- не добавлять catalog/capability/import, retention, notification, Project,
  Recipe, Artifact, Agent/MCP/Skills, branding или locale expansion;
- не использовать live Ollama, реальную модель, public network, user DB или
  реальные workspace files в deterministic suite;
- не называть fake telemetry hardware validation, current sample future fit или
  process-local observation host-wide safety.

## Validation

Уточни новый telemetry test filename в плане и сохрани exact counts:

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
  packages/server/test/runtime-reconciliation.test.ts
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

В финальном evidence укажи exact counts, telemetry state/source/confidence,
observed/unknown fit basis, failure independence, call bound, linearization rule,
какие routes реально подключены и какие browser actions реально проверены.
Отдельно назови, что live hardware/Ollama, continuous observation, future fit,
external-client identity и multi-process safety не проверены и не реализованы.

После успешной независимой проверки:

- обнови current-state runtime/HLD/LLD/development/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A–P1-G evidence и добавь только P1-H;
- не отмечай всю Phase 1 завершённой: prewarm/unload policy, Runtime Bar,
  queue/stop-and-switch UX и resource UX ещё впереди;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий bounded Phase 1 slice
  read-only Runtime Bar/resource projection либо оставь P1-H с blocker и
  recovery steps;
- сделай небольшие conventional commits для contract/telemetry, tests и docs.

Если Apple pressure/available-memory semantics или observed-fit threshold
требует недоступного official evidence либо нового product decision, не угадывай.
Реализуй меньший truthful profile/unknown snapshot, а спорное оставь residual
scope; P1-H блокируй только при конкретном несовместимом invariant и failing
fixture.

В финале сообщи status `successful` либо `blocked`, commits, exact tests,
failures, residual risks и что `NEXT_AGENT_PROMPT.md` полностью переписан.
