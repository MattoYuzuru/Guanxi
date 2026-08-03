# Разработка

**Статус:** implemented  
**Проверено:** 2026-08-03
**Область:** фактическая структура и команды текущего репозитория

## Репозиторий

```text
packages/
  contract/  Zod domain, REST paths, SSE events
  server/    Hono composition, SQLite, Ollama, agent, tools
  web/       React SPA, typed API/SSE client
  cli/       foreground launcher and browser reuse
```

Root npm workspaces связывают пакеты. Production server раздаёт собранный web.

## Требования

- Node.js >= 22.5;
- npm;
- Ollama для ручного inference;
- браузер для UI-проверок.

## Команды

```bash
npm install
npm run dev:server
npm run dev:web
npm run typecheck
npm test
npm run test:web:browser
npm run build
npm run link:cli
```

| Команда            | Фактическая область                                 |
| ------------------ | --------------------------------------------------- |
| `dev:server`       | Node/Hono на loopback:4310                          |
| `dev:web`          | Vite:5173 с API proxy                               |
| `typecheck`        | TypeScript workspaces                               |
| `test`             | server + CLI + узкие web component regression tests |
| `test:web:browser` | deterministic Chromium P0-A–P1-L regression gate    |
| `build`            | contract, web, server и CLI production artifacts    |
| `link:cli`         | глобальная локальная ссылка `alamo-ui`              |

`packages/web` содержит script `dev:mock`, но целевой `mock/server.mjs` отсутствует.
Считайте команду неработающей до отдельного решения: восстановить fixture server
либо удалить script.

## Current runtime conventions

- Current UI создаёт Chat с `num_ctx=8192`, Agent thread с `num_ctx=32768` и
  передаёт context в Ollama явно. Это текущее поведение, не универсальный safe
  default: target Governor должен учитывать exact model/hardware/runtime.
- Не все модели возвращают structured `tool_calls`. Current parser поддерживает
  native field и JSON/text fallback; сохраняйте оба пути и тесты при изменениях.
- Current agent turn отправляет `keep_alive=10m`; это известный lifecycle risk, а
  не рекомендуемый target default.
- Current P1-K `ResourceGovernor` сериализует Chat turn, compaction, explicit
  model warm/load и automatic prewarm одной typed process-local lease. Durable
  Chat использует canonical `jobId`; compatibility/prewarm operations — UUID
  operation owner. Priority — `normal > prewarm`, FIFO сохраняется внутри
  normal; normal отменяет queued prewarm либо exact-owner abort-ит active
  prewarm и ждёт release. Prewarm никогда не preempt-ит normal. P1-H samples
  `/api/ps` и injected host telemetry рядом с Governor state, но observation/
  current-fit explanation не меняют admission.
- New Chat auto prewarm ждёт 600 ms стабильного exact installed Chat selection,
  использует fit для того же context и отменяется при selection/mode/setting/
  visibility/unmount/normal-work change. Server повторно валидирует selection,
  setting, runtime identity и Governor; short TTL — `2m`, deadline — 30 s.
  Explicit warm и turns сохраняют `10m`. Prewarm request не durable и не
  переживает disconnect.
- Current P0-D adapter различает connect, load и stream-idle deadlines.
  Explicit Stop имеет приоритет; subscriber disconnect не отменяет Chat Job, а
  timeout/provider/explicit abort освобождает P1-F lease.
- Health/catalog/running facts — sampled observations с source/time. Installed
  models приходят из `/api/tags`, loaded rows из `/api/ps`; current catalog
  использует stale local cache или dated bundled fallback без remote endpoint.
- `GET /api/runtime` и compatibility `GET /api/models/running` используют один
  `RuntimeReconciliationService`. Pending callers делят `/api/ps`, `/api/tags`,
  `/api/version` и host sample; completed state не кэшируется. Sources fail
  независимо.
  `models: []` — healthy empty, `models: null` — source failure. Owner без exact
  active reference остаётся `unknown`.
- P1-L complete observation key version 1 требует exact tags↔ps digest,
  context, sourced Ollama version и stable local Apple profile. Missing,
  ambiguous, changed, remote либо unsupported facts остаются typed unavailable;
  timestamp не входит в fingerprint. Migration 6 хранит exact calibration
  отдельно и не читает legacy name-only rows как measured evidence. `/api/show`
  cache invalidates same-name changed digest и удерживает максимум 64 references.
- P2-A installed list/detail добавляют additive `InstalledModelDescriptor`.
  Installation и tag declaration получают `/api/tags` observation; detail
  declaration из `/api/show` сохраняет unknown digest basis, потому что response
  не содержит artifact digest. Duplicate normalized references не вызывают
  name-based detail lookup. Unknown/malformed/failure остаются видимыми
  unknown/degraded, а process cache не меняет исходное `/api/show` observation
  time.
