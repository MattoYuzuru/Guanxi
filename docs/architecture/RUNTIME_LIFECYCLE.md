# Runtime, Jobs и память

**Статус:** mixed — diagnosis locally validated, lifecycle target accepted

**Проверено:** 2026-08-04
**Критичность:** основной correctness и safety boundary

## Подтверждённое current behavior

### Turn

```text
UI POST /threads/:id/messages + idempotency key
→ one transaction: queued Job + initial event + private input + Message pair
→ application ChatJobExecutionOwner starts once per Job
→ queued → reserving → typed Resource Governor ticket → active lease
→ loading/prefill/thinking/generating/tool phases
→ Ollama /api/chat keep_alive=10m
→ persist each private Chat output before subscriber wake-up
→ finalizing
→ one transaction: assistant projection + terminal Job + terminal event/output
→ idempotent lease release
→ GET /jobs/:id/events may replay from any persisted sequence
```

P1-D добавил один `ChatJobExecutionOwner` в application composition. SQLite
владеет command intent, idempotency, lifecycle order, private replay output и
Message association. `activeTurns` остаётся только compatibility mirror для
старых внутренних проверок; route и React component больше не владеют работой.

P1-F заменил `ExclusiveInferenceBridge` одним application
`ResourceGovernor`. Durable Chat Jobs разных threads ждут его FIFO вместе с
compaction и explicit model warm/load, поэтому участвующие entry points одного
application process не входят в Ollama inference одновременно. Chat request
владеет canonical `jobId`, compatibility operations — process-local UUID. Это
ещё не host-wide координация внешних clients или второго Alamo process.

На route/thread change `useChat` закрывает только subscription. Job продолжает
выполнение, а возвращение в Chat находит `jobId` в pending Message, читает
canonical Job и replay-ит persisted output с sequence 0. Явные Thread Stop и Job
cancel сходятся в owner: сначала durable `cancelling`, затем provider abort и
одна подтверждённая terminal проекция. P1-E после restart не продолжает unsafe
side effect: process-local owner не является daemon/worker, поэтому startup
reconciles execution в `interrupted` и запускает только untouched `queued`.

### Исправленная в P0-A причина белого экрана

До P0-A `ChatPage.tsx` streaming child вызывал:

```ts
useEffect(onChange, [snapshot.version, toolCalls.length, onChange]);
```

Переданный callback возвращает результат `scrollIntoView()`. В наблюдавшемся
Chrome он возвращает Promise; React принимает return эффекта за cleanup и на
следующей phase пытается вызвать Promise как функцию. Результат:

```text
TypeError: T is not a function
```

Root Error Boundary отсутствовал, поэтому React root становился белым.

P0-A реализовал безопасную форму:

```ts
useEffect(() => {
  onChange();
}, [snapshot.version, toolCalls.length, onChange]);
```

Root boundary теперь сохраняет Reload, безопасную навигацию, correlation ID,
время/route/error и component stack. Отдельный keyed Chat boundary сохраняет
application shell при падении feature. Поведение локально подтверждено component
test с Promise-returning `scrollIntoView` и deterministic Chromium flow с
несколькими streaming phases.

### P0-B truthful terminal bridge

P0-B добавил additive Message-проекцию:

```text
legacy unknown (NULL)
pending
  ├─ completed
  ├─ failed
  └─ cancelled
```

Terminal update использует compare-and-set только из `pending` и одной SQL
операцией сохраняет partial/final content, thinking, tools, usage, safe error и
stop reason. Поздняя повторная terminalization не меняет failure/cancel на
completed. `completed` требует наблюдавшийся Ollama chunk с `done:true`; EOF без
него становится `failed/runtime_protocol`.

SQLite migration 3 backfill-ит `completed/legacy_terminal_chunk` только для
старых assistant rows с `usage IS NOT NULL`: до P0-B usage строился только из
terminal Ollama chunk. Старые empty/partial rows без usage остаются `NULL`, и Web
показывает их как legacy outcome unknown, а не success.

Provider error до первого chunk, partial provider error, explicit Stop и
connection abort сохраняют terminal outcome. Если terminal DB update не удался,
stream не эмитит completed; row остаётся `pending` либо повторная финализация
фиксирует `failed/storage_error`. Это наблюдаемый storage failure, а не пустой
success.

Adapter сохраняет abort identity для authoritative cancellation reason, а
non-abort ошибки чтения provider body нормализует в безопасный
`upstream_error/provider_error`. Graceful EOF без `done:true` по-прежнему
отличается как `runtime_protocol/protocol_error`. Если перечитать terminal
history не удалось, Web удерживает live partial buffer с отдельной
неподтверждённой меткой и alert.

### P1-F Resource Governor foundation

Governor имеет ровно один process-local accelerator permit и `normal` FIFO.
Immutable admission request содержит owner, operation, exact Ollama model,
requested context, priority и enqueue time. Ticket проходит `queued → active →
released` либо `queued → cancelled`; active lease фиксирует acquire/release time
и освобождается идемпотентно. Lease держится весь turn, включая tool/approval
phases, как консервативная граница; compaction и warm/load держат её до завершения
route operation. Chat lease принадлежит execution owner, а не SSE request.
Release находится в `finally`, поэтому provider/protocol/storage error, Stop,
timeout и generator return не блокируют следующий request.

Compaction выбирает prefix после admission и получает boundary из реального
persisted `messages.seq`. После предыдущего summary следующая compaction больше
не использует array index, не оставляет уже суммированные rows в tail и передаёт
следующему turn упорядоченный context.

Governor snapshot/explanation содержит только live queue, active lease, последнюю
decision, observation time и policy basis; released state не растёт без границ.
Explicit unload получает controlled conflict до Ollama call при exact active
model и при любом другом current owner консервативного lane. Governor не защищает
внешний Ollama client или второй application process, не знает hardware fit и не
допускает measured parallelism.

### P1-G sampled runtime reconciliation

Один application `RuntimeReconciliationService` связывает
`ModelService.ps()` и `context.governor`. `GET /api/runtime` и compatibility
`GET /api/models/running` делят один pending provider call; completed result,
cache и history не сохраняются. Abort отдельного caller прекращает только его
ожидание и не отменяет общий sample для остальных.

Linearization rule: сначала завершается validated `/api/ps` response либо
controlled failure, затем service выбирает один `observedAt` и синхронно снимает
Governor snapshot. Enqueue/acquire/release до этой точки видны в result, после
неё — только в следующем call. Source health, Governor projection и все model
rows имеют тот же sample timestamp; исторический `lastDecision.observedAt`
сохраняет время самой admission decision.

Exact normalized Ollama reference (`case/whitespace`, implicit `:latest`) может
связать active lease с одной observed row. Lease не содержит digest, поэтому
даже matched row публикует runtime digest только как provider fact и оставляет
artifact identity `unknown`. Остальные rows имеют owner `unknown`, не
`external`; active lease без row остаётся `active_not_observed`.

