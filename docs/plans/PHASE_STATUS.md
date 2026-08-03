# Phase status

**Статус документа:** implemented tracker  
**Проверено:** 2026-08-03
**Текущая фаза:** Phase 2 — Models, Capability Registry и import

Этот файл — короткий mutable tracker. Канонический scope/exit gates находятся в
[`ROADMAP.md`](ROADMAP.md); решения — в
[`2026-08-02-product-decisions.md`](../decisions/2026-08-02-product-decisions.md).

Статусы: `not started`, `in progress`, `blocked`, `implemented`,
`independently verified`.

## Phase 0

| Slice                             | Статус                 | Outcome                                                  |
| --------------------------------- | ---------------------- | -------------------------------------------------------- |
| P0-A Web crash containment        | independently verified | `f038b5c`/`d05a906`; 3 component, 2 Chromium; all checks |
| P0-B Truthful turn terminal state | independently verified | `c673227..7721ca0`; 23 targeted, 76+10 root, 5 Chromium  |
| P0-C Exclusive inference bridge   | independently verified | `0ca72d8`/`7a626f6`; 16 P0-C, 40 targeted, all gates     |
| P0-D Runtime/catalog health       | independently verified | `edf737d`/`5454fc7`; 36 targeted, 116+16 root, 6 browser |
| P0-E Browser regression gate      | independently verified | `55b8048`/`b2b3088`; 17 component, 9 Chromium; all gates |

Phase 0 становится `independently verified`, только когда все slices выполнены и
exit gate ROADMAP проверен целиком.

## Phase 1

| Slice                                   | Статус                 | Outcome                                                             |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| P1-A Durable Job/event-store foundation | independently verified | `138fb5e`, `91cb21f`, `92b68f0`; 15 targeted, all required gates    |
| P1-B Job transitions/subscription       | independently verified | `56b2200`, `55351bc`; 30 targeted, 10x races, all required gates    |
| P1-C Public Job HTTP API/SSE/cancel     | independently verified | `4b9d96a`, `0a06ea6`; 44 targeted, 10x races, all required gates    |
| P1-D Durable Chat execution/reattach    | independently verified | `da70576`, `08b3516`, `f33d5b9`; 57 targeted, 10x race, all gates   |
| P1-E Startup recovery/reconciliation    | independently verified | `22a1aff`, `6c748de`; 66 targeted, 10x recovery, all gates          |
| P1-F Resource Governor foundation       | independently verified | `a0bc047`, `ff96dc0`; 72 targeted, 10x cleanup, all gates           |
| P1-G Runtime `/api/ps` reconciliation   | independently verified | `b8328bd`, `bd0d7a1`, `40a0de7`, `f53a868`; 82 targeted, all gates  |
| P1-H Apple host telemetry/current fit   | independently verified | `df4d156`..`66c23c0`; 92 targeted, all gates                        |
| P1-I Read-only Runtime Bar projection   | independently verified | `6c297ce`..`11e516b`; 13 component, 10 browser, all gates           |
| P1-J Resource conflict/queue action UX  | independently verified | `2e8dc47`, `dc3f992`; 10 component, 4 browser, all gates            |
| P1-K Prewarm priority/debounce          | independently verified | `811f7fa`..`60693ea`; 35 race, 6 service, 2 browser, all gates      |
| P1-L Exact observation identity         | independently verified | `44730e2`..`94300b7`; 28 exact, 10× repeats, all gates              |
| P1-M No-artificial-caps audit           | independently verified | `c86e537`, `fbff386`; 49 custom, 1 browser, 10× repeats, all gates  |

