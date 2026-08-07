# Phase status

**Статус документа:** implemented tracker  
**Проверено:** 2026-08-04
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
Phase 2 остаётся `in progress`. Запись выше отражала состояние на 2026-08-04;
owner session 2026-08-07 закрыла Q-25 (GGUF-only), поэтому HF import больше не
заблокирован и разбит на P2-J..P2-M, а hardware-зависимые пункты вынесены за
Phase 4. Следующий handoff — bounded P2-I exact installed capability user
override foundation по MOD-008/ADR-0003, не full Capability Registry, remote
provider или inferred capability resolver.

## Phase 2 — что реально осталось

**Проверено кодом 2026-08-07.** Таблица обязательна к обновлению каждым Phase 2
slice: без неё читатель делает вывод, что до конца фазы остался один HF slice, а
это неверно.

| ROADMAP scope item                               | Состояние                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| HF search + exact GGUF/revision import (MOD-010) | **нет кода**: `huggingface`/`gguf` — 0 файлов в src; Q-25 закрыт, unblocked → P2-J..P2-M                     |
| license/gated/size/dry-run/fit preview           | **нет кода**: `dryRun`/`gated` — 0 файлов; `license` только display                                          |
| local Ollama create/import + checksum/provenance | **нет кода**: `/api/create` отсутствует; все `sha256:` — internal keys                                       |
| measured-parallel за feature flag (RES-009)      | flag infra → P2-N; estimated admission → P2-O; measured вынесен за Phase 4 (Q-34a)                           |
| variant calibration (MOD-004)                    | **половина**: variant-first install есть, calibration не связана с catalog fit (`catalog.ts` — 0 упоминаний) |
| Linux/NVIDIA verified tier (PLAT-002)            | prototype есть; verified tier вынесен за Phase 4 (Q-35), убран из exit gate                                  |
| user override (MOD-008)                          | следующий slice P2-I                                                                                         |
| bounded `/api/show` concurrency                  | **сделано в P1-M** (`c86e537`), не Phase 2                                                                   |

Итог на 2026-08-07: из 14 scope bullets — 9 delivered, 1 сделан Phase 1,
1 половина (calibration не связана с catalog fit), 3 без единой строки кода.
После owner decisions ни один пункт не заблокирован вопросом: HF разблокирован
Q-25, а hardware-зависимые пункты вынесены за Phase 4 и убраны из exit gate.
Остаток фазы — семь slices P2-I..P2-O.

## Планируемая последовательность Phase 2

Пересобрано 2026-08-07 после owner decisions Q-25/Q-33–Q-36. HF-цепочка намеренно
разбита на bounded vertical slices, а не один «import» slice: из
`research/EVIDENCE.md` следует, что HF URL нельзя обещать как direct
`ollama pull`, и каждый шаг имеет свои failure states.

| Slice | Outcome                                                            | Статус          |
| ----- | ------------------------------------------------------------------ | --------------- |
| P2-I  | exact installed capability user override (MOD-008)                 | ready           |
| P2-J  | HF search + repository metadata, GGUF-only; non-GGUF → unsupported | ready           |
| P2-K  | выбор exact GGUF file/revision + size/license/fit preview          | blocked by P2-J |
| P2-L  | download с checksum/provenance, bounded и cancel-safe              | blocked by P2-K |
| P2-M  | local Ollama import через `/api/create` + probe                    | blocked by P2-L |
| P2-N  | feature-flag infrastructure (без обещания measured)                | ready           |
| P2-O  | estimated parallel-admission вердикт, всегда `estimated`           | blocked by P2-N |

`/api/create` в текущем `ollama/client.ts` отсутствует — P2-M добавляет его как
новый documented endpoint, а не переиспользует pull. P2-N/P2-O закрывают
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
- **`independently verified` без механизма.** Все 132 commit — один автор, CI и
  git hooks отсутствуют. До Phase 2 этот статус означал self-review, а не
  второго участника. С 2026-08-07 статус ставится только при наличии отдельного
  reviewer-субагента и видимого review-fix commit.
- **Playwright Chromium** требует `npx playwright install chromium`; postinstall
  hook отсутствует, поэтому документированная последовательность
  `npm install` → `npm run test:web:browser` на чистой машине падает.
- `dev:mock` удалён 2026-08-07 по Q-36; browser gate использует Playwright routes.

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