- Один `HostTelemetry` создаётся в `context.ts`; route, Web, Governor и static fit
  не запускают host commands. Apple adapter использует bounded absolute
  `/usr/bin/vm_stat`; non-Apple возвращает `unsupported`. Total/free/legacy
  estimate/current available/pressure/discrete VRAM остаются разными facts.
  Current production Apple fit — `unknown`, пока pressure и available memory не
  имеют подтверждённого source.
- P1-D `JobService` поверх migration 5/`JobStore` владеет canonical state
  transitions, cancel и persisted-first subscription. SQLite event sequence
  остаётся источником replay; live listeners хранят только wake-up signal.
  Public Job и current Chat routes используют этот service. Один
  `ChatJobExecutionOwner` продолжает Chat после subscriber disconnect. P1-E
  выполняет bounded Chat recovery после migration и до HTTP listen: unsafe
  execution становится `interrupted`, persisted `cancelling` — `cancelled`, а
  только untouched `queued` передаётся тому же owner.
- P1-I persistent Runtime Bar читает только typed `GET /api/runtime`: один
  component владеет максимум одним HTTP wait, poll-ит active/queued sample через
  2 s, idle через 10 s, не создаёт timer в hidden document и немедленно
  refresh-ится после `visible`. Route change component не unmount-ит и не
  вызывает Job cancel, model stop или unload. Failed refresh сохраняет последний
  confirmed sample с явной stale/error меткой.
- P1-J переносит этот poller в один persistent `RuntimeProvider`. Chat dispatch
  делает bounded fresh read через общий single-flight, но не создаёт второй
  polling loop. При active lease/FIFO predecessor safe default отправляет тот же
  Chat command с заранее созданным UUID key; destructive Stop разрешён только
  для fresh exact Job owner, повторно сверяет owner и public Job state, вызывает
  один cancel и ждёт terminal acknowledgement перед единственным dispatch.
  Operation/unknown/stale/changed owner никогда не угадывается и не отменяется.

## Карта current-state

### Contract

- `schemas.ts` — domain Zod schemas;
- `api.ts` — route constants и request/response schemas;
- `events.ts` — Chat/Job SSE unions и classified private Chat output;
- `index.ts` — public exports.
- Durable Job record/state/error/outcome, event envelope и P1-C public
  create/query/cancel/cursor/SSE schemas экспортируются из contract.
- P1-D Chat command snapshot/idempotency и Message `jobId` остаются additive;
  точные новые SSE terminal details optional для старого strict client.
- P1-H Runtime snapshot содержит source health, current Governor state, sampled
  model rows, host profile/sample и stable observed/unknown current-fit reasons.
- P1-K Runtime snapshot дополнительно различает normal/prewarm priority и
  `model_prewarm`; prewarm command/settings имеют strict additive schemas.
- P1-L Runtime model/decision additive публикует versioned
  `observationKey: complete | unavailable`; legacy snapshots default-ятся в
  `legacy_snapshot`, а exact digest claim допустим только с complete key.
- P2-A `LocalModel`/`ModelDetail` additive публикуют descriptor с canonical
  reference, artifact identity, installation observation и source-preserving
  capability declarations. Legacy response получает explicit unknown default.

### Server

- `app.ts` — routes/composition/static serving;
- `context.ts` — зависимости, один `JobStore` + `JobService` +
  `ChatJobExecutionOwner`, один process-local `ResourceGovernor` и один
  `HostTelemetry`;
- `runtime/resource-governor.ts` — typed normal-before-prewarm admission, active
  lease, snapshot/explanation, unload guard и close boundary;
- `runtime/prewarm.ts` — exact validation, short-TTL warm и caller/normal abort;
- `runtime/observation-key.ts` — canonical key construction и unavailable
  policy; `runtime/reconciliation.ts` — shared provider/host sources, common
  timestamp, owner/artifact/current-fit classification и compatibility projection;
- `ollama/` — client, status и wire types;
- `models/` — installed/running details, P2-A descriptor assembler и sourced
  catalog fallback; descriptor path сохраняет four-worker `/api/show` bound,
  caller AbortSignal, digest-aware LRU 64 и fail-closed ambiguous evidence;
- `hardware/` — legacy profile/static fit и injectable sampled telemetry adapter;
- `http/` — models, runtime, Jobs, threads, workspaces, SSE;
- `store/` — SQLite migrations и stores;
- migration 3 добавляет nullable `turn_status/turn_error/stop_reason` и не
  переписывает старые migrations;
- migration 4 additive добавляет `jobs`/`job_events`; `store/jobs.ts` владеет
  create/read/event page/sequence CAS, canonical non-terminal transition CAS и
  terminal CAS;