P1-A–P1-M реализуют additive contract, migrations 4–6, canonical state CAS,
persisted-first `JobService`, public create/query/replay/cancel API и один
process-local Chat execution owner. Current Chat command атомарно создаёт Job и
Message pair, переживает subscriber disconnect и reattach-ится из SQLite. P1-E
до HTTP listen bounded-страницами reconciles unsafe Chat execution в
`interrupted`, подтверждает persisted cancellation и запускает только untouched
queued Chat. P1-F заменяет anonymous mutex одним typed process-local
`ResourceGovernor`: Chat, compaction и warm/load получают FIFO ticket/lease,
unload защищён active owner, close прекращает admission и освобождает live state.
P1-G добавляет один sampled `/api/ps` reconciliation service и public
`GET /api/runtime`. P1-H добавляет shared Apple host sample и truthful
observed/unknown current-fit explanation. P1-I добавляет persistent read-only
Runtime Bar. P1-J добавляет safe Queue и exact Job Stop/cancel acknowledgement
для Chat conflict. P1-K добавляет typed lowest-priority prewarm после stable
New Chat selection. P1-L добавляет exact observation keys, migration 6 и
digest-aware bounded cache. P1-M удаляет arbitrary context ceiling, добавляет
sourced declared/unknown limit evidence, exact custom propagation и truthful
one-permit/device-unknown projection. Все Phase 1 slices и полный ROADMAP exit
gate independently verified; Phase 1 завершена.

P1-E evidence: reopened temporary SQLite с page sizes 2/2 покрывает восемь
executing states, cancelling, queued, terminal no-op, partial channels,
malformed/failure retry и pre-listen rejection; recovery terminal truth
повторена 10 раз. Локально прошли 66 targeted Job/Chat, 26 route/concurrency,
19 runtime/provider, 182 server/CLI, 17 Web component и 9 mocked Chromium tests,
а также typecheck, build, markdownlint и diff check. Live Ollama/hardware,
external clients и multi-process ownership не проверялись.

P1-F evidence: immutable admission request фиксирует canonical Chat `jobId` либо
process-local operation UUID, operation, exact Ollama model, requested context,
единственный priority `normal` и enqueue time. Ticket/lease transitions —
`queued → active → released` либо `queued → cancelled`; release, cancel и close
идемпотентны. Локально прошли 72/72 Job/Governor, 28/28 route/concurrency,
19/19 runtime/provider, 190/190 server/CLI, 17/17 Web component и 9/9 mocked
Chromium tests. Matrix покрывает same/cross-thread Chat, Chat ↔ compaction,
Chat ↔ warm/load, compaction ↔ warm/load, waiting/active cancel, все current
timeout/failure/release paths, exact/conservative unload conflict, stable P1-E
recovery order, 1000 acquire/release без роста live diagnostics и 10 повторов
release/cancel/close. Migration 6 не добавлена: queue intent уже durable Job, а
lease process-local. `/api/ps`, live Ollama/hardware, external clients и
multi-process ownership не проверялись и не реализованы; browser gate проверяет
только существующие mocked P0/P1-D flows без Governor UI.

P1-G evidence: `GET /api/runtime` и compatibility `GET /api/models/running`
используют один application `RuntimeReconciliationService`; overlapping callers
дают один provider call, caller abort независим, completed Promise очищается.
Linearization point — Governor capture после provider completion с одним
`observedAt`. Exact normalized active reference получает
`matched_active_lease`, но runtime digest не становится artifact identity;
unmatched rows остаются `unknown`, active lease без row —
`active_not_observed`, successful empty — `empty_sample`, source error —
`models: null`/`source_failure`. Unavailable/timeout/malformed fixtures сохраняют
queue/lease и не раскрывают raw body, endpoint credentials или path. Локально
прошли 82/82 Job/Governor/reconciliation, 28/28 route/concurrency, 19/19
runtime/provider, 200/200 server/CLI, 17/17 Web component и 9/9 mocked Chromium,
а также typecheck, build, markdownlint и diff check; recovered stable FIFO
fixture повторён 10/10. Migration 6, cache/history и auto-unload не добавлены.
Live Ollama/hardware, continuous observation, external-client identity и
multi-process safety не проверялись и не реализованы. Browser gate проверяет
только mocked connect timeout/EOF partial, create/redirect/stream/terminal reload,
navigation detach/reattach, Stop/cancelled reload, Error Boundary accessibility и
degraded runtime narrow viewport; это не Governor/runtime UI или hardware test.