Successful empty response публикует `models: []` и `empty_sample`. Unavailable,
timeout или malformed source публикует `models: null`, safe source code и
`source_failure`, сохраняя queue/lease projection. Reconciliation не освобождает
lease, не запускает load/unload, не меняет admission и не доказывает состояние
между calls. Stale state отсутствует, потому что P1-G не имеет cache.

### P1-H sampled host telemetry и current fit

Один injected `HostTelemetry` boundary принадлежит application composition.
`/api/ps` и host sample запускаются параллельно внутри того же shared pending
reconciliation. После завершения обоих service выбирает root `observedAt`,
выравнивает timestamps фактов и синхронно capture-ит Governor. Поэтому один
result является coherent application sample, но не атомарным host-wide снимком.
Caller abort прекращает только ожидание; следующий call после completion заново
вызывает оба источника. Cache, background polling и durable history не добавлены.

Apple Silicon adapter применяется только для `darwin/arm64` и запускает
`/usr/bin/vm_stat` без shell с timeout 1 s и output limit 64 KiB. Из официально
документированных полей он публикует `Pages free × page size` как observed
system-free bytes. `os.totalmem()` даёт static total unified-memory fact.
Legacy `HardwareInfo.usableMemoryBytes = 70%` остаётся явно estimated
compatibility value, а не current availability. Free pages также не считаются
safe available capacity. Discrete VRAM/GPU-free для unified memory не
выдумываются; available memory и pressure остаются unknown. Malformed output
даёт `partial`, timeout/failure — safe `unavailable`, non-Apple host —
`unsupported` без выполнения команды.

P2-G добавляет второй adapter только для local `linux` + detected `cuda`
profile. Он выполняет absolute `/usr/bin/nvidia-smi` без shell с fixed
`--query-gpu=index,uuid,name,memory.total,memory.free` и
`--format=csv,noheader,nounits`, теми же timeout 1 s/output 64 KiB и minimal C
locale env. Pure parser принимает LF/CRLF, whitespace, Unicode names и любое
число rows внутри output bound; MiB переводится в safe integer bytes. Каждый
usable device имеет provider index, nullable UUID, name, total/current-free
VRAM, source/time/confidence. Missing UUID даёт partial identity, usable +
malformed rows — partial, all malformed — unavailable, duplicate index/UUID —
fail-closed inconsistent, command/timeout/output failure — redacted unavailable.

Этот sample не суммирует VRAM, не определяет MIG/topology и не связывает
`/api/ps` row с device. Поэтому Linux observation key остаётся unavailable,
current fit — unknown, free VRAM не становится safe admission capacity, а
Governor сохраняет один консервативный permit.

Ошибки источников независимы: valid runtime rows сохраняются при telemetry
failure, а valid host facts сохраняются при `/api/ps` failure (`models: null`).
Raw command output/error не проходит в public contract. Все факты имеют source,
confidence и общий observation time.

`currentFit.observed` разрешён только для unambiguous exact active lease/row,
provider digest, exact requested/observed context и достаточного Apple sample с
observed available memory и normal observed pressure. Он означает только
наблюдаемую текущую residency/configuration; artifact identity остаётся
`unknown`, а `futureAdmissionGuarantee` всегда `false`. Missing digest/context,
ambiguous row, unsupported/failed/partial host, unknown/elevated pressure или
missing available memory дают stable `unknown` reason. Production Apple adapter
не публикует достаточные pressure/available-memory facts, поэтому его fit сейчас
truthfully `unknown`; observed branch проверяется только injected fixtures.

### P1-I read-only Runtime Bar projection

Persistent Web shell теперь читает только typed `api.runtimeSnapshot()` и
показывает один active lease, FIFO waiters, loaded runtime rows, independent
Ollama/host source states и per-model current fit. Compatibility
`GET /api/models/running` остаётся, но Runtime Bar его не вызывает. Projection не
является durable Jobs list, не доказывает external client identity и не владеет
admission/cancel/load/unload.

Один `useRuntimePolling` владеет одним HTTP wait и одним timer. Active либо
queued sample планирует следующий query через 2 s, idle — через 10 s. Hidden
document не планирует timer; возврат в visible вызывает immediate refresh. Пока
request не завершён, timer/manual/visibility trigger не создают overlap.
Unmount abort-ит только свой HTTP wait и удаляет timer/listener; Job и lease
остаются server-owned.

Initial loading, ordinary refresh и failed refresh различаются. Confirmed sample
не очищается во время обновления; failure сохраняет его с явным stale/error
alert и не показывает raw endpoint/body. `models: []` остаётся healthy empty,
`models: null` — source failure. Narrow shell держит bar последним flex-элементом,
поэтому bottom-sheet-like disclosure не перекрывает main content.

### P1-J resource conflict decision

`RuntimeProvider` сохраняет один P1-I poller на уровне shell. Chat send intent
получает UUID до resource check и делает bounded fresh query через тот же
single-flight. Active lease или уже ожидающий FIFO ticket открывает dialog;
иначе intent один раз передаётся существующему Chat POST. UI sample не является
lock: canonical admission и порядок остаются у server `ResourceGovernor`.

`Queue after current` — safe default. Она отправляет ровно тот же intent/key и
не вызывает cancel, stop либо unload. Dialog закрывается только после HTTP
command acceptance; transport failure оставляет draft/intent для явного retry.
Back, Escape, route change и unmount не выполняют resource command.

`Stop current and switch` доступен только для fresh exact
`{ kind: "job", jobId }`. Перед mutation Web запрашивает новый Runtime sample,
сверяет тот же owner, читает public Job и вызывает один typed cancel. Новый Chat
dispatch разрешён только если Job уже terminal либо cancel acknowledgement
достиг terminal через bounded public Job polling. Changed, stale, unavailable,
operation или unknown owner fail-closed; их IDs не угадываются и не выводятся
как title. Abort dialog wait не отменяет shared Runtime request или active Job.

Dialog показывает только contract operation/model/owner kind/context/FIFO
position, без private input и durable-history claim. Localized safe errors не
включают raw endpoint/provider body/path. Portal обеспечивает named description,
Queue initial focus, Escape, Tab containment, inert background, focus restore,
один content scroll и responsive actions.

### P0-D sampled health и provider deadlines

Application health подтверждается ответом собственного HTTP route и не зависит
от Ollama или каталога. Ollama проверяется через валидированный `/api/version` и
различает `reachable`, `unavailable` и доказанный malformed
`incompatible` response. Наблюдение содержит `source` и `observedAt`; проверка
наличия binary имеет отдельный `installSource`.

Каталог больше не обращается к недокументированному
`https://ollama.com/api/search`. Разрешённые current sources:

1. локальный recommendations cache с filesystem `mtime`, всегда `stale_cache`;
2. датированный bundled snapshot, `bundled_fallback`;
3. `unavailable`, если данных нет.

Контракт оставляет `fresh_remote` для будущего документированного provider, но
current implementation его не публикует. Каждая catalog row также несёт
provenance/freshness. Cached claims без поля-источника не превращаются в
capability facts.

