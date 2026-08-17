# High-level architecture

**Статус:** mixed — as-is implemented/locally validated, target accepted

**Проверено:** 2026-08-17
**Решение:** сохранить local-first modular monolith

## Обозначения

- **As-is** — поведение, подтверждённое кодом и локальным аудитом.
- **Target** — принятая архитектура; её компоненты ещё нельзя считать
  реализованными.
- **Ollama host** — процесс/runtime Ollama; может быть локальным или удалённым.
- **Application host** — процесс Alamo server/daemon.

## As-is

Исходник диаграммы: [hld-system-as-is.mmd](diagrams/hld-system-as-is.mmd).

```text
Browser ─ REST + POST/GET SSE ─> Node/Hono server ─ HTTP/NDJSON ─> Ollama
                                  │
                                  ├─ SQLite ~/.alamo/alamo.db
                                  ├─ workspace filesystem
                                  └─ local shell

CLI ─ foreground start/open ──────┘
Contract package ─ Zod types ─ browser + server
```

Это локальный модульный монолит из четырёх npm workspaces:

| Компонент  | Ответственность                                    |
| ---------- | -------------------------------------------------- |
| `contract` | Zod domain/API/event schemas                       |
| `server`   | Hono composition, stores, Ollama, agent и tools    |
| `web`      | React UI и typed REST/SSE client                   |
| `cli`      | foreground launcher и reuse уже запущенного server |

Ollama — отдельный runtime и фактический владелец model weights/RAM/VRAM.
SQLite хранит settings, threads/messages, nullable immutable Project ownership,
versioned Chat retention policy/user-activity basis, workspaces, logical
Projects, canonical scoped Quick Run metadata с общей retention policy,
canonical Recipe identities/immutable revisions/queued Job snapshots,
versioned Project presentation metadata и
filesystem bindings, tool journal,
legacy
calibration, exact P1-L observation samples, `jobs`/`job_events` и P1-D private
Chat input association. Message bridge хранит
`pending/completed/failed/cancelled`, safe error, stop reason и `jobId`. Public
Job API читает canonical records, replay-ит persisted events через GET SSE и
выполняет explicit cancel поверх одного `JobService`. Chat execution подключён
к тому же service через один application `ChatJobExecutionOwner`; controller,
subscriber wake-ups, typed Resource Governor tickets/leases и approvals остаются
в памяти, но command intent, lifecycle и replay output находятся в SQLite. P1-E
startup coordinator bounded-страницами reconciles v5 Chat associations до HTTP
listen.

P3-D migration 14 additive хранит `Keep | ttl(7 days) | Session`, источник
policy и последний accepted user-activity timestamp. Existing Threads получают
conservative `Keep / legacy_compatibility`; новые Project и projectless Chats —
одинаковый TTL default. Exact expiry вычисляет server. GET/PATCH retention не
вызывает Job, Ollama, Governor, tool или filesystem boundary. P3-E migration 15
добавляет recoverable `active | trash`, sourced tombstone/audit и indexes для
stable TTL scan. Один server-owned startup/periodic owner обрабатывает bounded
batches, исключает каждый non-terminal Chat Job и не вызывает Ollama, Governor,
tools или filesystem. Trash scoped по Project либо projectless; Restore и смена
policy на Keep/7 days возвращают Chat и начинают новый rolling basis. P3-H
migration 18 добавляет sourced server-time basis для только явной versioned
Leave session команды с exact Chat/Project scope. Тот же owner после Job recheck
переводит Session Chat в Trash; projection вычисляет ровно 24 часа recovery от
tombstone. Restore/Keep/7 days до deadline очищают basis. Reload, reconnect,
transport lifecycle и restart сами leave не создают. P3-I migration 20
добавляет content-free `chat_deletion_audit`, а тот же owner после recovery
deadline stable bounded pages удаляет Session Thread и directly owned SQLite
metadata. Scan и transaction CAS исключают non-terminal Jobs; audit insert и
Thread delete атомарны. Durable Jobs/events сохраняются, а их private
Chat input bridge удаляется по current FK ownership. TTL Trash hard deletion,
generic blob GC и filesystem cleanup не реализованы. Append-only migration 19 harden-ит уже
применимую v18 schema: invalid existing Session Trash fail-closed останавливает
upgrade, а новые raw writes без exact leave basis отклоняются trigger-ом.

P3-J migration 21 additive создаёт отдельную `quick_runs` table: immutable
identity/operation/Project ownership, sourced policy version 1 и timestamps.
Project FK restrictive, exact projectless/Project scopes не смешиваются, а
create/PATCH metadata не вызывают Job, Ollama, Governor, tools, filesystem или
Chat maintenance. Execution, Artifact/Result storage и Quick Run cleanup не
подключены; Session enforcement остаётся `not_implemented` до owner decision.