P1-H evidence: один application `HostTelemetry` injected в
`RuntimeReconciliationService`; routes, Web, Governor и static fit не запускают
host commands. Apple `darwin/arm64` adapter использует absolute
`/usr/bin/vm_stat`, `shell:false`, timeout 1 s и output limit 64 KiB. Он
публикует observed `node_os_totalmem` total unified memory и
`apple_vm_stat_pages_free` system-free bytes. Legacy 70% usable memory остаётся
estimated compatibility fact; current available memory, pressure,
discrete VRAM и GPU-free — `unknown`. Malformed output даёт `partial`,
timeout/output/failure — redacted `unavailable`, non-Apple — `unsupported` без
command. Production Apple current fit поэтому остаётся
`unknown/host_pressure_unknown`; sufficient injected fixture доказывает только
`observed_current_residency`, с artifact identity `unknown` и
`futureAdmissionGuarantee:false`.

Provider и telemetry samples стартуют вместе и fail независимо. После обоих
settled выбирается один root `observedAt`, затем синхронно capture-ится Governor.
Overlapping callers дают один provider call и один host probe; caller abort не
отменяет shared work, а post-completion query запускает новые calls. Подключены
только `GET /api/runtime` и compatibility `GET /api/models/running`; второй
сохраняет прежнюю response shape. Ни один observation не меняет FIFO/admission,
не запускает load/unload и не создаёт migration 6/cache/history.

Локально прошли 92/92 Job/Governor/reconciliation, 28/28 route/concurrency,
19/19 runtime/provider, 19/19 fit/telemetry, 210/210 server/CLI, 17/17 Web
component и 9/9 mocked Chromium tests, а также typecheck, build, markdownlint и
diff check. Полный P1-E recovery file с восемью cases прошёл 10/10 повторов;
P1-F suite сохранил 1000-release bound и внутренние 10x release/cancel/close.
На момент P1-H browser gate проверял только прежние mocked connect-timeout/EOF partial,
create/redirect/stream/terminal reload, navigation detach/reattach,
Stop/cancelled reload, Error Boundary accessibility и degraded Runtime narrow
viewport; Runtime Bar/telemetry UI ещё не был реализован и credit не получал. Live
hardware/Ollama, continuous observation, future fit, external-client identity и
multi-process safety не проверялись и не реализованы.

P1-I evidence: persistent shell `RuntimeStatus` больше не вызывает compatibility
`/api/models/running`, а читает только contract-validated
`api.runtimeSnapshot()`. Read-only projection различает один active lease,
FIFO waiters, closed/idle admission, sampled loaded/unknown-owner models,
`active_not_observed`, independent Ollama/host states и observed/unknown current
fit. Apple free pages явно не названы capacity, legacy 70% остаётся estimate,
null memory не становится zero, а observed residency всегда показывает
`futureAdmissionGuarantee:false`. Runtime feature Error Boundary сохраняет shell.

Polling bound: один request, один timer и один visibility listener; active/queued
2 s, idle 10 s, hidden pause, visible immediate refresh, no overlap. Unmount
abort-ит только свой HTTP wait. Failed refresh сохраняет confirmed sample с
явной stale/error меткой без raw endpoint/body. Route navigation Chat ↔ Settings
сохраняет тот же Runtime Bar/disclosure и не вызывает Job cancel, model stop или
unload. Narrow bar является последним flex-элементом shell и не перекрывает main.

Локально прошли 92/92 P1-A–P1-H Job/Governor/reconciliation, 28/28
route/concurrency, 19/19 runtime/provider, 19/19 fit/telemetry, 210/210
server/CLI, 27/27 Web component/parser и 10/10 mocked Chromium tests, а также
typecheck, build, markdownlint и diff check. Три timer/visibility cases и полный
P1-E recovery file повторены 10/10. Browser открыл Chat и Settings, проверил
active lease, два FIFO waiter, independent Ollama failure при доступном host,
manual retry/recovery, navigation persistence, 390 px, 200% scaling, no
horizontal overflow и reduced motion. Live hardware/Ollama, continuous
observation, future admission fit, external-client identity, multi-process
safety и resource actions не проверялись и не реализованы.

