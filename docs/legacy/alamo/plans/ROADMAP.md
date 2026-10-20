# Roadmap

**Статус:** accepted order, individual implementation designs pending

**Проверено:** 2026-08-18
**Правило:** следующая фаза начинается после exit gate предыдущей

Roadmap — последовательность снижения рисков, а не обещание дат. Требования
ссылаются на [PRODUCT](../PRODUCT.md), принятые решения — на
[decision log](../decisions/2026-08-02-product-decisions.md) и
[ADR](../decisions/README.md).

## Phase 0 — Stabilize the truth

**Цель:** первый Chat turn никогда не превращается в необъяснимый белый экран или
пустой success.

### Scope

- исправить `useEffect`/`scrollIntoView` crash;
- добавить root и feature Error Boundaries с diagnostics;
- browser E2E `create → redirect → send → stream → done → reload`;
- сохранять turn/run status, error, stop reason;
- missing terminal Ollama chunk считать failure;
- не оставлять пустой assistant как успешный ответ;
- global exclusive inference mutex как временный safety bridge;
- запретить compaction одновременно с active turn;
- исправить повторную compaction sequence;
- реальные network/catalog health states;
- убрать несуществующий catalog endpoint;
- показать `/api/ps` running models в Chat/Runtime status;
- добавить Ollama connect/load/idle timeouts.

### Requirements

`RUN-002`, `RUN-006`, `RES-001`, `RES-002`, `MOD-001`, `BRD-001`.

### Exit gate

- deterministic browser test ловит старый white-screen defect;
- каждый turn после reload: completed/failed/cancelled, но не ambiguous empty;
- два threads не запускают два inference одновременно;
- current running models видимы;
- tests, web E2E, typecheck и build проходят.

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
- context/model/digest-aware observation keys;
- no artificial context/output UI caps.

### Requirements

`RUN-001..008`, `RES-001..008`.

### Exit gate

- Job продолжает работу после route change;
- reload replay не дублирует output;
- restart даёт interrupted/recovery state;
- conflict queue предотвращает unsafe load;
- lease не освобождается route;
- resource decision имеет human explanation.

## Phase 2 — Models, Capability Registry и import

**Цель:** выбрать exact model variant под задачу и устройство без live scraping и
ложных обещаний.

### Scope

- Model Reference/Variant/Installation/Runtime Instance;
- descriptor/evidence schema;
- installed inspect/load/unload/delete;
- variant-first install и calibration;
- controlled probes;
- persisted provider cache, TTL/SWR;
- local documented Ollama APIs;
- `Add from Ollama` по model name/page URL;
- HF search и exact GGUF/revision import;
- license/gated/size/dry-run/fit preview;
- local Ollama create/import, checksum и provenance;
- faceted search/filter/compare;
- bounded `/api/show` concurrency (реализовано в P1-M, `c86e537`);
- Linux/NVIDIA telemetry prototype без verified claim;
- feature-flag infrastructure как отдельный slice;
- estimated parallel-admission вердикт из declared model size, KV-cache estimate,
  observed `/api/ps` VRAM и host memory sample — всегда с source и confidence.

### Requirements

`MOD-001..010`, `RES-008`, `PLAT-001`.

`RES-009`/`RES-010` measured parallelism и `PLAT-002` verified Linux tier
перенесены за Phase 4 решением owner 2026-08-07 (Q-34a/Q-35): для них нужен
measured evidence с реального железа, недоступный до тех пор.

### Exit gate

Пересобран 2026-08-07 так, чтобы каждый bullet был достижим mocked-тестами на
Apple Silicon. Hardware-зависимые пункты вынесены явно, а не молча ослаблены.

- installed и Marketplace не смешаны;
- selected GGUF/quantization совпадает с fit/install;
- unknown не отображается как supported;
- network/provider offline не ломает local;
- HF import фиксирует exact revision/checksum и license state для GGUF-only
  scope; non-GGUF repository получает explicit unsupported state;
- arbitrary URL не server-side fetch-ится;
- Ollama human catalog не scrape-ится;
- user override видим, экспортируем и не выдаётся за provider/runtime facts;
- parallel-admission вердикт помечен `estimated` с источником и никогда не
  публикуется как `measured` или как гарантия будущего admission.

### Вынесено из exit gate Phase 2

- measured parallel execution и pin/TTL policy (`RES-009`, `RES-010`) → Phase 9
  либо отдельный post-Phase-4 slice;
- Linux/NVIDIA verified tier (`PLAT-002`) → post-Phase-4; в Phase 2 остаётся
  только prototype без verified claim;