P3-K migration 22 additive создаёт `recipes` и `recipe_revisions`: identity и
nullable restrictive Project ownership immutable, presentation name изменяется
отдельно, а configuration хранится canonical immutable numbered bytes с
SHA-256/size provenance. `BEGIN IMMEDIATE` атомарно создаёт identity + revision 1
и сериализует expected-revision CAS; stale writer не оставляет partial row.
Strict scoped REST читает current/exact historical revision, а Web показывает
current revision. Ни одна граница не создаёт Job, не обращается к Ollama/
Governor/provider/filesystem и не реализует execution либо automatic routing.

P3-L migration 23 additive создаёт private immutable
`recipe_job_snapshots`. Exact Recipe revision одной transaction становится
одним canonical `inference` Job в `queued`, sequence-1 content-free lifecycle
event и snapshot canonical configuration bytes/hash/size. Restrictive FK и DB
guards связывают scope, Project, Recipe/revision, Job identity и initial event;
UUID idempotency scope глобален для этой команды. Snapshot не является Chat
input и не попадает в safe event metadata. Его POST/GET и Web confirmation не
подключены к execution owner, Governor, Ollama или Artifact storage.

P3-M migrations 24–25 additive создают immutable versioned
`context_checkpoints` поверх сохранённых Messages. Checkpoint фиксирует exact
Thread/boundary/source count, previous link и UTF-8 summary size/SHA-256; read
fail-closed проверяет всю цепочку и сохранённый source. Public history оставляет
original Messages на месте, а model context использует только latest summary и
post-boundary tail. Client UUID связывает ambiguous/repeated POST; route
reconcile-ит exact committed intent до provider и повторно после Governor
admission, поэтому concurrent retry не запускает второй summary call. Legacy
destructive summary помечается `legacy_source_unavailable`, а не выдаётся за
сохранённую историю.

P3-N migration 26 additive создаёт отдельные immutable `artifact_blobs` и
`artifacts`; существующие diagnostic reasoning rows, context checkpoints и HF
staging не мигрируют. Server пишет bytes в private temp, сам считает exact
SHA-256/size, публикует no-overwrite content address и только затем одной SQLite
transaction фиксирует blob/reference metadata. Одни bytes могут иметь несколько
Artifact identities. Directory-identity handoff закрывает prefix symlink-swap
между проверкой и publish/read; final bytes всегда повторно хэшируются.
Filesystem/SQLite не объявляются одной atomic transaction: post-publish/pre-DB
orphan не читается по Artifact ID и виден через bounded inventory. Generic GC
пока не реализован.

P3-O migrations 27–28 additive добавляют immutable attachment presentation
metadata и fail-closed C0 filename hardening поверх generic Artifact. Public
loopback REST принимает raw bounded bytes с server-derived hash/size/storage key,
stable UUID intent и exact Project/projectless scope. Отдельный transfer owner
публикует sourced storage policy, держит один active helper и bounded FIFO queue;
abort/disconnect/watchdog освобождают child, permit, listeners и temp. Download
повторно валидирует content и возвращает safe RFC 5987 disposition, exact typed
headers, `private, no-store`, `nosniff` и sandbox CSP; Range явно unsupported.
Standalone Web library показывает bounded/truncated list, upload/cancel/retry и
export, но честно не подключает attachment к model context, Recipe или Job.

P3-P расширяет existing `settings` key/value boundary без новой migration:
server хранит strict `en | ru`, default/provenance и атомарно применяет patch.
Browser-owned `LocaleProvider` загружает setting single-flight и владеет root
`lang`; complete English source/fallback, curated Russian и 17-entry Glossary
остаются Web presentation data. Raw provider/server message не владеет
локализацией: typed API code и locale-neutral shape error переводятся при render.
Эта граница не вызывает Ollama, Governor, Job, filesystem или external network.

P3-F migration 16 additive хранит immutable version 1 diagnostic Reasoning
Artifact в SQLite: exact UTF-8 text, byte size, SHA-256, source Chat/Message/Job,
immutable Project/projectless ownership и seven-day diagnostic expiry. Final
answer остаётся в `messages.content`; новый terminal row не дублирует reasoning
в `messages.thinking`, а compatibility Message projection читает Artifact и
fallback-ит только на literal legacy column. Artifact list/read доступны только
для exact active Chat scope и не запускают runtime effects. P3-G migration 17
добавляет content-free deletion audit. Тот же server-owned Maintenance owner
исполняет seven-day/shorter-current-parent expiry stable bounded batches,
повторно проверяет current policy и non-terminal Jobs и атомарно удаляет exact
Artifact с audit row. Enforcement projection versioned отдельно от Artifact
data version. Final answer, Message/Job, legacy thinking, generic blob GC и Chat
hard deletion не затрагиваются.

### As-is execution boundary

Текущий `POST /threads/:id/messages`:

1. валидирует thread, immutable input и optional UUID idempotency key;
2. одной transaction создаёт queued Chat Job, initial event, private input и
   user/pending-assistant pair;
3. передаёт Job application execution owner, который один владеет controller;
4. возвращает compatibility SSE subscription на persisted Job events.

Owner проходит canonical states, создаёт immutable admission request и ждёт
одну process-local Resource Governor lease, запускает Ollama stream и сначала
persist-ит каждый private output event. Тот же `context.governor` выдаёт lease
для compaction и explicit model warm/load. Второй Chat Job имеет durable
ID/events и продолжает работу после subscriber disconnect, но tickets/leases
всё ещё process-local и не восстанавливаются при restart.

Browser disconnect/route change закрывает только subscription. При возврате Web
находит `jobId` в pending assistant, читает canonical Job и replay-ит ordered
private output из SQLite. Explicit Stop и public cancel проходят через owner:
durable `cancelling`, provider abort, затем один `cancelled/stopped_by_user`.
Assistant projection, optional Reasoning Artifact и terminal Job/event
commit-ятся атомарно; injected Artifact/checksum failure не публикует terminal
state. Pending/replay thinking остаётся private Job output, а terminal reload
проецирует те же bytes из canonical Artifact.

После открытия/migration SQLite, но до публикации HTTP health, startup recovery
сначала сканирует все non-terminal typed Chat Jobs в стабильном порядке. Unsafe
executing states становятся `interrupted`, persisted `cancelling` подтверждается
как `cancelled`, и только untouched `queued` без execution/output evidence
schedule-ится существующим owner. Partial Message собирается из ordered private
output; Message, Job и terminal output commit-ятся одной transaction. Malformed
association/output или storage failure закрывает DB и не начинает listen.

Provider adapter ограничивает connect, load и stream-idle отдельно. Валидный
stream progress обновляет только idle deadline; timeout сохраняет failed partial
outcome и освобождает active lease. Caller-owned Stop/disconnect имеет
приоритет над совпавшим deadline.

Application shell остаётся доступным при degraded Ollama. `/api/version`,
локальный catalog cache/bundled snapshot и `/api/ps` публикуются как раздельные
sampled observations с source/time. Installed state приходит из `/api/tags`;
loaded rows — только из `/api/ps`. P1-G добавил один application
`RuntimeReconciliationService`: `GET /api/runtime` и compatibility
`GET /api/models/running` делят pending provider sample и один injected
`HostTelemetry` sample. На Apple Silicon adapter параллельно вызывает только
bounded `/usr/bin/vm_stat`; P2-G на local Linux с detected CUDA profile вызывает
один fixed shell-free `/usr/bin/nvidia-smi` query с теми же 1 s/64 KiB bounds и
публикует per-device index/nullable UUID/name/total/current-free VRAM. Другие
hosts возвращают `unsupported` без host command. Partial/malformed/duplicate и
command failure не становятся healthy empty/zero. После завершения обоих
источников service выбирает один
`observedAt`, снимает Governor state и классифицирует exact normalized active
reference, unmatched active lease и unknown-owner runtime rows. Ошибки Ollama и
host telemetry независимы. Completed server sample/cache/history не хранится.
P1-I Web Runtime Bar выполняет bounded query polling: 2 s при active/queued,
10 s idle, pause в hidden document и immediate refresh после visibility return.
Он сохраняет confirmed sample при refresh failure и не владеет Job, lease,
cancel, load или unload.
P1-J поднимает этот poller в один persistent shell `RuntimeProvider`. Chat
использует caller-scoped bounded fresh reads того же single-flight: Queue
передаёт один command с canonical client UUID в server-owned FIFO, а Stop
доступен только для повторно подтверждённого exact Job owner и вызывает public
Job cancel до terminal acknowledgement. Dialog/navigation не владеют lease и
не отменяют shared polling либо active Job по unmount.

P1-K добавляет отдельный typed `POST /api/models/:name/prewarm`. New Chat
selector после 600 ms стабильного exact installed выбора отправляет Chat context,
digest и fit basis; hidden/unmount/selection/setting cleanup отменяет только этот
request. Server повторно валидирует facts, exact resident identity и setting,
после чего `ResourceGovernor` допускает lowest-priority `prewarm` lease только
без normal work. Новый normal intent отменяет queued prewarm либо abort-ит exact
active prewarm owner и ждёт release, не меняя FIFO normal Jobs. Short prewarm
`keep_alive=2m` не меняет explicit warm/turn `10m`; prewarm не durable и не
переживает disconnect.

P1-L добавляет один versioned observation-key builder для model/runtime evidence.
`/api/tags`, `/api/ps`, `/api/version`, requested/observed context и sourced
local Apple profile дают complete key только при однозначном digest match.
Incomplete/remote/ambiguous identity публикуется как typed unavailable reason.
Migration 6 хранит exact samples отдельно и не credit-ит legacy name-only rows;
`/api/show` cache удерживает не более 64 normalized references и invalidates row
при смене digest того же имени.