- migration 5 additive связывает Message с Job, хранит private Chat input и
  classified private output; Chat create и terminal Message/Job projection
  transactionally atomic;
- migration 6 additive создаёт `model_calibration_observations`; legacy
  `model_calibration` сохраняется без backfill/credit. Failed migration остаётся
  на v5 и повторяется после устранения conflicting schema;
- `store/calibration.ts` принимает только complete observation key и отделяет
  context/digest/runtime/hardware rows;
- `jobs/lifecycle.ts` фиксирует transitions из canonical diagram;
  `jobs/service.ts` валидирует terminal edges и читает bounded SQLite pages при
  replay/live subscription без in-memory event queue, закрывает terminal tail и
  владеет cancel transitions;
- `jobs/chat-execution.ts` владеет Chat controller, canonical phases,
  persist-first output, 16 KiB chunk boundary и cancellation acknowledgement;
- `jobs/chat-recovery.ts` владеет recovery-only interrupted edges, stable
  keyset scan, bounded private-output reducer и fail-closed startup policy;
- `http/jobs-routes.ts` предоставляет strict public command/query/GET SSE/cancel
  API с server-owned idempotency scope и bounded HTTP backpressure;
- `agent/` — turn loop, prompts, approvals и parser;
- `tools/` — registry, filesystem, shell и jail.

### Web

- `App.tsx` — current three-tab IA и persistent Runtime Bar boundary;
- `components/ErrorBoundary.tsx` — root/Chat/Runtime containment и safe diagnostics;
- `lib/router.tsx` — History API router;
- `lib/api.ts` — typed REST, Chat POST/SSE и Job query/replay/cancel calls;
- `lib/sse.ts` — Chat `seq`/Job `sequence` parser;
- `lib/locale.ts` — English fallback и curated Russian для новых boundary strings;
- `features/health/RuntimeContext.tsx` — persistent shared Runtime projection;
  `RuntimeStatus.tsx` — read-only lease/FIFO/models/host/fit projection;
  `useRuntimePolling.ts` — bounded adaptive polling/visibility owner и
  caller-scoped fresh wait без отмены shared request;
- `features/launcher` и `features/models` — installed/catalog/profile; installed
  cards/profile показывают P2-A source/state/freshness через locale keys без
  verified-green semantics для provider declaration;
- `features/chat` — creation, timeline, composer, UUID command key, durable Job
  discovery/reattach state и P1-J conflict decision. Queue сохраняет canonical
  command key; Stop использует только typed Runtime/public Job query/cancel;
  New Chat prewarm использует exact-context debounce и cleanup owner;
- `features/context` — context/cache/compaction;
- `features/agent` — workspace, approval и tool projections;
- `features/settings` — current settings.
- `test/component` — Vitest/jsdom P0-A/P0-B/P0-D/P0-E/P1-I/P1-J/P1-K
  projection, accessibility, conflict/prewarm races/idempotency и fake timers;
- `test/browser` — Playwright Chromium full create/stream/reload, failure/reload
  и boundary smoke, включая P1-I active/queued/degraded/recovery/navigation и
  P1-J literal Queue/Stop/unsupported/failure и P1-K selection/debounce/cleanup/
  Chat-dispatch flows, narrow viewport, 200% scaling и reduced motion.
- server tests — deterministic P1-F governor, cross-thread turn/compaction/warm,
  cancellation/release и repeated-compaction regression; P0-D fake provider
  health/catalog/running/timeout envelope; P1-A/P1-B/P1-C temporary SQLite и
  worker-thread connections проверяют migration, atomicity, idempotency,
  transition races, public command/query/cancel, persisted-first replay/live
  handoff, HTTP cleanup/backpressure, terminal close и restart replay; P1-D
  проверяет migration 5, duplicate command, detached execution/reattach,
  cancellation races, private-output redaction и atomic Message/Job terminal;
  P1-E — closed/reopened DB recovery, all non-terminal Chat states, bounded
  pages, partial projection, fail-closed startup и truthful shutdown; P1-F —
  typed request/ticket/lease, FIFO/cancellation/close, bounded diagnostics,
  unload conflict и полная current Chat/compaction/warm matrix; P1-G — exact
  runtime contract/identity, source failures, linearization, single-flight,
  caller cancellation, route inventory и no-auto-unload; P1-H — bounded command,
  parser/source states, failure independence, shared call count, Governor
  linearization и observed/unknown fit fixtures; P1-I — contract-round-tripped
  Web states, inventory, adaptive polling cleanup, feature containment и mocked
  navigation/recovery projection; P1-J — typed API inventory, exact owner/TOCTOU,
  cancel acknowledgement, command acceptance/key reuse, focus/inert/keyboard,
  retry и responsive browser flows; P1-K — contract compatibility, priority
  order, exact owner abort/release, typed route/TTL, settings, exact residency,
  debounce/visibility/StrictMode cleanup и one-command browser flow; P1-L —
  typed keys, migration 6, exact calibration, digest-aware cache, tags↔ps
  reconciliation, redaction и AbortSignal.

