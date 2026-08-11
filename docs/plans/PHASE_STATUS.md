# Phase status

**Статус документа:** implemented tracker  
**Проверено:** 2026-08-11
**Текущая фаза:** Phase 3 — P3-F reasoning Artifact foundation ready

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
one-permit/device-unknown projection. Все Phase 1 slices реализованы и полный
ROADMAP exit gate проверен.

Поправка 2026-08-07: exit-gate bullet «reload replay не дублирует output» до этой
даты не имел assertion — browser tests проверяли только `toHaveCount(0)` на live
draft, поэтому отсутствие duplicate было следствием, а не проверкой. Явный
`toHaveCount(1)` на persisted answer добавлен в
`packages/web/test/browser/chat-first-stream.spec.ts`; mutation check
(ожидание 2) падает, значит assertion имеет силу. «restart даёт
interrupted/recovery state» подтверждён `chat-job-recovery.test.ts:306`
(close → reopen → `interrupted === 8`). Остальные bullets exit gate не
перепроверялись этой правкой.

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
| P2-C Explicit controlled completion probe | implemented, locally validated | `ce9ef4b`, `c48799a`, `d1c3c38`; P2-C 34/34, core 300/300, Web 58/58, Chromium 18/18, all required gates |
| P2-D Confirmed Add from Ollama | implemented, locally validated | `21c0404`, `3d129d2`, `0d9aaa6`; P2-D 20/20, core 311/311, Web 65/65, Chromium 19/19, all required gates |
| P2-E Variant-first Marketplace install | implemented, locally validated | `56b802b`, `2959b98`; P2-E 12/12, core 320/320, Web 75/75, Chromium 20/20, all required gates |
| P2-F Truthful facets/pairwise compare | implemented, locally validated | `c769fbd`, `c1495a3`, `1fc3c20`; P2-F 10/10, core 330/330, Web 83/83, Chromium 21/21, all required gates |
| P2-G Truthful Linux/NVIDIA telemetry | implemented, locally validated | `a4a3ead`, `3f1a533`, `6ceae50`; P2-G 38/38, core 339/339, Web 88/88, Chromium 22/22, all required gates |
| P2-H Catalog pagination/bounded rendering | implemented, locally validated | `3c4960d`, `cc40d14`; P2-H 10/10, core 349/349, Web 95/95, Chromium 23/23, all required gates |
| P2-I Exact installed capability user override | independently verified | `6b98d37`..`6cc4504`; P2-I 52 new / 401 core envelope, Web 117/117, Chromium 25/25, all required gates |
| P2-J Read-only Hugging Face discovery (GGUF-only) | independently verified | `e544c7c`..`2f13e31`; P2-J 45 new / 446 core envelope, Web 27 new / 144 envelope, Chromium 1 new / 26 envelope, all required gates |
| P2-K Exact GGUF file/revision + preview | independently verified | `9f3990d`, `9f3f19c`; 29 new / 475 core envelope, 17 new / 161 Web envelope, Chromium 1 new / 27 envelope, all required gates |
| P2-L Bounded exact GGUF download + provenance | independently verified | `8bb65c9`, `e1d4e66`; 29 new / 504 core envelope, 6 new / 167 Web envelope, Chromium 1 new / 28 envelope, all required gates |
| P2-M Local staged GGUF import + probe | independently verified | `62a41c6`, `5b3d71d`; 16 new / 520 core envelope, 6 new / 173 Web envelope, Chromium 0 new + 1 expanded / 28 envelope, all required gates |
| P2-N Server-owned feature flags | independently verified | `ac928a3`, `b0b7248`; 12 new / 532 core envelope, 0 new / 173 Web envelope, Chromium 0 new / 28 envelope, all required gates |
| P2-O Estimated parallel-admission verdict | independently verified | `0dc5c71`, `2f08b78`, `7b5101c`; 14 new / 546 core envelope, 0 new / 173 Web envelope, Chromium 0 new / 28 envelope, all required gates |

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

P2-C добавляет strict additive completion-probe contract и append-only migration
8 без backfill из provider declarations. Exact key version 1 включает provider,
canonical reference, installed digest, sourced Ollama version, requested context
и probe-definition version. Store хранит только normalized latest outcome, safe
reason и согласованное timing; prompt, response, reasoning, raw body, endpoint,
credentials и paths не сохраняются. Compatible exact row без force возвращается
как historical с исходным observation time; force создаёт новый observation.

Manual action доступен только из Installed profile после focus-safe confirmation.
Server-owned request проверяет только basic `completion`, использует
`num_predict=8`, `temperature=0`, `seed=0`, `keep_alive=2m`, limits 1 KiB response,
10 s connect, 30 s load, 5 s idle и 45 s total. Cloud/red/unknown-fit и sourced
context overflow skip-ятся до load. Canonical normal-priority `model_probe`
Governor operation не обходит active/queued work; ticket, lease, timers и
listeners очищаются на success/failure/cancel/timeout. Caller connection владеет
wait, поэтому probe не является durable/background/replayable Job.

Positive `verified` требует terminal non-whitespace response и exact
tags/runtime identity до и после call. Empty/malformed/non-terminal/provider/
transport/persistence failure остаётся degraded/unknown, cancel — cancelled,
identity/fit/context safety — skipped; ни один failure не становится
`unsupported`. Runtime Bar показывает typed operation без P1-J Job Stop. Web
показывает idle/confirmation/queued/running/historical/result/error/cancel,
English fallback и curated Russian; mount/hover/selection/navigation/reload не
запускают probe.

Required evidence through revision `d1c3c38`: typecheck; P1 exact 98/98; P1-L+M
32/32; prewarm 7/7; routes/Governor/concurrency 33/33; runtime/provider 20/20;
fit/telemetry 19/19; P2-A descriptor 9/9; P2-B persistent 17/17; P2-C + Ollama
boundaries 34/34; core 300/300 + Web 58/58; Chromium 18/18; build, markdownlint
и diff check. Detached inherited baseline `226da56` отдельно прошёл typecheck и
P2-A/P2-B 26/26. Repeats выполнены последовательно с exit-status checking:
P2-C 10×34/34, P2-B 10×17/17, P2-A 10×9/9, P1-L+M 10×32/32, affected Web
10×58/58, P1-K 10×37/37, P1-J 10×11/11, P1-I 10×3/3 и P1-E 10×8/8.

Первые failures не скрыты повторным green. Первый root run дал 284/295 и 11
старых migration-fixture failures: current version expectations обновлены на 8,
а downgrade helpers теперь удаляют более новые tables. Узкий rerun сначала ждал
старый reason для whitespace-only response; ожидание исправлено на
`empty_response`. Первый affected Web run дал 53/58 и unhandled error:
Runtime projection сделана optional для isolated `ModelPage`, unsupported
matcher/invalid selector заменены portable assertions. Первый Chromium P2-C
case дал 0/1 из-за strict locator, совпавшего с badge и confidence text; locator
сузили до exact badge. Review дополнительно исправил whitespace false verify,
persisted timing, unmount update, forced-run focus restore, safe route redaction
и реальные per-call transport deadlines. Один незасчитываемый targeted Vitest
repeat из root не подхватил Web jsdom config и получил 11 `document is not
defined`; все засчитываемые P1-J runs выполнены из Web workspace и дали 10×11/11.

P2-D добавляет strict additive reference preview/start contract и один pure
server-owned normalizer. Разрешены ASCII base/tag/one namespace и exact HTTPS
Ollama model-page shapes; case normalizes, missing tag становится `:latest`.
Whitespace/control, credentials, port, query/fragment, arbitrary/lookalike/IP/
localhost host, encoded separator, literal traversal и ambiguous grammar
fail-closed. Preview не обращается к DNS/network/Ollama/filesystem/SQLite и не
утверждает availability, size, license, capability, fit или installation.

Start заново нормализует original reference и требует exact confirmed name.
Local `OllamaClient.pull` получает только canonical name без user-owned endpoint,
headers, auth, insecure или options. Pull chunk валидируется; regressing/
malformed/EOF-before-success даёт controlled redacted error, а `done` требует
provider status `success`. Controller принадлежит connection, stream не retry-ится
автоматически и не является durable/background/replayable Job. Cancel не
останавливает daemon. После success Web отдельно перечитывает `/api/tags`; refresh
failure не фабрикует installed digest и completion probe не запускается.

Marketplace modal использует locale keys с English fallback и curated Russian,
explicit keyboard preview/confirmation, one-intent double-click guard,
validating/invalid/progress/error/cancel/retry/success states, focus containment/
restore и truthful already-installed/refresh projection. Mount/type/paste/hover/
reload/navigation не запускают pull. StrictMode/unmount cleanup не делает late
Installed refresh; 390 px, 200% zoom, overflow и reduced motion проверены в
mocked Chromium.

Required evidence through revision `0d9aaa6`: typecheck; P1 exact 98/98; P1-L+M
32/32; prewarm 7/7; routes/Governor/concurrency 33/33; runtime/provider 20/20;
fit/telemetry 19/19; P2-A 9/9; P2-B 17/17; P2-C 34/34; P2-D server 20/20;
core 311/311 + Web 65/65; Chromium 19/19; build, markdownlint и diff check.
Sequential repeats with exit/count checking: P2-D server 10×20/20, targeted Web
10×7/7, affected Web 10×65/65, P2-C 10×34/34, P2-B 10×17/17, P2-A 10×9/9,
P1-L+M 10×32/32, P1-K 10×37/37, P1-J 10×11/11, P1-I 10×3/3 и P1-E 10×8/8.
После review-fixes затронутые P2-D/Web groups повторены с теми же counts.

Первые failures не скрыты. Initial normalizer использовал unsupported TypeScript
parameter property: 11 tests прошли, два files не загрузились; field assignment
переписан явно. Raw explicit `:443` терялся при URL canonicalization и дал 17/18;
authority теперь проверяется до `URL`. Первый targeted Web run дал 3/5 из-за
невалидных fixtures/assertions; setup и strict model fixture исправлены до 7/7.
Root-level Playwright не нашёл Web baseURL; exact spec из `packages/web` прошёл
1/1. Review дополнительно нашёл literal dot-segment canonicalization и late
unmount state update; raw traversal reject и StrictMode-safe mounted guard
зафиксированы в `0d9aaa6`. Две repeat-wrapper попытки неверно восстановили
envelopes (11 вместо 20 без `ollama-client`, затем 19 вместо P1-K 37); product
tests были green, а точные groups перезапущены с ожидаемыми counts.