P2-A добавляет transient installed descriptor поверх тех же documented local
endpoints. `/api/tags` остаётся installation source и exact digest basis;
`/api/show` даёт отдельную provider declaration без digest binding, а
`/api/version` — sourced runtime fingerprint. Missing, malformed, conflicting,
unavailable, future enum и ambiguous normalized-reference facts остаются
unknown/degraded. Installed list/detail REST shape расширена совместимо, Web
показывает state/source/time и прямо отделяет declaration от probe/runtime proof.
P2-B добавляет persistent safe evidence cache в SQLite migration 7, но не full
Capability Registry. Exact row keyed provider/reference/digest/runtime/schema
читается fresh 15 минут; unavailable detail может использовать explicit
stale/offline row ещё 7 дней. Перед write повторные `/api/tags` и `/api/version`
должны подтвердить прежнюю identity. Один per-key flight и общий four-worker
pool ограничивают duplicate detail work. В scope P2-B Marketplace, probes и
import не менялись.

P2-C добавляет первый narrow runtime proof отдельно от descriptor aggregation:
explicit `completion` probe для exact installed Ollama fingerprint. Web сначала
объясняет краткий load и требует confirmation; server владеет prompt/options,
проходит normal-priority `model_probe` через canonical Governor и проверяет
tags/runtime identity до и после bounded call. Только terminal non-empty response
становится `verified`; provider/protocol/timeout/persistence failure остаётся
degraded, cancel — cancelled, а unsafe identity/fit/context — unknown/skipped.
Connection владеет wait: это не durable/replayable Job.

P2-D добавляет bounded manual reference/pull boundary, не весь import subsystem.
Marketplace Web по explicit submit отправляет name либо official Ollama page URL
на pure local preview; server normalizer fail-closed сводит только разрешённую
grammar к canonical lower-case name с explicit tag. Confirmation start заново
проверяет original reference и exact confirmed name, затем documented local
`/api/pull` отдаёт validated progress через существующий additive SSE contract.
Только provider `success` даёт terminal `done`; disconnect/cancel прекращает
этот connection-owned wait. После success Web отдельно перечитывает `/api/tags`;
preview/pull target не становится installed/capability evidence и не запускает
P2-C probe автоматически.

P2-E делает текущий local/bundled Marketplace variant-first. Catalog assembler
проводит base/tag/namespace через тот же strict P2-D normalizer, вычисляет fit по
claimed size каждого exact row и сопоставляет installation только с exact
normalized `/api/tags` row. Invalid/duplicate rows не получают удобный default
target. Top-level family installed и largest-variant fit остаются additive
compatibility projections, а variant несёт собственные source/freshness/times.
Web требует selection и confirmation, фиксирует target на время pull и после
terminal success принимает digest только из одного exact Installed descriptor.
Это не persistent registry, immutable tag resolution, durable download или
remote catalog provider.

P2-F добавляет bounded discovery поверх тех же validated rows. Strict REST query
кодирует multi-select одним CSV value, применяет OR внутри facet group и AND
между groups; repeated/unknown/invalid input fail-closed до source access.
Installation/fit/context/size должны совпасть на одной exact variant row, тогда
как scope/source/freshness/capability остаются model-level claims. Web владеет
только debounced query и page-local pair selection: late response игнорируется,
vanished exact target удаляется с объяснением, а compare показывает две rows без
winner/recommendation. Filter/compare не создаёт pull, probe, load, remote fetch,
cache write или runtime evidence.

P2-H делает discovery response/render bounded без total catalog ceiling.
Explicit `page + pageSize` включает additive paged mode; отсутствие обоих keys
сохраняет legacy full-list response. Server один раз читает разрешённый source,
до slicing выполняет P2-E validation, global duplicate-target fail-closed,
P2-F filtering и stable code-unit ordering, затем сообщает exact model-row total,
pages и previous/next. Maximum 100 ограничивает только одну response page; Web
использует 12, показывает constant Previous/Next pager и не создаёт total-
proportional controls. Две exact compare snapshots переживают page navigation,
но query/filter/context/source basis change очищает их явно. Active P2-D/P2-E
pull остаётся connection-owned: pager disabled и не отменяет operation.

P2-I вводит первое user-owned capability состояние. Пользователь на Installed
profile явно утверждает одну capability для exact `(canonical reference, digest,
sourced runtime version)`; assertion живёт отдельной append-only SQLite row,
переживает restart и экспортируется как safe typed JSON. Server владеет
identity: mutation допускается только при одном canonical `/api/tags` match,
exact expected digest и sourced local `/api/version`, а identity перечитывается
в точке mutation, поэтому stale client expectation или подменённый artifact дают
controlled conflict вместо записи по имени. Assertion не наследуется другим
digest, runtime version или Marketplace row, не переписывает provider
declaration и completion probe и показывается отдельным labelled регионом. Value
только positive: отсутствие row остаётся unknown, а не unsupported. Mutation не
запускает chat/pull/load/unload, Governor admission, probe, catalog refresh или
background Job.