`/api/tags` остаётся источником installed models, а `/api/ps` — отдельным
sampled source для текущих loaded rows. Running projection показывает только
полученные raw facts, nullable legacy-derived поля, source и `observedAt`.
Пустой sample не доказывает unload между наблюдениями, а ошибка `/api/ps` не
превращается в empty success и не удаляет installed rows.

Timeout ownership:

- connect deadline — получение HTTP response/headers;
- load deadline — первый валидный NDJSON provider event либо весь non-stream
  model request после bounded `/api/version` preflight;
- stream-idle deadline — пауза после валидного provider event; каждый следующий
  валидный event обновляет deadline, произвольные неполные байты — нет.

Current defaults: 15 s connect, 300 s load и 30 s stream idle. Timeout получает
stable `ollama_*_timeout` category, сохраняет partial assistant как `failed` и
использует совместимый DB `provider_error` stop reason. Missing terminal
`done:true` остаётся отдельным `runtime_protocol`.

Caller-owned explicit Stop имеет приоритет, включая гонку с deadline: результат
остаётся `cancelled/stopped_by_user`. P1-D subscriber disconnect больше не
передаётся provider как abort. Любой timeout/provider/explicit-abort path выходит
через идемпотентный release P1-F lease и допускает следующего waiter.

### P1-A durable persistence foundation

SQLite migration 4 additive создаёт `jobs` и `job_events`, не меняя migrations
1–3 и legacy `threads/messages`. `JobStore` реализует:

- scoped uniqueness пары `idempotency_scope/idempotency_key`;
- atomic `Job(queued) + lifecycle event(sequence=1)`;
- monotonic per-Job sequence через transaction/CAS и unique constraint;
- ordered page `sequence > after`;
- atomic terminal state + ровно один terminal lifecycle event;
- controlled failure на unknown/malformed stored record;
- flat JSON-scalar metadata boundary без private input/output content.

Create, append и terminal races проверены через независимые SQLite connections.
На этапе P1-A foundation ещё не использовался Chat; P1-D подключил к нему
текущий turn через additive migration 5.

### P1-B transitions и persisted-first subscription

`JobStore.transition` выполняет compare-and-set только для exact non-terminal
edges canonical diagram. State, optional phase, write-once `startedAt`, next
sequence и lifecycle event принадлежат одной `BEGIN IMMEDIATE` transaction.
Invalid/reverse/skipped edge даёт controlled error; stale expected state не
пишет ничего; terminal Job не возвращается в execution.

Один application `JobService` поверх store владеет create/get, transition,
safe event append, terminal edge validation и subscription. Mutation сначала
полностью commit-ится, затем service отправляет process-local wake-up. Subscriber
регистрируется до replay и читает SQLite bounded pages после собственного
cursor; wake-up не содержит event payload. Поэтому replay/live handoff не теряет
и не дублирует sequence, slow consumer не блокирует writer, а AbortSignal удаляет
только listener и не меняет Job.

Новый service instance после restart теряет listeners, но воспроизводит durable
tail из SQLite. На handoff P1-B это был только internal `AsyncIterable`; durable
execution, Chat bridge, worker, startup recovery и Governor не были реализованы.

### P1-C public command/query/replay/cancel API

Additive contract и Hono composition теперь предоставляют:

- `POST /api/jobs` с strict `kind`/`operation`/`idempotencyKey`, server-owned
  scope `local-api:v1`, `202` для нового и `200` для duplicate Job;
- `GET /api/jobs/:jobId` как canonical persisted projection;
- `GET /api/jobs/:jobId/events` как replayable SSE по `after` либо
  `Last-Event-ID`;
- `POST /api/jobs/:jobId/cancel` с единственной public safe reason
  `user_requested`.

Каждый Job SSE frame несёт полный typed persisted event, а `id` точно равен его
positive integer `sequence`. Handler до заголовков проверяет Job и первый bounded
replay page, затем использует `JobService.subscribe`: SQLite остаётся источником
replay/live order. Pull-based HTTP stream буферизует не более одного frame;
producer не ждёт медленного reader. Disconnect/AbortSignal удаляет только
subscriber и не меняет Job.

Terminal event доставляется последним, после чего subscription закрывается;
reconnect уже на terminal tail закрывается без зависания. Одинаковые `after` и
`Last-Event-ID` дают один cursor, разные либо malformed/negative/fractional/
unsafe integer значения отклоняются до subscription.

Cancellation принадлежит application service. Terminal и уже `cancelling` Job
возвращаются идемпотентно. `queued` проходит persisted
`cancelling → cancelled`, потому что executor ещё не запускал side effect.
Активный cancellable state переходит только в `cancelling`; будущий execution
owner должен подтвердить остановку перед `cancelled`. P1-D реализует это
подтверждение для Chat owner; generic Job без adapter остаётся `cancelling`.
State без canonical edge возвращает controlled conflict без event.

На этапе P1-C API ещё не имел Job executor: generic public Job без известного
adapter и сейчас правдиво остаётся `queued`. P1-D подключает owner только для
Chat Jobs, созданных через thread command boundary.

### P1-D durable Chat execution, detach и replay

Additive migration 5 сохраняет `messages.job_id`, immutable private
`chat_job_inputs` и optional private `job_events.output` с обязательной
classification `private_chat`. Safe lifecycle metadata остаётся отдельной
плоской границей и не содержит prompt, reasoning, secrets или workspace content.

`POST /api/threads/:threadId/messages` принимает optional UUID idempotency key
для совместимости со старыми clients. Server строит scope
`chat:<threadId>:send:v1` и fingerprint canonical input snapshot. Одна
`BEGIN IMMEDIATE` transaction создаёт ровно один queued Job, initial lifecycle
event, user/pending-assistant pair и association. Повтор того же key/input
возвращает canonical Job; тот же key с другим fingerprint даёт controlled
conflict без дополнительной записи.

Один process-local `ChatJobExecutionOwner` стартует новый Chat Job ровно один
раз, владеет controller и проходит canonical states. Каждый Chat output сначала
commit-ится как Job event, затем `JobService` будит subscribers. Deltas больше
16 KiB делятся по UTF-8 bytes на несколько ordered events без усечения. Final
`done` не публикуется раньше transaction, которая одновременно terminalize-ит
pending assistant, Job и его единственный terminal event. При injected failure
Job остаётся `finalizing`, Message — `pending`, completed event отсутствует, а
inference permit освобождается.

Compatibility POST/SSE читает тот же durable event stream; canonical reattach
использует `GET /api/jobs/:jobId` и `GET /api/jobs/:jobId/events`. HTTP
backpressure ограничивает выдачу одним frame, а slow/disconnected subscriber не
владеет producer. Web получает association из persisted Message, поэтому
navigation, remount и hard reload не требуют localStorage truth.

P1-D локально проверен на mocked Ollama и temporary SQLite, включая duplicate
delivery, create/terminal rollback, cancel-before-admission, disconnect/replay,
oversized deltas, cross-thread one-lane admission и 10 повторов
disconnect/cancel/terminal race. Сам P1-D не доказывал live Ollama/hardware,
multi-process coordination или restart recovery; startup reconciliation добавил
следующий P1-E.