- любые live-Ollama/GPU тесты → post-Phase-4 (Q-35).

## Phase 3 — Text, Projects, retention и localization

**Цель:** полностью завершить text foundation до STT и закрепить рабочие
сущности.

### Scope

- Project/Recipe/Artifact persistence;
- current Workspace → filesystem binding migration;
- Project name/icon/color;
- large searchable icon library и accessible palette;
- Quick Run и Chat retention control;
- Keep/7 days/Session semantics с global 7-day default, optional Project
  default, rolling user TTL и 24-hour Session recovery;
- Maintenance Job, Trash/grace и reasoning TTL;
- Chat Info: rename/delete/retention/reasoning/notifications;
- Project Chat search по user/final-assistant text, active/archive/unarchive;
- Recipe snapshots и routing;
- attachment upload и Artifact store;
- Markdown/thinking controls;
- document batch foundation;
- visible context compaction/checkpoint;
- Project defaults, vocabulary и integration bindings;
- target navigation shell и Warm Instrument Panel tokens;
- English locale, curated Russian и Glossary;
- in-app terminal Job notifications;
- accessibility baseline.

### Requirements

`WORK-001..013`, `WB-001..003`, `I18N-001..003`, `NOT-001`, `AGT-001`.

### Exit gate

- Chat/Quick Run используют одну retention model без Save-type conversion;
- cleanup не удаляет active work и может восстановить Trash;
- reasoning удаляется отдельно от final answer;
- stored history, context window и KV cache правдиво объяснены;
- Project не требует filesystem root;
- Recipe edit не меняет старый Job;
- English/Russian/glossary проходят automated key/state/copy assertions;
- Quick Run Session заканчивает successful Job либо explicit Finish;
- Project search/archive и defaults не индексируют private content и не
  переписывают existing entities;
- mobile/keyboard/Error Boundary flows доступны.

## Phase 4 — Background Service, CLI и TUI foundation

**Цель:** приложение и Jobs переживают закрытие terminal, а все клиенты используют
одни настройки.

### Scope

- single-instance Application Service;
- advisory-lock + exact-instance identity и loopback control API;
- `start --detach`, `status`, `stop`, `restart`, `open`;
- shared settings/config client;
- restart-sensitive settings preview;
- scriptable models/jobs/chat/config commands;
- `--json`, exit codes и shell completion;
- no-args keyboard TUI;
- opt-in login autostart на macOS;
- opt-in user service adapter на Ubuntu/Fedora;
- stale process/lock recovery;
- bounded drain/interrupted/queue-preserving stop и controlled restart;
- optional completion sound и channel deduplication;
- UI Exit управляет только Guanxi Service.

### Requirements

`CLI-001..007`, `NOT-002..004`, `PLAT-001`.
Linux user-service adapter входит в Phase 4, но `PLAT-002` verified
Linux/NVIDIA tier и live Ollama/GPU evidence остаются post-Phase-4 (Q-35).

### Exit gate

- terminal закрывается, service и active Job продолжают работать;
- повторный start подключается к existing service;
- Web/CLI/TUI видят одинаковые settings/Jobs;
- controlled restart восстанавливает состояние;
- login autostart opt-in обратим и диагностируем;
- stop Guanxi не останавливает Ollama;
- sound не повторяется после reload и имеет visual equivalent.
- no-args `guanxi` подключает/запускает один profile; `guanxi` остаётся
  compatibility alias;
- stop никогда не убивает process по одному PID и не останавливает Ollama;
- Agent CLI честно unsupported до Phase 5.

## Phase 5 — First-party coding Agent MVP

**Цель:** независимый Guanxi coding agent без Claude Code/Codex dependency.

### Scope

- Agent API и `guanxi agent`;
- interactive Agent Chat/TUI и slash command discovery;
- Project filesystem bindings;
- read/search/list files;
- previewed create/edit/delete;
- command/test/build execution, включая repository-native tools;
- docs/web research adapters;
- Git inspection и разрешённые writes;
- plan, steps, checkpoints и evidence;
- Manual и Auto-within-policy modes;
- allowed roots/commands/network;
- Project MCP/Skills default-off bindings;
- per-Run temporary integration toggle;
- durable approvals/audit;
- verification summary и final diff/artifacts;
- bounded restart/resume.

### Requirements

`AGT-001..010`.

### Exit gate

