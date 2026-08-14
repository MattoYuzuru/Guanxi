# Разработка

**Статус:** implemented  
**Проверено:** 2026-08-14
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
npx playwright install chromium   # обязательно один раз до test:web:browser
npm run dev:server
npm run dev:web
npm run typecheck
npm test
npm run test:web:browser
npm run build
npm run benchmark:catalog
npm run link:cli
```

`npm install` не устанавливает browser binaries: postinstall hook отсутствует.
Без `npx playwright install chromium` browser gate падает на чистой машине.

| Команда             | Фактическая область                                  |
| ------------------- | ---------------------------------------------------- |
| `dev:server`        | Node/Hono на loopback:4310                           |
| `dev:web`           | Vite:5173 с API proxy                                |
| `typecheck`         | TypeScript workspaces                                |
| `test`              | server + CLI + узкие web component regression tests  |
| `test:web:browser`  | deterministic Chromium P0-A–P3-M mocked gate         |
| `build`             | contract, web, server и CLI production artifacts     |
| `benchmark:catalog` | synthetic 1k server/jsdom diagnostic, не SLA         |
| `link:cli`          | глобальная локальная ссылка `alamo-ui`               |

`dev:mock` удалён 2026-08-07 (Q-36): целевой `mock/server.mjs` отсутствовал, а
browser gate мокает REST/SSE через Playwright routes, поэтому отдельный fixture
server не нужен.

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
  P2-G Linux/NVIDIA device facts не добавляются в key: без связи `/api/ps` row с
  backend/device identity Linux key и current fit остаются unavailable/unknown.
- P2-A installed list/detail добавляют additive `InstalledModelDescriptor`.
  Installation и tag declaration получают `/api/tags` observation; detail
  declaration из `/api/show` сохраняет unknown digest basis, потому что response
  не содержит artifact digest. Duplicate normalized references не вызывают
  name-based detail lookup. Unknown/malformed/failure остаются видимыми
  unknown/degraded, а process cache не меняет исходное `/api/show` observation
  time.
- P2-B добавляет migration 7 и safe exact installed-evidence cache. Key version
  1 включает provider, canonical reference, installed digest, Ollama version и
  evidence schema version. Fresh policy — 15 минут; unavailable `/api/show`
  допускает explicit offline stale fallback ещё 7 дней. Before/after
  `/api/tags` + runtime-version validation обязателен до write. Process LRU 64
  остаётся front-cache; один per-key flight и общий pool не превышают четыре
  detail workers. Cache хранит только allowlisted capabilities/context/
  architecture numbers, без raw body, endpoints, paths, prompts или license.
- P2-C добавляет только явный `completion` probe из Installed profile.
  `POST /api/models/:name/probes/completion` принимает exact expected digest,
  requested context и optional force, а server владеет prompt/options. Exact
  fingerprint version 1 связывает canonical reference, digest, Ollama version,
  context и probe-definition version. Historical exact row возвращается без
  нового load, force выполняет новый bounded observation; declaration при этом
  не повышается до verified.
- Probe проходит normal-priority `model_probe` admission через тот же Governor.
  Cloud/red/unknown-fit и context-over-limit дают skip до load. Transport bounds:
  connect 10 s, load 30 s, response-idle 5 s, общий request deadline 45 s,
  `num_predict=8`, response bytes 1024 и `keep_alive=2m`. До и после call
  повторно проверяются `/api/tags` и `/api/version`; identity drift, cancel,
  timeout, protocol/provider или persistence failure не дают verified.
- P2-D добавляет отдельный Marketplace flow для user-supplied Ollama reference.
  Strict server normalizer локально принимает только ASCII model name с одним
  optional namespace/tag либо exact HTTPS page shape на `ollama.com`, приводит
  case и implicit `:latest`, fail-closed отклоняет credentials/port/query/
  fragment/encoded или literal traversal. Preview не вызывает сеть, Ollama,
  filesystem или SQLite. Start заново нормализует исходный reference, требует
  exact confirmed name и передаёт в `OllamaClient.pull` только это имя.
- P2-D pull использует validated NDJSON progress и legacy additive SSE event
  schema, но требует provider status `success` до `done`. Caller connection
  владеет controller; disconnect/cancel не создаёт durable/replayable Job и не
  останавливает Ollama daemon. Web не retry-ит stream автоматически, после
  terminal success отдельно перечитывает `/api/tags` и не запускает completion
  probe либо capability promotion.
- P2-E расширяет local/bundled catalog exact variant rows: shared P2-D
  normalizer формирует canonical pull target, fit считается по claimed size
  выбранного варианта, а installation сопоставляется только с exact normalized
  `/api/tags` row и digest. Duplicate/malformed row fail-closed без fallback на
  base/latest; top-level `installed`/`fit` сохранены как явно compatibility
  aggregate/largest projection.
- Marketplace требует variant selection до confirmation, фиксирует выбранный
  target на время active pull и переиспользует connection-owned P2-D start.
  Success отдельно перечитывает Installed descriptor и показывает exact digest
  только при одном canonical `/api/tags` match. Catalog source/fetched/observed
  time и unknown/stale/fallback остаются видимыми; никаких auto probe, prewarm,
  load, capability promotion или remote catalog fetch.
- P2-F additive расширяет catalog query strict facets. Multi-select кодируется
  одним CSV value: OR внутри installation/fit/scope/source/freshness/capability,
  AND между группами. Context/size принимают positive safe integer либо
  explicit unknown. Repeated/unknown key, duplicate value, future enum и
  конфликт numeric+unknown дают controlled 400 до provider access.
- Variant-level installation/fit/context/size фильтруются только на одной exact
  row после P2-E normalization; model-level scope/source/freshness/capability
  применяются отдельно. Empty capability metadata означает unknown, не
  unsupported. Filtering сохраняет source timestamps и не создаёт remote fetch,
  persistence либо нового runtime observation.
- Web debounces и abort-ит catalog queries, не принимает late response, показывает
  applied chips/clear/loading/empty/error/retry. Compare допускает ровно две
  unique exact rows, показывает claims, per-variant fit, provenance и exact
  sampled installation без winner/recommendation. Vanished target удаляется
  явно; remove/swap/Escape сохраняют focus boundary. Search/filter/compare не
  запускают pull, probe, prewarm, load или provider refresh.
- P2-H explicit paged catalog mode использует pair `page + pageSize`: оба
  positive safe integers, page size не больше 100; partial/invalid/repeated/
  unknown query даёт 400 до source и `/api/tags`. Legacy request без pair
  сохраняет полный list. Server выполняет normalization, global duplicate-target
  fail-closed, P2-F filtering и locale-independent stable sorting до exact count/
  slice; empty и out-of-range page не подменяются другой страницей. Caller
  AbortSignal проходит до local cache read, а один request по-прежнему делает не
  более одного `/api/tags` sample.
- New Web всегда запрашивает page size 12, рендерит только current page и
  constant Previous/Next pager. Accepted debounced query/filter/context basis
  атомарно сбрасывает page 1, late response не принимается. До двух exact compare
  snapshots переживают простую page navigation, но source/query basis change
  очищает их с localized notice. Pager блокируется на время active
  connection-owned pull и не отменяет его; paging не запускает resource action
  или background prefetch. Legacy full response дополнительно bounded client-side.
- P2-I добавляет explicit positive user capability assertion только для exact
  installed artifact. `POST`/`DELETE /api/models/:name/capability-overrides`
  принимают capability из существующего closed enum, expected digest и expected
  runtime version; оба пути зарегистрированы до generic `/:name`, чтобы жадный
  name pattern не поглотил suffix. Server перечитывает `/api/tags` и
  `/api/version` в точке mutation: один canonical match, exact digest и sourced
  version обязательны, иначе возвращается typed conflict без записи и удаления.
  Repeated identical write идемпотентен и не меняет timestamps; clear удаляет
  ровно одну row. Mutation не запускает chat/pull/load/unload, Governor
  admission, probe, catalog refresh или background Job.
- Installed profile показывает assertions отдельным labelled регионом рядом с
  provider declarations и completion probe. Positive assertion не красит
  declaration в verified и не скрывает conflict/degraded/unknown. Add/remove
  требуют explicit confirmation и one-intent guard; mount/hover/focus/navigation/
  reload/export ничего не мутируют. Copy/Download отдают deterministic safe JSON
  без endpoint, credentials, path, provider body, prompt, response и reasoning.
  Absence assertion остаётся unknown, а не unsupported.
- Один `HostTelemetry` создаётся в `context.ts`; route, Web, Governor и static fit
  не запускают host commands. Apple adapter использует bounded absolute
  `/usr/bin/vm_stat`. Local Linux с detected CUDA profile использует один
  shell-free `/usr/bin/nvidia-smi` query с fixed argv, timeout 1 s и output limit
  64 KiB; остальные hosts возвращают `unsupported` без команды. Pure parser
  публикует все usable rows как per-device index, nullable UUID, name и observed
  total/current-free VRAM с общим time/source/confidence. Duplicate identity
  fail-closed; malformed subset остаётся `partial`, а command/timeout/output
  failure — redacted `unavailable`. Total/free/legacy estimate/current available/
  pressure/discrete VRAM остаются разными facts. Current Apple и Linux fit
  остаётся `unknown`, пока нет достаточных pressure/admission и exact
  runtime-device facts.
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
  confirmed sample с явной stale/error меткой. P2-G добавляет localized
  available/partial/unavailable/unsupported NVIDIA projection, redacted UUID и
  contained scrolling всех returned devices без aggregate capacity claim.
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
- `retention.ts` — общий strict retention policy/default version 1 плюс Chat
  activity/expiry/lifecycle compatibility projections;
- `quick-runs.ts` — strict canonical Quick Run metadata, exact scopes и truthful
  execution/cleanup/session capability projection version 1;
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
- P2-C additive публикует strict completion-probe request/response/evidence с
  `verified | degraded | unknown | cancelled | skipped`, exact/unavailable basis,
  source/time/confidence и historical flag. Unknown future enum отклоняется;
  legacy model/descriptor shapes не получают probe fields.
- P2-D additive публикует strict preview/start request и preview response для
  Ollama reference. Input kind закрыт enum-ом, unknown fields отклоняются, а
  pull progress сохраняет совместимый `PullStreamEvent` contract.
- P2-E additive расширяет `CatalogModel.variants` normalized target, claimed
  context, per-variant calculated/unknown fit, exact installed/not-installed/
  unknown evidence и source freshness/timestamps. Legacy variant rows получают
  non-installable unknown defaults; top-level compatibility projections не
  выдаются за выбранный variant fact.
- P2-F additive расширяет strict `listCatalogQuery`: deterministic CSV facets,
  positive-safe claimed context/size и explicit unknown. Legacy `q`/
  `contextLength` сохраняют no-filter defaults; repeated/unknown keys и future
  enums fail-closed. Server возвращает только совпавшие exact variant rows с
  прежней provenance.
- P2-H additive добавляет `page + pageSize`, page-size maximum 100 и
  discriminated `legacy | paged` metadata с exact model-row total/pages и
  previous/next. Оба pagination keys обязательны вместе; Web default 12 —
  transport/render policy, не total catalog ceiling. Optional metadata сохраняет
  parse старых recorded responses.
- P2-I additive добавляет `ModelCapabilityOverride` version 1, descriptor поля
  `runtime` и `overrides`, strict mutation body и typed outcome union
  `applied | cleared | absent | conflict`. Legacy descriptor responses парсятся с
  `overrides: []` и unknown runtime. Conflict по contract не может нести ни
  identity, ни override. Negative `unsupported`, confidence и free-form
  capability не введены.

### Server

- `app.ts` — routes/composition/static serving;
- `context.ts` — зависимости, один `JobStore` + `JobService` +
  `ChatJobExecutionOwner`, один process-local `ResourceGovernor` и один
  `HostTelemetry`;
- `runtime/resource-governor.ts` — typed normal-before-prewarm admission, active
  lease, snapshot/explanation, unload guard и close boundary;
- `runtime/prewarm.ts` — exact validation, short-TTL warm и caller/normal abort;
- `runtime/completion-probe.ts` — explicit exact completion probe, request-owned
  deadline/cancel, fixed provider call, Governor cleanup и before/after identity;
- `models/capability-override.ts` — exact installed identity ownership, mutation-
  point revalidation, typed conflict/redaction и никакого model work;
- `models/ollama-reference.ts` — pure strict name/page normalizer;
  `models/ollama-pull.ts` — terminal-success/redacted pull event adapter;
- `runtime/observation-key.ts` — canonical key construction и unavailable
  policy; `runtime/reconciliation.ts` — shared provider/host sources, common
  timestamp, owner/artifact/current-fit classification и compatibility projection;
- `ollama/` — client, status и wire types;
- `models/` — installed/running details, P2-A descriptor assembler и sourced
  catalog fallback; catalog строит P2-E exact variant targets/fit/installation
  и применяет P2-F same-row facets без mutation provenance; P2-H перед slice
  выполняет global duplicate-target fail-closed и stable code-unit order,
  считает exact total и возвращает legacy full либо explicit bounded page;
  descriptor path сохраняет four-worker `/api/show` bound, caller AbortSignal,
  digest-aware LRU 64 и fail-closed ambiguous evidence;
- `scripts/catalog-pagination-benchmark.ts` — reproducible 1,000-model/
  4,000-variant local diagnostic response bytes/time без live provider и SLA;
- `hardware/` — legacy profile/static fit и injectable sampled Apple/NVIDIA
  telemetry adapters с fixed command boundaries и pure parsers;
- `http/` — models, runtime, Jobs, threads, Projects, workspaces, SSE;
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
- migration 7 additive создаёт `installed_model_evidence_cache` без backfill;
  failed migration остаётся на v6, а старый code игнорирует новую table;
- migration 8 additive создаёт `completion_probe_evidence` без backfill из
  provider declarations; failed migration остаётся на v7 и безопасно retry-ится;
- migration 9 additive создаёт `model_capability_user_overrides` без backfill из
  declarations или probe results; failed migration остаётся на v8, старый code
  игнорирует table, а schema rollback не удаляет user data;
- migration 10 additive создаёт logical `projects` и
  `project_filesystem_bindings`, backfill-ит exact legacy Workspace ID в одной
  transaction и оставляет старые tables/routes без rename/delete; startup
  reconciliation идемпотентно подхватывает Workspace, записанный старым binary;
- migration 11 additive добавляет constrained Project `icon_key`/`color_token`
  с deterministic defaults; canonical manifest и SQLite CHECK allowlists
  проверяются exact-set assertion, а legacy Project response остаётся opt-out;
- migration 12 additive добавляет nullable restrictive `threads.project_id` и
  stable `(project_id, updated_at, id)` index; existing Threads остаются
  projectless, failed migration откатывает schema/data и безопасно retry-ится;
- migration 13 append-only добавляет ownership immutability и Project Chat
  mode/Workspace integrity triggers; v12 databases получают hardening без
  переписывания уже применённой migration 12;
- migration 14 additive добавляет Chat retention policy/source/update и sourced
  user-activity basis. Existing rows backfill-ятся conservative Keep, а новые
  Project/projectless Chats получают один seven-day default;
- migration 15 additive добавляет recoverable Chat lifecycle/tombstone basis,
  audit и eligibility/Trash indexes. Existing rows остаются active; schema
  rollback/retry не переписывает migrations 1–14;
- migration 16 additive добавляет immutable diagnostic `reasoning_artifacts`
  с exact UTF-8 byte size/SHA-256 и UNIQUE source Message/Job. Terminal write
  атомарен с Message/Job; legacy `messages.thinking` не переписывается;
- migration 17 additive добавляет content-free
  `reasoning_artifact_deletion_audit` с UNIQUE Artifact identity;
- migration 18 additive добавляет nullable sourced Session leave basis,
  совместимый lifecycle reason и audit support для `session_left`; existing TTL
  Trash сохраняет legacy reason bytes, migration rollback/retry не меняет v17;
- migration 19 append-only валидирует уже применённые v18 rows и пересоздаёт
  lifecycle triggers так, чтобы Session Trash требовал exact explicit basis;
- migration 20 additive добавляет content-free Session Chat deletion audit;
- migration 21 additive добавляет canonical `quick_runs` с restrictive Project
  FK, immutable identity/operation/ownership и strict policy/source constraints;
- migration 22 additive добавляет canonical `recipes`/`recipe_revisions` с
  restrictive immutable ownership, normalized name, immutable canonical bytes,
  digest/size и current-revision guard;
- migration 23 additive добавляет private immutable `recipe_job_snapshots` с
  exact Recipe/revision/Project/Job ownership, queued initial event guards и
  canonical bytes/hash/size;
- migrations 24–25 additive добавляют non-destructive immutable
  `context_checkpoints` и запрещают direct deletion вне owning Thread cascade;
- migration 26 additive добавляет `artifact_blobs`/`artifacts`: server-derived
  content address, immutable exact metadata, restrictive Project/Job/parent
  references и explicit `keep`/`referenced`; generic GC не реализован;
- `store/quick-runs.ts` и `http/quick-runs-routes.ts` владеют exact Project/
  projectless create/list/read/PATCH metadata без Job/runtime/filesystem effects;
- `store/recipes.ts` и `http/recipes-routes.ts` владеют exact scoped identity,
  atomic revision 1, historical read, expected-revision CAS и rename отдельно от
  immutable configuration; `JobStore.createRecipeSnapshot` и те же routes
  атомарно материализуют exact revision в idempotent queued Job snapshot без
  execution owner либо Chat association;
- `store/reasoning-artifacts.ts` владеет active exact-Chat scoped list/read,
  integrity validation, current-parent effective expiry, stable bounded due
  scan и atomic recheck/delete/audit;
- `store/artifacts.ts` владеет generic server-only byte writer/read boundary.
  Temp hash/size, no-overwrite publish, prefix-directory identity и final
  content проверяются до SQLite commit; crash orphan не читается по Artifact ID
  и виден только через bounded inventory без cleanup claim;
- `store/chat-retention.ts` и `retention/service.ts` владеют Chat-only
  projection/PATCH, exact scoped idempotent Session leave, bounded TTL/Session
  eligibility, tombstone CAS, scoped Trash и Restore/Keep/TTL recovery;
  `retention/maintenance.ts` — один startup/periodic owner с injected clock,
  separate stable Chat/reasoning cursors, batch cap, coalescing и shutdown
  cleanup. Chat hard delete/blob GC отсутствуют;
- `projects/service.ts` и `store/projects.ts` владеют strict identity/
  presentation metadata, no-path create/rename, isolated idempotent appearance
  update и fail-closed compatibility mapping;
- `projects/chat-service.ts` и versioned nested Project Chat routes владеют
  immutable ownership create/list/read; queryless legacy Thread REST использует
  прежнюю projection, а projectless opt-in boundary versioned явно;
- `store/capability-override.ts` принимает только compatible exact identity,
  делает identical write идемпотентным без изменения timestamps, удаляет ровно
  одну row и fail-closed читает corrupted/incompatible row;
- `store/completion-probe.ts` принимает только compatible exact fingerprint,
  normalized outcome/timing и fail-closed читает corrupted/incompatible row;
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
  verified-green semantics для provider declaration; Installed profile отдельно
  объясняет side effect manual completion probe, подтверждает его dialog-ом и
  показывает queued/running/historical/result/error/cancel states; Marketplace
  отдельно даёт localized `Add from Ollama` preview/confirmation/progress/
  cancel/retry и truthful post-success Installed refresh; catalog cards требуют
  P2-E exact variant selection и показывают per-variant claim/fit/provenance/
  installation до того же confirmed pull lifecycle; P2-F добавляет accessible
  server-owned filters, applied summary и pairwise exact compare с abortable
  query/vanish/focus handling без resource side effects; P2-H хранит explicit
  page state, renders максимум 12 current rows, сохраняет две exact compare
  snapshots между pages и блокирует pager без cancel active pull;
- `features/chat` — creation, timeline, composer, UUID command key, durable Job
  discovery/reattach state и P1-J conflict decision. Queue сохраняет canonical
  command key; Stop использует только typed Runtime/public Job query/cancel;
  New Chat prewarm использует exact-context debounce и cleanup owner; P3-C
  добавляет sourced Project route/create/reload без Workspace read и synchronous
  repeated-activation guard; P3-D добавляет Chat Info retention modal с
  fail-closed identity, one-mutation Save/retry и sourced expiry; P3-E добавляет
  Project/projectless Trash list, focused load/Restore failures, stale-item
  suppression и explicit idempotent Restore без hard-delete claim; P3-F
  добавляет separate generated-answer/reasoning lists, exact expiry, copy/export
  и refresh после retention Save; P3-G добавляет versioned active cleanup
  projection, explicit reasoning refresh и empty state без потери answer; P3-H
  добавляет confirmation-only Session leave, pending/blocked/Trash states,
  scoped retry и truthful 24-hour recovery/no-hard-delete projection; P3-M
  добавляет visible non-destructive checkpoint, exact intent recovery и
  preserved-history/active-context separation;
- `features/quick-runs` — P3-J Project/projectless metadata create/list и direct
  Keep/7 days/Session control без Save conversion; UI явно показывает отсутствие
  execution, cleanup и Session enforcement;
- `features/recipes` — P3-L Project/projectless create, current revision
  provenance, rename, explicit revise/conflict и confirmed queued Job snapshot
  create/retry/hard-reload flow без execution/routing;
- `features/context` — context/cache и P3-M confirmation/error/retry surface;
- `features/attachments` — P3-O exact Project/projectless local attachment
  upload/list/download, visible storage policy и truthful no-model-consumption
  boundary;
- `features/agent` — workspace, approval и tool projections;
- `features/settings` — current settings.
- `test/component` — Vitest/jsdom P0-A/P0-B/P0-D/P0-E/P1-I/P1-J/P1-K и
  P2-C–P2-H/P3-A–P3-O projection, accessibility, conflict/prewarm races/idempotency,
  catalog pages/compare и fake timers;
- `test/browser` — Playwright Chromium full create/stream/reload, failure/reload
  и boundary smoke, включая P1-I active/queued/degraded/recovery/navigation и
  P1-J literal Queue/Stop/unsupported/failure и P1-K selection/debounce/cleanup/
  Chat-dispatch flows, P2-G NVIDIA, P2-H catalog paging, P3-C Project Chat и
  P3-D retention, P3-E scoped Trash/Restore, P3-F/P3-G reasoning Chat Info и
  P3-H explicit Session leave/recovery, P3-J Quick Run metadata, P3-L Recipe
  revisions/queued snapshots, P3-M context checkpoint и P3-O attachment
  retry/reload/download (current SQLite schema version 28),
  narrow viewport, 200% scaling, forced colors и reduced motion.
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
  reconciliation, redaction и AbortSignal; P2-D — strict local reference
  grammar, pure preview, exact confirmed target, validated terminal pull/
  progress/redaction/cancel и Marketplace one-intent/locale/focus/responsive/
  unmount regression; P2-E отдельно покрывает additive variant contract,
  fail-closed target derivation, exact installed tag, different/unknown fit,
  target snapshot, refresh truth и deterministic catalog selector Chromium flow;
  P2-F покрывает strict query/400, same-row facets, unknown/provenance semantics,
  abort/late response, loading/empty/error/retry/clear, exact compare/remove/
  swap/vanish, locale/focus/responsive/reduced-motion и no-side-effect boundary;
  P2-H — legacy/paged contract, 1,000+ stable pages, exact totals/out-of-range,
  cross-page compare, atomic page reset, active-pull pager block и bounded DOM/
  listener behavior в component, Chromium и benchmark fixtures.
- P2-J–P2-M держат Hugging Face отдельным от catalog/Installed. Search и exact
  selection используют только server-owned anonymous transport с timeout/byte/
  file/page bounds и AbortSignal. Selection перечитывает exact immutable commit
  с `blobs=true`, принимает путь только из complete well-formed inventory и не
  сохраняется. Host profile получает startup observation timestamp; calculated
  preview содержит source/time/estimated confidence и явно исключает KV cache и
  runtime overhead. Discovery/selection/download не вызывают Ollama pull/create/
  probe/Governor или catalog refresh. P2-L добавляет explicit exact-file
  POST+SSE download:
  server строит URL из validated tuple, принимает полный HTTP 200 через exact
  HTTPS/443 host allowlist, stream-ит bytes в generated managed staging,
  одновременно считает SHA-256 и проверяет bounded GGUF v2/v3 header. Операция
  connection-owned, не имеет reconnect/resume/Job/SQLite semantics; cancel и
  ошибка удаляют только доказанно owned partial. Его `completed` означает
  verified staging artifact, а не Installed/runtime-ready model. P2-M добавляет
  отдельный confirmed POST+SSE import только из process-owned artifact UUID в
  loopback Ollama: blob upload, strict files-map `/api/create`, exact tags
  reconciliation и существующий forced completion probe. Он не принимает
  path/Modelfile/options, не является Job/replay/resume и обновляет Installed/
  catalog только после terminal verified provenance.
- P2-N держит feature flags в одном server-owned typed registry. Compiled
  default-off declaration и exact operator env снимаются один раз при
  `AppContext` startup; `GET /api/feature-flags` публикует только strict
  versioned effective value/source/time/basis. SQLite setting, write API, Web
  override и network provider отсутствуют.
- P2-O читает этот flag через typed registry в отдельном strict
  `POST /api/runtime/estimated-parallel-admission`. Query revalidate-ит explicit
  active/queued pair, internal Ollama endpoint и exact-key calibration, сохраняет
  per-number provenance и возвращает только conservative estimated/unknown
  explanation. Он не меняет queue/lease/model lifecycle, не пишет SQLite, не
  добавляет Web consumer и оставляет Governor с одним permit.

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
6. Runtime probe запускайте только explicit action, с exact identity,
   Governor admission, bounded transport и content-free persistence.

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