### P1-E startup recovery и interrupted reconciliation

Application startup теперь выполняет одну границу после SQLite migration и до
HTTP listen/healthy:

```text
bounded typed Chat scan
→ validate immutable association + exactly one pending assistant
→ reconcile every unsafe/cancelling row
→ second bounded scan schedules only proven untouched queued
→ HTTP listen
```

Keyset `(created_at, id)` и limits 50 Jobs/100 events по default ограничивают
каждый read. Generic public Jobs без `chat_job_inputs` не запускаются. Chat scope
с потерянной association, malformed input/Message/private output и permanent
storage failure дают один redacted startup error, закрывают DB и оставляют rows
для следующей попытки.

`queued` считается safe только при `startedAt = null`, `phase = null`, одном
pending assistant и полном отсутствии private output. Все rows проверяются до
первого scheduling side effect. `reserving/loading/prefill/thinking/generating/
waiting_tool/waiting_approval/finalizing` не replay-ят adapter и одной
recovery-only CAS transaction становятся Job `interrupted` + Message
`failed/internal_error` + terminal `private_chat` output. Это явная projection:
canonical restart outcome остаётся `interrupted`, хотя v3 Message contract пока
не имеет отдельного interrupted outcome. Persisted `cancelling` подтверждается
как `cancelled/stopped_by_user` и не выдаётся за restart failure.

Reducer читает ordered pages, сбрасывается только на `start.messageId` latest
pending assistant и применяет последующие content/thinking/tool/usage channels.
Ранее terminalized tool-step Messages не меняются. Transaction failure не
публикует terminal event; следующий startup повторяет исходный non-terminal row.

Graceful application close сначала прекращает HTTP accept, использует отдельную
internal shutdown abort reason и reconciles active Chat как `interrupted` либо
уже persisted cancellation. Он не записывает `user_requested/stopped_by_user`
для внутреннего shutdown и закрывает subscribers/SQLite после owner cleanup.

P1-E не реализует checkpoint resume, multi-process locking или daemon/service.
P1-F добавил transient Resource Governor tickets/leases без lease journal; P1-G
добавил только query-time sampled `/api/ps` reconciliation без recovery journal.

## Target Job lifecycle

Исходник: [job-state.mmd](diagrams/job-state.mmd).

### States

| State              | Meaning                          | Holds inference lease |
| ------------------ | -------------------------------- | --------------------: |
| `queued`           | ждёт admission                   |                   нет |
| `reserving`        | Governor оценивает и резервирует |               pending |
| `loading`          | model load/prewarm               |                    да |
| `prefill`          | prompt/context ingest            |                    да |
| `thinking`         | reasoning channel                |                    да |
| `generating`       | output channel                   |                    да |
| `waiting_tool`     | tool dispatch/result             | зависит от checkpoint |
| `waiting_approval` | user decision                    |   предпочтительно нет |
| `finalizing`       | persist artifacts/usage          |         необязательно |
| `cancelling`       | abort в процессе                 | до подтверждения stop |
| `completed`        | success terminal                 |                   нет |
| `failed`           | failure terminal                 |                   нет |
| `cancelled`        | explicit cancel terminal         |                   нет |
| `interrupted`      | process died/unsafe resume       |                   нет |

Phase — деталь внутри state и может включать provider-specific label, но стабильные
states нужны API/UX.

### Transaction boundaries

1. `jobs INSERT + queued event INSERT` — одна transaction.
2. Claim queue item использует compare-and-set expected state.
3. Каждый event получает next sequence under transaction/unique constraint.
4. Assistant/Artifact projection обновляется из durable event/output.
5. `terminal job UPDATE + terminal event INSERT` — одна transaction.
6. Lease release идемпотентен и journaled.

### SSE/replay

- create Job — обычный POST, не streaming request;
- subscription — GET SSE;
- `Last-Event-ID` или `after` определяет sequence;
- server сначала replay persisted events, затем live tail;
- duplicate events безопасны для projection;
- gap вызывает повторный bounded read;
- disconnect закрывает subscription, не Job;
- cancel — отдельный explicit command.

WebSocket нужен только если duplex live-audio latency это подтвердит. Обычные Jobs
и token streams остаются HTTP+SSE.

## Resource Governor

### Current P1-F–P1-M policy

- один active process-local accelerator lease как консервативная application
  policy, не как assertion о числе accelerator devices;
- priorities `normal > prewarm`; FIFO сохраняется внутри normal;
- Chat, compaction, explicit warm/load, automatic prewarm и explicit completion
  probe используют один `context.governor`;
- normal intent отменяет queued prewarm; active prewarm получает abort только
  через callback своего exact owner, освобождает lease, и лишь затем входит
  первый normal waiter;
- prewarm не допускается при active/queued normal и никогда не abort-ит normal;
- waiting abort удаляет только свой ticket, active abort принадлежит execution
  owner;
- unload блокируется active lease/conservative current owner;
- close прекращает admission, abort-ит owners и ждёт release;
- queue intent остаётся в durable Job, а tickets/leases process-local, поэтому
  migration 6 не вводилась;
- `/api/ps` sampled через single-flight query boundary, но не влияет на
  admission/unload;
- Apple host telemetry делит single-flight и объясняет current fit, но не влияет
  на admission/unload;
- production current pressure/available memory, proven external ownership и
  multi-process lock отсутствуют.

Device cardinality current host adapter не сообщает. Governor permit count не
используется как hardware fact, а Runtime Bar показывает unknown отдельно.

### Current context boundary

P1-M принимает requested context как positive JavaScript safe integer и
сохраняет exact value через thread/settings SQLite, Governor request, Ollama
`num_ctx`, fit и prewarm. Defaults `8192`/`32768`, Launcher datalist и profile
steps — только defaults/suggestions.

Provider declaration из `/api/tags` или `/api/show` содержит value, source,
observation time и confidence. Значение выше единственного непротиворечивого
declared maximum даёт controlled `context_limit_exceeded` либо typed prewarm
skip без clamp. Absent/conflicting evidence остаётся unknown и не блокирует
валидный request. `/api/show` projection использует максимум четыре workers и
digest-aware LRU 64; cache сохраняет исходное observation time.

P2-A использует те же local sources для installed capability descriptor, но не
повышает declaration до runtime proof. `/api/tags` несёт installation/exact
digest basis; `/api/show` response не несёт digest и остаётся
`detail_not_bound_to_digest`. Ambiguous reference, unknown enum, conflict,
missing/malformed/unavailable field видимы как degraded/unknown и не меняют
Governor admission, prewarm, context propagation или runtime reconciliation.

P2-B превращает только доказанную bounded collection в exact persistent row:

```text
tags/version identity A → compatible cache lookup
  → fresh: return original observation
  → stale/miss: one four-worker-bounded /api/show flight
      → tags/version still A: normalize allowlist + atomic migration-7 write
      → identity changed/malformed: visible unknown/degraded, no write
      → detail unavailable: stale/offline only inside 7-day window
```

