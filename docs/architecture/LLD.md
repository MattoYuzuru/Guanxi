# Low-level design

**Статус:** mixed — current implemented, target accepted/not implemented

**Проверено:** 2026-08-04

## Current package design

### `packages/contract`

Исходник: [lld-contract.mmd](diagrams/lld-contract.mmd).

- `schemas.ts`: models, hardware fit, health, threads/messages, settings,
  workspaces, tool calls, approvals и durable Job/event records;
- `api.ts`: route paths и request/response Zod;
- `events.ts`: Chat SSE union, Job lifecycle envelope и private Chat replay
  output;
- `index.ts`: public exports.

Current capability enum: completion, tools, vision, insert, thinking, embedding.
Current thread mode: chat или agent. Message содержит content/thinking/tools/usage
и P0-B bridge fields `turnStatus/turnError/stopReason`. P1-D добавляет optional
`jobId`, который связывает durable Job с user/assistant pair. P0-D добавляет
source/time health, catalog freshness, sampled running rows и stable
connect/load/stream-idle error categories.

P1-G добавляет typed additive `RuntimeSnapshot`: один `observedAt`, source health,
current Governor admission projection, nullable observed models и stable
reconciliation decisions. `models: []` означает successful empty sample;
`models: null` — controlled unavailable/incompatible source. Runtime digest
остаётся observed `/api/ps` fact, а artifact identity явно `unknown`.

P1-H additive добавляет `host` с отдельными static profile/dynamic sample,
provenance/confidence и explicit available/missing fields, а каждой runtime row
— `currentFit`. `observed` означает только текущую exact loaded configuration
при достаточных Apple host facts; это не future admission guarantee. Production
Apple adapter пока публикует current fit как `unknown`, потому что официальный
pressure/available-memory source не подтверждён.

P1-K additive расширяет Governor operation/priority contract значениями
`model_prewarm`/`prewarm`, сохраняя parser compatibility для прежнего
normal-only snapshot. Strict request/response schemas для
`POST /api/models/:name/prewarm` фиксируют exact digest, Chat context, fit
level/basis, short `2m` keep-alive и typed warmed/reused/skipped/cancelled reason.
Settings получает additive `prewarmEnabled`; отсутствие старого key означает
`true`.

P1-L additive добавляет `ModelObservationKey` version 1 и
`complete | unavailable(reason)` projection в Runtime model/decision. Legacy
snapshots default-ятся в `legacy_snapshot`/`unknown`; complete key обязан
соответствовать `artifactIdentity: exact_digest`. Key компоненты — `ollama`,
normalized exact reference, artifact digest, context, sourced Ollama version и
stable local Apple hardware fingerprint без private CPU/device strings.

P1-M additive добавляет `positiveSafeIntegerSchema`, sourced
`ModelContextLimit` и controlled `context_limit_exceeded`. Thread/settings/model
query/warm/prewarm boundaries принимают любой positive JavaScript safe integer,
но sourced declared maximum отклоняет запрос без clamp; absent/conflicting
provider declarations остаются unknown. Legacy model responses получают
additive unknown default. P2-B freshness также defaults в unknown. SQLite
migrations 7/8 используются только новыми evidence stores; старые clients их
игнорируют.

P2-A additive добавляет `InstalledModelDescriptor`: canonical/unknown Ollama
reference, exact/unknown artifact identity, installation observation и
source-preserving capability evidence. Legacy `LocalModel`/`ModelDetail`
ответы default-ятся в explicit unknown. Реализованы только provider states
`declared | degraded | unknown`; `verified/claimed/probe/override` остаются
target. Unknown enum не фильтруется в ложную пустую декларацию.

P2-C additive добавляет отдельный strict completion-probe contract, не меняя
legacy descriptor: request содержит literal `completion`, expected digest,
positive safe-integer context и optional force. Evidence различает
`verified | degraded | unknown | cancelled | skipped`, exact/unavailable basis,
source/confidence/timing и historical reuse. `verified` относится только к
versioned fixed probe, не повышает provider declaration и не означает semantic,
tool или media support.

P2-D additive добавляет strict Ollama reference preview/start schemas. Preview
возвращает только closed input kind, original safe display value и normalized
model name; start содержит original reference и exact confirmed name. Unknown
fields/future kind fail-closed. Progress/error/done использует существующий
additive `PullStreamEvent`, поэтому legacy clients и route schema не удалены.

P2-E additive расширяет catalog variant exact normalized name, claimed context,
calculated/unknown fit, exact installed/not-installed/unknown evidence и source
freshness/timestamps. Старый `{tag,sizeBytes,parameterSize}` row parse-ится с
non-installable legacy defaults. Top-level installed/fit остаются только явно
помеченными compatibility projections.

P2-F additive расширяет strict `listCatalogQuery`; его exact row semantics
сохраняются при последующем additive P2-H response metadata.
Facet groups принимают один deterministic CSV value без duplicates; repeated
keys, unknown fields, future enums и unsafe numeric shapes отклоняются. Claimed
context/size — positive safe integer либо explicit unknown, но не оба сразу.
Legacy `q/contextLength` получают пустые filter defaults.

P2-H additive расширяет query парой positive-safe `page + pageSize` и response
discriminated metadata `legacy | paged`. Partial pair, value выше page-size
policy 100, repeated/unknown/fractional/non-positive/unsafe input отклоняется до
source access. Paged metadata содержит requested page, applied page size, exact
model-row total/pages и nullable previous/next; zero и out-of-range page не
clamp-ятся. Optional metadata позволяет новому parser читать старые recorded
responses. Web default 12 и maximum 100 ограничивают одну page, не общий catalog.

P2-I additive добавляет `ModelCapabilityOverride` version 1 и два additive
descriptor поля: sourced/unknown `runtime` fingerprint и `overrides: []` с legacy
default. Override содержит literal source `user_override`, state `overridden`,
единственное positive value `present`, одну capability из существующего closed
enum, canonical reference, exact digest, sourced runtime version и
createdAt/updatedAt. Negative `unsupported`, confidence, free-form capability и
arbitrary note в этой версии отсутствуют, поэтому absence строки оставляет
capability в прежнем `declared | degraded | unknown` состоянии. Mutation body
несёт capability и expected digest/runtime version; typed outcome различает
`applied | cleared | absent | conflict`, а conflict по contract не может нести ни
identity, ни override.