P1-J evidence: один persistent `RuntimeProvider` владеет P1-I polling и делится
single-flight refresh с Chat; второй loop/timer/listener не создаётся, а abort
dialog/unmount прекращает только caller wait. Composer создаёт один UUID intent
до resource query. No-conflict и safe default Queue вызывают существующий Chat
command не более одного раза; transport retry повторно использует тот же key и
dialog закрывается только после принятия HTTP/SSE command. Server Governor
остаётся canonical admission/FIFO owner; same-model conflict не получает
Parallel/future-fit обещание.

Dialog показывает только typed active operation/model/owner kind/context и FIFO
position. Exact fresh Job Stop повторно запрашивает Runtime, сверяет тот же
`jobId`, читает public Job, вызывает один cancel и bounded ждёт
`cancelling → terminal`; already-terminal сразу допускает один dispatch.
Operation/unknown/stale/changed owner, unavailable verification и cancel failure
не приводят к guessed cancel или hidden dispatch. Errors локализованы и не
раскрывают endpoint/body/path/private input. Queue initial focus, Escape/Back,
Tab containment, inert background, focus restore, polling without focus steal,
390 px, 200%, no horizontal overflow и reduced motion проверены.

Локально прошли 92/92 P1-A–P1-H, 28/28 route/Governor/concurrency,
19/19 runtime/provider, 19/19 fit/telemetry, 210/210 server/CLI, 37/37 Web и
14/14 mocked Chromium, а также typecheck, build, markdownlint и diff check.
Новый dialog file повторён 10× по 10/10, P1-I polling — 10× по 3/3, полный P1-E
recovery — 10× по 8/8.

Первые новые browser fixtures дали 2/4: composer focus не возвращался, потому
что control становился disabled до захвата active element; cancel retry fixture
ошибочно делал Job terminal после неуспешного cancel. Explicit return-focus ref
и accepted-cancel fixture исправили причины, после чего 4/4 и полный 14/14
стабильно прошли. Первый repeat Vitest был ошибочно запущен из repository root
без Web jsdom config и дал `document is not defined`; повтор из
`packages/web` прошёл 10×. Одна post-change пакетная Node попытка также была
невалидной: устаревшие `.mjs` paths попали одним аргументом. Точные команды из
handoff с `.ts` затем дали 92/92, 28/28, 19/19 и 19/19. Это command-scope/
fixture failures, не скрытые product regressions.

Не проверены live Ollama/hardware, continuous observations, production pressure/
available-memory, safe parallel/future admission, external-client identity и
multi-process safety. Full Jobs history и generic resource actions не
реализованы.

P1-K evidence: contract различает compatible legacy `normal` snapshot и current
`normal | prewarm`, отклоняет unknown priority и типизирует отдельный
`POST /api/models/:name/prewarm`. Governor policy — один permit,
`normal > prewarm`, FIFO внутри normal. При normal enqueue queued prewarm
отменяется; active prewarm получает abort только через exact process-local
operation owner, release происходит до первого normal admission. Active/queued
normal блокирует новый prewarm, а prewarm никогда не abort-ит normal owner.
Cancel/release/close повторяются идемпотентно; normal выигрывает simultaneous
enqueue независимо от callback order без двух active leases.

New Chat запрашивает models/fit для exact operation context и после 600 ms
stable exact installed Chat selection отправляет name/digest/context/fit basis.
Setting off, mode/selection change, hidden document, normal Runtime work,
unmount/navigation и stale completion очищают только timer/request этого
prewarm. Client deadline — 35 s, server command deadline — 30 s, centralized
prewarm `keep_alive=2m`; explicit warm/turn остаются `normal` и `10m`. Server
повторно проверяет setting, installed facts, safe fit, sampled runtime и
canonical Governor. Один exact resident name+digest+context даёт `reused` без
warm call; ambiguous identity даёт safe skip. Runtime Bar показывает
`model_prewarm`/`prewarm` как operation owner, не durable Job; P1-J не открывает
Stop dialog для prewarm-only state.