Application freshness policy — 15 минут, stale window — 7 дней. Access/cache
hit не обновляет `observedAt`. Caller abort прекращает только его wait; owned
request abort-ится, когда не осталось waiters. Provider installation failure не
создаёт cached installed row: `/api/tags` остаётся current installation owner.

P2-C использует отдельный exact probe key и migration 8:

```text
explicit confirmation → tags/version identity A → historical exact lookup
  → hit without force: return original observation as historical
  → miss/force: normal-priority model_probe admission
      → fixed bounded Ollama completion call
      → release ticket/lease
      → tags/version still A: persist normalized latest outcome
      → identity changed/unavailable: degraded/unknown, no positive write
```

Cloud, red fit, unknown fit и sourced context overflow дают skip до provider
load. Cancel/timeout/provider/protocol/empty/persistence failure никогда не
становятся unsupported или verified. Caller connection владеет ожиданием;
request не durable, не replayable и не продолжает работу после abort.

P2-D reference preview/pull не меняет Governor или evidence stores:

```text
explicit preview submit → pure strict local normalization
  → explicit confirmation of exact normalized name
  → connection-owned local Ollama /api/pull
      → validated non-regressing progress
      → provider terminal success → SSE done
      → Web refreshes /api/tags for installed/digest truth
```

Preview не делает provider/network/filesystem/SQLite call. Start повторно
нормализует original reference и отклоняет confirmation mismatch. Pull не
является inference lease или durable Job, не retry-ится Web автоматически и не
запускает completion probe. Disconnect/cancel abort-ит только owned HTTP wait;
Ollama daemon, partial provider data и external pulls не принадлежат этому
controller.

P2-E добавляет selection boundary перед тем же P2-D pull:

```text
catalog source row → strict exact target + per-variant claimed fit
  → explicit variant selection → confirmation snapshots exact target
  → one connection-owned P2-D pull
  → terminal success → fresh Installed descriptor query
      → one exact target + digest: confirmed installation
      → missing/ambiguous/failed refresh: unconfirmed
```

Selection, hover, focus, carousel navigation, reload и variant change не создают
side effect. Во время active pull selector disabled, а upstream rerender не
подменяет captured target. Unmount abort-ит только owned wait и запрещает late
refresh/state update. Catalog fit остаётся calculation по claimed size, не
Governor admission или live hardware measurement; exact installation не
наследуется между tags одной family.

P2-F добавляет только read-only query/compare boundary:

```text
validated P2-E rows + strict facets
  → model claims: scope/source/freshness/capability
  → one-row predicates: installation + fit + claimed context + claimed size
  → filtered exact rows with unchanged provenance
  → page-local selection of exactly two unique targets
  → side-by-side claims/sampled facts, no resource command
```

CSV values дают OR внутри facet group, groups объединяются AND. Unknown доступен
только явно; absent capability metadata, size, context, fit или installation не
становятся unsupported/zero/green/not-installed. Web abort-ит предыдущий query
и не принимает late response. Если exact target исчез из последнего valid
response, selection удаляется с visible notice, а не rebound-ится по family/tag
index. Filter, clear, retry, swap, remove, Escape и reload не запускают pull,
probe, prewarm/load, provider fetch или timestamp refresh.

P2-O добавляет read-only explanation поверх текущего one-permit conflict:

```text
strict active + queued request → typed P2-N flag
  → disabled: no Runtime/provider/calculator work
  → enabled: one Runtime snapshot + internal endpoint identity
      → exact active /api/ps + candidate tags/version/show coherence
      → exact calibration OR derived declared+KV lower bound
      → compare with advisory available memory without active double count
      → estimated_deny on equality/shortfall; otherwise typed unknown
```

Runtime и candidate обязаны использовать тот же loopback Ollama endpoint,
runtime/hardware fingerprints и requested reference/digest/context. Exact
calibration row дополнительно сверяет все denormalized key columns и timestamp;
formula публикует отдельный combined source. Contract резервирует coherent
`estimated_allow`, но current calculator его не возвращает без owner-approved
capacity/margin. Production Apple не даёт observed available-memory/pressure, а
Linux/NVIDIA не связывает `/api/ps` row с device, поэтому production verdict
сейчас `unknown`; injected fixtures доказывают только arithmetic branches.

Query не cache/persist-ит result, не acquire/release/enqueue/cancel-ит Governor,
не запускает load/probe и не меняет current single permit. Caller cancellation
прекращает только его wait/provider reads; shared Runtime sampling semantics не
меняются.

Output-budget control и media upload в current Chat flow не реализованы; UI не
подставляет guessed maxima. Это не отменяет существующие safety/transport bounds:

| Boundary                         | Kind                     | Observable behavior                                          |
| -------------------------------- | ------------------------ | ------------------------------------------------------------ |
| Bash stdout/stderr 64 KiB        | tool safety              | result явно сообщает truncation                              |
| `read_file` 256 KiB/2000 lines   | tool/context safety      | result сообщает safe read limit и предлагает offset/limit    |
| host probe output 64 KiB/1 s     | host adapter reliability | typed redacted `host_probe_output_limit`/timeout             |
| tool JSON candidate 32k chars    | parser safety            | oversized candidate не исполняется и остаётся обычным text   |
| Job/recovery pages 100, max 1000 | storage/backpressure     | bounded reads; invalid injected config даёт controlled error |
| Chat output chunk 16 KiB         | replay transport         | ordered chunks без truncation                                |
| Ollama/prewarm deadlines         | runtime reliability      | typed timeout/cancel state освобождает lease                 |
| Completion probe 10/30/5/45 s    | runtime reliability      | connect/load/idle/total; typed non-verified outcome          |
| Completion probe 8 tokens/1 KiB  | protocol safety          | server-owned bounds; generated content не сохраняется        |
| Ollama pull default 15/300/30 s  | adapter reliability      | connect/first-progress/idle; connection abort, no total Job  |
| Agent 40 steps                   | current watchdog policy  | visible max-steps failure; Q-27 остаётся open                |

### Default policy

- один active local inference permit на accelerator profile;
- FIFO внутри priority с защитой от starvation;
- priority: interactive > normal > background > prewarm;
- current active Job не вытесняется prewarm;
- parallel execution запрещён, пока measured fit/policy явно не разрешили;
- tool CPU work может идти отдельно, но его effect/resource limits независимы.

### Admission

```text
enqueue
→ resolve exact model variant and operation
→ obtain fresh runtime + host snapshot
→ estimate reservation and confidence
→ if compatible resident instance: reuse lease
→ else wait for permit
→ release idle incompatible leases / explicit unload
→ load and observe
→ admit Job or fail with explanation
```

AdmissionExplanation содержит:

- выбранную model variant;
- requested context/parallelism;
- observed running models;
- memory estimate и confidence;
- queue reason;
- возможные действия: wait, smaller variant, lower context, stop active, override.

### Measured parallelism