P2-N добавляет `FeatureFlagProjection` version 1: closed boolean key,
`effectiveValue`, resolution `resolved | invalid | unavailable`, effective
source, observation time и versioned registry/declaration basis. Strict schema
отклоняет unknown key/state/source, future version, extra field и duplicate key.
Default не маскируется под operator choice: missing env публикует
`safe_default`, а invalid/unavailable operator source остаётся видимым reason,
но effective value fail-closed возвращается к declaration default.

P1-A добавил canonical Job states, terminal states, kind, safe structured
error/outcome metadata и persisted event envelope. P1-C добавил strict public
create/query/cancel/path/cursor schemas, Job route constants, response schemas и
typed Job SSE event data. P1-D добавил optional Chat idempotency key, immutable
input snapshot и private typed Chat output внутри Job event. Public caller не
передаёт storage scope или privacy classification.

### `packages/server`

Исходник: [lld-server.mmd](diagrams/lld-server.mmd).

- `app.ts`: Hono composition, health, routes, SPA;
- `context.ts`: Ollama client, stores, tools, approvals, один
  `ResourceGovernor` и один `ChatJobExecutionOwner`;
- `config/feature-flags.ts`: immutable process-start registry. Compiled
  declaration → exact `enabled | disabled` operator env override → redacted
  client projection; SQLite, network, localStorage и runtime side effects
  отсутствуют;
- `runtime/resource-governor.ts`: typed immutable request/ticket, один
  process-local permit, normal-before-prewarm admission, active lease, bounded
  live snapshot/explanation, unload guard и graceful close;
- `runtime/prewarm.ts`: bounded exact selection/residency validation,
  lowest-priority admission, exact-owner abort и short-TTL Ollama warm;
- `runtime/completion-probe.ts`: explicit fixed completion call, exact
  tags/version fingerprint, normal-priority admission, bounded transport,
  request cancel/deadline и before/after identity validation;
- `models/capability-override.ts`: exact installed identity ownership для user
  assertions — canonical reference normalization, один `/api/tags` match, exact
  digest, sourced `/api/version`, revalidation в точке mutation, typed
  conflict/redaction; никакого chat/pull/load/unload, Governor admission, probe,
  catalog refresh или background Job;
- `models/ollama-reference.ts`: pure strict model-name/official-page parser без
  DNS, fetch, Ollama, filesystem или persistence;
- `models/ollama-pull.ts`: validated progress, terminal-success requirement и
  redacted provider/protocol error projection;
- `runtime/observation-key.ts`: canonical exact-reference normalization,
  versioned hash components и typed unavailable reasons;
- `runtime/reconciliation.ts`: process-local shared `/api/ps`, `/api/tags`,
  `/api/version` + host telemetry single-flight, common timestamp linearization,
  exact artifact matching, independent source failure redaction, current fit
  explanation и compatibility projection;
- `http/runtime-routes.ts`: additive `GET /api/runtime` sampled query;
- `http/models-routes.ts`: list/show/pull/delete/explicit warm/prewarm/unload/
  running, P2-D reference preview/confirmed connection-owned pull и P2-I
  POST/DELETE `capability-overrides`, зарегистрированные до generic `/:name`,
  чтобы жадный name pattern не поглотил suffix;
- `http/threads-routes.ts`: CRUD, durable Chat command/compatibility SSE, stop,
  compact;
- `http/workspaces-routes.ts`: current filesystem workspace CRUD;
- `models/service.ts`: installed `/api/tags`, sampled `/api/ps`, sourced
  `/api/version`, digest-aware LRU на 64 normalized references и не более четырёх
  параллельных `/api/show` workers на installed-list projection;
- `models/catalog.ts`: validated stale local cache + dated bundled snapshot,
  strict exact P2-E variants/fit/installation и P2-F pure same-row facets без
  remote request или provenance mutation; P2-H global duplicate-target
  fail-closed, stable code-unit sort, exact count и legacy-full/paged slice с
  caller AbortSignal;
- `scripts/catalog-pagination-benchmark.ts`: synthetic 1,000-model/
  4,000-variant response diagnostic без live provider;
- `hardware/probe.ts` и `fit.ts`: legacy local profile/estimate и static fit;
- `hardware/telemetry.ts`: один injectable host boundary; bounded Apple Silicon
  `vm_stat` и Linux/CUDA fixed `nvidia-smi` adapters, pure strict parsers и
  explicit unsupported/partial/unavailable states;
- `agent/loop.ts`: ordered turn/tool loop;
- `store/db.ts`: `node:sqlite` migrations;
- migration 3: nullable Message terminal bridge с evidence-based legacy backfill;
- migration 4: additive `jobs`/`job_events`, scoped idempotency, per-Job sequence
  и unique terminal event constraint;
- migration 5: additive `messages.job_id`, private `chat_job_inputs` и optional
  classified private output в `job_events`;
- migration 6: additive exact-key `model_calibration_observations`; legacy
  `model_calibration` остаётся readable, но не участвует в measured fit;
- migration 7: additive `installed_model_evidence_cache` с safe normalized JSON,
  exact identity, original observation, validation/expiry/stale timestamps и
  no-backfill rollback compatibility;
- migration 8: additive `completion_probe_evidence` latest projection keyed by
  versioned exact fingerprint; no provider-declaration backfill, prompt или
  response content;
- migration 9: additive `model_capability_user_overrides` — одна latest row на
  exact `(provider, reference, digest, runtime version, capability)` с CHECK на
  key/schema version, provider, source, state, value и capability enum; никакого
  backfill из declaration или probe, rollback не удаляет user data;
- `store/capability-override.ts`: fail-closed exact key/timestamp validation,
  idempotent create без изменения timestamps, exact-row clear, deterministic
  capability order и `exactCapabilityOverrides` projection, которая при неполной
  identity или нечитаемой row не показывает ничего;
- `store/completion-probe.ts`: fail-closed exact key/timing/outcome validation и
  atomic latest-row upsert;
- `store/calibration.ts`: complete-key-only record и same-artifact/runtime/
  hardware context curve; changed identity получает отдельную row;
- `store/jobs.ts`: atomic create + initial event, ordered replay page, event
  sequence CAS, canonical non-terminal state + lifecycle event CAS и terminal
  state + event CAS;
- `jobs/lifecycle.ts`: exact non-terminal/terminal edges из canonical diagram;
- `jobs/service.ts`: application create/get/transition/append/terminal boundary и
  persisted-first `AsyncIterable` subscription с bounded SQLite pages, terminal
  close и canonical cancel operation;
- `jobs/chat-execution.ts`: process-local Chat Job owner, request fingerprint,
  canonical state progression, persisted output/chunking и cancellation
  acknowledgement;