- Agent завершает bounded repository task и показывает diff/tests/evidence;
- no external branded executable required;
- auto mode не выходит за policy;
- manual approval переживает disconnect;
- restart не повторяет mutating effect;
- Skill/MCP enablement видимо и audit-able;
- security-focused verification не находит обход allowed roots.

## Phase 6 — Audio: STT, dictation и затем TTS

**Цель:** проверить adapter/workbench architecture после стабильного text core.

### Scope

- browser record/upload с waveform/level animation;
- audio Artifact streaming/storage;
- transcription Task Adapter;
- segment progress;
- transcript copy/export;
- language, timestamps/speaker только по evidence;
- Project/Recipe vocabulary;
- model-native raw/normalized mode;
- cleanup/filler removal как отдельный LLM Job;
- summary как отдельная pipeline stage;
- Chat voice input;
- Governor switching/measured parallel для speech + LLM;
- TTS adapter/player/seek/speed/download только после provider proof;
- browser capture/privacy/failure states;
- design system hooks для будущего toggle/hold-to-talk hotkey.

### Requirements

`WB-004..006`, `WB-011`, `WORK-001`, `RES-005`, `RES-009`.

### Exit gate

- длинная запись не держится целиком в React memory;
- cancellation имеет понятную partial-output policy;
- model-native и LLM transformations визуально различаются;
- vocabulary reusable;
- speech и Chat models не загружаются небезопасно;
- measured parallel отказывает при pressure;
- unsupported STT/TTS fields не выдумываются UI.

## Phase 7 — Vision, OCR и image artifacts

**Цель:** расширить typed workbench без новой доменной taxonomy.

### Scope

- image/document input;
- VLM caption/analysis;
- OCR/extraction Artifact;
- image generation adapter;
- count/seed/size/progress/gallery/download;
- batch processing;
- generic parameter schema fallback;
- artifact preview/cache/retention.

Video намеренно отсутствует и вернётся только через новое product decision.

### Requirements

`WB-007..010`, кроме deferred `WB-009`.

### Exit gate

- operation выбирается descriptor, не именем модели;
- media blobs не живут в SQLite messages;
- output downloadable/reproducible;
- unknown model получает safe fallback;
- memory policy проверена на Apple и NVIDIA.

## Phase 8 — Deliberate long-running Agent

**Цель:** довести first-party agent до многочасовой качественной работы.

### Scope

- Q-27 watchdog policy;
- durable task brief и hierarchical plan;
- bounded step loop;
- context reconstruction и compaction Artifacts;
- repeated-failure/no-progress detection;
- self-review и independent verification gates;
- test/build/endpoint/data evidence adapters;
- pause on unavailable dependency;
- 4–6+ hour coding benchmark;
- long research benchmark как secondary use case;
- restart/resume и overnight notifications;
- tool/output/disk audit.

### Requirements

`AGT-003..005`, `AGT-011`.

### Exit gate

- benchmark переживает restart;
- no-progress loop гарантированно обнаруживается;
- quality/evidence выше или надёжнее simple agent baseline;
- invalid verification claim виден, а не считается success;
- auto mode остаётся внутри immutable policy;
- пользователь утром получает понятный result или actionable failure.

## Phase 9 — Packaging, hotkey, rebrand и advanced deployment

**Цель:** сделать систему переносимой и удобной на постоянной основе.

### Scope

- packaging/upgrade/uninstall/data backup;
- central brand manifest и compatibility rename migration;
- system-wide voice hotkey: toggle и hold-to-talk;
- full NVIDIA telemetry/calibration;
- multi-device measured scheduling;
- remote security profile с auth/TLS/allowed roots;
- multi-endpoint model routing;
- multi-host scheduler только после capacity study;
- visual polish, dark/dense mode и performance budgets.

### Requirements

`BRD-002`, `WB-012`, remaining platform/security work.

### Exit gate

- старая install/data path мигрирует без потери;
- hotkey permissions/status управляются из UI;
- remote profile проходит security review;
- hardware status соответствует inference host;
- deployment имеет rollback/backup;
- второй host поддерживается только с measured scheduling evidence.

## Cross-phase rules

- Не начинать STT до exit gate text foundation.
- Не начинать media до Job/Governor/Artifact foundation.
- Не писать TUI вместо scriptable commands.
- Coding Agent first-party; external branded agents не foundation.
- Не запускать deliberate overnight loop до durable Agent MVP.
- Не создавать Ollama catalog scraper.
- Не вводить parallel execution как default.
- Video не имеет фазы до нового решения.
- Каждый phase добавляет deterministic failure tests и обновляет current docs.