Поздний advanced mode может допустить второй accelerator Job, например короткий
STT во время долгого LLM Job. Governor считает joint reservation для всех
instances, KV caches, parallelism и host reserve. Admission требует:

- fresh host/runtime observation;
- exact digest/configuration каждого Job;
- safety margin после совместного размещения;
- отсутствие critical pressure;
- user-enabled measured-parallel policy.

Если load observation хуже estimate, второй Job возвращается в queue либо
останавливается до влияния на active Job. UI не предлагает parallel на основании
общего объёма памяти без этой проверки.

### Model lease lifecycle

Исходник: [model-lease-state.mmd](diagrams/model-lease-state.mmd).

- **Job lease** — active work, highest protection.
- **Pipeline lease** — между короткими связанными stages, если reuse выгоден.
- **Pinned lease** — explicit advanced user choice.
- **Prewarm lease** — cancellable, low-priority, short TTL.

Navigation не участвует в refcount. Chat на той же модели может reuse instance.
Unload разрешён, когда:

1. нет active/pinned leases;
2. истёк idle grace либо есть memory pressure;
3. `/api/ps` подтверждает identity;
4. выбранная policy допускает управление instance.

External instance, загруженная не Alamo, сначала помечается `external/unknown
owner`; auto-unload её требует explicit policy.

### Prewarm

Current P1-K реализует bounded subset этой policy. В New Chat он начинается
после 600 ms debounce только если:

- Governor idle;
- exact installed name/digest, Chat operation и requested context уже resolved;
- fit level для того же context — `green` либо `yellow`, а basis известен;
- нет более приоритетного Job;
- пользователь не отключил prewarm;
- document видим, selector всё ещё mounted и выбор не изменился.

Prewarm не должен загружать все карточки, hovered models или каждый Chat в
background. Typed `POST /api/models/:name/prewarm` повторно проверяет installed
variant, fit facts, setting, sampled residency и canonical Governor state.
Exact resident name+digest+context даёт `reused`; ambiguous identity даёт
truthful skip без reuse claim. Load использует centralized `keep_alive=2m` и
30 s server deadline; explicit warm/turn сохраняют прежние `10m` semantics.

Selector change, setting off, hidden document, component unmount, request
disconnect или client/server deadline отменяют только этот prewarm. Normal
intent отменяет queued prewarm либо abort-ит exact active prewarm, ждёт release и
сохраняет normal FIFO. Prewarm — process-local request/lease, не durable Job и не
background work после закрытия соединения. Navigation не вызывает explicit
unload; она лишь завершает принадлежащий странице speculative prewarm request.

### Current explicit completion probe

Installed profile не запускает probe на mount, hover, selection, navigation или
reload. User открывает focus-contained confirmation, видит exact model/context и
краткий load side effect, затем явно запускает либо отменяет request. Runtime Bar
показывает `model_probe` как process-local operation/queue owner и не предлагает
Job Stop.

Server-owned definition version 1 отправляет только fixed text prompt с
`temperature=0`, `seed=0`, `num_predict=8`, exact requested `num_ctx` и
`keep_alive=2m`. Ollama transport применяет connect 10 s, load 30 s и stream-idle
5 s; общий request deadline — 45 s, accumulated visible response — не более
1024 bytes. Эти protocol/safety bounds не являются product output ceiling.

Terminal non-whitespace response даёт `verified` только для exact
reference/digest/runtime/context/probe version. Historical row сохраняет
исходные `observedAt/completedAt`; force заменяет latest projection новым
observation. Store не содержит prompt, response, reasoning, endpoint,
credentials или paths.

### Current confirmed Ollama reference pull

Marketplace dialog не запускает preview/pull на mount, type, paste, hover,
navigation или reload. Explicit preview показывает только normalized name и
предупреждает о network/disk side effect. Confirmation dispatches один UI intent;
retry всегда новый explicit intent, а SSE POST имеет zero automatic retries.

Server принимает base/tag/one-namespace ASCII names либо exact HTTPS
`ollama.com` model-page shapes. Credentials, ports, query/fragment, alternate
host/scheme, encoded separators, literal traversal, whitespace/control и
lookalikes fail-closed до Ollama. Provider progress становится terminal только
после status `success`; malformed, regressing или EOF-before-success даёт safe
error без raw body/input/path. Success сам по себе не создаёт evidence: Web
перечитывает `/api/tags`, а refresh failure остаётся explicit unconfirmed state.

### Current variant-first catalog pull

Marketplace catalog card больше не отправляет family base name. Пользователь
выбирает один exact valid tag, видит normalized target, claimed size/parameters/
context, per-variant fit, source freshness/fetch/observation и exact sampled
installation state. Invalid/duplicate row disabled; unknown size не становится
нулевым или зелёным fit.

Confirmation показывает network/disk effect и mutable-tag boundary. Double
activation создаёт один intent, а selection snapshot остаётся target до
terminal state. Progress/error/cancel/retry использует P2-D stream. После
success Web читает Installed descriptor и принимает digest только при одном
canonical exact match. Missing match и refresh failure различаются и не
запускают completion probe, prewarm/load, capability promotion либо remote
catalog fetch.

### Current catalog facets и pairwise compare

Catalog REST принимает legacy text/context query и additive strict facets.
Repeated keys, duplicate CSV values, future enum, unknown key, non-positive/
fractional/unsafe integer и numeric+unknown conflict дают controlled 400 до
source read. Filtering выполняется после exact variant validation и возвращает
только совпавшие rows, не переписывая top-level compatibility projections или
source/fetch/observation times.

Web query bounded debounce-ом и AbortSignal. Loading, filtered empty, source/
transport error и retry различимы; chips и clear отражают applied state. Compare
открывается только для двух unique exact targets, показывает claimed size/
parameters/context, calculated-or-unknown fit+basis, source/freshness/times и
exact sampled installation/digest-or-reason. Нет winner, quality score,
recommendation, capability support или implicit action. Dialog сохраняет focus
containment/restore, включая remove, и укладывается в один controlled region на
narrow/zoomed layout.

### Current catalog pagination и pull ownership

New Web catalog request всегда передаёт positive-safe `page` и `pageSize=12`;
server policy принимает максимум 100 rows на одну page. Legacy request без обоих
keys сохраняет полный filtered list. Partial pair, repeated/unknown key и
non-positive/fractional/unsafe/over-policy value отклоняются до local source и
`/api/tags` access. Page size не является total catalog или capability limit.

Один request читает local cache либо bundled snapshot один раз и получает не
больше одного installed sample. Затем server для всего logical response
fail-closed помечает duplicate exact targets, применяет P2-F filters, stable
locale-independent order, exact model-row count и только после этого slice.
Requested out-of-range page остаётся explicit empty page с тем же total и без
silent clamp. Caller abort проходит до/после local read; paging не создаёт
remote provider, background prefetch, persistent snapshot или cache history.