### As-is deployment

- CLI запускает application server в foreground;
- server раздаёт API и production SPA с одного loopback origin;
- Vite в dev проксирует API;
- daemon/PID/control socket нет;
- bind на non-loopback технически возможен, но security profile не реализован.

### As-is data ownership

| Состояние                            | Владелец                                | Durability                  |
| ------------------------------------ | --------------------------------------- | --------------------------- |
| Threads/messages/settings/workspaces | SQLite stores                           | persistent                  |
| Project metadata/bindings            | SQLite migrations 10–11                 | persistent additive bridge  |
| Project Chat ownership               | SQLite migrations 12–13                 | nullable immutable relation |
| Effective feature-flag policy        | `FeatureFlagRegistry` startup snapshot  | process memory              |
| Message terminal bridge              | SQLite `messages` v3 columns            | persistent                  |
| Job/event/output store               | SQLite `jobs`/`job_events` v5           | persistent                  |
| Chat input/Message association       | SQLite `chat_job_inputs`/`messages`     | persistent                  |
| Chat execution owner                 | application `ChatJobExecutionOwner`     | process memory, intent в DB |
| Chat startup recovery                | application startup coordinator         | bounded scan, truth в DB    |
| Job HTTP subscription listeners      | application `JobService`                | process memory, events в DB |
| Tool run record                      | SQLite                                  | persistent после выполнения |
| Active/waiting Chat controller       | `ChatJobExecutionOwner`                 | process memory              |
| Resource admission/active lease      | application `ResourceGovernor`          | process memory              |
| Runtime reconciliation/sample        | `RuntimeReconciliationService`          | process memory, без history |
| Static/dynamic host telemetry        | injected Apple/NVIDIA `HostTelemetry`   | sampled, без history        |
| Pending approval                     | `ApprovalGate`                          | process memory              |
| Runtime Bar HTTP wait/timer          | persistent Web shell component          | page memory, query-only     |
| Pending Chat conflict intent         | Chat decision component                 | page memory, one UUID key   |
| Automatic prewarm request/controller | New Chat + server operation owner       | request/process memory      |
| Exact calibration observation        | SQLite migration 6                      | persistent exact-key rows   |
| Installed safe provider evidence     | SQLite migration 7                      | exact 15m fresh + 7d stale  |
| Latest exact completion probe        | SQLite migration 8                      | latest exact-key projection |
| User capability assertion            | SQLite migration 9                      | one row per exact key       |
| Active completion probe/controller   | HTTP request + `ResourceGovernor`       | request/process memory      |
| Active confirmed Ollama pull         | HTTP request + Ollama `/api/pull`       | connection/provider owned   |
| Catalog page/filter/variant/compare  | paged REST + max two exact snapshots    | sampled facts + page memory |
| `/api/show` normalized front-cache   | `ModelService` bounded LRU              | process memory, 64 refs     |
| Chat/Job SSE output                  | SQLite event output + HTTP subscription | persistent private replay   |
| Streaming projection                 | React `StreamBuffer`                    | page memory                 |
| Loaded model                         | Ollama                                  | external runtime            |
| Catalog response                     | stale local cache/bundled snapshot      | sampled fallback            |
| Binary assets                        | отдельной canonical store нет           | partial/not implemented     |

### Основные current risks

1. Process-local Governor показывает sampled `/api/ps` drift, но не координирует
   внешний Ollama client или второй Alamo process и не считает неизвестного
   владельца внешним установленным фактом.
2. P1-K поддерживает только `normal > prewarm` на одном permit; нет measured
   parallelism, fairness для будущих priorities или координации provider вне
   этого application process.
3. Turn/explicit warm `keep_alive: 10m` и prewarm `2m` просят Ollama удерживать
   model, но не являются точным unload timer либо гарантией будущей residency.
4. P1-E восстанавливает single-process Chat truth после restart, но не даёт
   checkpoint/resume executing inference и не координирует второй process.
5. Generic public Job и P3-L Recipe snapshot Job без execution owner остаются
   queued и не исполняются.
6. Private input/output находится в локальной SQLite без отдельного encryption
   boundary; plaintext settings уже остаются известным долгом.
7. Remote bind открывает filesystem/shell boundaries без реальной authentication.
8. Production Apple adapter наблюдает total unified memory и system free pages,
   но не имеет официально подтверждённого current available-memory/pressure
   source; поэтому current fit остаётся `unknown`.
9. `/api/runtime` содержит query-time host/fit projection, но не является
   continuous truth, future admission guarantee или remote-host telemetry.
