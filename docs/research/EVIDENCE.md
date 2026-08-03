# Research evidence

**Статус:** locally validated research  
**Проверено:** 2026-08-03
**Правило:** upstream facts могут меняться; проверять перед реализацией

## Рекомендация

Развивать продукт как resource-aware local model workbench/control plane, а не
generic clone. Конкуренты уже широко покрывают chat, folders/projects, RAG,
voice, images, MCP и agent UI; менее закрытая зона — правдивый runtime state,
безопасное переключение моделей, evidence-based capabilities и graceful unknown.

Это discovery inference, не пользовательская валидация.

## Ollama: подтверждённые публичные contracts

| Факт                                                                           | Источник                                                                       | Ограничение                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------ |
| `/api/tags` перечисляет local models, digest, size/details                     | [List local models](https://docs.ollama.com/api/tags)                          | optional fields меняются             |
| `/api/show` возвращает model info, template, parameters, license, capabilities | [Show model details](https://docs.ollama.com/api-reference/show-model-details) | declaration не равно качеству        |
| `/api/ps` возвращает running models, VRAM, context, expiry                     | [List running models](https://docs.ollama.com/api/ps)                          | не даёт всю host RAM/queue ownership |
| Chat stream разделяет content, thinking и tool calls                           | [Chat API](https://docs.ollama.com/api/chat)                                   | capability зависит от модели         |
| Thinking имеет отдельный channel/control                                       | [Thinking](https://docs.ollama.com/capabilities/thinking)                      | boolean/level зависит от model       |
| Vision принимает images у совместимых models                                   | [Vision](https://docs.ollama.com/capabilities/vision)                          | не универсальный image generation    |
| Tools поддерживают function calling                                            | [Tool calling](https://docs.ollama.com/capabilities/tool-calling)              | качество нужно probe/eval            |
| Default context зависит от VRAM tier                                           | [Context length](https://docs.ollama.com/context-length)                       | user/runtime config может изменить   |
| Default residency, preload, keep_alive и concurrency settings описаны          | [FAQ](https://docs.ollama.com/faq)                                             | Alamo всё равно нужен owner/policy   |
| Частичная OpenAI compatibility существует                                      | [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)       | не весь stateful API поддержан       |

Официальная документация указывает default keep-alive около пяти минут, preload
через empty request, unload через `keep_alive:0`, а context memory растёт с
parallel requests. Поэтому prewarm/unload/parallel policy нельзя проектировать
как локальный effect одной страницы.

## Apple Silicon host telemetry

Проверено 2026-08-03 по официальным первичным источникам:

| Факт | Источник | Ограничение |
| ---- | -------- | ----------- |
| Node `os.totalmem()` возвращает total system memory bytes | [Node.js OS API](https://nodejs.org/api/os.html#ostotalmem) | static capacity, не current availability |
| `execFile` запускает executable без shell по default и поддерживает timeout/maxBuffer | [Node.js child process API](https://nodejs.org/download/release/v22.17.0/docs/api/child_process.html#child_processexecfilefile-args-options-callback) | timeout завершает child, output всё равно нельзя публиковать |
| `vm_stat` сообщает page size и `Pages free` | [Apple OSS vm_stat(1)](https://github.com/apple-oss-distributions/system_cmds/blob/main/vm_stat/vm_stat.1) | free pages не равны safe available capacity/pressure |
| `os_proc_available_memory()` оценивает память для текущего process | [Apple os_proc_available_memory](https://developer.apple.com/documentation/os/os_proc_available_memory) | advisory для Alamo process, не host/Ollama admission fact |
| `memory_pressure` manual описывает pressure generation/simulation | [Apple OSS memory_pressure(1)](https://github.com/apple-oss-distributions/system_cmds/blob/main/memory_pressure/memory_pressure.1) | не подтверждает стабильный read-only level/threshold contract |

Следствие P1-H: production adapter использует только bounded absolute
`/usr/bin/vm_stat` и публикует total unified memory и system free pages с
provenance. Текущие available memory и pressure остаются `unknown`; локально
работающий undocumented `memory_pressure -Q` не стал product contract. Поэтому
production current fit нельзя повышать до `observed`. Injected fixture может
доказать логику observed current residency при достаточных facts, но не является
hardware validation или future admission guarantee.

## Catalog policy

Текущий code endpoint `https://ollama.com/api/search` возвращал 404 при проверке.
Human-facing [Ollama Search](https://ollama.com/search) имеет полезные query,
sorting и capability filters, но не является documented public catalog API.

[Ollama Terms of Service](https://ollama.com/terms), обновлённые в мае 2026,
запрещают automated access без разрешения и использование сервиса для разработки
competing products. Вывод проекта: не scrape-ить human HTML/undocumented
registry, включая one-time snapshot job.

Допустимый interim:

- documented local APIs для installed/running/show;
- внешний link на официальный каталог;
- version-gated local experimental recommendations с label;
- вручную поддерживаемый dated bundled snapshot;
- manual user-supplied Ollama model name/page reference;
- Hugging Face public API как discovery и exact-file download.

Решение владельца: permission не запрашивать и live catalog не реализовывать.

## Hugging Face

- [Hub API](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api)
  поддерживает search, filters, tags, pipeline metadata, files и gated state.
- [Model Cards](https://huggingface.co/docs/hub/model-cards) дают intended use,
  license и author metadata.
- [Hub download](https://huggingface.co/docs/huggingface_hub/en/guides/download)
  поддерживает exact file/revision, local cache и dry-run.
- [Ollama import](https://docs.ollama.com/import) официально импортирует local
  GGUF через `Modelfile FROM /path/file.gguf` и `ollama create`.

Ограничения:

- metadata optional и часто заполняется автором;
- `apps=ollama` — hint, не доказательство `ollama pull`;
- GGUF variants имеют разный fit;
- gated model требует token/acceptance;
- intended task/language/quality требуют runtime/semantic validation.

Следствие для UI: HF URL нельзя обещать как direct `ollama pull`. Нужен pipeline
metadata → exact GGUF → download/checksum → local Ollama import → probe.

## Что можно и нельзя autodetect

### Надёжно или с явным source

- identity, digest, size, format, family, quantization;
- runtime-declared completion/tools/vision/embedding/thinking;
- installed/running/expiry/context/VRAM;
- stream timing/token usage после ответа;
- provider tags/card/license как claims;
- probe result на точном fingerprint;
- measured memory на точной configuration.

### Нельзя превращать в факт

- «хорошо убирает слова-паразиты»;
- качество summary/OCR/coding/tool use;
- поддерживаемые языки и качество на них только по имени;
- exact memory fit до load без assumptions;
- пригодность для ночного агента;
- универсальная TTS/video/any-to-any parameter schema;
- необходимость deliberate mode по числу параметров.

## Конкурентные precedents

| Продукт     | Подтверждённая сильная область                          | Источник                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LM Studio   | TTL/auto-evict, load estimate, rich CLI                 | [TTL and auto-evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict), [load](https://lmstudio.ai/docs/cli/local-models/load), [CLI](https://lmstudio.ai/docs/cli)                                                                                               |
| Jan         | model management, hardware fit, projects/agents/CLI     | [Models](https://jan.ai/docs/manage-models), [CLI](https://www.jan.ai/docs/desktop/cli)                                                                                                                                                                                     |
| Open WebUI  | workspace, folders, temporary chat и широкий generic UI | [Workspace](https://docs.openwebui.com/features/workspace/), [Folders](https://docs.openwebui.com/features/chat-conversations/chat-features/conversation-organization/), [Temporary chat](https://docs.openwebui.com/features/chat-conversations/chat-features/url-params/) |
| AnythingLLM | workspaces/documents/agents/integrations                | [Repository](https://github.com/Mintplex-Labs/anything-llm)                                                                                                                                                                                                                 |

Open WebUI имеет licensing/branding implications; заимствование кода требует
отдельного legal review. Архитектурные patterns можно изучать без копирования.

## Research-derived risks

| Risk                         | Impact          | Mitigation                               |
| ---------------------------- | --------------- | ---------------------------------------- |
| Ollama catalog Terms         | высокий         | permission/official API, no scraping     |
| scope explosion              | высокий         | phases + common entities + adapters      |
| false capability confidence  | высокий         | provenance/confidence/unknown            |
| multi-model memory           | высокий         | global Governor + leases                 |
| experimental media API drift | высокий         | versioned adapter, not core enum promise |
| agent autonomy/security      | высокий         | durable bounded runs, policy/audit       |
| upstream version drift       | средний/высокий | fingerprint and cache invalidation       |
| cross-platform fit           | высокий         | measured hardware adapters               |

## Локальные наблюдения

Проверка development instance на `127.0.0.1:4310`:

- Ollama 0.32.0 был доступен;
- host: Apple M2 Pro, 16 GB unified memory;
- running models в момент проверки отсутствовали;
- current catalog показывал bundled/offline 10 models;
- проблемный Chat имел user rows и пустые assistant rows;
- Ollama log не содержал chat POST для этих failed attempts;
- browser reproduction дал `TypeError: T is not a function` из effect cleanup.

Эти значения относятся только к проверенному локальному устройству и не являются
продуктовыми defaults.
