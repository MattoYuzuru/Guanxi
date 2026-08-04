# Стратегия проверки

**Статус:** implemented для current-state, proposed для target matrix  
**Проверено:** 2026-08-03

## Текущий baseline

На 2026-08-03 после P2-C:

- `npm test`: 300/300 server/CLI и 58/58 web component/parser tests;
- `npm run test:web:browser`: 18/18 deterministic Chromium tests с mocked
  REST/SSE;
- `npm run typecheck`: успешно во всех workspaces;
- `npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"`:
  проверяет документацию с repository config;
- web automation покрывает единый P0-E
  `health → installed → create → redirect → send → multi-phase stream → done →
  hard reload` с persisted terminal projection, а также P0-A Error Boundaries,
  P0-B failed-partial/unreconciled/Stop reload, connect timeout, missing
  `done:true`, P1-D navigation detach/reattach через durable Job replay, P1-J
  resource conflict Queue/Stop decisions, P1-K prewarm selection/cleanup и P1-M
  exact custom context save/reload, а также P2-C explicit completion-probe
  confirmation, queued/running/result/error и cancel projection;
- browser assertions управляют mocked headers/chunks без произвольных sleeps и
  проверяют keyboard/focus, live phase status, narrow viewport, отсутствие
  horizontal overflow, 200% scaling и reduced motion;
- deterministic P0-B tests покрывают fresh/v2→v3/recovery migration, legacy
  compatibility, CAS terminalization, actual-adapter provider body failure,
  protocol/storage failure, explicit Stop, connection abort и reload states;
- deterministic P1-F tests покрывают immutable typed request/ticket/lease,
  canonical Job и process-local operation owners, single-permit FIFO,
  snapshot/explanation, waiting/active cancellation, exact/conservative unload
  guard, bounded live diagnostics после 1000 releases и 10 repeats
  release/cancel/close;
- deterministic P1-G tests покрывают typed additive Runtime snapshot, exact
  normalized
  reference match с conservative legacy identity, unknown-owner rows,
  active-not-observed, healthy empty, unavailable/timeout/incompatible sources,
  redaction, common timestamp linearization, shared route single-flight,
  independent caller abort, cleanup и отсутствие auto-unload;
- deterministic P1-H tests покрывают единственный injected `HostTelemetry`,
  exact bounded Apple `vm_stat` command, page-size conversion, extra/malformed
  rows, available/partial/unavailable/unsupported states, provenance/confidence,
  safe timeout/output/failure redaction и отсутствие host command вне adapter;
- reconciliation P1-H fixtures покрывают independent provider/telemetry failure,
  один shared call каждого source, caller abort, Governor capture после обоих
  sources, новый sample после completion, observed current residency только при
  достаточных Apple facts и stable unknown для digest/context/host/pressure;
- deterministic P1-I component fixtures round-trip через
  `runtimeSnapshotSchema` и покрывают active Job/operation owner, два FIFO
  waiter, idle/closed admission, exact/unknown owner rows,
  `active_not_observed`, healthy empty/source failure, все четыре host states,
  observed/unknown fit, distinct memory facts, stale refresh, locale fallback,
  Russian copy и Runtime feature containment без focus steal;
- P1-I fake timers покрывают initial request, active/queued 2 s, idle 10 s,
  no-overlap, hidden pause, visible immediate refresh, bounded manual retry,
  stale sample preservation, unmount abort и отсутствие retained timer/listener;
- P1-J component fixtures покрывают no-conflict one-command path, exact active
  Job и multiple FIFO facts, safe Queue default, one UUID key across explicit
  retry, fresh owner revalidation, `cancelling → cancelled`, already-terminal,
  operation/stale/changed owner, cancel/transport failure и unmount caller abort.
  Dialog tests проверяют named description, initial Queue focus, Escape/Back,
  focus trap/restore, inert background, polling update without focus steal,
  Russian copy и English fallback;
- P1-K contract/Governor/service fixtures покрывают legacy normal compatibility,
  unknown priority rejection, normal-before-prewarm order, FIFO normal,
  simultaneous callbacks, queued/active exact preemption, idempotent cleanup,
  strict HTTP body/response, 30 s deadline, `2m` TTL, disconnect during
  validation/load, safe reasons, exact residency reuse и ambiguous skip;