10. Catalog не имеет разрешённого live provider; local cache и bundled snapshot
   могут отставать.
11. P1-J conflict decision использует sampled facts и fail-closed Stop; он не
    является cross-process lock, future-admission guarantee или full Jobs UI.
12. P1-L exact keys доказаны только deterministic local Apple fixtures; live
    Ollama/hardware, remote telemetry и durable continuous history не проверены.
13. P1-K exact reuse проверяет текущие name/digest/context facts, но continuous
    runtime history и production TTL/residency validation ещё отсутствуют.
14. P2-B cache хранит один latest exact safe row на normalized reference, но не
    full evidence history/registry. TTL/stale — application policy, а не
    provider guarantee; live Ollama и multi-process contention не проверены.
15. P2-C verified доказывает только basic terminal non-empty completion для
    exact fingerprint/probe version. Live model/hardware, semantic quality,
    tool/media support, external clients и multi-process admission не проверены.
16. P2-D pull не durable/replayable, не резервирует disk и не проверяет artifact
    checksum. Cancel закрывает owned wait, но partial provider data и concurrent
    external pulls остаются поведением Ollama; live large downloads не проверены.
17. P2-E exact target относится к mutable catalog tag и claimed metadata. Он не
    разрешает immutable digest до pull, не резервирует disk и не доказывает live
    hardware fit; post-success installation зависит от нового `/api/tags` sample.
18. P2-H pages/facets/compare работают только над current local/bundled response
    и не доказывают provider completeness или immutable multi-request snapshot.
    Legacy clients всё ещё могут запросить полный list; saved filters, generic
    virtualization, 10k/live load evidence и remote provider отсутствуют.
19. P2-G Linux/NVIDIA telemetry проверена fake runner, а не live driver/GPU.
    Она не связывает `/api/ps` row с device, не знает MIG/topology/pressure и не
    превращает current free VRAM в admission capacity, measured fit или второй
    Governor permit.
20. P2-I user override — это заявление пользователя, а не verification. Оно не
    доказывает, что модель действительно умеет capability, не включает Task
    Adapter и не участвует в admission/fit. Отсутствие override не означает
    unsupported. Полный Capability Registry, generic precedence/conflict
    resolver, negative override, audit history, multi-user profile и
    sync/cloud export не реализованы.
21. P2-N feature flags снимаются один раз при startup и не имеют persisted user
    choice или live reload. Первый declaration default-off; P2-O читает его
    только через typed registry, но Governor по-прежнему не меняется.
22. P2-O добавляет отдельный strict pair-scoped read query. Он revalidate-ит
    active/queued identity, internal Ollama endpoint, exact calibration и
    sourced host/model facts, но не выдаёт positive headroom за approved
    capacity. Current production adapters возвращают `unknown`; arithmetic deny
    доказан только injected fixtures. Второго permit, Web consumer, persistence
    и model lifecycle side effects нет.

Подробности: [RUNTIME_LIFECYCLE](RUNTIME_LIFECYCLE.md).

## Target

Исходник: [hld-system-target.mmd](diagrams/hld-system-target.mmd).

### Архитектурный стиль

Сохраняется один application process и SQLite. Внутри процесса вводятся
application modules с явными контрактами:

```text
Web / CLI / TUI / Agent CLI
       │
API + event subscriptions
       │
Background Application Service
├── Project / Chat / Recipe
├── Job Engine + Event Store
├── Resource Governor
├── Capability Registry
├── Adapter Registry
├── Catalog Service
├── Agent Engine
├── Maintenance / Notifications
├── Integration Policy
└── Artifact Service
       │
Infrastructure adapters
├── SQLite
├── content-addressed artifact store
├── Ollama
├── host telemetry
├── filesystem/sandbox
└── allowed external providers
```

Microservices, network broker и distributed database не нужны текущему
single-user scale. Модульные границы нужны для correctness и разных клиентов, а
не для разнесения процессов.

### Target components

#### Job Engine

- создаёт Job идемпотентно;
- персистит status и append-only events;
- отделяет execution от connection;
- поддерживает attach/replay/cancel;
- восстанавливает interrupted Jobs после restart;
- оркестрирует pipeline и tool checkpoints.

#### Resource Governor

- единственный admission point для local inference;
- держит global queue и accelerator permits;
- выдаёт model leases;
- согласует desired state с Ollama `/api/ps`;
- принимает host telemetry;
- выполняет preload/eviction/unload policy;
- объясняет решения UI.

#### Capability Registry

- нормализует model identity, variants, operations и evidence;
- сохраняет declared/inferred/probed/user claims;
- строит runtime fingerprint;
- не превращает unknown в unsupported;
- предоставляет descriptors Adapter Registry и Marketplace.

#### Adapter Registry

