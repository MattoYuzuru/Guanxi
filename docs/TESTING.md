# Стратегия проверки

**Статус:** implemented для current-state, proposed для target matrix  
**Проверено:** 2026-08-02

## Текущий baseline

На 2026-08-02:

- `npm test`: 116/116 server/CLI и 16/16 web component/parser tests;
- `npm run test:web:browser`: 6/6 deterministic Chromium tests с mocked
  REST/SSE;
- `npm run typecheck`: успешно во всех workspaces;
- `npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"`:
  проверяет документацию с repository config;
- web automation покрывает P0-A streaming cleanup/Error Boundaries и P0-B
  failed-partial reload, unreconciled live partial и
  `Stop → cancelled → reload`: `create → redirect → first stream`,
  keyboard/focus, narrow viewport, 200% boundary scaling и reduced motion;
- deterministic P0-B tests покрывают fresh/v2→v3/recovery migration, legacy
  compatibility, CAS terminalization, actual-adapter provider body failure,
  protocol/storage failure, explicit Stop, connection abort и reload states;
- deterministic P0-C tests покрывают FIFO/idempotent permit, cross-thread turns,
  same/cross-thread turn-compaction, две compaction, warm/load, cancelled waiter,
  provider/protocol/storage failures, Stop/body cancel/generator return и
  repeated compaction с next-turn context;
- deterministic P0-D tests покрывают sourced application/Ollama/catalog health,
  malformed/slow/unavailable provider, stale cache/bundled fallback, empty/error
  `/api/ps`, connect/load/idle deadlines, continuous progress, missing terminal,
  cancellation race и release следующему waiter;
- CI/lint/formatter commands отсутствуют;
- живой Ollama, durable/replayable Job flow, второй application process и внешние
  Ollama clients не входят в regression suite.

Baseline локально подтверждает P0-A/P0-B/P0-C/P0-D bridges на временной SQLite,
управляемом fake `OllamaClient` transport и mocked browser REST/SSE. P0-C
доказывает one-lane admission только для участвующих entry points одного
application composition; он не подтверждает hardware fit, Ollama scheduler,
multi-process/external-client safety, restart recovery или production use.
P0-D health остаётся sampled observation; обязательный suite не проверяет live
Ollama, реальное железо или публичную сеть.

### P0-D residual risks

- health и `/api/ps` — sampled observations, а не непрерывная истина;
- process-local exclusive bridge не является Resource Governor;
- текущий POST/SSE turn остаётся connection-owned и не replayable;
- restart recovery отсутствует;
- обязательный suite не проверяет live hardware или live Ollama.

## Существующее покрытие

| Область                            | Есть                               |
| ---------------------------------- | ---------------------------------- |
| Agent loop                         | unit cases                         |
| Hardware fit                       | unit cases                         |
| Filesystem tools/jail              | unit cases                         |
| Server routes                      | integration-style tests            |
| SQLite stores/migration v3         | fresh + v2 upgrade                 |
| Turn terminal contract/CAS         | compatibility + failures           |
| Tool parser                        | tests                              |
| Context usage                      | tests                              |
| Static web serving                 | test                               |
| CLI existing-server logic          | tests                              |
| React render/navigation            | P0-A/P0-B/P0-D component cases     |
| Browser streaming/reload           | P0-A/P0-B mocked stream            |
| Catalog provider/cache             | P0-D local/bundled fixtures        |
| Global concurrency/model lifecycle | P0-C one-lane fake routes          |
| SSE replay/restart                 | нет                                |
| Runtime health/timeouts            | P0-D fake transport/routes/Web     |
| Accessibility/responsive           | P0-A/B + P0-D degraded smoke       |

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
