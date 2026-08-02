# Стратегия проверки

**Статус:** implemented для current-state, proposed для target matrix  
**Проверено:** 2026-08-02

## Текущий baseline

На 2026-08-02:

- `npm test`: 59/59 server и CLI tests;
- `npm run typecheck`: успешно во всех workspaces;
- `npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"`:
  проверяет документацию с repository config;
- web unit/component/E2E/a11y tests отсутствуют;
- CI/lint/formatter commands отсутствуют;
- живой первый Chat turn не входит в regression suite.

Baseline подтверждает существующие server/CLI unit и route cases, но не
пользовательский Web flow и не resource safety.

## Существующее покрытие

| Область                            | Есть                    |
| ---------------------------------- | ----------------------- |
| Agent loop                         | unit cases              |
| Hardware fit                       | unit cases              |
| Filesystem tools/jail              | unit cases              |
| Server routes                      | integration-style tests |
| SQLite stores                      | tests                   |
| Tool parser                        | tests                   |
| Context usage                      | tests                   |
| Static web serving                 | test                    |
| CLI existing-server logic          | tests                   |
| React render/navigation            | нет                     |
| Browser streaming                  | нет                     |
| Catalog provider/cache             | нет                     |
| Global concurrency/model lifecycle | нет                     |
| SSE replay/restart                 | нет                     |
| Accessibility/responsive           | нет                     |

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