P2-E расширяет `CatalogModel.variants` exact normalized target, claimed context,
per-variant calculated/unknown fit, exact installed/not-installed/unknown
evidence и source freshness/timestamps. Legacy rows получают non-installable
unknown defaults; top-level family installed и largest-variant fit остаются
явно помеченными compatibility projections. Shared P2-D normalizer строит
base/tag/namespace target. Invalid, traversal, multi-colon, duplicate либо
malformed rows fail-closed без silent base/latest pull. Unknown size не
превращается в zero/green fit, а один installed tag не отмечает соседний.

Marketplace catalog card требует exact selection до install, показывает target,
claimed size/parameters/context, fit basis, source freshness/fetch/observation и
sampled `/api/tags` installation time. Confirmation объясняет network/disk и
mutable-tag boundaries. Active pull фиксирует selected target и блокирует
подмену selection; double activation создаёт один intent. Progress, provider/
protocol/transport error, cancel, explicit retry и unmount используют тот же
connection-owned P2-D lifecycle без auto retry. После terminal success Web
принимает digest только из одного exact canonical Installed descriptor; missing
target и refresh failure остаются разными unconfirmed states. Completion probe,
prewarm/load, capability promotion и remote catalog fetch автоматически не
запускаются.

Required evidence through revision `2959b98`: typecheck; exact P2-E contract/
catalog 12/12; P2-D 20/20; catalog/descriptor/fit с additive contract 34/34;
P2-C 34/34; core 320/320 + Web 75/75; mocked Chromium 20/20; production build,
markdownlint и diff check. Sequential repeats with exit/count checking: P2-E
server 10×12/12, targeted Web 10×10/10, affected Web 10×75/75, P2-D
10×20/20, P2-C 10×34/34, P2-B 10×17/17, P2-A 10×9/9, P1-L+M
10×32/32, P1-K 10×37/37, P1-J 10×11/11, P1-I 10×3/3 и P1-E
10×8/8.

Required product checks не падали. Initial inherited P2-E smoke дал server
11/11 и Web 10/10; последующий review нашёл fail-open parsing локального cache:
`name:tag:extra` мог быть усечён прежним `split(':')` до удобного target.
Cache row теперь сначала проходит shared strict normalizer; regression поднял
exact group до 12/12. Review также добавил отсутствовавшие catalog observed/
fetched и `/api/tags` observation timestamps в selector/success projection.
Несколько oversized repeat wrappers завершились до всех заявленных groups без
test failure; незавершённые runs не засчитаны и соответствующие groups
перезапущены отдельно до полных exact 10× counts.

P2-F additive расширяет strict catalog query доступными current facts. Один CSV
value задаёт OR внутри installation/fit/scope/source/freshness/capability, а
groups объединяются AND. Repeated/unknown key, duplicate/future enum,
non-positive/fractional/unsafe numeric и numeric+unknown conflict дают controlled
400 до provider access. Variant installation/fit/context/size обязаны совпасть
на одной exact P2-E row; model scope/source/freshness/capability применяются
отдельно. Missing metadata остаётся explicit unknown, provenance/timestamps не
переписываются, remote fetch/persistence не добавлены.

Web сохраняет text search и добавляет accessible filter disclosure, applied
chips/clear, loading/filtered-empty/error/retry, bounded debounce, AbortSignal и
late-response guard. Pairwise compare принимает ровно две unique valid exact
rows, показывает claimed size/parameters/context, per-variant fit+basis,
source/freshness/times и exact sampled installation/digest-or-reason. Duplicate,
invalid и third row fail-closed; remove/swap/vanish/Escape восстанавливают
предсказуемый focus. Search/filter/compare/reload не вызывают pull, probe,
prewarm/load, provider fetch или capability promotion.

Required evidence through revision `1fc3c20`: typecheck; P2-F server 10/10;
P2-E server 12/12; combined catalog/descriptor/fit 44/44; P2-F/P2-E targeted Web
18/18; P2-D 20/20; P2-C 34/34; P2-B 17/17; P2-A 9/9; core 330/330 + Web
83/83; mocked Chromium 21/21; production build, markdownlint и diff check.
Sequential repeats with exit/count checking: P2-F server 10×10/10, targeted Web
10×8/8, affected Web 10×83/83, P2-E server/Web 10×12/12 и 10×10/10, P2-D
10×20/20, P2-C 10×34/34, P2-B 10×17/17, P2-A 10×9/9, P1-L+M
10×32/32, P1-K 10×37/37, P1-J 10×11/11, P1-I 10×3/3 и P1-E 10×8/8.
После review fixes P2-F targeted и affected Web повторены ещё 10×8/8 и
10×83/83; updated browser spec прошёл 1/1 и полный gate 21/21.

Первые failures сохранены. Baseline server command сначала был запущен из
неверного cwd; unknown fixture использовал default вместо `null`. Первый Web run
дал 13/17: translation labels вычислялись при module import, а часть assertions
не соответствовала DOM; translation перенесён в render, fixtures/assertions
исправлены. Первый Chromium locator неоднозначно находил `установлен`, после
exact locator следующий run обнаружил реальный wiring defect: compare props
передавались Installed card вместо catalog card. Root targeted Vitest без Web
config получил 18 `document is not defined`; exact workspace run прошёл 18/18.
Полный Chromium затем нашёл старый глобальный absence assertion `completion`,
который пересёкся с новой закрытой facet option; assertion scoped к Installed
carousel. Review добавил fail-closed duplicate compare targets, vanished close,
initial Swap focus, focus remaining row после remove и очистку invalid numeric
draft при explicit unknown.

Несколько незасчитанных repeat wrappers тоже не скрыты: zsh read-only `status`,
несуществующий Vitest reporter `basic`, envelope 35 вместо P1-L+M 32 и 19 вместо
P1-K 37. Они исправлены до fail-fast/count-aware wrappers, после чего все exact
10× groups выполнены заново с каноническими file sets.

P2-G additive расширяет host contract explicit NVIDIA projection с legacy
`unknown` default. Local Linux + detected CUDA использует один absolute
`/usr/bin/nvidia-smi` call с fixed argv, `shell:false`, minimal C locale, timeout
1 s и output limit 64 KiB. Pure parser принимает LF/CRLF, safe Unicode и любое
число rows внутри reliability bound, переводит integer MiB в safe bytes,
сохраняет non-sequential indexes и nullable UUID. Missing identity/mixed rows
дают `partial`; all malformed, duplicate index/UUID, command missing/failure,
timeout и output limit остаются разными redacted unavailable reasons. Apple и
unsupported routing сохранены.

Каждый usable device несёт index, redacted-in-UI UUID, name, observed total и
current-free VRAM, source/time/confidence. System memory, legacy usable estimate,
per-device VRAM, `/api/ps` allocation и pressure не смешиваются. Runtime Bar
показывает localized available/partial/unavailable/unsupported states и все rows
в contained scroll без UI cap; stale refresh сохраняет confirmed timestamps.
Linux observation key/current fit остаются unavailable/unknown, Governor — с
одним permit: `/api/ps` не сообщает device assignment, а free VRAM не является
safe admission capacity.

Required evidence through revision `6ceae50`: typecheck; P2-G server/identity
38/38 и exact three-file group 34/34; P2-F server 10/10; P2-E server 12/12;
key/model/runtime group 30/30; full core 339/339 + Web 88/88; mocked Chromium
22/22; production build, markdownlint и diff check. Sequential repeats with
exit/count checking: P2-G server 10×38/38, targeted Web 10×20/20, Chromium
10×1/1, affected Web 10×88/88, P2-F server/Web 10×10/10 и 10×8/8, P2-E
server/Web 10×12/12 и 10×10/10, P1-H fit/telemetry 10×25/25, P1-L+M
10×33/33, P1-K 10×37/37, P1-J 10×11/11, P1-I 10×3/3 и P1-E 10×8/8.

Первые failures не скрыты. Root npm Chromium `--grep` был разобран как filename
и дал `No tests found`; direct root Playwright не имел Web `baseURL` и получил
invalid `/chat`. Канонический запуск из `packages/web` прошёл. Первый English
component fixture искал Russian disclosure, а `toHaveClass` отсутствовал в
текущем matcher setup; locale-neutral locator и portable `className` assertion
исправили harness. Review нашёл browser fixture с `nvidia` внутри source-health
и ложный Linux fit reason `host_unsupported`; projection перенесена в host, а
reason выровнен с server `observation_key_unavailable`. Первый full Web gate
после strict provenance review дал 86/88: all-malformed fixtures ошибочно
ставили `source:none`; `nvidia_smi` source восстановлен, после чего 88/88 и все
repeats зелёные.

P2-H добавляет additive explicit catalog pagination без silent legacy break.
Pair positive-safe `page + pageSize` включает paged mode; отсутствие обоих keys
сохраняет полный legacy list. Maximum 100 ограничивает одну response page, Web
default 12 — одну render page; total matching rows не ограничен. Partial pair,
repeated/unknown/fractional/non-positive/unsafe/over-policy input даёт controlled
400 до source и `/api/tags`. Response различает `legacy | paged`, exact
model-row total/pages и nullable previous/next; zero и requested out-of-range
page остаются explicit и не clamp-ятся.

Server один раз читает local cache либо bundled fallback и не больше одного раза
samples `/api/tags`. P2-E normalization, global duplicate canonical-target
fail-closed, P2-F filtering и locale-independent stable sort выполняются до
count/slice. Caller AbortSignal проходит в route/local read. Web хранит accepted
debounced query/filter/context/source basis и page отдельно: новый basis
атомарно запрашивает page 1, late response игнорируется. DOM содержит только
current page и constant Previous/Next controls. До двух exact row snapshots
переживают page navigation; changed evidence basis очищает compare с localized
notice. Active connection-owned P2-D/P2-E pull блокирует pager с explanation,
но не abort-ится и не превращается в durable/background Job.