- `jobs/chat-recovery.ts`: pre-listen recovery coordinator, stable keyset scan,
  recovery-only terminal edges и bounded latest-pending Message reducer;
- `http/jobs-routes.ts`: public create/query/replay/cancel boundary, server-owned
  idempotency scope, controlled error mapping и pull-based Job SSE;
- `store/threads.ts`: atomic pending-to-terminal compare-and-set и compaction
  boundary по persisted `seq`;
- `tools/*`: jail, filesystem и bash.

### Current installed-model fact inventory

| Fact/surface | Source и observation | Confidence/identity | Staleness/failure | Current consumer |
| --- | --- | --- | --- | --- |
| Installation/name/size/details/digest | local `/api/tags`, request completion time | observed installation; digest exact либо unknown | no persistent cache; route failure controlled | installed list, detail, fit, descriptor |
| Capability field | `/api/tags`, тот же installation sample | provider-declared; exact digest basis возможен | missing/malformed/future value → unknown | legacy capabilities и descriptor |
| Architecture/capability detail | local `/api/show`, first response time | provider-declared; exact cache write only after tags/version revalidation | LRU 64 + SQLite v7; 15m fresh, 7d stale/offline; four workers + per-key flight | context limit, fit, detail, descriptor |
| Loaded instance | local `/api/ps`, sampled time | observed runtime row; exact only through P1-L reconciliation | failure remains `models:null`; no history | Runtime Bar, fit/calibration |
| Runtime version | local `/api/version`, response time | observed runtime fingerprint либо unknown | request-scoped, failure independent | observation key и descriptor basis |
| NVIDIA device facts | fixed local `/usr/bin/nvidia-smi` query, common sample time | observed per-device index/name/total/free; UUID nullable | query-time only; partial/malformed/duplicate/command failure explicit | Runtime Bar only; no admission/key credit |
| Catalog variant claim | local stale cache or dated bundled snapshot + server normalizer | exact mutable target; size/context/fit remain claimed | malformed/duplicate target or unknown size fail closed; explicit stale/fallback | P2-E selector + P2-F facets/compare |
| Catalog page projection | same validated source/query snapshot, then stable sort/count/slice | exact matching model-row total for one request; page size is transport policy | no durable snapshot across requests; legacy full mode retained | P2-H Marketplace pager/benchmark |
| Legacy `capabilities` | filtered known `/api/tags` values | compatibility projection, not evidence decision | unknown/malformed → empty legacy array | old Web/clients |
| Context facts | `/api/tags`/`/api/show` declarations | declared maximum либо unknown/conflict | LRU time preserved; no guessed ceiling | settings/list/detail/validation |
| Canonical reference | P1-L normalizer over provider name | registry/name/tag/digest syntax preserved | invalid/duplicate → unknown/ambiguous | descriptor/cache/observation key |
| Web evidence projection | additive REST descriptor | declared/degraded/unknown + fresh/stale/offline/unknown | loading/empty/error remain separate | installed card/profile, locale keys |
| Completion probe | explicit fixed local Ollama chat call | verified only for exact reference/digest/runtime/context/probe v1 | no automatic run; historical exact reuse or bounded forced observation | installed profile + Runtime Bar operation |
| Manual Ollama reference | pure local name/page parser, then local `/api/pull` | normalized target only; no availability/digest/capability claim | pull connection-owned; success rechecks Installed via `/api/tags` | Marketplace Add from Ollama |
| User capability assertion | explicit user action, revalidated `/api/tags` + `/api/version` at the mutation point | `overridden/user_override`, positive `present` only, bound to exact reference/digest/runtime version | SQLite v9 survives restart; drifted identity gives conflict and stays hidden from the current descriptor | installed profile region + safe JSON export |

`/api/tags` и `/api/show` declaration не являются runtime proof. Name-based
`/api/show` lookup не выполняется для duplicate normalized references; даже при
одной row transient detail declaration имеет `detail_not_bound_to_digest`.
P2-B exact cached projection получает digest basis только после bounded
before/after validation; identity change не пишет row. Store принимает только
allowlisted capability/context/architecture values. P2-C хранит отдельно только
latest normalized completion outcome для exact probe key; raw provider text,
prompt, reasoning, endpoint/path и credentials не сохраняются. Full history,
generic registry service и semantic/tool/media probes не реализованы.
P2-D preview/target не становится installation/capability fact: до отдельного
`/api/tags` refresh он не доказывает installation или digest и нигде не
persist-ится.
P2-E catalog variant переиспользует этот pull target, но не меняет evidence
семантику. Exact tag installation определяется только one-to-one normalized
`/api/tags` match; соседний tag не наследует family installed. Claimed size fit,
source observation/fetch time и installation observation показываются отдельно.
P2-F сначала получает эти exact rows, затем одним predicate применяет
installation/fit/context/size к каждой row; model-level scope/source/freshness/
capability не смешиваются с variant facts. Empty capabilities — unknown, не
unsupported. Результат сохраняет исходные timestamps и compatibility fields.
P2-H до filtering/count/slice помечает duplicate canonical targets во всём
logical source snapshot как ambiguous, затем применяет locale-independent stable
order. Explicit page возвращает exact metadata; legacy request возвращает весь
filtered list. Между requests source snapshot не pin-ится и total не считается
durable catalog fact.

P2-I user assertion не участвует в этой evidence-цепочке и не меняет ни одну её
строку: она хранится отдельной row, читается только для exact
reference+digest+runtime version и проецируется отдельным descriptor полем.
Mutation принимает expected digest и expected runtime version от caller, поэтому
stale client expectation, ambiguous или пропавшая installation, отсутствующий
digest и недоступный `/api/version` дают controlled conflict вместо записи по
имени. Provider failure не маскируется существующей row: capability evidence
остаётся degraded/unknown, а assertion показывается рядом. Absence row —
по-прежнему unknown, не unsupported.

`ChatJobExecutionOwner` ограничивает один active Chat Job на thread и владеет
Stop controller, включая ожидающий Job. `activeTurns` остаётся compatibility
mirror, но routes не используют его как lifecycle owner. Application-wide
exclusion принадлежит одному `context.governor`. Его lease используют Chat,
compaction, explicit model warm/load и automatic prewarm; unload отклоняется при
exact active lease и консервативно при любом другом active single-lane owner.
Normal intent отменяет queued prewarm либо вызывает abort hook только exact
active prewarm owner и ждёт release. Prewarm не допускается при normal work и не
abort-ит normal owner. Tickets, leases, `ApprovalGate` и controllers не durable.