Локально прошли typecheck; 96/96 P1 exact; 6/6 prewarm service; 30/30
routes/Governor/concurrency; 19/19 runtime/provider; 19/19 fit/telemetry;
223/223 server/CLI + 43/43 Web root; 16/16 mocked Chromium; build,
markdownlint и diff check. Server priority/prewarm/inference group повторён 10×
по 35/35, debounce file — 10× по 4/4, P1-J conflict — 10× по 11/11, P1-I
polling — 10× по 3/3, P1-E recovery — 10× по 8/8.

Первые узкие проверки сохранили четыре test-harness failures. Governor assertion
ожидал прежний `fifo`; его обновили на принятую `priority_fifo`. Vitest сначала
пытался fake-ить readonly `requestAnimationFrame`, затем fixture сохранял
default active normal и fake-timer `waitFor` не продвигался; fake timers сузили,
fixtures сделали idle, microtask flush — явным, а cleanup перестал dispatch-ить
visibility event после восстановления исчерпанного mock. Первый Chromium case
увидел B и C, потому что fake clock пересёк deadline до React passive cleanup;
controlled animation-frame flush зафиксировал реальный effect order. После
исправлений все gates/repeats зелёные; это assertion/fixture failures, не
скрытые product regressions.

Первый post-docs markdownlint нашёл четыре `MD060` только в двух добавленных
table rows, второй — один оставшийся сдвиг; выравнивание колонок исправлено до
финального lint gate.

Live hardware/Ollama, production TTL/residency, continuous observation,
safe parallel/future fit, external-client identity, multi-process safety и
generic eviction не проверены. Prewarm остаётся best-effort request/process-local
lease, не durable Job и не гарантия будущего admission.

P1-L evidence: `ModelObservationKey` version 1 различает `complete` и typed
`unavailable(reason)`. Complete components: provider `ollama`, normalized exact
reference, installed/runtime artifact digest, context, `/api/version`-sourced
runtime fingerprint и stable local Apple hardware fingerprint
(`darwin/arm64/metal`, unified memory, total bytes/source). Timestamp остаётся
sample metadata; raw CPU/device/user/path strings не входят в fingerprint.
Missing/ambiguous tags↔ps identity, digest, context, version, local supported
hardware либо remote host остаются unavailable и не получают measured credit.

Additive migration 6 создаёт `model_calibration_observations`. Legacy
`model_calibration(model, context)` rows сохраняются readable без invented
backfill и никогда не читаются как exact evidence. Failed transaction оставляет
v5; после устранения conflicting schema reopen повторяет migration. Exact row
upsert deterministic, context/digest/runtime/hardware изменения дают отдельные
rows; context curve читает только одну artifact/runtime/hardware family.
`/api/show` cache invalidates changed digest того же normalized name, удерживает
один digest на reference и максимум 64 references. Model detail wait получает
caller AbortSignal; provider failures не кэшируются и не раскрывают raw body.
`PrefillTracker` остаётся process-local name heuristic вне measured contract.
P1-K resident reuse остаётся current-sample name+digest+context и не требует
недоступный historical hardware key.

Локально прошли typecheck; 98/98 P1 exact; 28/28 новый key/migration/cache/
runtime group; 6/6 prewarm service; 30/30 routes/Governor/concurrency; 19/19
runtime/provider; 19/19 fit/telemetry; 237/237 server/CLI + 43/43 Web root;
16/16 mocked Chromium; build, markdownlint и diff check. Новый P1-L group,
P1-K priority/prewarm/inference, P1-K debounce, P1-J conflict, P1-I polling и
P1-E recovery повторены 10×: соответственно 28/28, 35/35, 4/4, 11/11, 3/3 и
8/8 в каждом run.