Launcher хранит accepted debounced query/filter/context basis отдельно от page,
поэтому новый basis атомарно запрашивает page 1 и late old response не заменяет
его. DOM содержит только current page: максимум 12 slides/dots и constant two
pager buttons. До двух exact comparison snapshots переживают обычный page
change; query/filter/context/explicit source refresh либо изменившийся source
basis очищает их с localized notice. Focus остаётся на доступной pager boundary,
а 44 px mobile targets не создают horizontal overflow.

P2-D/P2-E pull всё ещё принадлежит одному POST/SSE connection и card subtree.
Пока он active, Previous/Next disabled с accessible explanation; page не меняется
и pull не abort-ится. После terminal/cancel ownership освобождается. Pagination
сама не запускает pull, Installed refresh, probe, prewarm/load или unload.

## Memory model

Предварительная reservation:

```text
weights
+ KV cache(context × parallelism × cache format × architecture)
+ multimodal projector/encoder
+ runtime/backend overhead
+ active media buffers
+ safety margin
+ host reserve
```

Источники в порядке доверия:

1. observation после load для того же fingerprint/config;
2. runtime-reported `/api/ps`;
3. architecture-aware estimate;
4. model artifact heuristic;
5. unknown.

Fingerprint:

```text
model digest
Ollama version
backend/device
hardware profile
context
parallelism
KV cache type
flash-attention/runtime settings
adapter/probe version
```

Current P1-L реализует безопасный subset как `ModelObservationKey` version 1:
provider `ollama`, normalized exact reference, installed/runtime digest,
observed/requested context, `/api/version`-sourced Ollama fingerprint и stable
local Apple profile (`darwin/arm64/metal`, unified memory, total bytes и source).
`/api/ps` не даёт отдельный backend/device identifier, поэтому он не
fabricate-ится. Parallelism, KV format, flash-attention и adapter version
остаются target-компонентами будущего calibration key, а не неявными defaults
v1. P2-C completion probe использует отдельный exact key с probe-definition
version 1; он не дополняет calibration fingerprint выдуманными hardware/backend
facts.

Complete key требует one-to-one `/api/tags` ↔ `/api/ps` digest match. Missing
source, duplicate normalized reference, changed digest, missing context/version,
remote либо unsupported hardware дают typed unavailable reason. Timestamp
остаётся observation metadata. Migration 6 хранит exact samples отдельно от
legacy `(model, context)` rows; context rows одной exact digest/runtime/hardware
family строят curve, но каждый context имеет собственный key и не перезаписывает
другой.

Нельзя использовать универсальную константу bytes-per-element для всех runtime.
На Apple unified memory учитываются total pressure и host reserve; на NVIDIA —
VRAM, RAM/offload и device topology. Remote Ollama использует remote telemetry.

UI fit:

- `Observed fit` — измерено на этом fingerprint;
- `Estimated fit` — расчёт с диапазоном/assumptions;
- `Unknown` — данных недостаточно;
- `Does not fit policy` — governor отказал при текущих limits;
- `May run with offload` — отдельное состояние, не зелёный fit.

## История, context и KV cache

Эти lifecycle независимы:

- **model weights** — установленный artifact; обычный Chat их не изменяет;
- **loaded instance** — weights/runtime buffers в RAM/VRAM;
- **KV cache** — transient результат обработки текущего prompt/context;
- **Chat history** — persistent messages/Artifacts на диске;
- **context window** — выбранная часть истории, переданная конкретному Job.

Unload обычно теряет loaded instance и KV cache, но не Chat history. Следующий Job
может заново собрать и отправить историю. Это восстанавливает смысловой контекст,
но не гарантирует тот же output из-за sampling, runtime/model version и другой
compaction.

Chat retention экономит disk и ограничивает privacy; он не освобождает VRAM сам
по себе. Model unload освобождает runtime memory; он не удаляет Chat.

## Navigation и concurrency UX

### Navigation

Всегда non-destructive. Runtime Bar и Job screen позволяют вернуться к active
work.

### Dispatch второго Job

Если второй Job совместим и policy допускает reuse, он может быть queued behind
active Job. Если требует другой model instance:

- `Queue` — default;
- `Stop current and switch` — cancel active, wait terminal/release, затем admit;
- `Parallel` — только advanced и только после Governor approval;
- `Open current` — ничего не запускает.

Не нужно спрашивать подтверждение при простом открытии нового/старого Chat.

### Multi-tab

Server state canonical. Каждая вкладка подписывается на Job events. Cancel в одной
вкладке виден остальным. Idempotency key защищает двойной submit.

## Pipeline scheduling

### Voice prompt

1. audio capture не требует model lease;
2. STT Job получает lease и создаёт Transcript;
3. speech lease освобождается;
4. пользователь редактирует transcript;
5. Chat Job получает LLM lease.

Если joint reservation и fresh telemetry достаточны, measured-parallel policy
может выполнить короткий STT одновременно с LLM Job. Это accepted future mode,
но не default.

### Long document

Upload → parse/OCR Jobs → chunk/index Artifacts → Chat/Agent Jobs. Каждый stage
имеет свой status и retry. Нельзя скрывать partial failure под одной spinner.

### Agent

First-party coding Agent Run состоит из bounded steps. Между ними сохраняются:

- plan/checkpoint;
- compacted context artifact;
- tool audit;
- unresolved approvals;
- verification record;
- watchdog/usage state.

`Checkpointed deliberate` profile:

- ограничивает один шаг;
- формирует краткий durable context;
- перечитывает plan/artifacts;
- выполняет verifier step;
- может освободить model lease между длинными waits;
- останавливается по watchdog, repeated-failure или user cancel.

Размер модели не включает этот режим автоматически.

Approval mode:

- `manual` ждёт решения на effectful boundary;
- `auto_within_policy` выполняет только actions, входящие в immutable Run policy;
- новое root/network/MCP/Skill расширение требует новую user decision;
- все tool effects сохраняют audit/evidence.

Expected benchmark — coding/research work продолжительностью 4–6 часов и более.
Качество важнее latency, но «нет денежного budget» не означает бесконечный
no-progress loop.

## Retention lifecycle

Исходник: [retention-state.mmd](diagrams/retention-state.mmd).

Current P3-D/P3-E реализует policy/activity projection и recoverable переход
`active → tombstoned in Trash`: новые Chats получают rolling seven-day default,
existing rows — explicit Keep, а accepted user message либо explicit Restore
обновляет sourced basis. Exact expiry вычисляется server-side. Один
startup/periodic owner после Chat Job recovery сканирует stable bounded pages;
любой non-terminal Job блокирует tombstone. Keep/Session не выбираются этим
scan. Scoped Trash и Restore реализованы. Expiring intermediate state,
TTL/Session grace, metadata deletion и blob GC ниже — accepted target, не
текущее поведение.

```text
active
  → expiring
  → tombstoned in Trash
  → grace
  → metadata deleted
  → unreferenced blobs collected
```

- `Keep` не получает automatic expiry.
- `7 days` — default любого нового Chat, включая Chat внутри Project.
- `7 days` использует rolling TTL только от user activity.
- `Session` становится eligible после ухода пользователя и terminal state
  связанной Job; reload/reconnect не завершают Session.
