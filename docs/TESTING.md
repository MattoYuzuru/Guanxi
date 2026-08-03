# Стратегия проверки

**Статус:** implemented для current-state, proposed для target matrix  
**Проверено:** 2026-08-03

## Текущий baseline

На 2026-08-03:

- `npm test`: 200/200 server/CLI и 17/17 web component/parser tests;
- `npm run test:web:browser`: 9/9 deterministic Chromium tests с mocked
  REST/SSE;
- `npm run typecheck`: успешно во всех workspaces;
- `npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"`:
  проверяет документацию с repository config;
- web automation покрывает единый P0-E
  `health → installed → create → redirect → send → multi-phase stream → done →
  hard reload` с persisted terminal projection, а также P0-A Error Boundaries,
  P0-B failed-partial/unreconciled/Stop reload, connect timeout, missing
  `done:true` и P1-D navigation detach/reattach через durable Job replay;
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
  reference match без digest identity claim, unknown-owner rows,
  active-not-observed, healthy empty, unavailable/timeout/incompatible sources,
  redaction, common timestamp linearization, shared route single-flight,
  independent caller abort, cleanup и отсутствие auto-unload;
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
- exact P1-A/P1-B/P1-C/P1-D/P1-E/P1-F/P1-G files дают 82/82; routes/Governor/
  concurrency дают 28/28; runtime/provider — 19/19; 15-test store race suite
  ранее повторён 10 раз, P1-D disconnect/cancel/terminal race выполняет 10
  repeats, terminal P1-E recovery — 10 repeats без новых sequence/output, а
  P1-F release/cancel/close — 10 repeats без duplicate transfer/live state;
- P1-G исправил flaky ожидание P1-E fixture на канонический
  `(createdAt, jobId)` order; узкий recovered FIFO case повторён 10/10;
- CI/lint/formatter commands отсутствуют;
- живой Ollama, второй application process и внешние Ollama clients не входят в
  regression suite. Chromium P1-E server restart не моделирует: hard boundary
  доказан server integration tests с закрытием/reopen SQLite, browser сохраняет
  P1-D navigation/detach/reload gate.

Baseline локально подтверждает поведение P0-A/P0-B/P0-C/P0-D/P0-E и
P1-A–P1-G на временной SQLite, управляемом fake `OllamaClient` transport и
mocked browser REST/SSE. P1-F доказывает typed one-lane admission только для
Chat, compaction и warm/load одного application composition; он не подтверждает
hardware fit, Ollama scheduler, multi-process/external-client safety или
production use. P1-G доказывает только sampled query-time `/api/ps`
reconciliation: exact active reference match, unknown ownership и bounded
single-flight; он не идентифицирует external client и не меняет admission.
P1-E доказывает
single-process startup ordering/reconciliation, но не checkpoint resume или
process lock. P0-D health остаётся sampled observation; обязательный suite не
проверяет live Ollama, реальное железо или публичную сеть.

### Current residual risks

- health и `/api/ps` — sampled observations, а не непрерывная истина;
- P1-G reconciles `/api/ps` только на query; Resource Governor и leases остаются
  process-local, host telemetry/fit отсутствуют;
- Chat execution durable/replayable, но execution owner и lease остаются
  process-local;
- generic public Job без Chat adapter остаётся queued; live wake-up предполагает
  mutation через один service instance;
- startup recovery не координирует второй writer и не resume-ит executing side
  effects; malformed typed Chat state намеренно блокирует healthy startup;
- обязательный suite не проверяет live hardware или live Ollama.

## Существующее покрытие

| Область                            | Есть                               |
| ---------------------------------- | ---------------------------------- |
| Agent loop                         | unit cases                         |
| Hardware fit                       | unit cases                         |
| Filesystem tools/jail              | unit cases                         |
| Server routes                      | integration-style tests            |
| SQLite stores/migrations v3/v4/v5  | fresh + v2/v3/v4 upgrade/recovery  |
| Durable Job/event foundation       | atomicity + two-connection races   |
| Job transitions/service            | canonical matrix + replay/live     |
| Turn terminal contract/CAS         | compatibility + failures           |
| Tool parser                        | tests                              |
| Context usage                      | tests                              |
| Static web serving                 | test                               |
| CLI existing-server logic          | tests                              |
| React render/navigation            | P0-A/P0-B/P0-D/P0-E component      |
| Browser streaming/reload           | P0-A/P0-B/P0-E mocked flows        |
| Catalog provider/cache             | P0-D local/bundled fixtures        |
| Global concurrency/model lifecycle | P1-G sampled reconcile + P1-F lane |
| Job replay/reattach                | HTTP SSE; browser durable replay   |
| Chat startup recovery              | reopened SQLite, fail-closed pages |
| Runtime health/timeouts            | P0-D fake transport/routes/Web     |
| Accessibility/responsive           | P0-A/B/D/E Chromium smoke          |

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