Один `RuntimeReconciliationService` входит в application context рядом с
Governor. `GET /api/runtime` и `GET /api/models/running` используют этот service,
поэтому overlapping callers создают не больше одного `/api/ps` request и одного
host probe. Caller abort прекращает только его ожидание. Provider и host sample
стартуют вместе; после завершения обоих выбирается общий `observedAt` и
синхронно снимается Governor snapshot — это linearization point. Ошибка одного
source не уничтожает факты другого. Completed result не кэшируется; stale state
не публикуется, следующий call делает новые samples.

P2-G выбирает NVIDIA adapter только для local `linux` + detected `cuda` legacy
profile. Fixed query не использует shell/PATH/user args и ограничен 1 s/64 KiB.
Parser не имеет device-count ceiling, конвертирует integer MiB в safe bytes,
сохраняет usable rows при malformed subset и fail-closed отклоняет duplicate
index/UUID. Linux observation key/current fit остаются unavailable/unknown:
device sample не связывает `/api/ps` allocation с GPU и free VRAM не является
safe capacity.

Один `JobStore`, `JobService` и `ChatJobExecutionOwner` входят в application
context; public Job и Chat routes используют один service. Store синхронно
сериализует writers через SQLite `BEGIN IMMEDIATE`; Job create и terminalization
откатываются целиком, если event insert не состоялся; то же верно для
non-terminal transition, включая `startedAt`. Первый успешный выход из `queued`
задаёт `startedAt`, поздние transitions его сохраняют. Одинаковая пара
`idempotency_scope/idempotency_key` возвращает canonical Job. Event metadata
ограничена плоскими JSON scalars и не предназначена для prompt, reasoning,
secrets или workspace content.

Chat create расширяет эту границу: одна transaction создаёт Job/initial event,
user/pending-assistant pair и immutable private input association. Server-owned
scope содержит thread ID; SHA-256 fingerprint связывает key с canonical input.
Duplicate возвращает ту же association, а conflicting input не пишет ничего.
Private Chat output хранится отдельно от safe metadata и читается только через
typed `privacyClassification: private_chat` boundary.

`JobService` проверяет terminal edge до store CAS. Subscription регистрирует
process-local wake-up до replay, но всегда отдаёт сами events из SQLite по
sequence. Wake-ups coalesced, поэтому slow subscriber не блокирует writer и не
накапливает unbounded event queue; AbortSignal удаляет только listener.

Job HTTP handler валидирует UUID и decimal safe-integer cursor до subscription.
`after` и `Last-Event-ID` могут совпадать, но conflict даёт `400`. Каждый SSE
frame получает `id`, равный persisted sequence, и полный `jobStreamEventSchema` в
`data` с additive private output. `ReadableStream.pull` ограничивает буфер одним
frame. Terminal replay
закрывает stream, включая reattach после terminal tail; cancel/disconnect stream
не вызывает Job cancel command.

Public create всегда использует `local-api:v1`: duplicate key возвращает тот же
Job без второго initial event. Public cancel reason ограничена
`user_requested`. Queued cancel фиксирует `cancelling → cancelled`; active Job
остаётся `cancelling` до execution-owner acknowledgement. P1-D Chat owner такое
acknowledgement выполняет; generic Job без adapter остаётся `cancelling`.
Terminal и уже cancelling ответы идемпотентны.

Chat owner persist-ит output event до wake-up, делит UTF-8 delta на chunks не
больше 16 KiB и не держит in-memory output queue. Terminal Chat transaction
одновременно обновляет pending assistant, Job и terminal event/output. Stop из
thread route и cancel из Job route сходятся в owner; `cancelling` фиксируется до
abort, а `cancelled` — после его подтверждения. Subscriber abort owner не
останавливает.

### `packages/web`

Исходник: [lld-web.mmd](diagrams/lld-web.mmd).

- `App.tsx`: application health gate, degraded Ollama notice, persistent sampled
  Runtime Bar и Models/Chat/Settings shell;
- `components/ErrorBoundary.tsx`: root, keyed Chat и Runtime containment с diagnostics;
- `lib/router.tsx`: custom History API routing;
- `lib/api.ts`: REST, compatibility POST/SSE и canonical Job GET/GET SSE/cancel;
- `lib/sse.ts`: frame parser с Chat `seq` и Job `sequence` cursor;
- `lib/locale.ts`: locale keys для boundary с English fallback/Russian;
- `features/health/RuntimeContext.tsx`: один persistent shell owner shared
  Runtime projection;
- `features/health/RuntimeStatus.tsx`: typed read-only lease/FIFO/runtime-model/
  host/current-fit projection с compact disclosure и feature containment; P2-G
  группирует все NVIDIA devices в contained scroll, redacts UUID и сохраняет
  per-device source/time/confidence без aggregate capacity claim;
- `features/health/useRuntimePolling.ts`: один abortable HTTP wait, один timer,
  active/queued 2 s, idle 10 s, hidden pause, visible refresh без overlap и
  caller-scoped fresh wait без abort shared request;
- `features/chat/useChat.ts`: page projection, caller-supplied per-send UUID key,
  HTTP command acceptance и durable Job discovery/reattach;
- `features/chat/useModelPrewarm.ts`: exact-selection debounce, visibility/
  setting/normal-work cleanup и caller-owned bounded prewarm request;
- `features/chat/ResourceConflictDecision.tsx`: sampled conflict state machine,
  safe Queue default, exact Job revalidation/cancel/terminal acknowledgement,
  bounded own reads и localized accessible dialog;
- `features/chat/streamBuffer.ts`: rAF-buffered content/thinking;
- `features/chat/ChatPage.tsx`: create, timeline, composer, context/tool UI и
  one-intent conflict dispatch boundary с exact custom context validation;
- `features/launcher`/`models`: installed/catalog/profile, preset suggestions,
  keyboard custom context, sourced maximum/unknown explanation и P2-A installed
  evidence state/source/time; P2-C manual completion confirmation/status/cancel
  и historical projection; P2-D Marketplace `AddFromOllama` с explicit local
  preview, confirmation, one-intent pull, progress/cancel/retry и Installed
  refresh без auto-probe/capability promotion; P2-E `CatalogVariantInstall`
  требует exact row selection, показывает variant claim/fit/provenance и
  фиксирует target до terminal refresh; P2-F `CatalogFilters` формирует
  debounced/abortable strict query, а `CatalogCompare` хранит максимум две unique
  exact rows, удаляет vanished target и восстанавливает focus после close/remove;
  P2-H Launcher владеет explicit page/query basis, current-page projection и
  constant Previous/Next pager; две exact row snapshots переживают простой page
  change, accepted query/source basis invalidates их, а active pull блокирует
  navigation без cancel; P2-I `CapabilityOverrides` живёт только в Installed
  profile, отдельным labelled регионом от provider evidence и probe: explicit
  add/remove с confirmation и one-intent guard, exact identity в подтверждении,
  typed conflict states с reload только для identity drift и deterministic safe
  Copy/Download JSON;