- P1-K Web fixtures покрывают 600 ms A→B→C debounce, StrictMode, setting off,
  hidden document, normal work, unmount/stale completion и Runtime/P1-J
  projection. Browser делает один exact C prewarm, затем доказывает abort/release
  до одного Chat dispatch; отдельный case покрывает setting/hidden/navigation,
  390 px, 200%, keyboard и reduced motion;
- P1-L fixtures покрывают version 1 complete/unavailable contract, canonical
  key/miss для reference/digest/context/runtime/hardware, private-string
  exclusion, exact tags↔ps matrix, legacy no-credit, migration 6 fresh/v5/
  reopen/failure recovery, exact upsert/context family isolation, changed-digest
  `/api/show` invalidation, 64-reference LRU, remote-host unknown, safe provider
  failure и caller AbortSignal;
- P1-M contract/server fixtures покрывают retired ceiling boundaries вплоть до
  `Number.MAX_SAFE_INTEGER`, malformed/unsafe rejection, exact SQLite/settings/
  thread/Governor/Ollama/prewarm propagation, sourced over-maximum refusal,
  absent/conflicting unknown, low declared default и bounded four-worker
  `/api/show` projection;
- P1-M Web fixtures покрывают Settings/Launcher/Model Profile custom input,
  locale hints/errors, exact query/PUT, device-count unknown и отсутствие
  скрытого `max`; Chromium буквально вводит `1_048_577`, нажимает Enter,
  сохраняет/reload-ит значение и проверяет keyboard, 390 px, 200%, overflow и
  reduced motion;
- P2-A descriptor fixtures покрывают legacy additive default, canonical
  provider/reference, installation/digest identity, source/time/confidence,
  list/detail parity, same-name digest replacement, duplicate normalized
  references, unknown future enum, missing/malformed/conflicting/unavailable
  declarations, runtime-version unknown, cached original observation time,
  four-worker `/api/show` bound, caller abort и safe redaction;
- P2-A Web fixtures показывают declared/degraded/unknown без verified-green или
  unsupported masquerade, English fallback/curated Russian и distinct loading/
  empty states. Chromium literally opens installed card/profile and verifies
  keyboard, 390 px, 200%, no horizontal overflow and reduced motion;
- P2-B migration/store/cache fixtures покрывают fresh/v6→v7/reopen/rollback,
  safe allowlist, incompatible row, exact provider/reference/digest/runtime/
  schema key, same-reference digest replacement, fresh/stale/expired policy,
  restart reuse, per-key single-flight, общий four-worker bound, before/after
  identity conflict, malformed/conflicting current facts, offline fallback,
  independent caller cancellation и отсутствие private/raw provider content;
- P2-B Web fixtures round-trip additive freshness, сохраняют legacy unknown
  fallback и различают localized fresh/stale/offline/unknown без optimistic
  capability semantics. Chromium сохраняет P2-A keyboard/responsive/reduced-
  motion gate;
- P2-C contract/migration/store/service/route fixtures покрывают strict legacy-
  compatible schema, fresh/v7→v8/reopen/rollback recovery, exact key isolation,
  no-backfill, historical reuse/force, before/after identity drift, cloud/red/
  unknown-fit/context skip, normal Governor queue/cleanup, per-call/total timeout,
  cancel, malformed/empty/non-terminal/provider response, bounded output,
  persistence failure и route redaction. Fake transport проверяет fixed prompt,
  deterministic options, `num_predict=8`, `keep_alive=2m` и 10/30/5/45 s bounds;
- P2-C Web fixtures покрывают отсутствие auto-probe, explicit confirmation,
  duplicate action, queued/running/verified/degraded/cancelled/historical/error,
  unmount abort, focus restore и English/Russian locale. Chromium проверяет
  keyboard, 390 px, 200%, overflow и reduced motion на mocked explicit probe;
- integration P1-F matrix покрывает same/cross-thread Chat, Chat ↔ compaction,
  Chat ↔ warm/load, compaction ↔ warm/load в обоих направлениях, два compaction,
  cancelled waiter, provider/protocol/storage failure, connect/load/idle timeout,
  Stop/body cancel/generator return и repeated compaction с next-turn context;
- deterministic P0-D tests покрывают sourced application/Ollama/catalog health,
  malformed/slow/unavailable provider, stale cache/bundled fallback, empty/error
  `/api/ps`, connect/load/idle deadlines, continuous progress, missing terminal,
  cancellation race и release следующему waiter;