Первые post-change проверки нашли: stale `ModelService` type/implicit-any;
пять migration assertions, ожидавших v5; четыре старых runtime fixtures без
новых tags/version facts; одну union-narrowing ошибку теста и одну устаревшую
artifact expectation. Причины исправлены, все соответствующие gates зелёные.
Первый 10× repeat P1-J conflict отдельно выявил focus-effect race: assertion
иногда опережал перевод фокуса на safe Queue. Проверка синхронизирована через
`waitFor`; повтор стал 10× по 11/11. Это harness/assertion failures, не скрытые
product regressions.

Не проверены live Ollama/hardware и production residency, continuous observation,
remote hardware identity, safe parallel/future admission, external-client и
multi-process safety, generic eviction. Exact v1 не включает ещё недоступные
parallelism/KV/flash-attention/probe facts; они не подменены defaults.

P1-M evidence: public context boundaries принимают positive safe integers без
replacement ceiling; invalid/fractional/non-positive/unsafe values получают
controlled validation. `ModelContextLimit` различает declared `/api/tags` или
`/api/show` evidence с observation time/confidence и absent/conflicting unknown.
Sourced over-maximum request отклоняется `context_limit_exceeded` без clamp;
unknown не создаёт guessed отказ. Exact `1_048_577` проходит Settings/thread
SQLite, route, Governor, Ollama `num_ctx`, fit и prewarm. Defaults `8192`/`32768`,
Launcher datalist и profile steps остались suggestions. `/api/show` projection
ограничена четырьмя workers, digest-aware LRU — 64; cached source time не
переписывается.

Settings, Launcher и Model Profile принимают keyboard custom input и показывают
localized validation/provenance. Runtime Bar называет один permit application
policy и отдельно оставляет device count unknown. Output-budget и media upload
в current flow остаются `not implemented`; guessed limits не добавлены. Bash/
file/host/parser/page/chunk/timeout/40-step safety bounds сохранены с текущими
failure semantics; Q-27 не закрыт.

Локально прошли typecheck; 98/98 P1 exact; 32/32 P1-L+M key/cache/runtime;
7/7 prewarm; 33/33 routes/Governor/concurrency; 19/19 runtime/provider; 19/19
fit/telemetry; 248/248 server/CLI + 46/46 Web; 17/17 mocked Chromium; root test,
build, markdownlint и diff check. Повторы: custom contract/settings/end-to-end
10×49/49; affected Web 10×46/46; P1-L 10×32/32; P1-K 10×37/37; P1-J
10×11/11; P1-I 10×3/3; P1-E 10×8/8.

Первые P1-M проверки сохранили только harness/static failures. Detached baseline
сначала запускался не из repository worktree и с неполным install; запуск из
repo после `npm ci` подтвердил исходные counts. Новый component file сначала не
имел Theme/matchMedia setup, затем использовал unsupported matcher и Embla path;
fixture/setup исправлены до 3/3. Один root Vitest запуск обошёл Web jsdom config.
Post-review typecheck поймал type-only imports и вложенный array; обе причины
исправлены. Первый 10× wrapper использовал readonly zsh `status`; переменная
wrapper заменена, все засчитываемые repeats зелёные. Product regression в этих
первых failures не подтверждён.

Phase 1 ROADMAP exit gate переоценён целиком:

- navigation detach/reattach сохраняет durable Job и lease;
- reload replay читает persisted canonical output без duplicate;
- pre-listen restart recovery даёт interrupted/cancelled/queued truth;
- P1-J Queue и canonical Governor предотвращают unsafe competing load;
- route lifecycle не освобождает application lease;
- Runtime Bar/conflict UI объясняют owner, queue, context, source и policy.

Release-readiness verdict для phase exit — `go`, не production deployment.
Остаточные риски не изменились: live Ollama/hardware, production residency/TTL,
continuous observation, external-client identity, multi-process ownership,
remote telemetry, safe parallel и generic eviction не проверены. Они входят в
следующие фазы и не выданы за Phase 1 evidence.

