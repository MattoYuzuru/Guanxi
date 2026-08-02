# Roadmap

**Статус:** proposed  
**Проверено:** 2026-08-02  
**Правило:** следующая фаза начинается после exit gate предыдущей

Roadmap — последовательность снижения рисков, а не список обещанных дат.
Product IDs ссылаются на [PRODUCT](../PRODUCT.md), решения — на
[ADR](../decisions/README.md).

## Phase 0 — Stabilize the truth

**Цель:** первый Chat turn никогда не превращается в необъяснимый белый экран или
пустой success.

### Scope

- исправить exact `useEffect`/`scrollIntoView` crash;
- добавить root и feature Error Boundaries с diagnostics;
- browser E2E `create → redirect → send → stream → done → reload`;
- сохранять turn/run status, error, stop reason;
- missing terminal Ollama chunk считать failure;
- не оставлять пустой assistant как успешный ответ;
- global exclusive inference mutex как временный safety bridge;
- запретить compaction одновременно с active turn и исправить повторную sequence;
- реальные network/catalog health states;
- удалить/заменить несуществующий catalog endpoint;
- показать `/api/ps` running models в Chat/Runtime status;
- добавить Ollama connect/load/idle timeouts;
- исправить документационные и UI утверждения, не соответствующие коду.

### Requirements

`RUN-002`, `RUN-006`, `RES-001`, `RES-002`, `MOD-001`, `BRD-001`.

### Exit gate

- deterministic browser test ловит старый white-screen defect;
- каждый turn после reload: completed/failed/cancelled, но не ambiguous empty;
- два threads не запускают два inference одновременно;
- current running models видимы;
- `npm test`, web E2E, typecheck и build проходят.

## Phase 1 — Durable Jobs и Resource Governor

**Цель:** работа и память больше не принадлежат странице.

### Scope

- `jobs`, `job_events`, idempotency и terminal transactions;
- POST create + GET replayable SSE + explicit cancel;
- migration/bridge current threads/messages;
- recovery non-terminal Jobs;
- global queue, admission, leases и safe unload;
- `/api/ps` reconciliation;
- host telemetry interface и Apple Silicon implementation;
- Runtime Bar;
- navigation без cancellation;
- queue/stop-and-switch dialog на dispatch;
- prewarm low-priority lease после debounce;
- context/model/digest-aware observation keys.

### Requirements

`RUN-001..008`, `RES-001..008`.

### Exit gate

- Job продолжает работу после route change;
- reload replay не дублирует output;
- restart даёт interrupted/recovery state;
- conflict queue предотвращает unsafe load;
- lease не освобождается route;
- resource decision имеет human explanation.

## Phase 2 — Installed Models, Capability Registry и Marketplace

**Цель:** выбрать exact model variant под задачу и устройство на основании
источников, а не догадки.

### Scope

- Model Reference/Variant/Installation/Runtime Instance;
- descriptor/evidence schema;
- installed inspect/load/unload/delete;
- variant-first install и calibration;
- controlled probes;
- provider adapters, persisted cache, TTL/SWR;
- local documented Ollama APIs;
- HF discovery provider;
- external Ollama catalog link до разрешения;
- faceted search/filter/compare;
- provenance/freshness/confidence UI;
- bounded `/api/show` concurrency;
- NVIDIA hardware adapter prototype.

### Requirements

`MOD-001..008`, `RES-008..010`.

### Exit gate

- installed и Marketplace не смешаны;
- selected quantization совпадает с fit/install;
- unknown не отображается как supported;
- provider offline не ломает local;
- claims имеют source/time;
- каталог не нарушает provider automation policy.

## Phase 3 — Work model и text/document foundation

**Цель:** закрепить Quick Run, Chat, Project, Recipe и Artifact до размножения
modalities.

### Scope

- Project/Recipe/Artifact persistence;
- current Workspace → filesystem binding migration;
- Quick Run retention/save;
- Chat search/rename/archive/grouping;
- Recipe snapshots и routing;
- attachment upload и Artifact store;
- Markdown/thinking controls;
- document batch foundation;
- visible context compaction/checkpoint;
- Project-scoped vocabulary и integration bindings;
- target navigation shell и Warm Instrument Panel tokens;
- accessibility baseline.

### Requirements

`WORK-001..007`, `WB-001..003`, `AGT-001`.

### Exit gate

- dictation-style one-shot и persistent Chat используют общие entities;
- Recipe edit не меняет старый Job;
- Project не требует filesystem root;
- Artifact export/references воспроизводимы;
- mobile navigation и Error Boundary доступны с клавиатуры.