- deterministic P1-A tests покрывают exact Job contract, fresh/v3→v4/reopen/
  recovery migration, atomic create/terminal rollback, scoped idempotency,
  ordered replay, malformed storage и двухconnection create/append/terminal
  races;
- deterministic P1-B tests покрывают все 19 canonical non-terminal и 14 terminal
  edges, stale/invalid/terminal rejection, atomic transition rollback,
  write-once `startedAt`, двухconnection transition CAS и internal
  persisted-first subscription: replay/live handoff, commit-during-handoff,
  failed mutation, two subscribers, terminal deduplication, AbortSignal cleanup,
  bounded-page slow consumer, reopened SQLite и malformed event;
- deterministic P1-C tests покрывают strict create/query/cancel/cursor contract,
  server-owned public idempotency scope, duplicate POST, controlled 400/404/409/
  500, exact SSE sequence IDs, replay/live handoff, commit во время handoff,
  rollback invisibility, `Last-Event-ID`, two clients, terminal close/reconnect,
  disconnect cleanup, one-frame HTTP backpressure, SQLite catch-up, queued/active/
  repeated/terminal/conflicting cancel и redaction;
- deterministic P1-D tests покрывают migration 5 fresh/v4→v5/failed+reopen,
  atomic Chat Job+Message create, server-scoped idempotency/fingerprint conflict,
  Message association, disconnect-only subscriber, ordered private replay,
  cancel-before-admission, cancelling-before-abort acknowledgement, missing
  terminal provider output, atomic terminal rollback/redaction, cross-thread
  one-lane execution и 16 KiB UTF-8 chunking без truncation;
- deterministic P1-E tests используют закрытую/reopened temporary SQLite как
  fixture предыдущего process и покрывают все восемь executing Chat states,
  persisted cancelling, untouched queued, terminal no-op, generic Job skip,
  stable scan/output pages size 2, latest-pending partial reducer, earlier
  tool-step preservation, atomic trigger rollback, malformed association/output,
  redacted failure before listen, три startup attempts после injected failures,
  same-thread/cross-thread one-lane scheduling и truthful graceful shutdown;
- exact P1-A/P1-B/P1-C/P1-D/P1-E/P1-F/P1-G/P1-H + P1-K/P1-L Runtime
  contract/Governor files дают 98/98; P1-L+P1-M key/cache/runtime group —
  32/32; отдельный prewarm service file — 7/7;
  routes/Governor/concurrency дают 33/33; runtime/provider — 19/19;
  fit/telemetry — 19/19; P2-A descriptor — 9/9; P2-B persistent group —
  17/17; P2-C + Ollama boundaries — 34/34; полный core — 300/300, Web —
  58/58, mocked Chromium — 18/18;
  15-test store race suite
  ранее повторён 10 раз, P1-D disconnect/cancel/terminal race выполняет 10
  repeats, terminal P1-E recovery — 10 repeats без новых sequence/output, а
  P1-F release/cancel/close — 10 repeats без duplicate transfer/live state;
- 13 новых P1-I component/lifecycle cases проходят в составе 27/27 Web;
  Chromium case 10 открывает Chat и Settings, сохраняет один Runtime Bar и
  disclosure, проверяет active lease + два FIFO waiter + unknown owner,
  переключает mocked runtime success → Ollama failure при доступном host →
  recovery двумя manual Retry, подтверждает отсутствие cancel/stop/unload,
  bottom placement, 390 px, 200% scaling, no horizontal overflow и reduced
  motion;
- 11 P1-J component cases проходят в составе 43/43 Web; четыре Chromium
  cases буквально выполняют Queue через Enter, повторное открытие/double click,
  exact Job Stop с terminal acknowledgement, operation/unknown disabled Stop и
  redacted cancel failure с explicit retry. Они также проверяют отсутствие
  resource action при Escape/navigation, 390 px, 200%, focus containment/
  restore, inert background, no horizontal overflow и reduced motion;
- P1-K server priority/prewarm/inference group повторён 10× по 35/35, debounce
  file — 10× по 4/4; P1-J dialog file повторён 10× по 11/11, P1-I polling file —
  10× по 3/3, полный P1-E recovery file — 10× по 8/8;
- P1-L key/migration/cache/runtime group повторён 10× по 32/32. Первый repeat
  P1-J dialog выявил focus-effect race в assertion `prewarm + normal queue`;
  ожидание initial safe-default focus синхронизировано через `waitFor`, после
  чего file прошёл 10× по 11/11;