- `features/context`: usage, cache, speed и compact;
- `features/agent`: workspace/approval/tool cards;
- `features/settings`: runtime/tool/theme fields и exact positive safe-integer
  default agent context без UI maximum.
- `test/component` и `test/browser`: P0-A cleanup/boundary/first-stream, P0-B
  terminal/error/reload, P0-D health, P1-I Runtime Bar/polling и P1-J
  conflict/TOCTOU/idempotency/accessibility, P1-K debounce/cleanup/priority и
  P1-M no-artificial-caps/P2-A descriptor/P2-C probe/P2-D confirmed pull/P2-E
  variant-first/P2-F facets-compare/P2-I capability-override regression; browser
  использует deterministic
  mocked REST/SSE/runtime snapshots. P2-H добавляет 1,000+ server rows, bounded
  12-row jsdom/Chromium projection, exact page state/cross-page compare и
  listener/pull ownership regression.

### `packages/cli`

Исходник: [lld-cli.mmd](diagrams/lld-cli.mmd).

CLI parses port/host/no-open, проверяет existing health, запускает server в
foreground и открывает browser. Durable service lifecycle/TUI/API client нет.

## Current sequence и Governor limits

1. Chat command атомарно создаёт queued Job, initial event, private input и
   Message pair до начала execution.
2. Application owner резервирует per-thread controller, переводит Job в
   `reserving` и ждёт typed process-local lease; Chat, compaction и explicit
   model warm/load выполняются в normal FIFO, а auto prewarm — в lowest-priority
   lane того же permit.
3. Lifecycle и private output persist-first; HTTP subscribers читают SQLite по
   sequence и не владеют execution.
4. Client crash/navigation только disconnect-ит subscriber; remount/hard reload
   находит Job по pending Message и replay-ит его с sequence 0.
5. Provider error и EOF без terminal chunk сохраняются как `failed`; partial
   content/thinking остаются в atomic terminal Message/Job projection.
6. Explicit Stop/cancel сначала сохраняет `cancelling`, затем единственный
   cancelled terminal outcome; disconnect не является cancel.
7. Connect заканчивается при response headers; load ждёт первый валидный stream
   event или non-stream model response; idle обновляется каждым валидным event.
8. Timeout сохраняет точный safe error, а explicit Stop остаётся authoritative
   cancellation; lease освобождается в обоих случаях.

`OllamaClient` пробрасывает signal abort для cancellation classification и
оборачивает прочие ошибки чтения body как provider failure. Если terminal
rehydrate падает, `useChat` сохраняет live partial buffer в idle state с явной
неподтверждённой меткой и accessible alert.

Migration 3 оставляет старые rows без usage в `NULL`, а usage-backed rows
backfill-ит как `completed/legacy_terminal_chunk`. Terminal update меняет только
`pending`, поэтому повторный late completion не перезаписывает failure/cancel.
Если запись terminal state падает, completed SSE не отправляется; `pending`
остаётся наблюдаемым recovery state.

P0-A по-прежнему отвечает за безопасный effect и root/Chat Error Boundaries.
P1-F lease освобождается после terminal/error/abort/generator return. Повторная
compaction выбирает prefix после admission и использует реальный persisted
`seq`. P0-D добавляет sampled `/api/ps` projection, но не ownership, lease или
доказательство unload между observations.

P1-D отделяет Chat execution от POST/SSE connection и подключает Message bridge
к durable Job records/replay/cancel. Generic public create без Chat adapter
остаётся `queued`. P1-E сканирует только durable Chat associations после SQLite
migration и до listen. `reserving/loading/prefill/thinking/generating/
waiting_tool/waiting_approval/finalizing` получают recovery-only
`interrupted`, `cancelling` — `cancelled`; untouched `queued` schedule-ится
существующим owner после полного reconciliation pass.

P1-G/P1-H сохраняют консервативный P1-F Governor, но добавляют sampled
reconciliation, host facts и explanation, не admission automation. Active lease
сопоставляется только с первой row по exact normalized Ollama reference;
ambiguous duplicates оставляют current fit unknown. Отсутствие lease digest не доказывает
artifact identity. Unmatched row получает owner `unknown`, active lease без row
— `active_not_observed`. Само observation state не запускает load/unload и не
меняет admission. Production pressure/available-memory observation, durable
observation keys/history, lease journal, measured parallelism и multi-process
lock отсутствуют.

P2-G расширяет только host projection: Linux/CUDA sample может быть available,
partial или unavailable и содержит per-device VRAM facts. Он не меняет
Governor, observation key, current-fit calculation, `/api/ps` ownership либо
model lifecycle.

P1-I заменяет Web compatibility projection `/api/models/running` на typed
`api.runtimeSnapshot()`. Persistent shell component показывает только один live
lease, FIFO waiters, sampled models, independent Ollama/host states и
observed/unknown current fit; это не durable Jobs history и не admission owner.
Refresh не очищает confirmed sample. Navigation/unmount отменяет только текущий
HTTP wait; resource action не вызывается. Compatibility route и contract
остаются для старых clients.

P1-J сохраняет один poller в `RuntimeProvider`; on-demand `refresh(..., true)`
либо делит pending request, либо после него делает один новый sample. Abort
dialog caller прекращает только его wait. Composer создаёт intent UUID до
проверки и повторно использует его при explicit Queue retry. Exact Stop делает
fresh Runtime verify, `GET Job`, не более одного `POST cancel`, bounded terminal
poll и затем не более одного Chat POST. Stale/operation/unknown/changed owner не
отменяется. Серверный Governor остаётся единственным admission/FIFO owner.

P1-K New Chat вычисляет exact operation context до model query, поэтому fit и
prewarm request относятся к одному context. `useModelPrewarm` ждёт 600 ms
стабильного Chat selection, требует exact installed digest и green/yellow fit,
не запускается hidden/disabled/normal-busy и очищает timer/controller на
selection, mode, visibility или route change. Server заново проверяет installed
facts, setting, sampled runtime и Governor в точке admission. Exact один
resident name+digest+context даёт reuse без Ollama call; ambiguous identity —
skip. Bounded warm использует `2m` и не меняет explicit warm response/`10m`.
Runtime Bar показывает operation/priority как process operation; P1-J игнорирует
prewarm-only conflict и никогда не предлагает из-за него Stop current Job.

