# Runtime, Jobs и память

**Статус:** mixed — diagnosis locally validated, lifecycle target accepted

**Проверено:** 2026-08-03
**Критичность:** основной correctness и safety boundary

## Подтверждённое current behavior

### Turn

```text
UI POST/SSE
→ activeTurns.set(threadId)
→ inspect capabilities
→ wait for process-local exclusive inference permit
→ INSERT user
→ INSERT empty assistant, turn_status=pending
→ Ollama /api/chat keep_alive=10m
→ stream thinking/content/tools
→ one CAS UPDATE with output + completed/failed/cancelled + error/stop reason
→ terminal SSE done
→ release permit
```

`activeTurns` запрещает второй request в том же thread и даёт Stop controller,
но не владеет host resource. P0-C добавил один `ExclusiveInferenceBridge` в
application composition. Разные threads ждут его FIFO, поэтому участвующие
Chat turns, compaction и explicit model warm/load не входят в Ollama inference
одновременно.

Ожидание существует только в памяти и привязано к текущему request/connection.
Chat использует совместимую фазу `sending`; durable queue, priority, replay и
restart recovery не изображаются. Отменённый waiter удаляется без отмены owner
и до сохранения user/assistant rows.

На route/thread change `useChat` abort-ит stream; server связывает disconnect с
AbortController. P0-B различает explicit Stop (`stopped_by_user`) и закрытие
соединения (`connection_aborted`) и сохраняет `cancelled` с partial output.
Generation всё равно прекращается, а модель может оставаться в Ollama до
`keep_alive` expiry. Это по-прежнему одновременно теряет работу и не освобождает
память.

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

### P0-C exclusive inference bridge

Bridge имеет ровно один process-local owner и FIFO waiters. Permit держится весь
connection-owned turn, включая tool/approval phases, как консервативная временная
граница; compaction и warm/load держат его до завершения route operation.
Идемпотентный release находится в `finally`, поэтому provider/protocol/storage
error, Stop, connection abort и generator return не блокируют следующий request.

Compaction выбирает prefix после admission и получает boundary из реального
persisted `messages.seq`. После предыдущего summary следующая compaction больше
не использует array index, не оставляет уже суммированные rows в tail и передаёт
следующему turn упорядоченный context.

Bridge не защищает внешний Ollama client или второй application process, не
наблюдает `/api/ps`, не управляет leases/model eviction и не допускает measured
parallelism. Bounded provider deadlines освобождают участвующий request, но не
превращают bridge в host-wide Resource Governor.

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

Caller-owned Stop/connection abort имеет приоритет, включая гонку с deadline:
результат остаётся `cancelled` с authoritative `stopped_by_user` либо
`connection_aborted`. Любой timeout/provider/abort path выходит через
идемпотентный release P0-C permit и допускает следующего waiter.

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
Foundation входит в server composition, но current Chat turn его не использует.

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
owner должен подтвердить остановку перед `cancelled`. State без canonical edge
возвращает controlled conflict без event.

P1-C создаёт API durable records, но не Job executor. Новый Job правдиво остаётся
`queued`; current Chat POST/SSE по-прежнему connection-owned и не использует эти
routes.

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

Prewarm начинается после model selection и debounce только если:

- Governor idle;
- variant/operation уже resolved;
- estimate не unknown-high-risk;
- нет более приоритетного Job;
- пользователь не отключил prewarm.

Prewarm не должен загружать все карточки, hovered models или каждый Chat в
background. New Job может отменить его до load либо забрать совместимый lease.

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
- Startup и periodic Maintenance Jobs обрабатывают bounded batches.
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
- уведомляет active Jobs;
- bounded graceful cancel/checkpoint;
- закрывает subscribers;
- releases Alamo-owned leases согласно policy;
- закрывает SQLite;
- не останавливает external Ollama daemon по умолчанию.

Background Application Service переживает закрытие terminal. Обычное закрытие
browser/TUI не запускает shutdown sequence.

### Restart

Recovery scan:

- `queued` возвращаются в очередь;
- executing states становятся `interrupted`;
- adapter с безопасным checkpoint может предложить explicit resume как новый
  attempt;
- pending approvals восстанавливаются;
- `/api/ps` reconciles remaining instances;
- stale leases закрываются journaled recovery event.

Opt-in login autostart после recovery scan поднимает тот же canonical service и
settings store. Одновременно запущенный второй writer обнаруживается до открытия
SQLite на запись.

## Observability contract

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
failure/reload regression из пункта 8. Navigation всё ещё отменяет current turn,
потому что durable Job/reattach не входит в bridge. P0-C реализовал пункты 4–5,
включая warm/load boundary и повторную compaction по persisted `seq`.
P0-D реализовал пункт 6 как минимальную sampled Chat/Runtime projection,
правдивые health/catalog sources и bounded connect/load/stream-idle deadlines.
Полный Runtime Bar, leases, durable execution и restart recovery остаются target.

Это bridge, а не повод закрепить current POST/SSE как финальный API.