Required evidence through revision `cc40d14`: clean detached baseline
`d75676a` после восстановления dependencies прошёл typecheck, P2-F 10/10,
P2-E 12/12 и Web 88/88. Post-implementation прошли typecheck; P2-H server
10/10; targeted Web 25/25; P2-H Chromium 1/1; P2-G server 38/38; full core
349/349 + Web 95/95; mocked Chromium 23/23; production build; markdownlint
31 files/0 issues; diff check; server/jsdom benchmark по 1/1. Vite сохранил
известный warning о chunk больше 500 kB, build завершился успешно.

Sequential repeats with exit/count checking: P2-H server 10×10/10, targeted Web
10×7/7, Chromium 10×1/1, affected Web 10×95/95; P2-F server/Web 10×10/10 и
10×8/8; P2-E server/Web 10×12/12 и 10×10/10; P2-G server/Web/Chromium
10×38/38, 10×20/20 и 10×1/1; P1-H 10×25/25; P1-L+M 10×33/33; P1-K
10×37/37; P1-J 10×11/11; P1-I 10×3/3; P1-E 10×8/8. Все засчитанные
groups выполнялись последовательно, а не десятками одновременных процессов.

Synthetic diagnostic использует 1,000 models/4,000 variants. Legacy server
response: 3,768,624 bytes и 10.537 ms; page 12: 45,513 bytes, 4.759 ms и
48 variants. jsdom legacy projection: 1,000 slides + 1,000 dots и 215.759 ms;
bounded: 12 slides + 12 dots + 2 pager buttons и 6.222 ms. Это один local run,
не production SLA, provider capacity или timing gate.

Первые failures/findings не скрыты. Detached worktree не имел `node_modules`,
поэтому первая typecheck attempt получила `tsc: command not found`; после
read-only dependency symlink baseline полностью прошёл. Review исправил page-1
reset: он теперь атомарен с accepted debounced basis и не делает request старого
query; duplicate targets across logical pages fail-closed до pagination; mobile
pager получил 44 px targets. Первый historical repeat wrapper использовал
несуществующий `chat-recovery.test.ts` и завершился после уже green P1-K/J/I;
канонический `chat-job-recovery.test.ts` подтверждён 8/8, затем весь exact
envelope выполнен заново. Следующий count wrapper ожидал TAP prefix `#`, тогда
как current Node печатает `ℹ`; parser переведён на поля `tests/pass`, после чего
все groups перезапущены и получили точные counts. Это dependency/orchestration
failures, не скрытые product regressions.

P2-I добавляет первое user-owned capability состояние. Strict
`ModelCapabilityOverride` version 1 несёт literal source `user_override`, state
`overridden`, единственное positive value `present`, одну capability из
существующего closed enum, canonical reference, exact digest, sourced runtime
version и createdAt/updatedAt. Descriptor получает два additive поля: sourced/
unknown `runtime` fingerprint и `overrides: []` с legacy default, поэтому старые
recorded responses парсятся без fabricated override. Negative `unsupported`,
confidence, free-form capability и arbitrary note не введены: absence строки
оставляет capability в прежнем `declared | degraded | unknown` состоянии.

Migration 9 создаёт `model_capability_user_overrides` без изменения migrations
1–8 и без backfill из declaration или probe. Одна latest row принадлежит exact
`(provider, canonical reference, digest, runtime version, capability)`; повторный
identical write идемпотентен и не меняет timestamps, clear удаляет ровно одну
row. Rollback на v8 оставляет user data читаемой, а старый code игнорирует table.
Одна нечитаемая row не прячет и не блокирует соседние capabilities той же
identity, но сама никогда не становится visible assertion.

Server владеет identity: mutation допускается только при одном canonical
`/api/tags` match, exact expected digest и sourced local `/api/version`, и
identity перечитывается в точке mutation. Duplicate/missing/changed identity,
missing digest, unavailable runtime version, stale client expectation и
persistence failure дают typed conflict без записи и удаления; conflict по
contract не может нести ни identity, ни override. Committed mutation никогда не
сообщается как `persistence_failed`. Mutation не запускает Ollama chat/pull/
load/unload, Governor admission, probe, catalog refresh или background Job —
только два read-only identity endpoint.

Installed profile показывает assertions отдельным labelled регионом рядом с
provider declarations и completion probe. Positive override не красит declaration
в verified-green и не скрывает conflict/degraded/unknown. Add/remove требуют
explicit confirmation и one-intent guard; mount, hover, focus, rerender,
navigation, reload и export ничего не мутируют. Copy/Download отдают
deterministic safe JSON с фиксированным filename и content type, без endpoint,
credentials, path, provider body, prompt, response и reasoning.

Required evidence through revision `6cc4504`: typecheck; P2-I 52 new / 401 core
envelope (contract 6, migration 6, store 12, service 21, routes 7); Web 117/117;
mocked Chromium 25/25; production build; markdownlint 31 files/0 issues; diff
check. Sequential repeats with exit/count checking: P2-I server 10×52/52,
targeted Web 10×22/22 и Chromium 10×2/2; migration/descriptor files, затронутые
diff — 10×35/35; AppContext-затронутые files — 10×64/64.

Первые failures не скрыты. Первый core run после migration 9 дал 335/349 и 14
inherited migration-fixture failures: version expectations были прибиты к 8, а
downgrade helpers не удаляли новую table. Причины исправлены в fixtures. Один
component assertion использовал недоступный в текущем setup `toBeDisabled`;
заменён на portable проверку `disabled` плюс явную проверку инертности. Первый
root-level Playwright запуск получил `Cannot navigate to invalid URL` — это
известная cwd-ловушка, канонический запуск из `packages/web` прошёл. Мой первый
catalog fixture в browser spec не соответствовал `catalogModelSchema`; исправлен.
Несколько `npm test | grep` конвейеров завершались exit 137 под memory pressure —
это окружение, а не продукт: те же команды с записью в файл дали полные counts.
Один repeat wrapper использовал zsh без word splitting и не нашёл файлы, другой
ожидал 17 вместо 16 tests; wrappers исправлены и все засчитанные groups
перезапущены.

Независимая verification выполнена двумя reviewer-субагентами
(`sde-agent:implementation-reviewer` для contract/store/routes,
`frontend-agent:accessibility-reviewer` для Installed Web) и нашла реальные
дефекты, исправленные отдельными commits. `09b3c00`: padded `/api/version`
делал успешно записанное assertion навсегда невидимым, потому что write
тримил runtime version, а descriptor read — нет; committed mutation
сообщалась как `persistence_failed`, когда падала только read-back projection;
одна corrupt row wedge-ила все capabilities identity без пути к восстановлению;
store принимал non-canonical reference, позволяя одной модели владеть несколькими
rows; malformed percent-escape в имени давал untyped 500. `c8ef1b8`: `Select` не
принимал `id`, поэтому visible `htmlFor` label не был связан с control.
`a177b14`: `URL.revokeObjectURL` в том же тике мог отменить начатое скачивание.
`6cc4504`: fix стабильного `returnFocusRef` был применён только к add-пути, из-за
чего remove-dialog отскакивал фокусом при каждом rerender, а после удаления row
фокус падал на `<body>`. Каждый fix имеет assertion, проверенный мутацией
исходника. Reviewer также нашёл, что мой `git add -A` затянул в коммит
scratch-каталог `.review-tmp/` первого reviewer-а; удалён и внесён в
`.gitignore` (`ef62f3c`).

Остаточные риски P2-I названы прямо. User override — это заявление пользователя,
а не verification: оно не доказывает capability, не включает Task Adapter, не
участвует в admission/fit, и отсутствие override не означает unsupported. Не
реализованы full Capability Registry, generic precedence/conflict resolver,
negative override, confidence, audit history, multi-user/auth profile и
sync/cloud export. Не проверены live Ollama/hardware, реальный provider-version
matrix, external-client identity и multi-process coordination: все tests
используют temporary SQLite, fake tags/version transport и mocked browser routes.
Явно не покрыт assertion пункт «positive override не красит declaration
verified-green» в состоянии, когда declaration действительно verified: текущие
fixtures держат provider evidence degraded, а verified-green треатмент в
Installed evidence сейчас не существует.

P2-J добавляет Hugging Face как отдельный read-only provider. Один pure
server-side parser (`hugging-face-reference.ts`) нормализует identity: разрешены
только strict `owner/name` и exact HTTPS `huggingface.co` model page. Whitespace,
control characters, NFKC-нормализуемый текст, credentials, port, query/fragment,
foreign и lookalike host, encoded separator, traversal, пустые segments,
multi-slash, reserved Hub routes (`datasets/...`) и revision/file suffixes
fail-closed с typed reason. Hub path case-sensitive: exact owner/name сохраняются,
а `comparisonKey` — только локальный case-folded dedup key, он не уходит в Hub и
не показывается как path.

`hugging-face-transport.ts` — единственная outbound HF граница. Один explicit
search = один bounded request: connect deadline 8s, response deadline 12s, hard
byte cap 2 MiB на streamed body, максимум 512 file entries на repository,
максимум 5 ordinal pages, bounded число published rows на страницу и caller
AbortSignal. Доступ только anonymous public: ни `Authorization`, ни cookie, ни
token; `redirect: 'error'` не даёт уйти на другой origin. Все failures —
typed redacted states (`provider_unavailable`, `connect_timeout`,
`response_timeout`, `response_too_large`, `provider_malformed`, `provider_error`,
`rate_limited`, `not_found`, `request_cancelled`) без raw body, endpoint, host,
path или credentials. Cursor opaque: он только echo-ится назад, проверяется на
origin, whole-token `rel="next"`, длину и control characters.

Verdict discipline — единственное support-утверждение среза, и только про
GGUF-only import scope: `supported` требует exact GGUF evidence, `unsupported`
требует complete listing, доказавшего отсутствие, всё остальное — `unknown` с
reason. Truncated listing и malformed entries никогда не дают `unsupported`;
отсутствие metadata тоже даёт `unknown`, а не `unsupported`. Gated state и
license сами по себе не меняют verdict. Дублирование правила в
`huggingFaceRepositorySchema.superRefine` не даёт опубликовать несогласованную
строку. `totalFiles` — число рассмотренных bounded listing entries, а не
provider total, и это зафиксировано в контракте.

