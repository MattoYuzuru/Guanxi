# Runtime, Jobs и память

**Статус:** mixed — diagnosis locally validated, lifecycle target accepted

**Проверено:** 2026-08-02  
**Критичность:** основной correctness и safety boundary

## Подтверждённое current behavior

### Turn

```text
UI POST/SSE
→ INSERT user
→ activeTurns.set(threadId)
→ inspect capabilities
→ INSERT empty assistant
→ Ollama /api/chat keep_alive=10m
→ stream thinking/content/tools
→ UPDATE assistant
→ done
```

Lock запрещает только второй turn в том же thread. Другой thread может начать
параллельный inference.

На route/thread change `useChat` abort-ит stream; server связывает disconnect с
AbortController. Generation прекращается, но модель может оставаться в Ollama
до `keep_alive` expiry. Это одновременно теряет работу и не освобождает память.

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

### Почему reload показывает пустой assistant

Пустой assistant уже сохраняется до Ollama request. До P0-A наблюдавшийся React
crash закрывал stream, abort проходил до начала runtime generation, а
status/error не персистились. P0-A устранил эту конкретную client-причину, но
любой другой disconnect/abort всё ещё способен оставить ambiguous row. Локально
наблюдавшийся проблемный thread имел четыре пустых assistant rows с `usage:null`;
в Ollama log в эти моменты не было `POST /api/chat`.

Дополнительный current defect: EOF без final Ollama chunk может интерпретироваться
как успешный empty stop.

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
Turn terminal persistence, disconnect semantics и остальные bridge items не
изменены.

Это bridge, а не повод закрепить current POST/SSE как финальный API.
