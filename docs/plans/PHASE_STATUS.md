# Phase status

**Статус документа:** implemented tracker  
**Проверено:** 2026-08-03
**Текущая фаза:** Phase 1 — Durable Jobs и Resource Governor

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
| P1-I Read-only Runtime Bar projection   | independently verified | `6c297ce`, `151fe07`; 13 component, 10 browser, all gates           |

P1-A–P1-I реализуют additive contract, migrations 4–5, canonical state CAS,
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
Runtime Bar; prewarm и resource action UX ещё не реализованы, поэтому Phase 1
остаётся `in progress`.

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

## Later phases

| Phase                                   | Статус      |
| --------------------------------------- | ----------- |
| Phase 1 — Durable Jobs/Governor         | in progress |
| Phase 2 — Models/Capability/import      | not started |
| Phase 3 — Text/Projects/retention/i18n  | not started |
| Phase 4 — Service/CLI/TUI               | not started |
| Phase 5 — First-party coding Agent      | not started |
| Phase 6 — Audio                         | not started |
| Phase 7 — Vision/OCR/image              | not started |
| Phase 8 — Deliberate long-running Agent | not started |
| Phase 9 — Packaging/hotkey/rebrand      | not started |

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