- P1-G исправил flaky ожидание P1-E fixture на канонический
  `(createdAt, jobId)` order; узкий recovered FIFO case повторён 10/10;
- P1-M custom contract/settings/end-to-end group повторён 10× по 49/49,
  affected Web suite — 10× по 46/46, priority/prewarm/inference — 10× по 37/37,
  P1-J conflict — 10× по 11/11, P1-I polling — 10× по 3/3 и P1-E recovery —
  10× по 8/8;
- P2-A descriptor group повторён 10× по 9/9, affected Web — 10× по 51/51,
  P1-L+M — 10× по 32/32, P1-K — 10× по 37/37, P1-J после focus assertion fix —
  10× по 11/11, P1-I — 10× по 3/3 и P1-E — 10× по 8/8;
- P2-B persistent group повторён 10× по 17/17, descriptor — 10× по 9/9,
  affected Web — 10× по 52/52, P1-L+M — 10× по 32/32, P1-K — 10× по
  37/37, P1-J — 10× по 11/11, P1-I — 10× по 3/3 и P1-E — 10× по 8/8;
- P2-C exact group повторён последовательно 10× по 34/34 с проверкой exit status;
  P2-B — 10×17/17, P2-A — 10×9/9, P1-L+M — 10×32/32, affected Web —
  10×58/58, P1-K — 10×37/37, P1-J — 10×11/11, P1-I — 10×3/3 и P1-E —
  10×8/8. Один root-level targeted Vitest command не подхватил Web jsdom config
  и получил 11 `document is not defined`; засчитываемые runs выполнены из
  `packages/web` с repository config;
- CI/lint/formatter commands отсутствуют;
- живой Ollama, второй application process и внешние Ollama clients не входят в
  regression suite. Chromium P1-E server restart не моделирует: hard boundary
  доказан server integration tests с закрытием/reopen SQLite, browser сохраняет
  P1-D navigation/detach/reload gate.

Baseline локально подтверждает поведение P0-A/P0-B/P0-C/P0-D/P0-E и
P1-A–P1-M на временной SQLite, управляемом fake `OllamaClient` transport и
mocked browser REST/SSE. P1-F доказывает typed one-lane admission только для
Chat, compaction и warm/load одного application composition; он не подтверждает
Ollama scheduler, multi-process/external-client safety или production use. P1-G
доказывает только sampled query-time `/api/ps`
reconciliation: exact active reference match, unknown ownership и bounded
single-flight; он не идентифицирует external client и не меняет admission.
P1-H добавляет deterministic fake-runner evidence для host source states,
sampling bound и current-fit semantics; это не live hardware validation. P1-I
доказывает read-only Web projection и query polling над mocked snapshots. P1-J
доказывает Queue и exact Job cancel/acknowledge action поверх sampled query и
canonical server admission; он не делает snapshot client-side lock, не
гарантирует future fit и не идентифицирует unknown/external owner.
P1-K доказывает application-local priority/cleanup и mocked short-TTL request,
но не production Ollama residency/TTL, live hardware fit, external ownership,
multi-process coordination или generic eviction.
P1-L доказывает exact observation identity и migration/cache policy только на
deterministic local Apple fixtures. Это не live Ollama/hardware validation,
continuous observation, remote telemetry или future-admission guarantee.
P1-M доказывает отсутствие product/UI context ceiling и truthful declared/
unknown semantics на deterministic provider fixtures. Он не доказывает live
model acceptance огромного context, production memory fit, output budget,
media support или device cardinality.
P2-A/P2-B доказывают installed descriptor и persistent exact safe provider cache
только на documented local endpoints с deterministic fake transport. Fresh
15-minute и offline stale 7-day windows являются application policy, а не
provider guarantee. P2-C отдельно доказывает только explicit basic completion
response для exact fingerprint на deterministic fake transport; verified значит
terminal non-empty bounded response, а не semantic quality. Это не full
Capability Registry/history, live Ollama validation, tool/media capability или
import evidence.
P1-E доказывает
single-process startup ordering/reconciliation, но не checkpoint resume или
process lock. P0-D health остаётся sampled observation; обязательный suite не
проверяет live Ollama, реальное железо или публичную сеть.

### Current residual risks

- health, `/api/ps` и host telemetry — sampled observations, а не непрерывная
  истина;
- P1-H reconciles `/api/ps` и host facts только на query; Resource Governor и
  leases остаются process-local, production Apple pressure/available memory и
  remote-host telemetry отсутствуют;