- маппит Operation Descriptor на provider protocol;
- валидирует input/parameters;
- переводит stream в нормализованные Job Events;
- создаёт typed Artifacts;
- сообщает renderer/schema/UI hints без hardcoded model-name branches.

#### Catalog Service

- агрегирует разрешённые providers;
- валидирует schemas;
- хранит cache/freshness/provenance;
- использует stale-while-revalidate;
- отделяет discovery claim от installability/runtime verification.
- нормализует user-supplied Ollama name/page URL;
- ищет exact Hugging Face GGUF через официальный API; **current state (P2-M):**
  read-only discovery и exact file/commit preview дополнены explicit
  connection-owned download в managed staging с streamed SHA-256 и bounded GGUF
  header inspection, а отдельный confirmed local import использует Ollama blob +
  `/api/create`, exact `/api/tags` observation и controlled completion probe.
  Обе операции остаются connection/process-owned, а не Job;
- не выполняет Ollama catalog scraping.

#### Agent Engine

- предоставляет независимый coding-first API/CLI;
- ведёт plan, bounded steps, checkpoints и verification;
- исполняет Manual или Auto-within-policy runs;
- использует Project filesystem/MCP/Skills bindings;
- не зависит от Claude Code/Codex executable или protocol identity.

#### Artifact Service

- хранит metadata в SQLite;
- большие blobs — в content-addressed local filesystem;
- поддерживает derivation, preview, export, retention и garbage collection;
- не передаёт большие media через бесконечные JSON rows.

#### Integration Policy

- управляет Tools, MCP Connections и Skills;
- вычисляет effective permissions по scope;
- персистит approvals/audit;
- разделяет local и remote security profiles.

#### Maintenance и Notifications

- Maintenance Job применяет Chat/Artifact expiry при startup и по расписанию;
- Trash/grace отделяет expiry от окончательного удаления blobs;
- terminal Job создаёт local notification record;
- Web/TUI решают visual/sound delivery по policy и permissions.

### Clients

Web, non-interactive CLI, TUI и first-party Agent CLI используют один API и одни
application semantics. TUI не управляет процессом через scraping stdout.
Background Application Service имеет control surface для
`start/status/stop/restart/open`, переживает закрытие terminal и опционально
стартует при login. Ollama service остаётся отдельной сущностью.

## Ключевые flows

### Job create и subscription

Исходник: [hld-runtime-target.mmd](diagrams/hld-runtime-target.mmd).

1. Client отправляет validated create command с idempotency key.
2. Job Engine транзакционно создаёт Job и первый event.
3. Client получает `202 + jobId`.
4. Client подписывается `GET /jobs/:id/events?after=seq`.
5. Governor admitting Job выдаёт/ожидает resource lease.
6. Adapter исполняет operation через Ollama/другой allowed provider.
7. Events сохраняются до broadcast.
8. Output становится Artifact/message projection.
9. Terminal state и final event фиксируются атомарно.

Connection может исчезнуть между любыми шагами: Job продолжает выполняться, а
client позднее replay events.

### Составная voice-команда

```text
Audio Artifact
  → STT Job
  → Transcript Artifact/draft
  → user confirmation
  → Chat Job
  → Text Artifact/message
```

Governor может выгрузить speech model перед Chat model; Workbench показывает
pipeline progress, не притворяясь одним непрерывным model call.

### Import GGUF из Hugging Face

Target pipeline. Current state (P2-M): pipeline реализован для public GGUF — bounded
server-owned search, metadata/revision/file-list, explicit GGUF-only verdict и
request-scoped выбор exact file на exact commit с size/license/gated и
claimed-size-only fit preview. Preview показывает source/time/confidence
стартового hardware profile и не выдаётся за measured fit. P2-L download
restart-from-zero, connection-owned и не replayable: он принимает только full
HTTP 200, пишет generated staging file, считает SHA-256 и проверяет GGUF v2/v3
header. Отдельный confirmed import повторно валидирует server-owned inode/size/
SHA-256/header, загружает content-addressed blob, вызывает documented
`/api/create`, затем требует exact fresh `/api/tags` и fresh controlled probe.
Только после этого staging удаляется и UI показывает Installed/runtime verified.
HF URL не обещается как `ollama pull`.

```text
HF URL/search
  → metadata + revision + file list
  → user selects GGUF
  → dry-run size/fit/license preview
  → bounded restart-from-zero download
  → checksum/format inspection
  → local Ollama GGUF import
  → capability probe
  → installed descriptor with provenance
```

Import действует только с loopback Ollama, не принимает path/Modelfile/options,
не перезаписывает уже наблюдаемую target и не replay-ит terminal success. Abort
после начала create reconciliate-ит provider state и не называется clean cancel.
No-overwrite против внешнего Ollama client остаётся best-effort из-за отсутствия
CAS в `/api/create`; окно между последней проверкой и create явно считается
остаточным риском.