- Session Chat хранится в Trash 24 часа перед hard deletion.
- Reasoning Artifact по default истекает через 7 дней.
- Active/non-terminal Job блокирует deletion.
- Startup и periodic Maintenance owner обрабатывает bounded batches для TTL
  Chat; generic durable Maintenance Job ещё не реализован.
- Policy change до hard deletion может восстановить record.
- Cleanup event не продлевает user TTL.

## Completion notifications

Terminal transaction создаёт один notification record на Job. Web/TUI:

1. применяют global → Chat/Agent Run policy;
2. проверяют, открыт ли Job для `when_background`;
3. показывают badge/in-app notification;
4. после user permission воспроизводят короткий sound не более одного раза;
5. хранят channel delivery marker отдельно от Job.

Notification failure не меняет успешный terminal state. Payload не содержит
prompt, reasoning или result content.

## Cancellation, timeout и shutdown

### Timeouts

Различаются:

- provider connect timeout;
- model load timeout;
- stream idle timeout;
- total Job watchdog;
- tool execution timeout;
- approval timeout;
- graceful cancel deadline.

Timeout создаёт event/error category и terminal state; он не исчезает как пустой
answer.

### Cancel

1. command переводит Job в `cancelling`;
2. adapter получает AbortSignal;
3. tool/process group останавливается по effect-aware strategy;
4. partial output policy решает, сохранить ли Artifact;
5. lease освобождается;
6. `cancelled` фиксируется terminal transaction.

Повторный cancel возвращает текущее terminal state.

### Application shutdown

- перестаёт принимать новые Jobs;
- сохраняет queue;
- уведомляет active Jobs отдельной internal shutdown reason;
- закрывает Governor admission, abort-ит current operation owners и ждёт
  идемпотентный release active lease;
- current Chat owner abort-ит adapter и сохраняет `interrupted`, а уже persisted
  cancellation подтверждает как `cancelled`;
- закрывает subscribers;
- releases Alamo-owned leases согласно policy;
- закрывает SQLite;
- не останавливает external Ollama daemon по умолчанию.

Background Application Service переживает закрытие terminal. Обычное закрытие
browser/TUI не запускает shutdown sequence.

### Restart

Current P1-E recovery scan:

- только доказанно untouched typed Chat `queued` возвращаются owner;
- unsafe typed Chat executing states становятся `interrupted`;
- persisted typed Chat `cancelling` становится `cancelled`;
- generic Jobs и pending approvals остаются будущей adapter recovery работой;
- transient P1-F leases после process death не восстанавливаются, а первый
  P1-H query только samples текущие `/api/ps` и host telemetry без
  восстановления ownership.

Checkpoint resume, opt-in login autostart и обнаружение одновременно запущенного
второго application writer остаются target более поздних slices.

## Observability contract

Current P1-H–P1-L + P2-G projection реализует bounded subset:

```ts
type RuntimeSnapshot = {
  observedAt: string;
  source: RuntimeSourceHealth;
  governor: RuntimeGovernorSnapshot;
  host: RuntimeHostTelemetry;
  models: RuntimeModelObservation[] | null;
  decisions: RuntimeReconciliationDecision[];
};
```

Host source states, facts, per-model current fit, P1-I read-only Runtime Bar и
P1-J bounded Queue/exact Job Stop action реализованы. P1-K дополнительно
показывает `model_prewarm` purpose, `prewarm` priority и live explanation, но не
выдаёт operation owner за durable Job. P1-L добавляет exact
model/digest/context/runtime/hardware observation key, exact-only calibration и
digest-aware bounded `/api/show` cache. P2-C показывает typed `model_probe`
operation и manual exact result без Job Stop. P2-D/P2-E pull не входит в Governor
projection: это connection-owned download, а не inference lease/Job. P2-L exact
HF download следует той же non-Job ownership semantics: POST+SSE disconnect или
explicit cancel abort-ит writer и чистит owned partial; reload/restart не даёт
replay/resume. Проверенный blob остаётся managed staging, но не runtime model и
не Governor lease. P2-M import также connection/process-owned и non-replayable:
blob/create не являются inference lease, но последующий controlled completion
probe входит в существующий `model_probe` Governor flow. Disconnect до create
может дать clean cancel; после create server выполняет independent bounded tags
reconciliation и возвращает conflict/unknown вместо ложного cancel. Retry после
пересечения create boundary не создаёт модель повторно. Success требует fresh
exact tags + forced probe и только затем удаляет staging. P2-F filter/compare
вообще не создаёт operation owner. Production pressure/available
memory, continuous durable runtime history, safe parallel и full resource
actions ещё не реализованы. P2-G Runtime Bar показывает sourced Linux/NVIDIA
devices с redacted UUID и contained scrolling, но не aggregate capacity либо
future fit. Target projection остаётся шире:

Runtime projection:

```ts
type RuntimeSnapshot = {
  observedAt: string;
  host: HardwareProfile;
  jobs: JobSummary[];
  queue: QueueSummary[];
  models: RuntimeModel[];
  leases: LeaseSummary[];
  pressure: ResourcePressure;
  sourceHealth: SourceHealth[];
};
```

Каждое значение памяти имеет source/confidence. UI polling frequency адаптивна:
чаще во время transitions, реже idle. Logs коррелируются `jobId`, но не содержат
private prompt/thinking/secrets по default.

## P0 safety bridge

До полного Job Engine минимальный переходный слой:

1. исправить effect и добавить Error Boundary;
2. добавить turn/run status, error и stop reason;
3. считать missing terminal chunk failure;
4. ввести global exclusive inference mutex;
5. блокировать conflicting compaction;
6. сделать реальный running-model panel;
7. убрать page unmount cancellation либо явно сохранить `cancelled`;
8. добавить deterministic first-turn/navigation tests.

P0-A локально реализовал пункт 1 и узкий first-stream regression из пункта 8.
P0-B реализовал пункты 2–3, truthful connection cancellation из пункта 7 и
failure/reload regression из пункта 8. P0-C реализовал пункты 4–5, включая
warm/load boundary и повторную compaction по persisted `seq`.
P0-D реализовал пункт 6 как минимальную sampled Chat/Runtime projection,
правдивые health/catalog sources и bounded connect/load/stream-idle deadlines.
P1-D добавил durable Chat execution/detach/reattach, P1-E — bounded startup
reconciliation, P1-F — typed process-local Governor admission/lease foundation,
P1-G — query-time `/api/ps` reconciliation и additive `GET /api/runtime`, P1-H —
sampled Apple host facts и observed/unknown current-fit explanation, P1-I —
read-only persistent Runtime Bar с bounded adaptive polling, P1-J — sampled
conflict decision с safe Queue и exact Job cancel acknowledgement. P2-G добавил
truthful local Linux/NVIDIA per-device telemetry prototype без fit/admission
promotion. Production pressure/available-memory source, safe parallel и другие
resource actions остаются target.

Это bridge, а не повод закрепить current POST/SSE как финальный API.