Marketplace показывает HF отдельной секцией, не подмешивая rows в catalog list и
не меняя P2-A descriptor или P2-E rows. Mount, hover, focus, typing, navigation и
reload не делают request; search требует explicit submit; double submit — один
intent; late response superseded поиска отбрасывается. Кнопок Install/Pull нет:
UI прямо говорит, что дальше нужен выбор точного GGUF file, и не обещает ни
one-click install, ни direct Ollama pull. `unsupported` объясняет scope и не
называет модель сломанной; `unknown` не показывается как supported. Failed
дальнейшая страница сохраняет уже найденные rows, а retry повторяет ровно тот
page/cursor, который упал.

Required evidence through revision `2f13e31`: typecheck; P2-J 45 new / 446 core
envelope (parser 7, transport 27, routes 11); Web 27 new / 144 envelope; mocked
Chromium 1 new / 26 envelope; production build; markdownlint 31 files/0 issues;
diff check. Sequential repeats with exit/count checking: P2-J server 10x45/45,
Web component 10x27/27, Chromium 10x1/1, затронутые AppContext fixtures 10x64/64.
Migration 10 не добавлена: P2-J остался request-scoped, HF данные не пишутся в
SQLite.

Первые failures не скрыты. Node type-stripping отверг TypeScript parameter
property в transport — переписано на explicit field. `HeadersInit` отсутствует в
server tsconfig lib — заменён на portable тип. Первый `npm run typecheck` после
wiring дал 6 inherited AppContext failures: fixtures не знали нового поля
`huggingface`; во все шесть добавлен inert stub, который бросает при обращении,
поэтому unrelated flow, дошедший до HF границы, упал бы громко. Два уже
закоммиченных файла содержали literal NUL bytes (git считал их binary) —
заменены на explicit escapes отдельным commit `985db43`. Mutation-проверка
парсера сначала показала два «выживших» мутанта (port, percent-escape); проверка
показала, что это дублирующие defense-in-depth гейты — при удалении соседнего
гейта или обоих сразу tests падают, то есть свойства проверяются. Mutation
транспорта показала два реально не покрытых свойства (точный `.gguf` suffix и
unavailable source health при failed repository read) — добавлены assertions.
Mutation Web показала, что late-response guard был недостижим: in-flight guard
блокировал любой повторный submit, поэтому guard был мёртвым кодом; guard
переписан на per-intent, и теперь другой запрос вытесняет предыдущий.

Независимая verification выполнена двумя reviewer-субагентами
(`sde-agent:implementation-reviewer` для contract/parser/transport/routes,
`frontend-agent:accessibility-reviewer` для Marketplace Web); обоим было явно
запрещено писать в worktree, и `git status` это подтвердил. Reviewer server-лейна
не нашёл blocking findings, но нашёл: `failedPage` за пределами bound публиковал
contract-invalid объект; число published rows не было ограничено `pageSize`
(provider мог вернуть 5000 строк на запрос 10); `parseIdentity` дублировал
grammar и не применял `RESERVED_OWNERS`, поэтому `datasets/squad` из search
принимался, хотя парсер тот же самый string отвергает; `rel="next"` матчился как
substring, поэтому `rel="next-page"` считался пагинацией; cursor не проверялся на
control characters. Исправлено в `2428475`. Reviewer Web-лейна нашёл три
blocking дефекта: failed или empty вторая страница уничтожала уже найденные
результаты и при empty ещё и заявляла «ничего не найдено»; retry игнорировал
упавший intent и молча перезапускал walk с первой страницы, а после правки текста
в поле — запускал вообще другой запрос; все три primary action теряли клавиатурный
фокус на `<body>` и не восстанавливали его. Также: dropped rows не раскрывались,
когда отброшены были все строки, то есть total metadata failure выглядел как
«ничего не найдено»; live region замолкал на empty; `role="alert"` на внутреннем
span озвучивал причину без заголовка и без retry; malformed license/revision
показывались как «не заявлена»; `observedAt` рендерился сырым ISO; написанный
license caveat не выводился; touch targets были 16–32 px против требуемых 44;
внутреннее слово «срез»/«slice» попало в пользовательский текст; `statusRef` был
мёртвым кодом; `as LocaleKey` cast обходил проверку типов. Исправлено в
`2f13e31`. Каждый fix подтверждён мутацией исходника: 4 server и 9 Web reverts,
все поймано, ни одного выжившего.

Остаточные риски P2-J названы прямо. **Live Hub API не проверялся**:
`huggingface.co` и web-поиск недоступны из этого окружения, поэтому форма ответа
(`id`, `sha`, `gated`, `tags` с `license:`, `siblings[].rfilename`/`.size`,
`Link: rel="next"` с `cursor`, параметр `full=true`) взята из документированного
Hub API и `research/EVIDENCE.md`, а не подтверждена реальным ответом. Reviewer
отдельно проверил degradation: при неверном предположении каждое поле уходит в
`unknown`, а не в ложный `supported`/`unsupported`. Единственный silent случай —
если Hub не присылает `rel="next"`, пагинация просто не появляется и это
неотличимо от честной одной страницы. HF metadata не является доказательством
`ollama pull`; `apps=ollama` — hint, не подтверждение совместимости; отсутствие
GGUF не значит, что модель сломана; отсутствие metadata не значит unsupported.
Ordinal `page` bound ограничивает честного клиента, а не сервер: cursor не
привязан к ordinal, поэтому прямой caller может пройти больше страниц. Bounded
concurrency не реализована: 50 одновременных запросов дадут 50 Hub reads.
Detail route `/api/models/discovery/hugging-face/repository` проверен серверными
тестами, но не имеет UI, и клиентский метод `readHuggingFaceRepository` пока без
вызывающей стороны. `rfilename` публикуется без проверки формы — в P2-J ничего не
скачивается, но P2-L будет качать именно по этому path. Identity pin сравнивает
case-folded key, поэтому published `repositoryId` — написание пользователя, а не
authoritative case Hub. Не реализованы и не проверены: выбор exact GGUF
file/revision, download/checksum/provenance, local import через `/api/create`,
probe, token/gated acceptance, safetensors conversion, persistent HF cache,
saved searches и ranking. Все tests используют fake HTTP transport, recorded
fixtures и mocked browser routes; live Ollama, GPU и network не задействованы.

P2-K реализован в `9f3990d`, verification hardening зафиксирован отдельным
`9f3f19c`; обязательная независимая read-only verification выполнена двумя
reviewer-субагентами. Strict additive
contract связывает exact repository identity, lowercase 40-hex commit и один
portable-safe `.gguf` path. Server перечитывает exact revision через существующую
anonymous bounded HF boundary с `blobs=true`; complete well-formed inventory,
revision и file membership проверяются заново. Truncated/malformed inventory,
mutable/changed revision, foreign path и unsupported/unknown repository
fail-closed. Selection request-scoped: SQLite migration, download, checksum,
Ollama create/pull/probe, Governor, catalog refresh и Job не добавлены.

Claimed-size preview не выдаётся за measured fit: dedicated refinements требуют
`measured:null`, нулевой KV, `requiredBytes === modelBytes`, coherent
utilization/level и обязательные source/observedAt/estimated-confidence
стартового hardware probe. Size и capacity могут дать typed unknown; UI прямо
говорит, что KV/runtime overhead не учтены. Fresh gated/license claims показаны
с access/legal caveats. Web требует explicit action, collapses duplicate intent,
abort-ит initial/repeated stale context и same-key evidence, восстанавливает
focus и не показывает Download/Install/Pull.

Evidence 2026-08-09: typecheck clean; P2-K server 29 new, полный server-only
envelope 472/472 и root core 475/475; Web 17 new / 161 envelope, exact P2-K
component 16/16; affected AppContext fixtures 64/64; production build;
exact Hugging Face Chromium 2/2 и полный mocked Chromium 27/27, включая 1 новый
P2-K case. Sequential repeats с
exit/count checking: server 10×29/29, Web 10×16/16, AppContext 10×64/64.
Mutation checks поймали удаление `blobs=true`, encoded/portable path gates,
inventory refusal, fit coherence/hardware evidence, cancellation forwarding,
initial-context supersession, same-key disclosure reset, fresh license caveat и
context refit.

Первые failures не скрыты. Два новых test-файла прошлого агента содержали literal
NUL — заменены на source escapes; первый targeted Web run был 35/36 из-за
устаревшего duplicate assertion, затем 34/36 из-за incoherent unknown-size/
summary fixtures — fixtures исправлены. Первый исполняемый browser gate также
нашёл три ambiguous strict locator в новом case; assertions были привязаны к
точным видимым и paragraph targets, после чего exact/full Chromium стали
зелёными. Reviewer нашёл hardware provenance,
initial pending-context race, fresh-license caveat, open-preview scaling,
stale browser copy, Disclosure reset, live-region assertions, portable Windows/
C1 paths, claimed-size fit coherence, signal-forwarding и mutable-revision gaps;
все findings исправлены и повторно проверены локальными suites/mutations.

P2-K independently verified и передан P2-L. Raw live HF JSON остаётся
неполученным: после снятия sandbox DNS/loopback ограничений anonymous запросы
дошли до внешнего egress filter, но вернули HTTP 503 с HTML «Сайт заблокирован».
Текущие official docs/source подтверждают exact revision path и
`files_metadata=True → blobs=true`; это не production validation, поэтому
provider-wire drift остаётся residual risk. Runtime gates используют mocked HF
routes и не доказывают live Ollama, GPU, download или network behavior.

P2-L реализован в `8bb65c9`, verification hardening — отдельным `e1d4e66`.
Два независимых read-only reviewer-субагента проверили server/contract/security/
filesystem и Web/a11y/browser diff. Exact confirmed tuple перечитывается через
P2-K boundary до writer; resolve URL строится из отдельно encoded segments.
Download принимает только full HTTP 200 через exact documented HTTPS/443 host
set, не отправляет credentials/Range, имеет redirect/connect/body/maximum-byte/
size bounds и не буферизует файл целиком. Generated `wx` partial stream-ится с
SHA-256, GGUF magic/version 2/3 inspection и atomic no-overwrite finalization.
Provider LFS digest остаётся claim и отделён от locally observed digest.