## Phase 4 — Audio: transcription, dictation и TTS

**Цель:** проверить adapter/workbench architecture на modality с реальной
пользовательской ценностью.

### Scope

- transcription Task Adapter;
- record/upload и audio Artifact;
- segment progress/streaming, если runtime поддерживает;
- transcript copy/save/export;
- language, timestamps/speaker только по evidence;
- vocabulary scope;
- optional clean-up/summary как отдельные pipeline stages;
- Chat voice input pipeline;
- resource switching между speech и Chat model;
- TTS adapter/player/seek/speed/download после provider selection;
- browser capture/privacy/failure states.

### Requirements

`WB-004..006`, `WORK-001`, `RES-005`.

### Exit gate

- длинная запись не держится целиком в React memory;
- cancellation оставляет понятный partial policy;
- speech и Chat models не загружаются небезопасно;
- vocabulary reusable;
- unsupported TTS/STT fields не выдумываются UI.

## Phase 5 — Vision, OCR и image artifacts

**Цель:** расширить typed workbench без новой доменной taxonomy.

### Scope

- image/document input;
- VLM caption/analysis;
- OCR/extraction Artifact;
- image generation adapter с count/seed/size/progress/gallery/download;
- batch processing;
- generic parameter schema fallback;
- artifact preview/cache/retention;
- video exploration только после adapter contract.

### Requirements

`WB-007..010`.

### Exit gate

- operation выбирается descriptor, не именем модели;
- media blobs не живут в SQLite messages;
- output downloadable/reproducible;
- unknown model получает safe fallback;
- video остаётся experimental до стабильного provider.

## Phase 6 — Integrations и Agent platform

**Цель:** безопасно поддержать MCP/Skills/tools и длительную проверяемую работу.

### Scope

- global/Project/Recipe/Job bindings;
- connection/secret management;
- durable approvals/tool audit;
- external agent launch/interoperability;
- Agent Run plan/checkpoints/budgets;
- compaction Artifacts;
- `checkpointed_deliberate` prototype;
- pause/resume semantics по adapter;
- isolated execution improvements;
- deep-research Recipe как pipeline, не special chat.

### Requirements

`AGT-001..007`.

### Exit gate

- effective permissions объяснимы;
- restart восстанавливает approval/checkpoint;
- budget гарантированно останавливает Run;
- external content не расширяет tools;
- deliberate profile проходит заранее заданный benchmark лучше/надёжнее baseline
  либо признаётся неэффективным.

## Phase 7 — Service CLI и TUI

**Цель:** одинаково управлять приложением без browser.

### Scope

- background application service;
- process identity/lock/control API;
- `start --detach`, `status`, `stop`, `open`;
- scriptable models/jobs/chat/agent/config;
- `--json`, exit codes и completion;
- no-args keyboard TUI;
- slash commands/help/model/compact в interactive client;
- UI Exit управляет application service;
- settings restart preview;
- shutdown/recovery coordination.

### Requirements

`CLI-001..005`.

### Exit gate

- automation не требует TUI scraping;
- повторный start показывает running state;
- stop не убивает внешний Ollama;
- Web/CLI/TUI видят один Job queue;
- crash/stale lock recovery проверен.

## Phase 8 — Packaging, rebrand и advanced deployment

**Цель:** сделать систему переносимой между Mac, NVIDIA PC и будущими
workstations.

### Scope

- central brand manifest и compatibility migration;
- packaging/upgrade/uninstall/data backup;
- full NVIDIA telemetry/calibration;
- remote security profile с auth/TLS/allowed roots;
- multi-endpoint model routing;
- multi-host scheduler только после capacity study;
- visual polish, dark/dense mode, performance budgets;
- video/experimental adapters по отдельным decisions.

### Requirements

`BRD-002`, remaining platform/security work.

### Exit gate

- старая install/data path мигрирует без потери;
- remote profile проходит security review;
- hardware status соответствует inference host;
- deployment имеет rollback/backup;
- второй host поддерживается только с measured scheduling evidence.

## Cross-phase rules

- Не начинать media studio до Job/Governor/Artifact foundation.
- Не писать no-args TUI до scriptable commands.
- Не создавать собственный autonomous harness до external-agent interop.
- Не обещать full Ollama catalog до разрешённого API.
- Не вводить parallel execution как default.
- Каждый phase добавляет deterministic failure tests и обновляет current docs.