## Phase 2

| Slice | Статус | Outcome |
| --- | --- | --- |
| P2-A Installed descriptor/evidence foundation | implemented, locally validated | `d750a3e`, `6a5c43d`, `d42b791`, `282c82e`; descriptor 9/9, Web 51/51, Chromium 18/18, all required gates |
| P2-B Persistent installed evidence cache | implemented, locally validated | `a1ead74`, `597c130`, `c22c435`; persistent 17/17, core 274/274, Web 52/52, Chromium 18/18, all required gates |

P2-A additive расширяет `LocalModel`/`ModelDetail` canonical/unknown Ollama
reference, exact/unknown installed artifact, `/api/tags` installation fact и
source-preserving capability declarations. Legacy response получает explicit
unknown defaults; legacy `capabilities`, `contextLength`, paths и clients
сохранены. `/api/tags`, `/api/show`, `/api/version` и `/api/ps` остаются
раздельными facts. `/api/show` declaration не получает exact digest basis,
потому что name-addressed response не содержит digest. Duplicate normalized
references не вызывают detail lookup; future enum, missing, malformed, conflict
и unavailable остаются unknown/degraded. Provider declaration не считается
controlled probe/runtime proof и не получает verified-green UI semantics.

Inventory current facts и failure/staleness semantics зафиксирован в LLD:
installation/digest и legacy capabilities из `/api/tags`; name-based detail и
context из `/api/show`; loaded rows из `/api/ps`; sourced runtime version;
stale/bundled catalog; canonical normalizer; digest-aware LRU 64; installed card/
profile consumers. SQLite migration не добавлена: descriptor transient, а
persistent cache/TTL/SWR/history остаются следующим slice. Marketplace, import,
Q-25/Q-26, probes и registry persistence не изменены.

Required code evidence through revision `282c82e`: typecheck; P1 exact 98/98; P1-L+M
32/32; prewarm 7/7; routes/Governor/concurrency 33/33; runtime/provider 19/19;
fit/telemetry 19/19; descriptor 9/9; root server/CLI 257/257 + Web 51/51;
Chromium 18/18; build. Repeats: descriptor 10×9/9; affected Web 10×51/51;
P1-L+M 10×32/32; P1-K 10×37/37; P1-I 10×3/3; P1-E 10×8/8; P1-J после fix
10×11/11.

Первые failures сохранены. Два узких Playwright запуска были ошибочно вызваны
не из Web workspace: первый передал `--grep` как filename и получил `No tests
found`, второй не загрузил workspace `baseURL` и получил invalid `page.goto('/')`;
exact workspace spec прошёл 1/1, полный browser gate — 18/18. P1-J repeat run 2
нашёл реальный flaky assertion: проверка initial Queue focus опережала modal
effect и видела `body`. Assertion синхронизирован через `waitFor`, после чего
file прошёл отдельный 11/11 и 10×11/11. First inherited P2-A review также нашёл
unknown-enum-to-empty filtering, duplicate-reference cross-digest detail risk и
fabricated exact digest basis для `/api/show`; `d42b791` сделал все три границы
fail-closed и добавил regression coverage.

P2-B добавляет append-only migration 7 и latest-row safe provider evidence cache.
Exact key version 1 включает provider, canonical reference, installed digest,
Ollama runtime version и evidence schema version. Fresh row читается 15 минут;
если current `/api/show` unavailable, exact stale row может использоваться ещё
7 дней с explicit offline state. Перед write bounded collection повторно
проверяет `/api/tags` installation identity и `/api/version`; changed,
ambiguous, malformed или conflicting current facts не получают cache write и не
маскируются старым row. Process LRU 64 остаётся front-cache, per-key
single-flight делит duplicate work, общий pool допускает не больше четырёх
detail workers, а abort одного caller не отменяет остальных waiters.