Операция connection-owned: reload/disconnect/cancel не создаёт Job, replay или
resume; cancel/error удаляет только доказанно owned partial. Duplicate exact
target имеет один process-local writer. Completed provenance содержит exact
identity/commit/path, fresh license/gated claims, expected/observed size,
checksum relation, format, managed artifact id и observedAt, но не создаёт
Installation, catalog entry, Ollama model или capability proof. Web показывает
explicit preparing/downloading/verifying и typed terminal states, truthful
known/unknown progress, stale-attempt protection, terminal focus/live semantics
и verified-staging wording без Install/Create/Pull.

Evidence 2026-08-09 разделено по `WORKFLOW.md`: **29 new / 504 full core
regression envelope**, **6 new / 167 full Web component/parser envelope**,
**1 new / 28 full mocked Chromium envelope**. Exact P2-L server/contract subset
24/24, exact HF Chromium 3/3, typecheck/build/markdownlint/diff-check зелёные.
Browser assertion проверяет same-origin exact route, known progress, provider
failure с сохранением ровно одной local catalog row, keyboard retry, 390 px,
200%, 44 px cancel target и computed reduced-motion transition.

Первые failures не скрыты. До feature commit browser fixture имел incoherent
unknown fit и был исправлен. Независимая verification нашла: collision cleanup
мог удалить чужой partial; HTTP 206 мог стать ложным completed; understated
Content-Length создавал schema-invalid progress; allowlist пропускал non-default
port; late SSE старой попытки мог перезаписать cancel/retry. Reviewer также
нашёл assertion gaps для GGUF v2/all hosts/connect/declared-size bounds,
state/a11y matrix, origin, local-catalog retention и reduced motion. Все findings
получили regression assertions и исправлены в отдельном fix commit.

Residual risks P2-L: live HF redirect/wire path и большие файлы не проверены из-за
HTTP 503 egress filter; fixtures synthetic/mocked и не доказывают real disk
pressure, screen reader, socket disconnect или live Ollama/GPU. Duplicate writer
только process-local; hard crash может оставить orphan `.partial`; restart не
resume-ит и не индексирует staging. Semantic GGUF/Ollama compatibility,
Semantic GGUF/Ollama compatibility тогда оставалась P2-M.

P2-M реализован в `62a41c6`, findings независимой verification исправлены
отдельным `5b3d71d`. Два read-only reviewer-субагента независимо проверили
contract/server/filesystem/Ollama lifecycle и Web/a11y/browser assertions.
Strict command принимает только P2-L artifact UUID, target reference и context;
server повторно проверяет managed root/path/inode/size/SHA-256/GGUF, запрещает
remote Ollama, владеет одним artifact и target на процесс и делает no-overwrite
samples до documented blob + files-map `/api/create`. Ordered create terminal
ещё не Installation: после него обязательны fresh exact `/api/tags` digest и
fresh forced completion probe с совпадающими reference/digest/runtime/context.
Success-only cleanup проверяет inode ownership; failure/cancel/conflict сохраняют
staging. После пересечения create boundary retry не вызывает второй create, а
abort reconciliate-ит tags и не выдаётся за clean cancel.

Web показывает import только после current P2-L completed, требует отдельного
target confirmation и до него не делает mutation. Preparing/importing/verifying/
probing, invalid target, provider/identity/probe failure, no-overwrite conflict,
clean server cancel и client-abort unknown outcome различимы. Installed/runtime
verified появляются только из completed provenance; refresh вызывается один раз
после success. Locale, late-event isolation, focus после retry, live roles,
mobile 44 px, 200% и reduced motion имеют exact assertions.

Evidence 2026-08-09 по правилу `WORKFLOW.md`: **16 new / 520 full core regression
envelope**, **6 new / 173 full Web component/parser envelope**, **0 new + 1
expanded / 28 full mocked Chromium envelope**. Расширенный existing P2-L browser
case выполняет P2-M failed → retry → cancel/conflict → retry → success и
проверяет exact bodies/counts, один Installed row и success-only refresh.
Targeted final: server/contract/adapter/filesystem 68/68, import 12/12, component
6/6, exact HF Chromium 3/3. Typecheck, full tests, full Chromium, build и
diff-check зелёные.

Первые failures не скрыты: initial component ожидал старую cancel copy; browser
содержал старую P2-L boundary copy; первый полный `npm test` обнаружил
несовместимый с Node strip-only parameter property; усиленный live-role browser
assertion сначала посчитал вложенный ancestor status дважды. Независимые reviewer
нашли stale completed replay, concurrent same-artifact/different-target create,
remote Ollama scope leak, несогласованные contract state/provenance, invalid
target как provider unavailable, потерю retry focus, 32 px confirmation targets,
скрытый degraded probe result и browser count gaps. Всё воспроизведено и закрыто
в `5b3d71d`. Mutation run намеренно ослабил checksum, pre-existing no-overwrite,
create frame order и cancel reconciliation: 4/12 tests упали на соответствующих
assertions; production guards восстановлены, 12/12 прошли.

Residual risks P2-M: fixtures synthetic/mocked и не проверяют live Ollama/HF/GPU,
большой GGUF, disk pressure, socket/kernel cancellation или semantic quality.
Ollama `/api/create` не предоставляет CAS: внешний client может изменить target
в узком окне после последнего tags sample, поэтому cross-process no-overwrite
остаётся best-effort. `lstat` + path-based `unlink` имеет узкое недоказанное
swap-window. Registry/attempt state process-local; restart делает staging orphan/
unowned, не resume-ит import и не удаляет уже созданную model. Screen-reader API,
forced colors, реальный touch и provider-version matrix не проверены.

P2-N реализован в `ac928a3`, а три findings независимого read-only reviewer
исправлены отдельным `b0b7248`. Один immutable server-owned registry содержит
ровно один closed declaration `estimated_parallel_admission_policy`: compiled
default `false`, exact process env `enabled | disabled`, deterministic operator
precedence и один observation time на startup. Invalid, unavailable, unknown и
future input fail closed; public GET projection strict/versioned и не содержит
raw env, env name, default metadata или arbitrary/server-only key. Persistence,
write API, Web/localStorage, network/analytics, model и Governor consumers
отсутствуют; P2-N не меняет admission.

Evidence по `WORKFLOW.md`: **12 new / 532 full core regression envelope**,
**0 new / 173 full Web envelope**, **0 new / 28 full mocked Chromium envelope**.
Targeted final P2-N — 12/12; root typecheck, build, markdownlint и diff-check
зелёные. Chromium 28/28 прошёл после feature commit и не повторялся после
server-only review fix по согласованному сокращённому режиму. Reviewer нашёл:
optimistic `safe_default:true` и empty v1 contract acceptance; partial cast
вместо двух production contexts; неполный no-side-effect evidence. Fix связал
safe default с false/exact count, использует два реальных `createAppContext` и
добавил network sentinel + production composition inventory.

Первые failures не скрыты: initial targeted redaction assertion искал строку
`false` и ошибочно совпал с JSON boolean; assertion заменён на exact keys и
private sentinel. Пять mutation checks намеренно включали default-on, unknown
key, inverted precedence, server-only projection leak и Governor access; все
пять дали ожидаемый non-zero exit, после восстановления 12/12 зелёные.

Residual risks P2-N: operator env требует restart и не является persisted user
choice; live process/service restart не проверялся, только независимые in-memory
`AppContext`; remote bind/auth profile и production operator workflow не
валидированы. Сам P2-N не имел consumer и не менял admission; P2-O consumer ниже
теперь реализован, а второй permit остаётся поздней measured-работой.

P2-O реализован в `0dc5c71`; findings независимого read-only reviewer исправлены
автором в отдельных `2f08b78` и `7b5101c`. Strict version-1
`POST /api/runtime/estimated-parallel-admission` принимает одну explicit
active/queued pair с owners, canonical references, digests, contexts и expected
Runtime timestamp. Default-off/invalid/unavailable flag возвращает `disabled`
до Runtime/provider work. Enabled query revalidate-ит один coherent Runtime
sample, internal Ollama endpoint, exact active `/api/ps` identity и candidate
`/api/tags`/`/api/version`/`/api/show` identity.

Каждый numeric fact сохраняет source/time/confidence/basis. Exact calibration
заменяет formula; без неё `declared + KV` публикуется как отдельный derived lower
bound. Active allocation показывается, но не прибавляется к current available
memory второй раз. Equality/shortfall дают conservative `estimated_deny` в
injected arithmetic fixtures; formula positive headroom остаётся
`formula_overhead_unknown`, exact-calibrated positive headroom —
`admission_capacity_policy_unapproved`. Contract резервирует только coherent
`estimated_allow`, но current calculator его не выпускает. Governor остаётся с
одним permit и query не acquire/release/enqueue/cancel-ит, не запускает
load/probe и не пишет persistence.

Evidence по `WORKFLOW.md`: **14 new / 546 full core regression envelope**,
**0 new / 173 full Web envelope**, **0 new / 28 full mocked Chromium envelope**.
Targeted P2-O после review fix — 14/14; root typecheck, `npm test`, build,
markdownlint, diff-check и Chromium 28/28 зелёные. Browser gate не содержит
P2-O consumer и даёт только compatibility credit. Ten incoherent synthetic
allow mutations отклоняются contract. Шесть явных mutation checks — flag
inversion, stale bypass, Ollama-host drift bypass, active-byte double count,
`measured` promotion и Governor acquire inventory sentinel — дали ожидаемый
non-zero; guards восстановлены перед final gates.

Первые failures не скрыты: initial response schema не принимала versioned
request; один declared-only fixture ожидал deny при positive headroom. Reviewer
затем подтвердил incoherent synthetic allow, runtime/provider host drift,
неполную проверку denormalized exact calibration row, misleading combined
formula provenance и assertion gaps pair/cancellation/inventory. Fix добавил
checked response coherence, internal Runtime endpoint identity, full row-key
validation, derived provenance и недостающие assertions. Повторный reviewer
проверил exact-calibration provenance и cross-pair runtime/hardware fingerprint
coherence; schema-valid mutations закрыты в `7b5101c`, final verdict — PASS.