Current admission request фиксирует owner (`jobId` либо process-local operation
ID), `chat | compaction | model_warm | model_prewarm | model_probe`, exact Ollama
model name, requested context, priority `normal | prewarm` и enqueue time. Probe
использует normal priority и поэтому не обходит active/queued normal work. Ticket проходит
`queued → active → released` либо `queued → cancelled`; release/cancel/close
идемпотентны. Snapshot хранит
только live queue, одну active lease и одну последнюю decision, поэтому
diagnostics не растут с числом завершённых operations. P1-L сохраняет только
один pending reconciliation Promise, но exact calibration samples пишет через
migration 6. Legacy rows не backfill-ятся, потому что digest/runtime/hardware
для них недоказуемы. Rollback code может перестать читать новую table, а schema
и rows остаются forward-compatible; failed migration transaction сохраняет
`user_version=5`, после устранения conflicting schema повторный open применяет
её заново. Тот же invariant доказан для migrations 7/8: failure сохраняет
предыдущие версии 6/7. Lease journal, durable runtime sample history и
client-side resource lock не вводились.

## Target module boundaries

### Application command/query API

Первые четыре Job routes ниже implemented в P1-C; `GET /api/runtime` implemented
в P1-G. Current P1-K route — `POST /api/models/:name/prewarm`; target
`/api/runtime/models/:id/prewarm` ниже остаётся proposed и не является alias.
Current P2-C route — `POST /api/models/:name/probes/completion`; generic target
`/api/capabilities/:fingerprint/probes` ниже остаётся proposed. Current P2-D
routes — `POST /api/models/imports/ollama-reference/preview` и connection-owned
`POST /api/models/imports/ollama-reference/start`; proposed generic single route
ниже не является alias или durable Job. Остальные route names остаются proposed
до соответствующего ADR/API review.

```text
POST /api/jobs
GET  /api/jobs/:jobId
GET  /api/jobs/:jobId/events?after=:sequence
POST /api/jobs/:jobId/cancel
POST /api/jobs/:jobId/approvals/:approvalId

GET  /api/runtime
GET  /api/runtime/models
POST /api/runtime/models/:id/prewarm
POST /api/runtime/models/:id/unload

GET  /api/models/installed
GET  /api/marketplace
GET  /api/capabilities/:fingerprint
POST /api/capabilities/:fingerprint/probes

CRUD /api/projects
CRUD /api/chats
CRUD /api/recipes
GET  /api/artifacts/:id

POST /api/models/imports/ollama-reference
POST /api/models/imports/hugging-face
GET  /api/models/imports/:jobId

GET  /api/service
POST /api/service/restart
GET  /api/notifications
POST /api/notifications/:id/read
```

Create Job принимает:

```ts
type CreateJobCommand = {
  idempotencyKey: string;
  kind: "inference" | "agent" | "tool" | "pipeline";
  operation: string;
  projectId?: string;
  chatId?: string;
  recipeId?: string;
  modelSelection: ModelSelection;
  inputs: ArtifactInput[];
  parameters: Record<string, unknown>;
  retention: RetentionPolicy;
  notificationPolicy?: NotificationPolicy;
};
```

Response `202` возвращает Job projection и event subscription URL. Validation
ошибка — до создания Job; runtime/admission ошибка — terminal Job с events.

### Job Engine

```ts
interface JobService {
  create(command: CreateJobCommand): Promise<Job>;
  get(jobId: string): Promise<Job>;
  cancel(jobId: string, reason?: string): Promise<Job>;
  approve(jobId: string, approval: ApprovalDecision): Promise<void>;
  recover(): Promise<RecoveryReport>;
}

interface JobEventStore {
  append(
    jobId: string,
    expectedNextSequence: number,
    event: NewJobEvent,
  ): Promise<JobEvent>;
  read(
    jobId: string,
    afterSequence: number,
    limit: number,
  ): Promise<JobEvent[]>;
  subscribe(
    jobId: string,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<JobEvent>;
}
```

Правило: event сначала durable, затем broadcast. Slow subscriber не блокирует
execution; он получает replay по sequence.

### Scheduler и Resource Governor

```ts
interface ResourceGovernor {
  enqueue(request: AdmissionRequest): Promise<AdmissionTicket>;
  acquire(ticket: AdmissionTicket, signal: AbortSignal): Promise<ResourceLease>;
  release(leaseId: string): Promise<void>;
  reconcile(): Promise<RuntimeSnapshot>;
  explain(ticketId: string): Promise<AdmissionExplanation>;
}

type AdmissionRequest = {
  jobId: string;
  model: ModelFingerprint;
  contextLength: number;
  parallelism: number;
  priority: "interactive" | "normal" | "background" | "prewarm";
  resourceHints: ResourceHints;
};
```

First implementation — single in-process scheduler. DB хранит Job/queue intent;
lease heartbeat/journal помогает recovery. Distributed locking не вводится.

### Capability Registry

```ts
interface CapabilityRegistry {
  describe(model: ModelFingerprint): Promise<ModelDescriptor>;
  addEvidence(evidence: CapabilityEvidence): Promise<void>;
  resolveOperation(
    model: ModelFingerprint,
    operation: string,
  ): Promise<OperationResolution>;
  invalidate(predicate: FingerprintPredicate): Promise<number>;
}
```

Resolution содержит `supported | degraded | unknown | unsupported`, evidence и
adapter candidates. `unknown` может предложить controlled probe, но не запускает
heavy load во время active Job.

### Adapter Registry

```ts
interface TaskAdapter {
  readonly id: string;
  readonly version: string;
  supports(descriptor: ModelDescriptor, operation: string): SupportDecision;
  validate(command: CreateJobCommand): ValidationResult;
  estimate(command: CreateJobCommand): ResourceHints;
  execute(context: AdapterExecutionContext): AsyncIterable<AdapterEvent>;
}
```

Adapter не пишет UI/DB напрямую. Он получает abort, lease, immutable Job snapshot
и artifact writer. Event mapper нормализует provider stream.

Первая последовательность adapters:

1. Ollama chat/completion/thinking/tools;
2. transcription как extensibility proof;
3. TTS/vision/OCR/image только с реальным provider contract;
4. generic JSON-Schema adapter.

### Catalog providers

```ts
interface CatalogProvider {
  readonly id: string;
  search(query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage>;
  resolve(
    reference: ModelReference,
    signal: AbortSignal,
  ): Promise<CatalogModel>;
}
```