Никакой remote model code не исполняется. Safetensors conversion и adapters
требуют отдельных capabilities.

### Retention cleanup

Current P3-E–P3-I реализует Chat TTL/Session lifecycle и Session metadata delete;
P3-J добавляет только Quick Run policy persistence:

1. Startup/periodic owner запускает bounded Maintenance pass.
2. Pass выбирает expired TTL Chat, исключая active work.
3. Chat атомарно получает tombstone/Trash timestamp и audit row; retry
   идемпотентен, Restore доступен через versioned boundary.

Quick Run не включён в эти passes. Его TTL/Session cleanup, metadata deletion и
blob GC — target, не current behavior.

## Consistency и availability

Single process + SQLite даёт простую strongly consistent application state в
пределах процесса:

- создание Job + initial event — одна transaction;
- terminal state + terminal event — одна transaction;
- event sequence unique per Job;
- cancellation command идемпотентен;
- external Ollama state eventually reconciled через polling/events;
- filesystem blob commit использует temporary write + checksum + atomic rename,
  после чего metadata transaction;
- orphan blobs удаляются только safe garbage collector.

При недоступном Ollama UI остаётся доступным для истории/settings/catalog cache и
показывает degraded runtime. Недоступность внешнего catalog не блокирует
installed models.

## Capacity model

Это single-user, но memory-constrained system. Главные размеры:

- model artifact weights;
- KV cache от context × parallelism × cache type;
- multimodal projector/encoder;
- runtime/backend overhead;
- host reserve и текущая pressure;
- media artifacts и stream buffers.

Default — один local accelerator Job. Measured parallelism является accepted
поздней policy: Governor может допустить второй Job только по fresh joint
reservation. Масштабирование означает не высокий RPS, а:

- больше installed descriptors;
- более длинные contexts;
- более крупные models;
- очередь долгих Jobs;
- второй inference host в будущем.

Один high-memory host может иметь несколько devices и не получает искусственных
UI limits. Multi-host scheduler не проектируется до реального второго host и
измеренных требований. `Remote Ollama` использует telemetry удалённого host, а
не Mac клиента.

## Supported deployment tiers

- Tier 1: macOS Apple Silicon;
- Tier 2: Linux/NVIDIA, Ubuntu и Fedora family;
- Deferred: Windows/WSL;
- Application Service и autostart используют platform adapters;
- Ollama daemon остаётся externally managed на каждом tier.

## Security boundaries

### Local profile

- loopback-only;
- origin/CSRF checks для state-changing API;
- allowed filesystem roots;
- tool effect classification;
- Manual и Auto-within-policy approvals;
- secrets не возвращаются client;
- reasoning и file content редактируются в logs.

### Remote profile

Отдельный режим, а не `--host 0.0.0.0`:

- authentication и authorization;
- TLS либо trusted reverse proxy contract;
- secure secret store;
- restricted tools и filesystem roots;
- explicit CORS/origin;
- request/rate/size limits;
- SSRF egress allowlist;
- remote hardware profile;
- session revocation и audit.

До реализации remote profile non-loopback agent/tools deployment считается
unsupported.

### External content

Model cards, catalogs, MCP data, documents и tool outputs — недоверенный content.
Они не становятся system instructions и не расширяют permissions. Gated models и
licenses требуют явного user action.

## Observability

Локальный diagnostics bundle может включать:

- app/runtime versions и platform fingerprint;
- Job lifecycle без private prompt/reasoning по default;
- queue/lease decisions;
- Ollama request timing/error categories;
- model digest/context/resource observations;
- DB migration version;
- client crash/error boundary correlation ID.

Export выполняется только пользователем и показывает preview/redaction.

Current P0-A Web уже создаёт локальный client correlation ID и показывает
timestamp, route, error type и component stack в root/Chat Error Boundary.
Автоматический diagnostics bundle/export и корреляция с будущим `jobId` ещё не
реализованы.

P0-B Web показывает persisted Message outcome/error/stop reason, включая
partial failure, cancellation, pending и legacy unknown. Raw provider body и
endpoint credentials в persisted error не попадают. Если terminal rehydrate
не удался, live partial buffer остаётся видимым как неподтверждённый и не
изображается сохранённым success.

## Evolution

Переход выполняется вертикальными slices, а не big-bang:

1. стабилизировать текущий first-turn flow;
2. ввести durable Job для Chat;
3. поставить Resource Governor перед Chat;
4. перенести current events на replay subscription;
5. добавить Capability Registry/installed models;
6. ввести background service и scriptable CLI primitives;
7. построить first-party coding Agent MVP;
8. только после text/agent foundation добавлять STT, затем image;
9. long-running deliberate profile проходит отдельный benchmark;
10. remote/multi-host — отдельные поздние решения.

См. [ROADMAP](../plans/ROADMAP.md) и [ADR index](../decisions/README.md).