Residual risks P2-O: current production Apple adapter не публикует observed
available-memory/pressure admission inputs, Linux/NVIDIA topology не связывает
`/api/ps` row с device; поэтому production calculator сейчас не достигает ни
allow, ни arithmetic deny и остаётся `unknown`. Нет Web consumer, live
Ollama/GPU/hardware, operator restart или external-client validation. Historical
calibration остаётся estimate будущего запуска. Owner-approved admission
capacity/margin отсутствует; второй permit и measured execution по-прежнему
вынесены post-Phase-4.

P2-A, P2-B, P2-C, P2-D, P2-E, P2-F, P2-G и P2-H остаются `implemented, locally
validated`, а не independently verified или production-validated. Не проверены
live Ollama/model/hardware, NVIDIA driver/GPU/MIG, provider-version matrix,
production TTL/residency, external-client ownership и multi-process coordination.
Migrations 7/8 хранят latest safe
projections, а не continuous evidence history/full Capability Registry;
semantic quality, tool/media capabilities и user overrides не реализованы.
P2-D/P2-E — только bounded mutable-tag pull: нет durable resume, disk
reservation, checksum/provenance, immutable tag resolution или recent entry.
P2-H работает только с current local/bundled response: нет remote provider,
immutable multi-request snapshot, saved filters, generic virtualization, 10k/
live load evidence или inferred license/quantization/task facts. Legacy client
может по-прежнему запросить полный list; page-size policy не является total cap.
Эта запись отражала состояние до final exit audit. Owner session 2026-08-07
закрыла Q-25 (GGUF-only), HF import реализован P2-J..P2-M, hardware-dependent
пункты явно вынесены за Phase 4, а P2-N/P2-O закрыли текущий estimated-policy
scope. Audit ниже подтвердил все актуальные exit bullets; Phase 2 теперь
`independently verified`, а P3-A готов к началу.

## Phase 2 — final scope и release evidence

**Проверено кодом 2026-08-09.** Таблица обязательна к обновлению каждым Phase 2
slice: без неё читатель делает вывод, что до конца фазы остался один HF slice, а
это неверно.

| ROADMAP scope item                               | Состояние                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| HF search + exact GGUF/revision import (MOD-010) | сделано P2-J–P2-M; mocked public GGUF + loopback Ollama                                                      |
| license/gated/size/dry-run/fit preview           | P2-K claims/fit и P2-L observed size/checksum готовы; disk reservation и gated token не реализованы          |
| local Ollama create/import + checksum/provenance | сделано P2-L/P2-M; blob/create + exact tags + forced probe                                                   |
| measured-parallel за feature flag (RES-009)      | P2-N flag + P2-O estimated query сделаны; measured execution вынесен за Phase 4 (Q-34a)                      |
| exact variant selection/fit (MOD-002)            | сделано P2-E/P2-K: selected exact row/file владеет своим claimed-size fit и install target                   |
| exact installed calibration (ROADMAP scope)      | сделано P1-L: exact reference/digest/context/runtime/hardware observation; Marketplace claim не повышается   |
| Linux/NVIDIA verified tier (PLAT-002)            | prototype есть; verified tier вынесен за Phase 4 (Q-35), убран из exit gate                                  |
| user override (MOD-008)                          | **сделано в P2-I** (`6b98d37`..`6cc4504`): migration 9, exact-identity ownership, Installed UI, safe export  |
| bounded `/api/show` concurrency                  | **сделано в P1-M** (`c86e537`), не Phase 2                                                                   |

Итог на 2026-08-09 после P2-O: HF public-GGUF chain, user override, feature-flag
infrastructure и conservative estimated query закрыты mocked/local evidence.
Именованных product slices больше нет. Release-readiness audit исправил прежнюю
ошибочную привязку calibration к MOD-004: MOD-002 требует fit для exact variant,
а MOD-004 описывает facets. Accepted D-006, DOMAIN_MODEL, HLD, LLD и Runtime
Lifecycle согласованно разделяют pre-download Marketplace claimed-size preview
и post-install exact calibration/runtime evidence. ROADMAP scope реализован как
две variant-owned capabilities; ни один exit bullet не требует объединённого
effective fit. Новая связь потребовала бы отдельной freshness/precedence/
threshold/compatibility policy и не блокирует Phase 2. Hardware-dependent
measured claims вынесены за Phase 4. P2-M создаёт provider-observed installation
evidence, но не durable import Job, persistent Artifact/Installation registry
или production validation.

### Phase 2 exit audit 2026-08-09

Audit не менял runtime code. Независимый reviewer отверг invented calibration
blocker, но нашёл два заявленных свойства без mutation-catching assertions;
отдельный test fix добавил их без изменения production behavior. Ниже
перечислены только актуальные ROADMAP exit bullets; `npm test` и mocked Chromium
являются regression envelope, а не production/live-hardware validation.

| Exit property | Code boundary | Direct failing assertion | Evidence/status |
| --- | --- | --- | --- |
| Installed и Marketplace разделены | `LauncherPage`, installed/model catalog projections | `catalog-variant-install.spec.ts` считает exact row: 0 в Installed/1 в Marketplace до pull, затем 1/1 в разных regions | locally validated; installed-before-pull mutation fails |
| Selected GGUF/quantization совпадает с fit/install | HF selection/download/import + exact catalog row | selection/import/variant tests проверяют exact file/commit/target; completed import deep-equal сохраняет весь staged source | locally validated; source-path mutation fails |
| Unknown не становится supported | descriptor/HF/catalog schemas и UI | `model-evidence`, `capability-override-service`, `hugging-face-transport` явно проверяют unknown вместо unsupported | locally validated |
| Provider offline не ломает local | local/bundled catalog fallback и installed error isolation | `catalog.test` проверяет no-network fallback/unavailable; browser HF flow сохраняет local Marketplace row | locally validated |
| HF exact revision/checksum/license, non-GGUF unsupported | selection, staging download, import provenance | `hugging-face-selection-contract`, `hugging-face-download`, `hugging-face-import` проверяют commit/file/checksum/license/GGUF refusal | locally validated |
| Arbitrary URL не server-side fetch-ится | strict Ollama/HF reference parsers and routes | `ollama-reference`, `hugging-face-reference`, `hugging-face-routes` отклоняют foreign/traversal до network work | locally validated |
| Ollama human catalog не scrape-ится | local recommendations + bundled catalog only | `catalog.test` ставит network sentinel и требует zero fetch calls | locally validated |
| User override видим/exportable и не masquerade-ится | exact override store/service/Installed UI | capability-override contract/service/component/browser suites проверяют separate user evidence и safe export | locally validated |
| Parallel verdict только estimated | strict P2-O query/response | `estimated-parallel-admission.test` запрещает measured/future guarantee и double-count | locally validated; live hardware deferred by Q-35 |

Review fix `aaaf7b7` добавил **0 new test cases + 2 strengthened direct
assertions / 546 core regression envelope**, **0 new / 173 Web envelope** и
**0 new / 28 mocked Chromium envelope**. Targeted server 12/12 и browser 1/1
зелёные. Две mutation-проверки дали ожидаемый non-zero: подмена staged HF
`remotePath` сломала full-source deep equality, а преждевременная Installed row
сломала region-scoped empty/count assertion; mutations полностью восстановлены.

Full gates после fix: typecheck, `npm test` 546+173, Chromium 28/28, build,
markdownlint и diff-check — PASS. Первый independent review отверг invented
calibration blocker и нашёл оба assertion gaps; follow-up подтвердил исправления,
MOD split, все девять exit bullets и bounded P3-A handoff — final verdict PASS.
Phase 2 release-readiness verdict — **GO для перехода к Phase 3**, не production
deployment/validation. Hardware items, вынесенные Q-35, не являются Phase 2
blocker; mocked/local evidence не является live Ollama/GPU validation.

## Phase 3 — P3-A logical Project identity

**Статус:** independently verified (`0e00ee3`, `6f68501`, review fix
`ba63ff4`).

Migration 10 additive создаёт strict `projects` и
`project_filesystem_bindings`. Existing Workspace получает Project с тем же
stable ID и отдельную deterministic binding row; path не участвует в Project
identity. New Project создаётся без path/binding, name редактируется отдельно от
Workspace metadata. Legacy tables, `/api/workspaces`, Web client и filesystem
paths не удалены и не переименованы. Startup reconciliation повторяемо
подхватывает Workspace, который мог записать старый binary после schema upgrade;
identity/binding conflict и malformed timestamps откатывают transaction целиком.

Minimal `/projects` Web projection добавляет loading/empty/error/retry, no-path
create, rename, synchronous repeated-activation guard, error focus и EN source/
fallback + curated RU strings. Browser assertion покрывает 390 px, 200% scale,
no horizontal document overflow и reduced-motion policy; это не final Project
picker/navigation polish.

Evidence разделено по правилу WORKFLOW: **12 new / 558 core regression
envelope**, **4 new / 177 Web component/parser envelope**, **1 new / 29 mocked
Chromium envelope**. Full typecheck, `npm test`, browser gate, build,
markdownlint и diff-check — PASS. Targeted migration/routes — 21/21; Project Web
component — 4/4.

Первые targeted browser попытки нашли два fixture defects: Strict Mode создал
два initial GET, а не-exact retry selector пересёкся с Runtime Bar. После
исправления fixture product code не менялся, targeted и full browser gates
прошли. Mutation checks дали ожидаемый non-zero для Project-with-path,
duplicate binding acceptance, отключённых migration rollback constraints,
изменённого legacy Workspace JSON, malformed timestamp acceptance и
непереведённой RU строки; все mutations восстановлены.

Независимый reviewer сначала дал `NEEDS FIX`: contract/store пропускали
whitespace/malformed metadata, legacy byte-compatibility assertion сравнивал
новый код с самим собой, а RU copy содержал `metadata`. `ba63ff4` добавил strict
IDs/normalized name/datetime, runtime parse, whitespace fallback, literal raw
Workspace bytes и exact RU assertion. Follow-up reviewer: **PASS**, новых
findings нет.