Provider обязан сообщить legal/automation policy, source URL, fetchedAt, TTL,
schema version и pagination. Aggregator:

- применяет timeout/AbortSignal;
- ограничивает concurrency;
- валидирует данные;
- дедуплицирует, не теряя provenance;
- отдаёт stale cache при сбое;
- никогда не блокирует installed list.

Ollama Marketplace provider не scrape-ит human HTML.

#### Ollama reference import

Input принимает только:

- canonical model name;
- URL официальной model page, из которого parser локально извлекает canonical
  name.

Server не fetch-ит произвольный URL. После preview/confirmation Job вызывает
documented local pull. Это target durable pipeline: current P2-D выполняет
connection-owned POST+SSE wait без Job/replay/resume и не создаёт recent catalog
entry. После terminal success только `/api/tags` даёт installed/digest fact.

#### Hugging Face GGUF import

```ts
type HuggingFaceImportRequest = {
  artifactId: string;
  targetModelName: string;
  contextLength: number;
};
```

Pipeline:

1. resolve official HF metadata;
2. validate immutable revision и exact file;
3. dry-run size/cache/fit;
4. show license/gated status;
5. bounded restart-from-zero download в managed staging;
6. checksum и GGUF format inspection;
7. upload the exact verified inode to `/api/blobs/sha256:<digest>`;
8. create through `/api/create` with `{ model, files, stream: true }`;
9. observe exact `/api/tags` identity and run the existing forced probe;
10. remove the exact owned staging inode only after verified provenance.

Path не принимается напрямую от remote metadata. Gated token хранится в protected
secret adapter и не попадает в Job Events.

P2-L (2026-08-09) реализовал шаг 1 и bounded часть шагов 2–6
как отдельный provider. Strict selection contract принимает только published
repository identity, lowercase 40-hex commit, exact safe GGUF path и context;
server перечитывает `/api/models/{repo}/revision/{commit}?blobs=true` через ту же
anonymous bounded transport boundary и подтверждает complete well-formed file
inventory. Truncated/malformed/foreign inventory, mutable/changed revision и
unsupported/unknown repository fail-closed. Размер остаётся provider claim;
fit использует только этот размер, исключает KV/runtime overhead, содержит
hardware source/observedAt/confidence и становится unknown при отсутствии размера
или usable capacity.

Шаги 5–6 реализованы отдельным strict POST+SSE contract. Server заново
подтверждает exact target, строит resolve URL по сегментам, следует только exact
documented HTTPS/443 hosts, принимает только full 200 и stream-ит в generated
managed staging с timeout/maximum-byte/size bounds. SHA-256 различает matched
LFS claim и locally observed-only digest; GGUF inspection ограничена magic и
version 2/3. Cancel/error удаляет только owned partial, duplicate exact target
имеет один process-local writer, а restart/reload не resume-ит операцию.

Current state (P2-M, 2026-08-09): шаги 7–10 реализованы отдельным strict
POST+SSE command. Web передаёт только artifact UUID, target reference и exact
positive context. Server разрешает UUID через process-local P2-L registry,
проверяет managed root/path/inode/size/SHA-256/GGUF, запрещает remote Ollama и
делает два no-overwrite `/api/tags` sample. Adapter сначала проверяет/загружает
SHA-256 blob, затем отправляет только documented files-map body в `/api/create`;
ordered progress, terminal, frame count/bytes и connect/idle/overall deadlines
строго валидируются. Create terminal не равен Installation: success требует
одну exact target/digest observation и свежий non-historical controlled probe с
тем же reference/digest/runtime/context.

Import connection/process-owned: нет Job, SQLite, replay или resume. Один
artifact и target имеют по одному process-local owner. После пересечения create
boundary retry только reconciliate-ит/probe-ит и никогда не вызывает второй
create. Clean cancel возможен только до create; поздний abort даёт conflict или
unknown outcome. Success удаляет только exact owned staging inode после
валидации terminal provenance; остальные terminal edges сохраняют staging.
Restart забывает registry/attempt state, поэтому orphan staging не становится
автоматически importable. Token/gated acceptance по-прежнему не реализованы.

### Artifact Service

```ts
interface ArtifactWriter {
  begin(metadata: ArtifactDraft): Promise<ArtifactSink>;
  commit(sinkId: string): Promise<Artifact>;
  abort(sinkId: string): Promise<void>;
}
```

Blob пишется во временный файл, хэшируется и atomically перемещается. DB row
создаётся/финализируется после blob commit. Download проходит через validated
artifact id, а не произвольный filesystem path.

### Integration Policy

```ts
type Effect = "read" | "write" | "execute" | "network" | "secret";
type Scope = "global" | "project" | "recipe" | "job";

interface PolicyService {
  resolve(
    subject: IntegrationSubject,
    context: PolicyContext,
  ): Promise<EffectivePolicy>;
  decide(
    request: EffectRequest,
    decision: UserDecision,
  ): Promise<PolicyDecision>;
}
```

Approval имеет durable status, scope, requester, input digest, preview, decision,
time и executor result. Изменившийся input digest требует нового approval.

### First-party Agent Engine

Компоненты: [lld-agent-target.mmd](diagrams/lld-agent-target.mmd).

```ts
type AgentApprovalMode = "manual" | "auto_within_policy";

interface AgentEngine {
  start(command: StartAgentRunCommand): Promise<Job>;
  resume(checkpointId: string, overrides: RunOverrides): Promise<Job>;
  compact(runId: string): Promise<Artifact>;
  verify(runId: string, gate: VerificationGate): Promise<VerificationResult>;
}
```

Agent step сохраняет expected plan/checkpoint version до tool dispatch. Mutating
tool получает idempotency/effect record; после crash recovery effect не
повторяется без подтверждённого result.

Auto mode проверяет immutable policy snapshot на каждом tool call. Подключение
нового MCP/Skill создаёт новое user decision и snapshot version.

### Retention и Maintenance

Lifecycle: [retention-state.mmd](diagrams/retention-state.mmd).

Chat/Quick Run metadata:

```ts
type RetentionPolicy =
  | { mode: "keep" }
  | {
      mode: "ttl";
      expiresAt: string;
      refreshOn: "user_activity";
    }
  | { mode: "session"; sessionId: string };
```

Новый Chat всегда создаётся с TTL семь дней от последней user activity, включая
Chat внутри Project. `Keep` задаётся только явным изменением policy.

Нужны indexes по `expires_at`, `deleted_at` и live references. Maintenance Job
работает bounded batches:

```text
eligible → tombstoned → trash grace → metadata delete → orphan blob GC
```

User activity обновляет TTL; model/tool/maintenance/background events — нет.
Уход пользователя из Session Chat делает его eligible после terminal state
связанной Job; reload/reconnect не считаются уходом. Active/non-terminal Job
блокирует tombstone. Session Trash grace равен 24 часам. Policy change до hard
delete снимает tombstone.

Reasoning Artifact получает default `expires_at = created_at + 7 days`; shorter
parent retention wins.

### Notifications

Terminal Job transaction создаёт deduplicated notification row:

```ts
type Notification = {
  id: string;
  jobId: string;
  outcome: "completed" | "failed" | "cancelled" | "interrupted";
  policy: "off" | "when_background" | "always";
  createdAt: string;
  readAt?: string;
};
```

Client-local delivery state отдельно отмечает visual/sound channel. Повторный
SSE/reload не воспроизводит sound второй раз. Notification payload не содержит
prompt, reasoning или output content.

## Persistence status

Migrations 4–5 и `JobStore` реализуют `jobs`, `job_events`, private
`chat_job_inputs` и additive Message association. Остальные target tables ниже
не реализованы. Legacy `threads/messages/workspaces` сохранены без destructive
backfill или route cutover.

Логические таблицы:

| Table                   | Назначение                                        |
| ----------------------- | ------------------------------------------------- |
| `projects`              | project metadata/defaults                         |
| `chats`                 | persistent conversations                          |
| `chat_entries`          | user/assistant/artifact references и status       |
| `recipes`               | versioned reusable config                         |
| `jobs`                  | lifecycle, snapshot, idempotency, terminal result |
| `job_events`            | append-only replay sequence                       |
| `job_dependencies`      | pipeline DAG                                      |
| `artifacts`             | type/checksum/storage/derivation                  |
| `model_variants`        | provider/digest/quantization metadata             |
| `capability_evidence`   | provenance/confidence/fingerprint                 |
| `resource_observations` | measured memory/load/runtime                      |
| `resource_leases`       | recovery journal                                  |
| `integrations`          | MCP/skill/tool metadata without exposed secret    |
| `bindings`              | scoped enablement/policy                          |
| `approvals`             | durable effect decision                           |
| `notifications`         | terminal Job notification/read state              |
| `maintenance_runs`      | cleanup cursor/count/error evidence               |
| `service_state`         | install/schema metadata, не PID source of truth   |

Current `threads/messages/workspaces` нельзя просто удалить:

1. добавляются nullable `job_id`, status/error fields либо projection bridge;
2. new Job flow dual-reads existing history;
3. Workspace становится filesystem binding;
4. backfill выполняется bounded и restart-safe;
5. legacy routes сохраняются до client cutover;
6. cleanup — отдельная поздняя migration.

## Job state and transitions

Canonical diagram: [job-state.mmd](diagrams/job-state.mmd).

Terminal states: `completed`, `failed`, `cancelled`, `interrupted`.
`waiting_approval` не держит accelerator lease, если adapter может безопасно
checkpoint/release; иначе имеет timeout и явную resource cost.

`interrupted` не является обычной runtime failure edge. Current P1-E разрешает
её только recovery coordinator из `reserving/loading/prefill/thinking/
generating/waiting_tool/waiting_approval/finalizing`; обычный
`JobService.terminalize` эти edges отклоняет. Persisted `cancelling` остаётся
отдельной принятой user command и завершается как `cancelled`.

Недопустимо:

- `completed → running`;
- две terminal events;
- output success без terminal event;
- автоматический retry mutating tool;
- replay create command вместо reattach.

## Error taxonomy

| Category              | Пример                           | Retry                  |
| --------------------- | -------------------------------- | ---------------------- |
| `validation`          | input/schema/capability mismatch | после user change      |
| `admission`           | queue full/policy denied         | policy-dependent       |
| `resource`            | measured insufficient memory     | другой variant/context |
| `runtime_unavailable` | Ollama offline                   | bounded/background     |
| `runtime_protocol`    | EOF without terminal chunk       | bounded if safe        |
| `cancelled`           | user/preemption/shutdown         | explicit new Job       |
| `tool_denied`         | approval denied                  | workflow-dependent     |
| `tool_failed`         | executable/file/network failure  | effect-aware           |
| `storage`             | DB/blob commit failure           | recovery path          |
| `client_projection`   | React render/crash               | Job continues          |

UI показывает stable code, human message, retryability и Job ID. Raw prompt,
thinking, secrets и file content не включаются по умолчанию.

## Web projection

Target frontend layers:

```text
router/layout
  → query cache + Job event client
  → domain projections
  → feature screens
  → operation workbench registry
  → UI primitives/error boundaries
```

Event client:

- сохраняет last applied sequence;
- ignores duplicates;
- detects gaps и читает replay;
- подписка отменяется без cancel Job;
- explicit cancel вызывает command API;
- terminal projection затем сверяется с `GET /jobs/:id`.

Thinking renderer получает отдельную policy и Markdown sanitizer. Long stream
парсится incrementally/chunked; auto-scroll уважает user position.

## CLI/service design

Компоненты: [lld-service-target.mmd](diagrams/lld-service-target.mmd).

Stable non-interactive primitives предшествуют TUI:

```text
alamo status [--json]
alamo start [--detach] [--port ...]
alamo stop
alamo open
alamo models list|pull|load|unload
alamo jobs list|show|cancel|events
alamo chat
alamo agent
alamo config get|set
alamo service autostart enable|disable|status
```

No-args TUI вызывает их через shared client library. First-party `alamo agent`
создаёт Agent Run через тот же Job API и поддерживает slash command discovery.
Application service state определяется health/control API + process identity, не
только открытым портом. Stop Alamo не останавливает external Ollama по default.

Service control и settings:

- Web/CLI/TUI читают одну canonical store;
- restart-sensitive patch возвращает preview;
- controlled restart перестаёт принимать Jobs, checkpoint/cancel по policy,
  закрывает DB, перезапускает process и проходит health verification;
- macOS/Linux autostart adapters opt-in и имеют uninstall/rollback.

## Versioning

- REST/SSE schema: additive first, explicit compatibility window;
- DB: monotonic `user_version`;
- Recipe/adapter snapshot: adapter id+version;
- Model evidence: digest+Ollama version+backend+hardware+probe;
- Artifact: immutable checksum;
- brand/display name: config, не protocol identity;
- unknown upstream fields: preserve/ignore safely.