Persistent JSON содержит только normalized allowlisted capability/context/
architecture facts и исходные observation timestamps. Raw provider body,
endpoint/credentials, paths, prompt/template/system/license и private strings не
сохраняются. Additive contract публикует `fresh | stale | unknown` и explicit
offline flag; Installed card/profile показывают localized provenance/freshness
без повышения provider declaration до verified runtime proof. Старые clients и
legacy Web fixtures получают explicit unknown default.

Required code evidence through revision `c22c435`: typecheck; P1 exact 98/98;
P1-L+M 32/32; prewarm 7/7; routes/Governor/concurrency 33/33; runtime/provider
19/19; fit/telemetry 19/19; descriptor 9/9; persistent migration/store/cache
17/17; root server/CLI 274/274 + Web 52/52; Chromium 18/18; build, markdownlint и
diff check. Repeats: persistent 10×17/17; descriptor 10×9/9; P1-L+M 10×32/32;
affected Web 10×52/52; P1-K 10×37/37; P1-J 10×11/11; P1-I 10×3/3; P1-E
10×8/8.

Первые P2-B проверки зафиксированы, а не скрыты повторным green. Test helper
сначала вывел неверный `TestContext` inference; тип указан явно. Node strip-only
режим отклонил parameter property; helper переписан на обычное class field.
Incompatible-row fixture нарушал SQLite `CHECK` до чтения; fixture теперь
подменяет key component и проверяет fail-closed parser. Старые Web fixtures без
freshness потребовали component-level unknown fallback. Невалидный CSS selector
в assertion заменён проверкой `innerHTML`. Stale fixture сначала отключал
`/api/tags`, хотя этот source владеет current installation; недоступным оставлен
только `/api/show`.

Две stress-orchestration попытки не входят в evidence counts. Запуск 80 процессов
одновременно упёрся в test harness `UnknownProcessId`; восемь concurrent lanes
теряли exit statuses и один раз дали contention-only timing failure P1-K. Он не
воспроизвёлся в 10 изолированных P1-K runs; все засчитанные repeat groups
запускались последовательно и завершились с точным exit status.

P2-A и P2-B остаются `implemented, locally validated`, а не independently
verified или production-validated. Не проверены live Ollama/model/hardware,
provider-version matrix и multi-process coordination. Migration 7 хранит latest
safe provider row, а не continuous evidence history/full Capability Registry;
controlled probes, semantic tool/media quality, user overrides и import не
реализованы. Phase 2 остаётся `in progress`: ROADMAP exit gate требует
variant-first import, HF exact revision/checksum/license, URL policy,
search/filter/compare и platform work; Q-25/Q-26 не закрыты молча.

## Later phases

| Phase                                   | Статус                 |
| --------------------------------------- | ---------------------- |
| Phase 1 — Durable Jobs/Governor         | independently verified |
| Phase 2 — Models/Capability/import      | in progress            |
| Phase 3 — Text/Projects/retention/i18n  | not started            |
| Phase 4 — Service/CLI/TUI               | not started            |
| Phase 5 — First-party coding Agent      | not started            |
| Phase 6 — Audio                         | not started            |
| Phase 7 — Vision/OCR/image              | not started            |
| Phase 8 — Deliberate long-running Agent | not started            |
| Phase 9 — Packaging/hotkey/rebrand      | not started            |

## Update protocol

После каждого implementation slice агент:

1. обновляет только свой статус и краткое evidence;
2. ссылается на commit/tests;
3. не переводит всю фазу в implemented по одному happy path;
4. оставляет `blocked` только с конкретной причиной и следующим действием;
5. синхронизирует current-state docs, если поведение изменилось;
6. переписывает `NEXT_AGENT_PROMPT.md` для следующего незавершённого slice.

Если текущий slice заблокирован или обязательная проверка не пройдена,
`NEXT_AGENT_PROMPT.md` остаётся на нём и содержит blocker, собранное evidence и
безопасные recovery steps. Переход к первой работе следующей фазы разрешён только
после полного exit gate и independent verification текущей.