Остаточный риск на момент P3-A: validation локальная на mocked/fixture SQLite и
Chromium; нет production migration corpus, multi-process race, real mobile/
screen-reader/forced-colors/visual-baseline validation. Project icon/color были
следующим bounded slice и закрыты P3-B ниже; defaults, Chat/Recipe/Artifact
ownership и final Workspace cutover по-прежнему не реализованы.

## Phase 3 — P3-B Project presentation metadata

**Статус:** independently verified (`b8eec80`, `6557c86`, test hardening
`29e75ba`, review fixes `4ab7a6a` и `794fc64`).

Migration 11 additive добавляет `icon_key` и `color_token` к Project с
deterministic defaults `folder`/`slate` и exact SQLite CHECK allowlists.
Versioned contract manifest фиксирует 48 stable Lucide icon keys, шесть
категорий, EN/RU accessible names, source/license metadata и восемь app-owned
palette tokens. Strict legacy Project v1 shape и `/api/projects` без query
остались byte-compatible; opt-in `presentationVersion=1` и отдельный
presentation PATCH не меняют Project identity, Workspace binding или path.

Web picker использует static Lucide imports, search/category filter, bounded
12-icon page, grid Arrow/Home/End/Page navigation, radio-group roving focus,
modal focus trap/return и synchronous one-mutation guard. Light/dark/forced-
colors styles используют только palette tokens; arbitrary SVG/URL/color и
user-facing bilingual hardcode не добавлены.

Evidence разделено по правилу WORKFLOW: **7 new / 565 core regression
envelope**, **4 new / 181 Web component/parser envelope**, **1 new / 30 mocked
Chromium envelope**. Full typecheck, `npm test`, browser gate, build,
markdownlint и diff-check — PASS. Build сохранил non-blocking Vite warning:
main chunk 816.38 kB minified / 216.76 kB gzip при warning threshold 500 kB.

Первые проверки нашли три fixture/assertion defects: browser long-name fixture
превышал strict 120-character contract; rollback fixture оставлял
`user_version=10` при уже существующих v11 columns; SQLite row имел null
prototype и требовал явной projection перед deep equality. После исправления
fixtures targeted и full gates прошли.

Первый independent review дал `NEEDS_FIX`: color radios не имели Arrow roving
pattern; SQL allowlist assertion доказывал только subset; modal name/trap/оба
close-control focus returns были неполными; responsive/forced-colors измерялись
после закрытия picker; reopen и unchanged-boundary evidence были недостаточны.
`4ab7a6a` закрыл findings. Follow-up нашёл один Low gap: provider counters не
охватывали versioned GET; `794fc64` добавил явный read+edit sequence. Финальный
reviewer verdict — **PASS**, все пять групп findings закрыты.

Mutation checks дали ожидаемый non-zero при разрыве transaction между двумя
ALTER, добавлении неизвестного SQL icon key, изменении Project name из
presentation PATCH, выдаче versioned fields legacy GET и снятии repeated-Save
guard. После восстановления targeted rollback/manifest/compatibility/isolation/
single-mutation tests снова прошли.

Остаточный риск: fixtures не являются production DB corpus или concurrent
multi-client PATCH validation; mocked Chromium не заменяет real screen reader,
touch/mobile и visual baseline; source/license mapping и palette contrast имеют
static/local evidence, а bundle size не имеет отдельного budget gate. Project
ownership/defaults и final Workspace cutover не реализованы. Следующий bounded
slice — P3-C Project-owned Chat grouping без reparent/move; после него retention
может одинаково доказать default для Project и projectless Chat.

## Phase 3 — P3-C Project-owned Chat grouping

**Статус:** independently verified (`c3521ed`, `71a48fa`, test hardening
`0d01fbe`, review fix `99cc556`, follow-up test `83dafbc`).

Migration 12 additive добавляет nullable `threads.project_id`, restrictive
Project FK и stable scoped-list index; existing Threads остаются projectless.
После independent review migration 13 append-only добавляет triggers, которые
запрещают reparent/nullification и не допускают mode/Workspace scope у
Project-owned Chat. Отдельный v12→v13 fixture доказывает mid-migration rollback,
recovery и reopen без переписывания уже применённой migration 12.

Versioned contract и nested `/api/projects/:id/chats` list/create/read владеют
canonical sourced ownership. Queryless Thread REST и literal create/list/read/
update bytes сохранены; projectless clients opt-in через explicit ownership
version. Store API не принимает произвольные owner/mode/workspace combinations,
response schema проверяет exact совпадение Project и Chat owner. Project-owned
Chat использует прежний durable Message/Job execution lifecycle.

Web показывает bounded Chat group на Project card, exact New Chat route и
sourced hard reload. Synchronous guard не допускает duplicate create; malformed
200, typed mismatch, stale reference и create failure переходят в safe focused
state. Project flow не читает Workspace и не выводит ownership из path/binding.
Long unbroken 120-character name переносится при 390 px и 200%; browser fixture
также проверяет forced colors и reduced motion.

Evidence по правилу WORKFLOW: **8 new / 573 core regression envelope**, **4 new
/ 185 Web component/parser envelope**, **1 new / 31 mocked Chromium envelope**.
Targeted migration/routes — 24/24; Project Web component — 12/12. Full
typecheck, `npm test`, browser gate, build, markdownlint и diff-check — PASS.
Build сохранил non-blocking Vite warning: main chunk 824.55 kB minified /
218.70 kB gzip при warning threshold 500 kB.

Первые implementation проверки нашли stale migration fixtures, которые
оставляли v12 column при artificial downgrade, eager Project Chat service
construction, hidden mobile sidebar assertion, отсутствующий typed mismatch code
и лишний Workspace read. Mutation legacy GET показала, что первоначальное
byte-assertion сравнивало mutated handler с ним же; `0d01fbe` закрепил literal
expected payload. Все defects исправлены до full gates.

Первый independent review дал `NEEDS_FIX`: DB не запрещала valid reparent/
nullification; nested schemas могли принять mismatched owner/future options;
long unbroken Project name переполнял heading; legacy CRUD/query/order,
malformed references и owned durable lifecycle не имели прямых assertions.
`99cc556` закрыл findings через append-only migration 13, narrow store boundary,
strict sourced schemas, element-level responsive check и точные server tests.
Follow-up нашёл один оставшийся assertion gap для multi-row projectless order;
`83dafbc` добавил exact count/order и mutation evidence. Финальный reviewer
verdict — **PASS**, открытых findings нет.

Mutation checks дали ожидаемый non-zero для migration rollback, cross-Project
leakage, ownership-vs-filesystem Workspace read, legacy raw response и repeated
form activation; все mutations восстановлены. Review findings дополнительно
имеют direct assertions для v12→v13 recovery/immutability, mismatched 200,
nested future fields, exact ordering, malformed references и owned Job reload.

Остаточный риск: SQLite и Chromium evidence остаются local/fixture/mock; нет
production DB corpus, concurrent multi-client create, real device/screen reader
или visual baseline. Server create не получил отдельный idempotency key: one-
create guarantee принадлежит текущему synchronous Web boundary. Project delete,
move/reparent UI и final navigation shell не реализованы; retention policy
реализована в P3-D ниже, а Trash ещё отсутствует.
Следующий bounded slice — P3-D canonical Chat retention policy/default/activity
projection без cleanup/Trash enforcement.

## Phase 3 — P3-D Chat retention policy foundation

**Статус:** independently verified (`c9913c8`, `5c6670b`, review fix
`cc41001`).

Migration 14 append-only добавляет policy/source/update и sourced
last-user-activity basis к `threads`. Existing rows получают explicit
`Keep / legacy_compatibility`, поэтому upgrade не делает старую историю
cleanup-eligible. Новый projectless и Project Chat получает один rolling
seven-day default. Первый accepted user message атомарно двигает basis вместе с
durable Job/Message command; duplicate key, model/tool/background/reload события
TTL не продлевают.

Strict contract и Chat-only GET/PATCH возвращают sourced activity, exact
server-calculated ISO expiry и `enforcement: not_implemented`, не меняя raw
legacy Thread bytes. Policy mutation изолирована от ownership, Workspace,
Project/binding, Message/Job/tool/settings, provider, Governor и filesystem.
Chat Info поддерживает `Keep | 7 days | Session`, explicit one-mutation Save,
раздельный GET/PATCH retry, fail-closed Chat/Project identity и честно сообщает,
что cleanup/Trash ещё отсутствуют.

Evidence по правилу WORKFLOW: **7 new / 580 core regression envelope**, **6 new
/ 191 Web component/parser envelope**, **1 new / 32 mocked Chromium envelope**.
Targeted server routes/retention — 26/26; Chat retention component — 6/6;
targeted browser — 1/1. Full typecheck, `npm test`, browser gate, build,
markdownlint и diff-check — PASS. Build сохранил non-blocking Vite warning: main
chunk 833.32 kB minified / 220.83 kB gzip при threshold 500 kB.

Первый full `npm test` выявил 26 stale artificial-downgrade fixtures: они
понижали `user_version`, но оставляли v14 columns. Fixtures теперь выполняют
точный v14→v13 schema downgrade, а baseline migration assertion обновлён на 14.
Других pre-review full-gate failures не осталось.

Independent reviewer сначала дал `NEEDS_FIX`: Web не сверял response `chatId`,
failed Save retry выполнял GET, а atomic command rollback, полный migration
payload, side-effect envelope и timezone/clock independence не имели достаточных
direct assertions. `cc41001` закрыл все шесть findings. Follow-up reviewer
повторно запустил server 26/26 и component 6/6 и дал **PASS** без открытых
findings.

Mutation checks дали ожидаемый non-zero для migration rollback, Project-vs-
projectless default drift, background-event TTL extension, literal legacy bytes
и repeated Save; все mutations восстановлены. Дополнительный trigger fault
доказывает общий rollback activity/Message/Job/event/input, а browser fixture
сохраняет sourced ISO при Honolulu timezone и fake clock 1999→2040.

Остаточный риск: SQLite migration corpus синтетический, Chromium mocked; нет
production DB corpus, concurrent multi-client PATCH, real device/screen reader,
visual baseline или live Ollama/GPU/network validation. Policy только настроена:
expiry query, Maintenance scheduler, Trash/grace, restore, Session leave
detection, active-Job deletion guard и hard deletion не реализованы. Следующий
bounded slice — P3-E TTL Maintenance/Trash enforcement foundation.