### CLI

- `bin.ts` — args, foreground start и browser open;
- `existing.ts` — probe/reuse already-running server;
- `scripts/build.mjs` — bundle.

## Change protocol

### REST/SSE

1. Измените Zod schema/path/event в `contract`.
2. Измените server handler и error semantics.
3. Измените web/CLI projection.
4. Добавьте route + parser + UI failure tests.
5. Обновите HLD/LLD, если поменялась граница.

Не добавляйте unvalidated ad-hoc JSON между пакетами.

### SQLite

1. Добавьте новую migration по `user_version`.
2. Сделайте migration forward-only и безопасной для существующих данных.
3. Опишите backfill/default и поведение при прерывании.
4. Тестируйте fresh DB и upgrade с предыдущей схемы.
5. Для destructive cleanup сначала введите совместимый read/write period.

### Model/runtime

1. Опишите Job/lease transition до кода.
2. Учитывайте весь host, browser tabs и внешние Ollama clients.
3. Не используйте route unmount как cancellation.
4. Добавьте timeout, abort и terminal persistence.
5. Ключуйте observations по digest/runtime/backend/hardware/context.

### Catalog/capability

1. Проверьте разрешённость provider API.
2. Добавьте schema validation, timeout, bounded retries и cache policy.
3. Храните provenance/freshness/confidence.
4. Не превращайте model-card claim в runtime fact.
5. Неподдерживаемый provider не должен ломать installed models.

### UI

1. Реализуйте loading/empty/error/offline/partial/terminal states.
2. Сохраняйте keyboard и semantic HTML.
3. Проверяйте narrow viewport, 200% zoom и reduced motion.
4. Не добавляйте page-local lifecycle для durable Jobs.
5. Добавляйте Error Boundary на feature и root boundaries.

## Code conventions

- Сохраняйте TypeScript strictness; не обходите contract через `any`, type
  assertion или повторное ручное описание JSON shape.
- Парсите недоверенные HTTP/provider/DB JSON на границе Zod/schema adapter.
- Передавайте инфраструктурные зависимости через существующий composition
  context; не создавайте Ollama/DB/tool clients внутри route/component.
- Async API принимает `AbortSignal`, задаёт timeout policy и различает cancel,
  timeout и provider error.
- Resource/model side effect выполняется только через владеющий lifecycle service;
  React effect не является владельцем durable operation.
- React effect callback возвращает только cleanup-функцию или `undefined`. Если
  вызываемый callback может вернуть Promise/value, оборачивайте его в block body.
- Не храните canonical server state только в component/localStorage. Local storage
  подходит для theme/temporary view preferences, но не для approvals/Jobs/leases.
- Ошибки имеют stable machine code и безопасное human message; raw provider error
  проходит redaction.
- Комментарий объясняет invariant/tradeoff, а не пересказывает строку кода.
- Публичное изменение сопровождается failure-path test, а не только happy path.

## Local data и безопасность

- пользовательская DB: `~/.alamo/alamo.db`;
- Ollama хранит свои models отдельно;
- agent workspace указывает на реальные user files;
- settings/secrets сейчас сохраняются в SQLite plaintext — известный риск;
- server по умолчанию loopback-only.

Не используйте реальные paths/data в unit tests. Temporary DB/workspace создавайте
в test temp directory. Bind на `0.0.0.0` не превращает текущий сервер в безопасный
remote product: auth middleware пока не реализует защиту, а tools имеют сильные
локальные эффекты.

### Прокси и сертификаты

В исходном development environment `npm install` работал через корпоративный
proxy, а Bun мог падать на self-signed certificate. Если Node/Bun или исходящие
provider requests не доверяют корпоративному CA, используйте утверждённый
root-certificate через `NODE_EXTRA_CA_CERTS`; не отключайте TLS verification и не
коммитьте сертификат в репозиторий.

## Branding

Имя `Alamo` сейчас встречается в packages, CLI, UI, DB path, localStorage и CSS.
Новые места не добавляйте. До rename нужен inventory и compatibility plan:

- display name;
- binary/package identity;
- API/client identifiers;
- data directory/DB;
- localStorage keys;
- config/env prefixes;
- migration aliases.

## Документация

Current behavior обновляется вместе с кодом. Target behavior проходит через ADR
и roadmap. В текстах не используйте «поддерживается», если существует только
enum, mock, proposal или upstream possibility.