- Chat execution durable/replayable, но execution owner и lease остаются
  process-local;
- generic public Job без Chat adapter остаётся queued; live wake-up предполагает
  mutation через один service instance;
- startup recovery не координирует второй writer и не resume-ит executing side
  effects; malformed typed Chat state намеренно блокирует healthy startup;
- обязательный suite не проверяет live hardware или live Ollama; observed-fit
  branch использует достаточный injected Apple fixture.
- P1-J Stop зависит от доступности fresh sampled Runtime/public Job query; при
  stale, changed или unknown owner действие fail-closed. Full Jobs history,
  continuous observation, safe parallel и multi-process coordination остаются
  вне current implementation;
- P1-K prewarm — request/process-local best effort. Production TTL/residency,
  external-client identity и generic eviction не проверены;
- P1-L exact calibration не backfill-ит legacy rows и доступна только для
  complete local Apple identity. Live Ollama/hardware, continuous history,
  remote hardware fingerprint и safe parallel не проверены.
- P1-M принимает любой positive safe integer на application boundary, но
  provider/runtime может отказать по sourced capability либо физическому
  ресурсу; output-budget и media controls остаются `not implemented`, device
  count — unknown, а one-permit Governor остаётся explicit application policy.
- P2-B/P2-C не проверяют live Ollama/provider-version matrix или concurrent
  writers в нескольких application processes. Stores хранят latest safe
  projections, а не полный registry/history; semantic/tool/media probes, import
  и user overrides не реализованы.

## Существующее покрытие

| Область                            | Есть                               |
| ---------------------------------- | ---------------------------------- |
| Agent loop                         | unit cases                         |
| Hardware fit                       | unit cases                         |
| Filesystem tools/jail              | unit cases                         |
| Server routes                      | integration-style tests            |
| SQLite stores/migrations v3–v8     | fresh + prior-version recovery     |
| Durable Job/event foundation       | atomicity + two-connection races   |
| Job transitions/service            | canonical matrix + replay/live     |
| Turn terminal contract/CAS         | compatibility + failures           |
| Tool parser                        | tests                              |
| Context usage                      | tests                              |
| Static web serving                 | test                               |
| CLI existing-server logic          | tests                              |
| React render/navigation            | P0-A/B/D/E + P1-I/J/K/M + P2-C     |
| Browser streaming/reload           | P0-A/B/E + P1-I/J/K/M/P2 mocked    |
| Catalog provider/cache             | P0-D local/bundled fixtures        |
| Global concurrency/model lifecycle | P1-G + P1-K priority lane          |
| Job replay/reattach                | HTTP SSE; browser durable replay   |
| Chat startup recovery              | reopened SQLite, fail-closed pages |
| Runtime health/timeouts            | P0-D fake transport/routes/Web     |
| Accessibility/responsive           | P0-A/B/D/E + P1-I/J/K/M Chromium   |

## Обязательная target matrix

### Contract

- каждая request/response/event schema;
- backward compatibility fixtures;
- unknown/new optional provider fields;
- malformed NDJSON/SSE;
- event ordering и terminal invariants.

### Storage

- fresh DB;
- upgrade с каждой поддерживаемой version;
- interrupted migration;
- concurrent Job/event append;
- idempotency uniqueness;
- recovery non-terminal Jobs;
- Artifact metadata и garbage-collection references.

### Ollama adapter

- unavailable/version mismatch;
- slow headers/idle stream timeout;
- stream content/thinking/tools;
- error before first chunk;
- EOF without terminal chunk;
- cancellation during load/prefill/generation;
- `/api/ps` external model reconciliation;
- capability fields absent/present/new;
- remote host hardware mismatch.

### Job Engine

- duplicate create с одним idempotency key;
- replay `after=sequence`;
- UI disconnect не cancel;
- cancel before admission/during load/during tool;
- server restart → interrupted;
- terminal state не возвращается в running;
- output/error persists;
- approval resume и timeout.

### Resource Governor

- one-lane queue;
- same-model lease reuse;
- conflicting model queue;
- prewarm loses to active Job;
- no unload while lease exists;
- idle TTL/LRU;
- external `/api/ps` drift;
- measured vs estimated vs unknown;
- Apple unified memory и NVIDIA discrete profile fixtures;
- voice STT → chat pipeline without simultaneous unsafe residency.

### Model import