## Phase 3 — P3-E Chat TTL Maintenance и recoverable Trash

**Статус:** independently verified (`01c8b3f`, `da7519a`, review fixes
`fed4ac6`, `1965feb`).

Migration 15 append-only добавляет `active | trash`, sourced tombstone basis,
lifecycle audit и eligibility/Trash indexes. Existing rows остаются active.
Один server-owned owner после Chat Job recovery выполняет startup и periodic
stable bounded passes с injected clock и shutdown cleanup. Только expired TTL
Chat eligible; Keep/Session, unexpired Chat и Chat с любым canonical
non-terminal Job исключаются. Tombstone и audit атомарны, повторный pass
сходится без duplicate effects.

Active global/projectless/Project lists скрывают Trash. Versioned boundary
возвращает exact projectless либо Project scope без leakage. Explicit Restore и
смена policy из Trash на Keep/7 days атомарно активируют Chat, задают новый
rolling basis и создают один sourced audit event. Raw legacy Thread JSON не
изменён. Web показывает bounded Trash в обеих областях, exact reason/time,
truthful отсутствие hard deletion и focused load/Restore retry. После успешного
Restore stale item скрывается даже при failed refresh и больше не остаётся
actionable.

Evidence по правилу WORKFLOW: **9 new / 589 core regression envelope**, **7 new
/ 198 Web component/parser envelope**, **1 new / 33 mocked Chromium envelope**.
Targeted P3-E server — 9/9; focused Web retention/Trash — 13/13. Full typecheck,
`npm test`, browser gate, build, markdownlint и diff-check — PASS. Build сохранил
non-blocking Vite warning: main chunk 841.73 kB minified / 222.85 kB gzip при
threshold 500 kB.

Первые проверки выявили три fixture/assertion проблемы: старые migration tests
ожидали v14, один Project Chat fixture не включал новую lifecycle projection, а
первый root-relative Vitest filter не нашёл файлов. После исправления полный
baseline прошёл. Independent reviewer затем дал `NEEDS_FIX`: failed reload
после Restore сохранял stale actionable row, а TTL policy restore, обе boundary
scope, terminal states, cursor tie, global/projectless visibility, exact schema,
non-lifecycle Thread payload и no-effect boundary не имели достаточных direct
assertions. Отдельный `fed4ac6` закрыл findings; follow-up reviewer запустил
server 40/40 и Web 21/21 и дал **READY** без открытых findings.

Первый финальный Chromium gate затем выявил старый P3-B cross-flow: background
initial Trash errors могли перехватить focus у внешней keyboard activation,
поэтому Project presentation case упал 1/33. `1965feb` ограничил error focus
нейтральным body либо текущей Trash region и добавил direct assertion, что
внешний active control сохраняется. Targeted component 7/7, targeted browser
1/1 и повторный full browser 33/33 прошли. Reviewer проверил exact fix diff и
component 7/7, дал READY; его browser retry не стартовал из-за занятого dev
port, поэтому full Chromium rerun остаётся evidence основной сессии.

Mutation checks дали ожидаемый non-zero для migration rollback, Keep/Session
leakage, active-Job guard, batch cap, active-list leakage, repeated Restore,
legacy Thread bytes и stale post-Restore UI duplicate; все mutations
восстановлены. Injected transaction faults отдельно подтверждают общий rollback
lifecycle/audit и Restore/audit.

Остаточный риск: SQLite corpus синтетический, Web evidence jsdom/mocked
Chromium; нет production DB corpus, concurrent-client lifecycle races, real
device/screen reader/visual baseline или live Ollama/GPU/network validation.
Hard deletion, TTL grace, Session leave/24-hour recovery, Artifact/blob GC и
reasoning retention не реализованы. Следующий bounded slice — P3-F typed
Reasoning Artifact persistence foundation без cleanup enforcement.

## Планируемая последовательность Phase 2

Пересобрано 2026-08-07 после owner decisions Q-25/Q-33–Q-36. HF-цепочка намеренно
разбита на bounded vertical slices, а не один «import» slice: из
`research/EVIDENCE.md` следует, что HF URL нельзя обещать как direct
`ollama pull`, и каждый шаг имеет свои failure states.

| Slice | Outcome                                                            | Статус                                               |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| P2-I  | exact installed capability user override (MOD-008)                 | independently verified                               |
| P2-J  | HF search + repository metadata, GGUF-only; non-GGUF → unsupported | independently verified                               |
| P2-K  | выбор exact GGUF file/revision + size/license/fit preview          | independently verified                               |
| P2-L  | download с checksum/provenance, bounded и cancel-safe              | independently verified                               |
| P2-M  | local Ollama import через `/api/create` + probe                    | independently verified                               |
| P2-N  | feature-flag infrastructure (без обещания measured)                | independently verified                               |
| P2-O  | estimated parallel-admission вердикт, всегда `estimated`           | independently verified                               |

`/api/create` добавлен P2-M как documented files-map endpoint, а не pull или
shell/Modelfile path. P2-N/P2-O закрывают
мотивацию owner про параллельный LLM + STT на уровне инфраструктуры и estimate;
сам STT остаётся в Phase 6 по cross-phase rule, а measured подтверждение — после
Phase 4.

## Design debts от owner session 2026-08-07

Проверено по коду 2026-08-07. Это не найденные баги в реализованном поведении, а
разрывы между accepted Q-27/Q-28 и текущим кодом. Каждый пункт обязателен к
закрытию до соответствующей фазы; agent tools остаются default-off, поэтому
сейчас это не активная уязвимость.

### Q-28 filesystem scope (Phase 5)

- **`resolveInWorkspace` принимает ровно один root** (`tools/jail.ts:61`).
  Трёхслойная модель требует набора allowed roots — это смена сигнатуры и всех
  шести tool-ов, не настройка.
- **`no delete` не обеспечен.** Delete-инструмента нет вовсе (tools: `list_dir`,
  `read_file`, `write_file`, `edit_file`, `glob`, `grep`), но `write_file`
  (`fs-tools.ts`, `mutating: true`) может записать пустоту, а `bash`
  (`tools/bash.ts:26`, `mutating: true`) **не имеет блок-листа команд**, поэтому
  `rm -rf` проходит. Гарантия «read/modify без delete» пока номинальная.
- **Traversal закрыт корректно** и переписывать не нужно: `realpathSync` вместо
  строковых сравнений (`jail.ts:13,68`), проверка `..` в несуществующем хвосте
  (`jail.ts:85-88`), граница по separator (`jail.ts:48-51`), NUL-байт
  (`jail.ts:62`).
- **Регистр не нормализуется**: `isInside` сравнивает case-sensitive
  (`jail.ts:48-51`), а macOS по умолчанию case-insensitive. Нужен явный тест на
  `/Users/x/Secret` против `/users/x/secret`.
- **`.env` скрыт только в листинге.** `list_dir` фильтрует dot-файлы кроме
  `.env.example`; `read_file` по явному пути не ограничен. Защита по маскам имён
  обходится через `.env.local`, `.env.production`, `id_rsa`, `.aws/credentials`,
  `.npmrc` — pattern-based правило само по себе не защита.
- **Layer 3 grants приходят текстом промпта**, поэтому обязательны: приём grant
  только из user input (никогда из file content, tool output или repository) и
  покрытие delete-эквивалентов — truncate к нулю, overwrite пустым, rename-away.

### Q-27 time-based control (Phase 5/8)

- **`wrap up and report` требует нового persisted state + migration.** Текущие
  transitions (`jobs/lifecycle.ts:4-37`) ведут из каждого рабочего состояния в
  `interrupted` при падении процесса. Без отдельного состояния P1-E recovery
  классифицирует прерванный wind-down как `interrupted` и **теряет сам отчёт** —
  то есть ровно то, ради чего wind-down и нужен.
- **`cancelling` переиспользовать нельзя** (`lifecycle.ts:26`): он ведёт в
  `cancelled`, а wind-down должен приводить к `completed` с отчётом. Это разные
  терминалы.
- **Stall detector по «нет input и output токенов» даст false positives.**
  В `prefill`/`thinking` отсутствие выходных токенов — штатное состояние
  (`lifecycle.ts:7-8`). Нужен порог по времени с учётом текущего state, иначе
  длинный prefill будет считаться залипанием.
- Deadline mid-run mutation: нужно решить owner-ство и поведение при сокращении
  дедлайна в прошлое и при сокращении во время уже идущего wind-down.

## Известные долги evidence

- **Двойной учёт tests.** `ollama-client.test.ts` (9) посчитан и в P2-C 34, и в
  P2-D 20. Net new у P2-D — 11, не 20. Таблица Phase 2 выше даёт headline без
  этой оговорки; новые slices пишут `N new / M envelope` по правилу 4a
  `WORKFLOW.md`.
- **`independently verified` без механизма.** Все commits — один автор, CI и
  git hooks отсутствуют. До Phase 2 этот статус означал self-review, а не
  второго участника. С 2026-08-07 статус ставится только при наличии отдельного
  reviewer-субагента и видимого review-fix commit. P2-I — первый slice, где это
  правило реально применено: два reviewer-субагента нашли шесть дефектов, каждый
  закрыт отдельным `fix(...)` commit с assertion, проверенным мутацией исходника.
- **Reviewer-субагент может писать в worktree.** Первый P2-I reviewer создал
  `.review-tmp/` для mutation-проверок, и `git add -A` затянул его в коммит.
  Каталог удалён и внесён в `.gitignore`; следующим агентам стоит проверять
  `git status` перед commit, а reviewer-у явно запрещать создание файлов.
- **Playwright Chromium** требует `npx playwright install chromium`; postinstall
  hook отсутствует, поэтому документированная последовательность
  `npm install` → `npm run test:web:browser` на чистой машине падает.
- `dev:mock` удалён 2026-08-07 по Q-36; browser gate использует Playwright routes.

## Later phases

| Phase                                   | Статус                 |
| --------------------------------------- | ---------------------- |
| Phase 1 — Durable Jobs/Governor         | independently verified |
| Phase 2 — Models/Capability/import      | independently verified |
| Phase 3 — Text/Projects/retention/i18n  | P3-F ready             |
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