- Ollama canonical name и official page URL normalization;
- arbitrary URL rejected without server-side fetch;
- HF exact repo/revision/file selection;
- dry-run size/fit и disk-space failure;
- resumable/cancelled download;
- checksum и invalid/non-GGUF file;
- gated token redaction;
- local Ollama import failure/rollback;
- provenance survives restart;
- no human catalog scraping request.

### Retention и Maintenance

- Keep never selected by expiry query;
- every new Chat defaults to rolling 7-day retention, including in Project;
- rolling TTL updates only on user activity;
- leaving idle Session Chat moves it toward Trash;
- reload/reconnect does not terminate Session;
- active/non-terminal Job prevents tombstone;
- Session Chat can be restored during its 24-hour Trash grace;
- reasoning expires without final answer;
- Trash restore before grace;
- referenced blob never collected;
- startup catch-up и bounded periodic batches;
- interrupted cleanup resumes idempotently;
- exact expiry localized in UI.

### Application Service

- single instance/stale identity;
- terminal closes without service exit;
- start/status/stop/restart exit codes and JSON;
- shared settings Web/CLI/TUI;
- controlled restart with active/queued Jobs;
- macOS/Linux autostart opt-in/disable/uninstall;
- stopping Alamo does not stop Ollama.

### First-party Agent

- Manual и Auto-within-policy modes;
- allowed root/command/network enforcement;
- MCP/Skills default off и Project inheritance;
- per-Run policy snapshot;
- crash after mutating effect does not duplicate it;
- checkpoint/restart/resume;
- test/build/evidence capture;
- repeated no-progress detection;
- 4–6+ hour benchmark in an explicit isolated envelope.

### Notifications

- one terminal Job → one notification;
- reload/replay does not duplicate sound;
- `when_background` respects active Job view;
- permission denied still leaves visual badge;
- no prompt/reasoning/result in payload;
- per-Chat override and localized accessible announcement.

### Web component/integration

- Error Boundary вместо white screen;
- create Chat → redirect → send → token → done;
- first phase re-render не вызывает invalid effect cleanup;
- reload reattaches;
- navigate away while running;
- queue/stop conflict dialog;
- Markdown/thinking/tools separately;
- empty/error/cancelled/interrupted projection;
- catalog filters и stale provider;
- mobile Chat drawer и Runtime Bar.

### Browser E2E

Минимальный release smoke:

```text
health → installed models → new Chat → send
→ loading/thinking/token → done → reload
→ history/output preserved
```

Второй smoke:

```text
Job A running → navigate → create Job B
→ queue decision → Job A terminal → Job B admitted
→ model/runtime bar consistent
```

Используйте deterministic fake Ollama для обязательного CI. Отдельный opt-in
hardware suite может работать с реальным Ollama и явно фиксирует model digest,
runtime version, device и memory budget.

## Accessibility

Автоматически:

- axe на основные экраны/states;
- accessible names и dialog semantics;
- contrast tokens;
- keyboard traversal smoke.

Вручную:

- screen reader phase/status announcements;
- 200% zoom;
- reduced motion;
- narrow mobile;
- focus return после modal;
- long streaming output без forced auto-scroll.

Автоматический a11y scan не заменяет ручную проверку.

## Performance/reliability

- каталог 1k/10k descriptors;
- 100 installed models с bounded detail fetch;
- длинный Chat и большой Markdown stream;
- large audio/image artifact;
- stuck Ollama stream timeout;
- queue backpressure;
- process restart во время Agent Run;
- memory pressure simulation через hardware adapters.

Нагрузочные тесты не должны случайно скачивать или загружать реальные большие
модели.

## Evidence levels

В отчёте используйте:

- `not run`;
- `passed`;
- `failed`;
- `blocked`;
- `passed with limitations`.

Указывайте команду, среду, fixture/модель и реальную область. Не называйте
typecheck доказательством runtime behavior, а fake Ollama — доказательством fit
на железе.

## Definition of done по риску

| Изменение          | Минимальное доказательство                                    |
| ------------------ | ------------------------------------------------------------- |
| Docs-only          | links, Markdown/Mermaid parse, diff check                     |
| Contract/store     | typecheck + unit + migration/route tests                      |
| Streaming/UI       | component + browser E2E + error path                          |
| Resource lifecycle | deterministic concurrency tests + opt-in hardware observation |
| Tool/MCP/security  | policy/unit + isolation + audit/cancel tests                  |
| Release            | build + full deterministic suite + smoke + residual risk      |
