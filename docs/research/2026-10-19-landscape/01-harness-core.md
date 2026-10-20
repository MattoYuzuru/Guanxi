# Lane 1. Ядро harness, agent loop, провайдеры, подписки

**Статус документа:** research (`proposed`). Ничего из этого не реализовано в Guanxi.
**Дата сбора данных:** 2026-10-19. Все звёзды, релизы и лицензии сняты через GitHub API
(`gh api repos/...`) и из файлов LICENSE в этот день. Политики и ToS взяты с официальных
страниц в этот же день.
**Метод:** shallow clone (только чтение) DeepSeek Harness, OpenCode, pi, Cordis, Codex,
claude-agent-acp и codex-acp в `scratchpad/clones/`. Чтение README, docs и исходников. Плюс
официальная документация вендоров и arXiv.

**Легенда достоверности:**

- **[V]** — проверено по первичному источнику: репозиторий, LICENSE, официальная документация, ToS или arXiv;
- **[S]** — вторичный источник: пресса, блог или обсуждение. Требует перепроверки;
- **[I]** — мой вывод или интерпретация.

Требования из brief: A (подключения), C (агенты), D (сессии/трассировка), H (инструменты),
L (нефункциональные).

---

## 0. Резюме

1. **«DeepSeek harness» со скриншота — это DeepSeek Harness (`dsh`).** [V] Это открытый
   проект (MIT), `deepseek-ai/deepseek-harness`. Создан 2026-08-13, ~254k★, текущий релиз
   `dsh-v0.2.1-rc.2` (2026-10-17, prerelease). Написан на TypeScript/Node, UI на React +
   Vite, desktop на Electron. Построен на **Cordis**: это и есть тот «plugin engine», о
   котором говорил владелец. Слоган проекта — «Everything is a Plugin». Плагинами сделаны
   agent loop, LLM-адаптеры, tools, session log, compaction, субагенты и UI. По архитектуре
   это ближайший к brief проект (F1, D2, D6, C, K4).
2. **Рекомендация (подробно в §6).** Строить Guanxi как **downstream-дистрибутив DSH**
   (soft fork, «compose on DSH»). В upstream закрепляем версию, сами пакеты не правим.
   Свои возможности Guanxi оформляем как пакеты `@guanxi/*`: плагины Cordis и bundles.
   Перед окончательным решением нужен **двухнедельный spike с измеримыми критериями**.
   Запасной вариант: **собственное тонкое ядро на библиотеках pi** (`pi-ai`,
   `pi-agent-core`, `pi-durable`) плюс Cordis, с выборочным копированием пакетов DSH под
   MIT с атрибуцией. Форкать OpenCode (Bun + Effect + SolidJS), goose (Rust), Codex (Rust,
   CLA), Gemini CLI, Cline/Kilo/Roo, Crush (FSL), Aider, OpenHands (Python) не рекомендую.
3. **Подписки без оплаты API (A1).** Картина на 2026-10-19 [V]:
   - **ChatGPT.** Есть официальный путь для open-source и локальных приложений: «Sign in
     with ChatGPT» (SIWC), plan usage через Responses API. Плюс Codex app-server с логином
     пользователя. Риск низкий.
   - **Claude Pro/Max.** OAuth-токены в сторонних клиентах запрещены. Предлагать claude.ai
     login в своём приложении нельзя, в том числе поверх Agent SDK. Остаётся только
     запуск **немодифицированного бинарника Claude Code**, в который пользователь вошёл
     сам. Это headless-режим или ACP. Но с 2026-04-04 подписка не покрывает «third-party
     harnesses»: такое использование тарифицируется как extra usage [S]. Риск средний или
     высокий.
   - **Gemini.** Переиспользовать OAuth Gemini CLI/Antigravity запрещено, за это были баны.
     С 2026-06-18 Gemini CLI не обслуживает тарифы Google AI Pro/Ultra и бесплатный
     уровень, их заменил закрытый Antigravity CLI. Практически Gemini — это только API key.
   - **GitHub Copilot.** Официальные пути: Copilot SDK (MIT) и `copilot --acp`. Риск низкий
     или средний.
4. **Провайдеры (A2/A4).** Рекомендую `pi-ai` (MIT, его уже использует DSH) плюс
   **models.dev** (MIT) как второй источник метаданных с provenance. Vercel AI SDK v7
   (Apache-2.0) — альтернатива и источник harness-адаптеров. Gateways (LiteLLM, Bifrost,
   Portkey) не нужны в ядре, только как опциональный sidecar.
5. **Стандарты.** MCP `2026-07-28` (stateless), ACP protocol v1, Agent Skills, AGENTS.md,
   A2A 1.0 (позже, для межхостовой делегации), формат плагинов Claude Code (его уже читает
   Codex), OTel.
6. **Секреты.** `@napi-rs/keyring` (MIT, keyring-rs) для мастер-ключа хоста и
   зашифрованный vault по аккаунтам. Агентам доступны только `secret://`-ссылки и
   производные факты (health, balance, limits). Значения подставляет broker на границе
   HTTP-клиента или spawn. Во всех путях персистенции работает redaction.

---

## 1. Кандидаты: метаданные и активность

Все данные сняты через GitHub API 2026-10-19 [V].

| Проект | Репозиторий | SPDX | Язык / runtime | ★ | Последний релиз | Статус / замечания |
|---|---|---|---|---|---|---|
| **DeepSeek Harness** | deepseek-ai/deepseek-harness | MIT | TS, Node ^22.19/≥24, pnpm 11; React+Vite; Electron | 254 349 | dsh-v0.2.1-rc.2 (2026-10-17, pre) | developer preview, «THERE WILL BE COMPATIBILITY-BREAKING CHANGES»; **внешние PR не принимаются**; DeepSeek — товарный знак |
| **Cordis** | cordiverse/cordis | MIT | TS | 9 264 | v4.0.0-rc.11 (2026-10-14) | API нестабилен; статья arXiv:2608.25512 |
| **OpenCode** | anomalyco/opencode (ex sst/opencode) | MIT | TS, **Bun**, **Effect 4**; SolidJS; Electron | 217 500 | v1.19.3 (2026-10-16) | активная V2-переработка; default branch `dev` |
| **pi** | earendil-works/pi (ex badlogic/pi-mono) | MIT | TS, Node ≥22.19 | 116 388 | v1.3.0 (2026-10-15) | issues/PR новых контрибьюторов автоматически закрываются |
| **Codex CLI** | openai/codex | Apache-2.0 | Rust (+TS/Python SDK) | 129 920 | rust-v0.163.0 (2026-10-15) | CLA для контрибьюций |
| **goose** | aaif-goose/goose (ex block/goose) | Apache-2.0 | Rust; Electron desktop | 55 439 | v1.55.0 (2026-10-16) | Agentic AI Foundation (Linux Foundation) |
| **Gemini CLI** | google-gemini/gemini-cli | Apache-2.0 | TS/Node | 107 457 | v0.64.0 (2026-10-13) | с 2026-06-18 consumer-тарифы переведены на закрытый Antigravity CLI |
| **Cline** | cline/cline | Apache-2.0 | TS (SDK, VS Code, CLI, desktop) | 70 555 | desktop-v0.0.48 (2026-10-17) | IDE-центричен |
| **Roo Code** | RooCodeInc/Roo-Code | Apache-2.0 | TS | 24 275 | — | **archived** (последний push 2026-05-15) |
| **Kilo Code** | Kilo-Org/kilocode | MIT | TS; Kilo CLI — форк OpenCode | 27 661 | jetbrains/v7.1.11 (2026-10-16) | — |
| **OpenHands** | OpenHands/OpenHands | MIT | Python + TS UI | 91 287 | v1.28.1 (2026-10-19) | — |
| **OpenHands SDK** | OpenHands/software-agent-sdk | MIT | Python (+REST, TS-клиент) | 1 274 | v1.56.0 (2026-10-19) | статья arXiv:2511.03690 |
| **Crush** | charmbracelet/crush | **FSL-1.1-MIT** (не OSI) | Go | 28 705 | v0.98.1 (2026-10-09) | source-available, «Competing Use» ограничен |
| **Aider** | Aider-AI/aider | Apache-2.0 | Python | 49 640 | v0.86.0 (**2025-08-09**) | релизов нет >14 мес. |
| **Letta / Letta Code** | letta-ai/letta, letta-code | Apache-2.0 | Python / TS | 25 192 / 3 655 | 0.16.8 (2026-05-14) / v0.34.17 (2026-10-18) | memory-платформа (MemGPT) |
| **Claude Agent SDK** | anthropics/claude-agent-sdk-typescript | **проприетарная** (Anthropic Commercial Terms) | TS + нативный бинарь Claude Code | 1 823 | v0.3.303 (2026-10-18) | не open source |
| **OpenAI Agents SDK** | openai/openai-agents-js / -python | MIT | TS / Python | 3 928 / 30 142 | agents-extensions 0.20.0 (2026-10-08) / v0.24.0 | библиотека, не harness |
| **OpenClaw** | openclaw/openclaw | MIT | TS, Node ≥24.16 | 392 463 | v2026.10.5 (2026-10-18) | ассистент-gateway, построен на pi |
| **Hermes Agent** | NousResearch/hermes-agent | MIT | Python | 255 216 | v0.22.2 (2026-10-15) | self-improving skills loop |
| **Kimi Code CLI** | MoonshotAI/kimi-code | MIT | TS | 7 936 | 2.2.0 (2026-10-14) | старый Python kimi-cli archived |
| **Qwen Code** | QwenLM/qwen-code | Apache-2.0 | TS (форк Gemini CLI) | 28 583 | sdk-ts v0.1.21 (2026-10-19) | — |
| **Copilot SDK / CLI** | github/copilot-sdk / copilot-cli | MIT / NOASSERTION (CLI не OSS) [I] | multi-lang (Node/Py/Go/.NET/Java/Rust) | 10 564 / 11 273 | — | официальный SDK поверх Copilot CLI |
| **Mastra** | mastra-ai/mastra | Apache-2.0 + `ee/` | TS | 28 915 | @mastra/core 1.78.0 (2026-10-16) | фреймворк, не harness |

Звёзды отражают популярность, а не пригодность для форка [I]. По активности и по
совместимости стека (TypeScript + Node + React) выделяются три кандидата: DSH, OpenCode и
pi. Цифры OpenClaw, Hermes и DSH (250–390k) нетипичны для 2026 года и частично отражают
хайп. Для решения важнее governance и стабильность API [I].

---

## 2. Возможности кандидатов

Метки: [V] — подтверждено по коду или docs, [I] — вывод.

| Проект | Архитектура | Плагины | Саб-агенты | Компакция / контекст | MCP | ACP | Сессии | Трассировка | Клиенты |
|---|---|---|---|---|---|---|---|---|---|
| **DSH** [V] | Дерево плагинов Cordis; host + web gateway (Typert RPC); профили `web`/`headless`/`sdk`/`acp` | **Всё**, включая UI (`packages/client/ui-*`, slots); profiles/bundles/`cordis.patch.yml`; Plugin Manager/Market; **агент сам пишет и монтирует плагины** (`extensions/`, Creator mode) | in-process spawn/fork, **ACP**, **Codex app-server**, **Claude Code (Agent SDK)**, другой dsh через SDK; continuable; agent teams (experimental) | Семейство плагинов: `compaction-basic`, `tool-result-pruner`, `image-offload`; события `compaction/start→summary→end` с lock-семантикой; `token-meter` | клиент (`packages/mcp`) | **сервер** (`packages/acp/acp`) + **клиент** (`subagent-acp`) | append-only `SessionEvent` JSONL (zstd), миграции форматов v0→v4, fork/resume/replay; SQLite FTS (`session-query`) | полный журнал (system prompt, reasoning, tool calls, планирование субагентов, context injections), trajectory UI (`ui-trajectory`), OTel-каналы | Web, Desktop (mac arm64/x64, win x64), CLI, SDK TS/Python |
| **OpenCode** [V] | client/server: Effect `HttpApi` + сгенерированный клиент; managed background service; pairing codes | `@opencode/plugin` (Promise/Effect/TUI API), `gui-extensions` | `task`/`subagent-job` | auto/overflow/manual; буфер 15% (≥16k), `keep` | да (+codemode) | сервер (`packages/cli/src/acp`) | SQLite (drizzle) | Effect spans; OTel не первоклассный [I] | TUI, Web app, Electron+Solid desktop, VS Code |
| **pi** [V] | Набор библиотек: `pi-ai` → `pi-agent-core` → `pi-coding-agent`; `pi-durable`; `chord` (hot-reload objects/RPC) | extensions, packages, skills, prompt templates, themes | **нет встроенных по дизайну** | `reserveTokens` 16384; branch summarization; compact-and-retry при overflow | `pi-mcp` (свой клиент) | через сторонний `pi-acp` | JSONL-деревья сессий; `pi-durable` | `pi-telemetry` (vendor-neutral контракты) | TUI, print/JSON, RPC, SDK; pi-chat (Slack) |
| **Codex** [V] | Rust core + **app-server JSON-RPC** (stdio/ws) + TS SDK (`codex exec` JSONL) | `.codex-plugin` **и `.claude-plugin`**; skills; hooks | agent roles / graph [I по crates] | авто + `thread/compact/start`, `thread/compacted` | клиент + сервер | через `codex-acp` (JetBrains, Apache-2.0) | rollout JSONL + state DB | `otel`, `rollout-trace` | TUI, IDE, desktop |
| **goose** [V] | Rust core; desktop через ACP-клиент (`ui/goose-acp-client`); GDK (UniFFI) | extensions = MCP; recipes; custom distros | да | `goose-context-management` | да (ядро) | сервер + **ACP providers** (Claude/Codex/Amp/pi как провайдеры) | своя БД | observability hooks | Desktop (mac/linux/win), CLI, API |
| **Gemini CLI** [V/I] | TS/Node | extensions, skills, hooks | да | да | да | `--experimental-acp` | checkpointing | OTel [I] | CLI, IDE |
| **OpenHands SDK** [V/I] | Python, event-sourced; Agent Server REST/WS; Docker/K8s workspaces | tools / MCP | да | condenser [I] | да | — | event store | [I] | CLI, Cloud |
| **OpenClaw** [V] | Gateway (control plane) + nodes; 20+ каналов | plugins; agent runtimes как плагины | runtimes: Codex app-server, Copilot SDK, ACP/acpx, `claude-cli` | (pi) | да | клиент (acpx) | своя | — | macOS/iOS/Android/Win/Linux, Control UI, TUI |
| **Claude Agent SDK** [V] | Библиотека, запускающая бинарь Claude Code | plugins, skills, hooks | да | внутренняя (`SDKCompactBoundaryMessage`) | да | через `claude-agent-acp` | `~/.claude/projects/*.jsonl` | stream events | — |
| **OpenAI Agents SDK** [I] | Библиотека: handoffs, agents-as-tools, guardrails, sessions | — | handoffs | sessions | да | — | sessions | trace processors | — |

### 2.1. Что конкретно переиспользовать (уровень пакетов и директорий)

Пути указаны относительно корней shallow-клонов в `scratchpad/clones/`.

**DeepSeek Harness** (commit `687f282`, 2026-10-17; MIT; переиспользование целым
дистрибутивом или копирование пакетов с атрибуцией) [V]:

- `vendor/cordis`, `vendor/loader`, `vendor/hmr`, `vendor/include`, `vendor/group`,
  `vendor/timer`, `vendor/schemastery`, `vendor/cosmokit`. Это vendored Cordis с локальными
  модификациями, записанными в `vendor/README.md`.
- `packages/core/{session,agent,agent-loop,tools,system-prompt,scope}` — spine агента.
- `packages/session/*` — `session-persistence-jsonl`, `session-projection`,
  `session-format-v*` (миграции), `session-telemetry-otel`. Закрывает D6 и J1.
- `packages/session-query` — SQLite FTS по сессиям.
- `packages/llm/{llm,llm-pi-ai,llm-retry,token-meter}` — LLM-seam поверх pi-ai.
- `packages/compaction/*` — основа для C5 (handoff-компакция как ещё один provider).
- `packages/subagent/{subagent,subagent-acp,subagent-codex,subagent-claude-code,tool-subagent,tool-subagent-control}`
  — C1, C3 и A1 через официальные CLI.
- `packages/acp/acp`, `packages/sdk/{protocol,server,client}` — интероперабельность.
- `packages/credentials/{credentials,authorization}`: seam `CredentialRef` нужен для A5.
  Провайдер `credentials-local` (приватный YAML) заменить на keyring (§11).
- `packages/interaction/*`, `packages/sandbox/*` (bwrap/Landlock/Seatbelt) — D3: Full
  access и Read-only на уровне `sandbox/mode` и `approval/policy`.
- `packages/{mcp,skill,jobs,schedule,goal,workflow,web,lsp,browser-use,computer-use}`.
- `packages/api/{gateway,remote-access}` — remote peers и роли. Основа для B3, D5 и E1.
- `packages/experimental/{agent-team,speech-to-text,speech-to-text-sensevoice}` — C3 и I1.
- `packages/client/*` (`ui-trajectory`, `ui-chat`, `ui-plugin-manager`,
  `ui-settings-models`, `ui-directory-picker-*`, `ui-permission-presets`, `ui-slots`) и
  `apps/desktop`.

**OpenCode** (commit `b56e253`; MIT) — только как справочник: код завязан на Effect 4 и Bun [V/I]:

- `packages/core/src/plugin/provider/chatgpt.ts` — эталонная реализация SIWC
  (`dynamic_agent_client`, scope `chatgpt.tokens.use.direct`, коды ошибок
  `subscription_sharing_*`).
- `packages/core/src/github-copilot/` — Copilot-провайдер, есть официальное партнёрство.
- `packages/cli/src/acp/` — реализация ACP-сервера.
- `packages/core/src/session/compaction.ts` — политика компакции.
- `packages/schema/src/models-dev.ts` — схема интеграции с models.dev.

**pi** (commit `e86b054`; MIT; использовать npm-пакеты) [V]:

- `packages/ai` (`@earendil-works/pi-ai`): провайдеры, каталог, cost, telemetry,
  cross-provider handoff. Модули `auth/oauth/openai-chatgpt.ts` (SIWC),
  `github-copilot.ts` и `openrouter.ts` подходят. **Не включать**
  `auth/oauth/anthropic.ts`: он использует OAuth client ID Claude Code, а Anthropic это
  запрещает. Не включать и `openai-codex.ts`: это legacy-путь через client ID Codex CLI
  (§7).
- `packages/agent` (`pi-agent-core`), `packages/durable` (`pi-durable`, experimental),
  `packages/chord` (hot-reload объектов, RPC по IPC/WebSocket), `packages/telemetry`,
  `packages/mcp`, `packages/codemode` (QuickJS-песочница для tool-скриптов).
- `packages/coding-agent/src/core/compaction/*` — справочник по компакции.

**Codex** (commit `d70c2c2`; Apache-2.0) [V]:

- `codex-rs/app-server-protocol` — JSON-RPC-схема для генерации TS-типов клиента. Там есть
  `account/rateLimits/read`, `thread/compact/start` и другие методы.
- `sdk/typescript` (`@openai/codex-sdk`).
- `codex-rs/keyring-store`, `execpolicy`, `linux-sandbox`, `windows-sandbox-rs` — как справочник.

**ACP-адаптеры (Apache-2.0)** — использовать как есть из npm:
`@agentclientprotocol/claude-agent-acp` и `@agentclientprotocol/codex-acp`. Их
сопровождают JetBrains и сообщество ACP. Rust-версия `zed-industries/codex-acp`
архивирована в 2026-07 [V].

**goose** (Apache-2.0) — справочник: `ui/goose-acp-client` (TS ACP-клиент),
`crates/goose-context-management`, формат recipes. **OpenClaw** (MIT) — справочник по
каналам, мобильным nodes и runtime-плагинам (`claude-cli`, Codex app-server, Copilot SDK).

---

## 3. DeepSeek Harness подробно (вопрос 1 из ТЗ)

**Что это.** [V] DeepSeek Harness (`dsh`), репозиторий `deepseek-ai/deepseek-harness`,
опубликован 2026-08-13 под MIT. Вышел одновременно с DeepSeek-V4-Pro [S]. Строка из
README: «Developer preview… THERE WILL BE COMPATIBILITY-BREAKING CHANGES». Desktop-
инсталляторы выпускаются для macOS (arm64/x64) и Windows x64. Пути кода для Linux в
Electron есть, но официального Linux-инсталлятора в скриптах нет [V]. Web-версия
запускается через `npx @deepseek-ai/dsh web` [S].

**Элементы скриншота владельца.** Заголовок «Into the Unknown» — это слоган DeepSeek, его
показывает пустая сессия [S]; строка «Into the unknown.» есть и в CONTRIBUTING [V]. Бейдж
«Preview» соответствует статусу developer preview [V]. «Standard mode» — preset агента
`standard`, он выбран по умолчанию в `agent-preset-registry` [V]. Вторичные источники
перечисляют режимы Standard, Code, Minimal и Creator [S]. «Full access» — permission
preset `danger-full-access` (`sandbox: danger-full-access` + `approval: never`). Второй
preset в таблице по умолчанию — `workspace-write` + `ask` [V]. GPT-модели в пикере,
вероятно, приходят через маршруты `pi-ai`: `openai` по API key или legacy `openai-codex`
OAuth. SIWC-маршрут `openai` в DSH сознательно отключён
(`llm-pi-ai/src/login.ts`, `UNSERVED_OAUTH = {'openai'}`) [V/I].

**Архитектура плагинов.** [V]

- **Cordis.** «Meta-Framework of Spatiotemporal Composability», MIT, автор Shigma.
  Научная база — статья *A Programming Paradigm for Spatiotemporal Composability*, Shi,
  Zhang, Cui (Peking University, DeepSeek-AI), arXiv:2608.25512, 2026-08-26. В ней
  описаны **revertible effects**: регистрации плагина откатываются при его выгрузке. Есть
  **reactive coeffects**: зависимости активируют и деактивируют плагин. Кроме того,
  Cordis даёт декларативный loader, reconciliation конфигурации и HMR. Это прямо отвечает
  на F1 «everything-as-a-plugin» и K4 «агент пишет и монтирует плагин» и даёт научное
  обоснование для L3.
- **Capability seams.** Каждая подсистема разделена на Service Definition, Service
  Provider и Consumer. Расширяющие плагины зависят только от Service Definitions, не от
  конкретных провайдеров (`packages/README.md`).
- **Profiles, bundles и patches.** Бегущий `dsh` — это дерево плагинов, собранное из
  слоёв: profile → bundles → `cordis.patch.yml` → home patch → `--patch`. Любую строку
  можно заменить по id. Ровно так и делается свой дистрибутив без правок upstream.
- **Self-modification.** Пакет `extensions/` и Creator mode дают агенту инструменты
  инспекции runtime и model-written mount/unmount. Persistent-изменения идут через Plugin
  Manager (K4).
- **Мост к Claude Code mods и plugins.** Подсистема `claude-code-mods` исполняет hooks-
  модули mods Claude Code и документирует расхождения с Claude Code 2.1.287. Изоляции
  нет: mod работает с полными правами процесса.

**Трассировка.** [V] Это эталон для D6 и J1.

- Единственный источник истины — append-only `SessionEvent` log. Документирован контракт
  `SessionHandle` (read/append/flush/close): single-writer lease, crash recovery, torn
  tail никогда не возвращается.
- Персистенция: JSONL с zstd-кадрами и checksum, плюс миграции форматов v0 → v4.
- В журнале лежат system prompts, reasoning, tool calls, планирование субагентов,
  context injections, compaction-события с lock-семантикой и image offload. На этом же
  потоке работают trajectory view, resume, fork, search и replay [V для событий
  компакции и персистенции; S для формулировки про trajectory].
- OTel: `ctx.otel` — фабрика независимых каналов (обычные события и session-log канал с
  потолком 4 000 000 байт). Перед экспортом выполняются авторизация и redaction.
- Генерируемые каталоги (config, tool, persistence, Cordis API) проверяются в CI на
  свежесть. Это хорошая практика для L2 и L4.

**Ограничения и риски DSH.**

- Developer preview, ежедневные alpha/rc-релизы [V].
- **Внешние PR не принимаются.** CONTRIBUTING: «We are sorry that we cannot accept
  external pull requests at the moment». Вклад в экосистему предлагается делать
  плагинами с topic `dsh-plugin` [V]. Значит, upstream-контрибуций не будет, только
  downstream-плагины.
- «DeepSeek Harness» — зарегистрированный товарный знак. Для производных проектов
  рекомендуют обозначение «DSH» и запрещают вводящее в заблуждение использование бренда
  [V, BRAND_GUIDELINES]. Для Guanxi это нормально: бренд меняется через `ui-brand-*`.
- Credentials по умолчанию — приватный YAML-файл, доступный только владельцу. Это не OS
  keychain [V].
- Через `pi-ai` UI может предложить Anthropic OAuth. Для Guanxi это нужно отключить [I].
- Есть product analytics / telemetry. Exporter «collects no Session data automatically»,
  Desktop отправляет выбранные события и уважает переключатель при запуске [V]. Endpoints
  по умолчанию не проверены, нужен аудит [I].
- `subagent-claude-code` подтягивает «platform payload» Claude Code через
  `@anthropic-ai/claude-agent-sdk`. Его лицензия — Commercial Terms, не OSS [V].
- Объём: ~205 MB в клоне, pnpm, генератор типов Typert, Python SDK. Порог входа высокий [V/I].

---

## 4. Короткие оценки остальных кандидатов

- **OpenCode.** Лучший по экосистеме подписок. В нём уже реализованы SIWC и официальная
  интеграция Copilot (партнёрство с GitHub от 2026-01-16) [V]. Но стек не совпадает с
  Guanxi: Bun-first, Effect 4 (плагины обязаны разделять host `effect`), SolidJS [V].
  Форк означает смену парадигмы и постоянный ребейз V2. **Использовать как справочник и
  как внешний агент через ACP или AI SDK harness.**
- **pi.** Лучшая библиотечная база. Минимализм заложен в дизайн: нет субагентов, плана и
  permission-системы [V]. `pi-ai` используют DSH и OpenClaw: это де-факто
  harness-уровневый TS LLM-слой 2026 года [V по зависимостям, I по оценке]. Для
  контрибьюторов есть барьер: issues и PR новичков автоматически закрываются [V].
  **Брать как зависимость (`pi-ai`, `pi-agent-core`), не форкать.**
- **Codex CLI.** Сильный runtime и app-server-протокол, ChatGPT-подписка официально
  поддерживается. Но это Rust, CLA и OpenAI-центричная модель [V]. **Использовать как
  субагента через app-server.**
- **goose.** Хорошее governance (AAIF/LF), есть ACP-провайдеры, по сути тот же паттерн
  «подписка через официальный CLI» [V]. Ядро на Rust → смена стека. **Как справочник и
  ACP-агент.**
- **Gemini CLI.** Repo живёт для API-key и enterprise-пользователей [V]. Consumer-тарифы
  ушли в закрытый Antigravity CLI [V]. **Только ACP-агент с API key.**
- **Cline / Kilo / Roo.** IDE-центричные. Roo архивирован, Kilo CLI — форк OpenCode [V].
  Не база.
- **OpenHands и OpenHands SDK.** Python, event-sourcing, Docker/K8s workspaces. Научно
  обоснованы (arXiv:2407.16741, arXiv:2511.03690) [V]. Стек не совпадает. **Как источник
  идей** (condenser, agent server).
- **Crush.** FSL-1.1-MIT — не open source до конверсии в MIT [V]. Не брать.
- **Aider.** Последний релиз 2025-08 [V]. Не брать.
- **Letta.** Memory-платформа: MemGPT, arXiv:2310.08560 [V]. Относится к памяти (C/K), не
  к ядру.
- **Claude Agent SDK.** Проприетарная лицензия, запрещено предлагать claude.ai login без
  одобрения [V]. Только как опциональный адаптер, который пользователь устанавливает сам.
- **OpenAI Agents SDK.** Библиотека для multi-agent и handoffs (MIT) [V]. Агентный цикл
  не заменит. Можно взять отдельные паттерны.
- **OpenClaw.** Персональный ассистент-gateway с мобильными приложениями и каналами (MIT,
  на pi) [V]. Полезный справочник для B3 и I3, ядром быть не может.
- **Hermes Agent.** Python, self-improving skills [V]. Справочник для K.
- **Оркестраторы «CLI-агент как чёрный ящик»** (§8): Conductor (закрыт, macOS),
  Crystal → Nimbalyst (Crystal deprecated в 2026-02), vibe-kanban (Apache-2.0,
  **sunsetting**), Sculptor (MIT, research preview, внешние контрибуции не берёт), Claude
  Squad (**AGPL-3.0**), Xum, ex-Mux (**AGPL-3.0**), Emdash (Apache-2.0, YC W26) [V].
  Паттерн mainstream, но ни один из этих проектов не стоит брать базой: у одних лицензия,
  другие сворачиваются.

---

## 5. Матрица решения

Оценки от 1 до 5 [I], на основе §1–§4.

| Критерий (вес) | DSH-дистрибутив | Своё ядро на pi-libs + Cordis | Текущий Guanxi + compose | Форк OpenCode | Форк goose |
|---|---|---|---|---|---|
| Совпадение стека TS/Node/React (×2) | 5 | 5 | 5 | 2 | 1 |
| Plugin model, включая UI, F1 (×3) | 5 | 3 | 1 | 3 | 3 |
| Трассировка D6/J1 (×2) | 5 | 3 | 2 | 3 | 3 |
| Субагенты и подписки через официальные CLI, A1/C (×2) | 5 | 3 | 2 | 4 | 4 |
| Мультипровайдер и локальные модели, A2/A4 (×2) | 4 | 5 | 3 | 5 | 4 |
| Governance и возможность upstream-вклада (×1) | 1 | 3 | 5 | 4 | 5 |
| Стабильность API (×2) | 2 | 3 | 4 | 3 | 4 |
| Объём собственной работы, выше — меньше (×3) | 5 | 3 | 1 | 3 | 2 |
| Лицензия (×1) | 5 | 5 | 5 | 5 | 5 |
| **Итого (взвешенно, max 90)** | **78** | **64** | **48** | **61** | **57** |

---

## 6. Рекомендация: fork, compose или own core

### 6.1. Основной вариант: «Guanxi = downstream-дистрибутив DSH»

Это **compose поверх DSH**, а не hard fork.

1. **Upstream закрепляем.** Ставим конкретный тег `dsh-v0.2.x` через git subtree или
   vendored workspace и обновляем осознанно, по чек-листу совместимости. Своих правок в
   пакетах `@deepseek-ai/*` по возможности не делаем. Неизбежные изменения оформляем
   патчами (DSH сам использует `patches/`) и считаем их метрикой долга.
2. **Всё своё — в пакетах `@guanxi/*` как Cordis-плагины и bundles:**
   - `@guanxi/brand` — бренд, лого и design tokens для F2;
   - `@guanxi/locale-ru` — в DSH есть i18n-YAML, но русского нет;
   - `@guanxi/connections` — единый реестр подключений, health и balance, для A2, A5, J2;
   - `@guanxi/credentials-keyring` — провайдер на `ctx.credentials` (§11);
   - `@guanxi/llm-ollama`, `@guanxi/llm-mlx` и другие — это перенос текущего Ollama-адаптера
     и capability evidence Guanxi с provenance;
   - `@guanxi/subagent-copilot` — Copilot SDK;
   - `@guanxi/accounts`;
   - `@guanxi/fleet` и `@guanxi/resource-governor` — B1–B5, другие lanes;
   - `@guanxi/compaction-handoff` — C5;
   - профиль `guanxi` с отключёнными DeepSeek-account- и telemetry-плагинами.
3. **Наработки текущего Guanxi переносятся как плагины.** Durable Jobs, Resource
   Governor, каталог HF/Ollama и capability evidence становятся сервисами Cordis. Что
   меняется в инвариантах:
   - `packages/contract` (Zod REST/SSE) перестаёт быть «единым runtime-контрактом»: у DSH
     свой RPC (Typert). Нужен новый ADR, отменяющий ADR-0001/0010 и пересматривающий
     инвариант контракта [I].
   - Публичный REST/SSE для телефона (B3) можно сохранить отдельным плагином на Hono или
     взять gateway DSH.
4. **Upstream-вклад невозможен,** потому что внешние PR закрыты. Значит, весь долг
   Guanxi держит сам. K3 «upstream contribution» относится к собственному репозиторию
   Guanxi.

**Почему этот вариант** [I]:

- максимальное переиспользование (L1), совпадение стека, научная база Cordis (L3);
- готовы ровно те подсистемы, которые brief считает эталоном (D2 и D6 «как DeepSeek
  harness»);
- уже есть субагенты через официальные Claude Code, Codex и ACP — самый безопасный путь
  к A1;
- есть Creator mode и model-written plugins (K4).

### 6.2. Spike-gate: две недели до окончательного решения

Критерии успеха — все обязательны:

1. Сборка из исходников и запуск web и desktop на macOS arm64, Fedora и Windows 11
   (Windows — минимум web).
2. Bundle `guanxi` (brand, ru-locale, Ollama, keyring-credentials, профиль без DeepSeek
   account) монтируется **без патчей** `@deepseek-ai/*` или с патчем ≤ 5 файлов.
3. Ребейз на два более новых rc upstream занимает ≤ 1 человеко-дня.
4. Субагенты: Codex app-server с логином пользователя или с SIWC-токеном, Claude Code
   через `claude-agent-acp` или `subagent-claude-code` с бинарником пользователя,
   `copilot --acp`. Для каждого видно usage и rate limits (§10).
5. Экспорт session log через OTel в локальный collector, trajectory UI показывает
   субагентов.
6. Потребление RAM/CPU host и desktop на Mac mini 32 GB в пределах, согласованных с B4.

### 6.3. Запасной вариант: своё тонкое ядро

Если spike провален — своё тонкое ядро на `pi-ai` + `pi-agent-core` (+ `pi-durable`) +
Cordis (MIT). Seams проектируются по образцу DSH: session event log, compaction seam,
subagent registry, credential refs. Отдельные пакеты DSH и OpenCode копируются под MIT с
атрибуцией в `THIRD_PARTY_NOTICES.md`. Вариант дольше, зато governance полностью наш.

### 6.4. Чего не делать

- **Не форкать OpenCode:** Bun, Effect 4, SolidJS, постоянная V2-переработка.
- **Не форкать goose и Codex:** Rust, и для Codex ещё CLA.
- **Не форкать Crush:** FSL.
- **Не брать Claude Agent SDK как ядро:** проприетарная лицензия.

---

## 7. Подписки без оплаты API (A1): что разрешено на 2026-10-19

### 7.1. Сводка по вендорам

| Подписка | Разрешённый путь [V] | Запрещено [V] | Механизм в Guanxi [I] | Риск |
|---|---|---|---|---|
| **ChatGPT** (Plus/Pro; Go — по help-статье для коммерческих приложений [S]) | **SIWC ChatGPT plan usage**: «available to open-source projects, personal projects that run locally». Dynamic client (`client_id=dynamic_agent_client`, `agent_name_hint`, host id `urn:uuid`), PKCE, scopes `offline_access resource.invoke chatgpt.tokens.use.direct`, Responses API `api.openai.com/v1`. **Codex app-server** с тем же токеном (`ACCESS_TOKEN`, `wire_api="responses"`) или с собственным логином Codex | Для платных или удалённо хостимых приложений нужна заявка (waitlist). Переиспользование client ID Codex CLI сторонними приложениями (legacy `openai-codex` в pi) официально не описано, считать небезопасным [I] | 1) native-маршрут `openai` (SIWC) в нашем agent loop; 2) субагент Codex через app-server или `codex-acp` | **Низкий** |
| **Claude Pro/Max** | Немодифицированный бинарник Claude Code, в который пользователь вошёл через «Anthropic's own flow». Legal-страница: «Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription». Headless `claude -p` документирован Anthropic | «Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users… may not collect, store, or intermediate Claude.ai credentials or session tokens». Agent SDK: «Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK». Consumer Terms (с 2025-10-08) запрещают «automated or non-human means… except… via an Anthropic API Key or where we otherwise explicitly permit it» | Субагент Claude Code: ACP через `claude-agent-acp` или stream-json. Используется **бинарник пользователя**, токены мы не трогаем и не подменяем system prompt под Claude Code. Fallback — API key | **Средний–высокий.** С 2026-04-04 «no longer be able to use your Claude subscription limits for third-party harnesses», нужен extra usage [S: TechCrunch, Register]. Есть сообщения о серверной классификации трафика `claude -p` по содержимому prompt [S: issue OpenClaw #65399]. Будущий риск: «`--bare` will become the default for `-p`», а bare-режим не читает OAuth [V] |
| **Gemini** (Google AI Pro/Ultra) | С 2026-06-18 Gemini CLI для этих тарифов перестал обслуживать запросы. Он остаётся для «paid Gemini… API keys» и Code Assist Standard/Enterprise [V]. Подписка доступна только через закрытый Antigravity CLI; есть ли у него ACP или headless — не подтверждено [S] | «using third-party software… (for example, using OpenClaw with Gemini CLI OAuth) is a violation… grounds for suspension or termination» [V]. Массовые баны 2026-02/03 [S] | Gemini = API key (AI Studio или Vertex) через `pi-ai`; Gemini CLI — как ACP-агент с API key | Подписка — **высокий**; API key — низкий |
| **GitHub Copilot** | Copilot SDK (MIT, официальный, JSON-RPC к Copilot CLI; auth: вход пользователя, токены GitHub OAuth App, BYOK). `copilot --acp` (public preview с 2026-01-28). Официальное партнёрство с OpenCode | Общая политика для прочих сторонних клиентов не опубликована [V: в changelog только OpenCode] | Субагент через `@github/copilot-sdk` или ACP | **Низкий–средний** |

### 7.2. Ограничения SIWC, важные для ролей C1

На странице Preview limitations перечислено [V]:

- обязательны `store:false` и `stream:true`;
- явные `system`-сообщения отвергаются: используем `instructions`;
- `previous_response_id` по HTTP не поддерживается;
- **не поддерживаются hosted tools:** image generation, file search, Code Interpreter,
  **native computer use**, hosted MCP/connectors;
- не поддерживаются audio/video input и transcription.

Вывод [I]: роль «computer-use проверка на ChatGPT-подписке» из C1 нужно делать на
**своих** function tools Guanxi (H2: скриншоты как image input, действия как function
calls) или внутри Codex app-server. Hosted computer-use tool OpenAI в этом режиме
недоступен.

Лимиты приходят ошибками `subscription_sharing_usage_limit_exceeded` и
`subscription_sharing_usage_unavailable` внутри стрима [V]. При переносе на VPS у каждого
хоста свой `ext_agent_host_id`. «Host-specific usage attribution and revocation… are not
yet available» [V].

### 7.3. Паттерн «официальный CLI-агент как чёрный ящик»

Механизмы [V]:

- **ACP** (stdio JSON-RPC). Агенты: `claude-agent-acp` (поверх Agent SDK), `codex-acp`
  (поверх Codex app-server), `copilot --acp`, `gemini --experimental-acp`, OpenCode, goose,
  DSH (`--profile acp`). В стабильной части протокола есть `session/new`, `load`, `list`,
  `resume`, `close`, `delete`, `set_mode`, `set_config_option`, `request_permission`, `fs/*`,
  `terminal/*`, `elicitation/*`. Unstable: `session/fork`, `providers/*`, `mcp/message`.
- **Headless.** `claude -p --output-format stream-json --verbose --include-partial-messages`.
  Есть события `system/init` (tools, MCP, plugins), `system/api_retry`, `result` с
  `total_cost_usd`. Субагенты коррелируются через `parent_tool_use_id`; текст субагентов
  включается флагом `--forward-subagent-text`. Отказы приходят как `permission_denied`.
  Для Codex — `codex exec --json` и TS SDK.
- **App-server и SDK.** Codex app-server даёт `thread/*`, `turn/*`, `account/read`,
  `account/rateLimits/read` и `…/updated`, `thread/compact/start`. Copilot SDK. Claude
  Agent SDK, у которого есть `spawnClaudeCodeProcess` и `pathToClaudeCodeExecutable`.
- **Кто это уже делает:** DSH (`subagent-claude-code`, `subagent-codex`, `subagent-acp`),
  goose (ACP providers), OpenClaw (`claude-cli`, Codex app-server, Copilot SDK, acpx),
  Zed и JetBrains AIR (ACP-клиенты). Vercel AI SDK `HarnessAgent` (experimental) поддерживает
  Claude Code, Codex, Copilot, OpenCode, Pi, Cline, Cursor и другие; ориентирован на
  песочницы и API key или AI Gateway. Также Conductor, Emdash, Xum, Claude Squad.

---

## 8. Что теряем, отдавая работу вендорскому агенту-«чёрному ящику»

| Аспект | Наш agent loop (pi-ai/DSH) | Вендорский агент через ACP/headless/SDK [V/I] | Компенсация в Guanxi [I] |
|---|---|---|---|
| Компакция и контекст (C5) | Своя политика: старт на 75%, handoff к 90% | Решает вендор. Можем только запустить (`/compact`, `thread/compact/start`) и наблюдать (`SDKCompactBoundaryMessage`, `thread/compacted`, ACP `session/update`) | Handoff во внешнем цикле: новая сессия с system prompt и handoff-документом; учёт по `context_window.used_percentage` или token usage |
| Трассировка (D6) | Сырые запросы и ответы, reasoning | Поток событий вендора: tool calls, сообщения, часто только summary reasoning. Сырых HTTP-запросов нет | Проецировать события в наш session log с `source=vendor`, хранить вендорский transcript-путь (`~/.claude/projects/*.jsonl`, rollout Codex) как артефакт |
| Tools | Наши tools и политика | Встроенные tools вендора. Наши tools доступны только как **MCP-серверы** (ACP `mcpServers`, `--mcp-config`) | Опубликовать возможности Guanxi (connections, fleet, memory, jobs) как MCP-сервер `guanxi` |
| Права (D3) | Наши режимы Full / Read-only | Маппинг на режимы вендора (`permissionMode`, `approvalPolicy` + sandbox), запросы приходят через `request_permission`, `canUseTool` или approvals app-server | Таблица маппинга Full→`bypassPermissions` / `danger-full-access`, Read-only→`plan` / `read-only`. Аудит каждого решения |
| Выбор модели | Любая | Только модели вендора | Роутинг C1 делает Guanxi на уровне выбора субагента |
| Субагенты внутри агента | Видны | Частично: ACP subagents RFD, `parent_tool_use_id` | Показывать дерево из событий |
| Стоимость и лимиты (J2) | Точные usage и cost | Оценки: `total_cost_usd` — client-side estimate, rate_limits | §10 |
| Сессии | Наш durable log | Persistence вендора, resume по id | Хранить внешний `sessionId` и `threadId` в нашем журнале |
| Стабильность | Под нашим контролем | Обновления CLI меняют поведение и протокол | Закреплять версии бинарников (DSH так и делает), тесты на контракте событий |
| ToS и биллинг | API key | Классификацию трафика задаёт вендор (Anthropic extra usage) | Явный UI-предупредитель и fallback на API key |

---

## 9. Абстракция провайдеров (A2, A4)

| Решение | Лицензия | Язык | Охват | Стриминг и tool calling | Метаданные моделей | Подписки / OAuth | Cost | Локальные модели | Вывод [I] |
|---|---|---|---|---|---|---|---|---|---|
| **pi-ai** [V] | MIT | TS | 35+ провайдеров, включая DeepSeek, OpenRouter, Copilot, Bedrock, Vertex | единые события, partial JSON для tool args, унифицированный thinking, cross-provider handoff, сериализация контекста | встроенный каталог + overlay pi.dev; image gen; классификаторы | SIWC, Copilot, OpenRouter OAuth (Anthropic OAuth **отключить**) | `usage.cost` из каталожных цен; telemetry spans | любой OpenAI-compatible (Ollama, vLLM, LM Studio), llama.cpp classify | **Основной LLM-слой** (уже в DSH) |
| **Vercel AI SDK v7** [V] | Apache-2.0 | TS | официальные и community-провайдеры | `streamText`, agent loop, MCP-клиент, UI message stream; `HarnessAgent` (experimental) | своего реестра нет | нет | частично | community (Ollama) | Альтернатива; источник harness-адаптеров |
| **@opencode/ai** [V] | MIT | TS + Effect | широкий, включая STT/TTS/видео | да | models.dev | SIWC, Copilot | да | да | Только справочник: привязан к Effect |
| **models.dev** [V] | MIT | данные + API (`api.json`, `models.json`, `catalog.json`) | — | — | `attachment`, `reasoning`, `tool_call`, `structured_output`, `temperature`, `knowledge`, `release_date`, `open_weights`, `interleaved`, `cost.*` (вкл. cache и audio), `limit.context/input/output`, `modalities.input/output`, `status` | — | цены | — | **Второй источник метаданных** с provenance и `observed_at` |
| **OpenRouter** [V] | сервис; SDK Apache-2.0 | — | сотни моделей | OpenAI-compatible | `/models`, `/models/user` (ограничения по ключу) | OAuth PKCE создаёт ключ | per-key usage | — | Провайдер, не абстракция |
| **LiteLLM** [V] | MIT + `enterprise/` | Python | 100+ | прокси | свой | — | cost, budgets | да | Не в ядре. 2026-03-24 — **компрометация PyPI 1.82.7/1.82.8** [S] |
| **Bifrost** [V] | Apache-2.0 | Go | шлюз | OpenAI-compatible | — | — | virtual keys, budgets, MCP gateway | да | Опциональный sidecar для бюджетов по аккаунтам |
| **Portkey gateway** [V] | MIT | TS | шлюз | да | — | — | да | да | Рост замедлился: последний push 2026-05-25, релиз 2026-01-12 |
| **any-llm** [V] | Apache-2.0 | Python | — | — | — | — | — | — | Не подходит (Python) |

**Вывод** [I]:

- **LLM-слой.** `pi-ai` закрывает parity стриминга и tool calling, каталог, cost, SIWC и
  Copilot в TypeScript. Его выбрали DSH и OpenClaw.
- **Метаданные.** Capability evidence Guanxi (с источником, временем наблюдения и
  уверенностью, по инварианту AGENTS.md) собирается из нескольких источников: каталог
  `pi-ai`, models.dev, `/models` провайдера, Ollama `/api/show`. Расхождения показываются,
  а не сглаживаются.
- **Gateways.** Только как опциональный plugin. Supply-chain-гигиена: pinned lockfile,
  `npm install --ignore-scripts` (так делает pi), cooldown для новых версий.

---

## 10. Балансы, лимиты и стоимость (A2/J2): API по провайдерам

| Источник | Endpoint / механизм [V] | Ключ | Что получаем |
|---|---|---|---|
| OpenRouter | `GET https://openrouter.ai/api/v1/key` | обычный ключ, судя по примерам Bearer | `limit`, `limit_remaining`, `limit_reset`, `usage{,_daily,_weekly,_monthly}`, `budgets[]`, `effective_budget`, `is_free_tier`, `free_model_daily_requests`; `rate_limit` deprecated |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | API key [I] | `is_available`, `balance_infos[{currency CNY/USD, total_balance, granted_balance, topped_up_balance}]` |
| OpenAI API | `GET /v1/organization/costs` (только 1d), `/v1/organization/usage/*` | **Admin key** | расходы и usage по проектам и ключам. Публичного endpoint предоплаченного баланса не нашёл [I] |
| Anthropic API | `GET /v1/organizations/usage_report/messages` (1m/1h/1d), `GET /v1/organizations/cost_report` (1d); данные с задержкой ~5 мин | **Admin API key**, «unavailable for individual accounts» | usage и cost. Для индивидуального аккаунта — только учёт по ответам: `usage` в каждом ответе + цены models.dev |
| ChatGPT plan (SIWC) | Ошибки `subscription_sharing_usage_limit_exceeded`; лимиты пользователь видит в ChatGPT Settings → Usage | — | Остатка через API нет, только факт исчерпания |
| Codex (подписка) | app-server `account/rateLimits/read` и уведомление `account/rateLimits/updated` | логин Codex | окна rate limits (проценты и сброс) [V по названиям методов; поля — I] |
| Claude подписка | statusline JSON: `rate_limits.five_hour/seven_day.used_percentage`, `resets_at`; в Agent SDK есть тип `SDKRateLimitEvent` | логин Claude Code | процент 5-часового и 7-дневного окна |
| Copilot | AI Credits / premium requests; персонального API баланса не нашёл [I] | — | открытый вопрос |
| Gemini API | Cloud Billing; отдельного balance API для AI Studio не нашёл [I] | — | учёт по `usageMetadata` |
| Локальные модели | Resource Governor Guanxi | — | CPU, GPU, VRAM — не деньги |

**Дизайн** [I]:

- `@guanxi/connections` опрашивает эти источники по расписанию с backoff, кэширует
  результаты и хранит каждое наблюдение как evidence `{value, source, observed_at,
  confidence}`.
- Агенты читают состояние через MCP tool `connections.status`. Значения секретов они не
  видят.
- Где API баланса нет, показываем «оценка по локальному учёту» с явной пометкой.

---

## 11. Секреты: хранилище и «ссылки вместо значений» (A5, A6, E2)

### 11.1. Хранилища OS [V]

- **`@napi-rs/keyring`.** MIT, биндинг keyring-rs, версия 2.1.2 опубликована 2026-10-19,
  ~3,07 млн загрузок в неделю против ~1,76 млн у keytar. Совместим с API `node-keytar`.
  Бэкенды: macOS Keychain, Windows Credential Manager, Linux Secret Service (gnome-keyring,
  KWallet, keepassxc). На Linux при отсутствии Secret Service тихо переключается на
  **keyutils, который хранит секреты только в памяти ядра и теряет их после
  перезагрузки**. Можно пинить store опцией `linux.store`.
- `keytar` архивирован в 2022-12.
- `Bun.secrets` есть только в Bun (Keychain, libsecret, Credential Manager).
- Codex умеет режимы `keyring`, `auto` и `file`; `auth.json` — plaintext.
- В DSH credentials по умолчанию — приватный YAML.
- В pi ключ можно задать `!command`; у Claude Code есть `apiKeyHelper`.

### 11.2. Предлагаемый дизайн

Всё в этом подразделе — мой вывод [I]. Опора: OWASP LLM Top 10 2025 (LLM02 Sensitive
Information Disclosure, LLM06 Excessive Agency) и принципы безопасности MCP.

1. **Модель ссылок.** Формат `secret://<scope>/<connection-id>/<field>`, где `scope` — это
   `account:<id>`, `host` или `system`. Конфиг и агенты оперируют только ссылками. Это
   совместимо с `CredentialRef` в DSH (`apiKeyEnv` — имя, а не значение).
2. **Broker** — серверный сервис `ctx.credentials`. Метод `resolve(ref, purpose,
   consumer)` отдаёт значение только в три места:
   - HTTP-клиент провайдера (заголовок формируется внутри адаптера);
   - окружение порождаемого процесса при spawn (MCP-сервер, вендорский CLI) — по образцу
     `op run` и `env`-overlay в DSH;
   - OAuth refresh под межпроцессным lock (так делает `pi-ai`).
   Каждое разрешение пишется в аудит: кто, зачем, какая ссылка.
3. **Redaction.** Все значения, разрешённые в процессе, регистрируются в redactor. Он
   учитывает варианты кодирования: raw, base64, URL-encoded. Redactor чистит tool output,
   логи, OTel и session log до записи. Дополнительно работают паттерн-сканеры, например
   правила gitleaks, для секретов, которых нет в реестре.
4. **Хранение.**
   - Мастер-ключ хоста (KEK) лежит в OS keychain через `@napi-rs/keyring`.
   - Секреты — в SQLite в виде зашифрованных blob (AES-256-GCM из `node:crypto`).
   - Каждый аккаунт получает свой DEK.
   - Для unattended-подключений DEK обёрнут KEK хоста: фоновые jobs работают без
     присутствия пользователя.
   - Для interactive-only подключений DEK обёрнут ключом из пароля аккаунта (scrypt или
     Argon2id).
   - VPS без Secret Service: systemd-creds или TPM2, либо файл 0600 с явным
     предупреждением. Нельзя молча падать в keyutils.
5. **Логины вендорских CLI** (Claude, Codex, Copilot) Guanxi **не хранит и не читает**.
   Они живут в хранилищах самих вендоров. Изоляция по аккаунтам Guanxi делается через
   `CLAUDE_CONFIG_DIR` и `CODEX_HOME` [V: оба механизма описаны в DSH и OpenClaw].
   Guanxi видит только health: «вход выполнен, CLI отвечает».
6. **Агентам** доступен read-only MCP-сервер `guanxi-connections`. Он отдаёт `{id, kind,
   provider, scopes, health, quota-evidence, secret_refs: [только имена]}`. HTTP-вызов с
   ключом выполняется через broker-tool `http.request({auth: {secret_ref}})`. Политика
   (allowlist доменов по connection) проверяется до подстановки ключа.

---

## 12. Стандарты, которые стоит принять (вопрос 4)

| Стандарт | Текущая версия и статус [V] | Ключевое для Guanxi | Рекомендация [I] |
|---|---|---|---|
| **MCP** | `2026-07-28` (release 2026-07-28); предыдущая `2025-11-25` | **Stateless**: убраны сессии, `Mcp-Session-Id` и `initialize`; появился `server/discover`; `subscriptions/listen`; **MRTR** (`input_required`) вместо server-initiated requests; tasks перенесены в extension `io.modelcontextprotocol/tasks`; deprecated Roots, Sampling, Logging; DCR deprecated в пользу Client ID Metadata Documents; OTel `traceparent` в `_meta`; `ttlMs`/`cacheScope` для list | Host и client на `2026-07-28` с fallback на `2025-11-25`. Guanxi как MCP-**сервер** для вендорских агентов (§8) |
| **ACP** | protocol version **1** stable; schema v1.26.0, v2.0.0-alpha.9 (2026-10-16); официальные SDK Kotlin, Java, Python, Rust, TS | stable: `session/list`, `resume`, `close`, `delete`, `set_config_option`, elicitation; unstable: `session/fork`, `providers/*` | Guanxi = ACP-**клиент** (субагенты) и ACP-**сервер** (Zed и JetBrains смогут управлять Guanxi) |
| **A2A** | 1.0.0 (2026-03-12; v1.0.1 — 2026-05-28); с 2026-08 в AAIF [S] | Agent Card, Task, Message, Artifact; JSON-RPC, gRPC, HTTP+JSON; push notifications (webhook) | Позже, для межхостовой делегации C4 (wake-up по webhook) |
| **Agent Skills** | agentskills.io/specification; `skills-ref validate` | `SKILL.md`: `name` (≤64), `description` (≤1024), `license`, `compatibility`, `metadata`, `allowed-tools` (experimental); progressive disclosure | Единственный формат skills в Guanxi; валидация в CI |
| **AGENTS.md** | agentsmd/agents.md (MIT); AAIF | Инструкции репозитория | Читать AGENTS.md в агентах и прокидывать вендорам (Codex читает нативно) |
| **Формат плагинов Claude Code** | `.claude-plugin/plugin.json`, `marketplace.json` | **Codex читает `.claude-plugin/plugin.json` как альтернативный manifest и `.claude-plugin/marketplace.json`**; DSH подключает Claude Code mods | Импорт skills, agents, commands, hooks и `.mcp.json` из таких пакетов; hooks — только в песочнице |
| **OpenAI-compatible API** | Chat Completions (локальные серверы: Ollama, vLLM, llama.cpp, LM Studio) и Responses (SIWC работает только через Responses) | — | Поддерживать оба wire-формата (они есть в `pi-ai`) |
| **OTel GenAI semconv** | Перенесены в `open-telemetry/semantic-conventions-genai`, релизов ещё нет | spans и metrics для GenAI и MCP | Экспорт session log по этим конвенциям, помечая версию как нестабильную |

---

## 13. Лицензионная совместимость (L1)

Guanxi распространяется под **MIT** [V].

- **MIT** (DSH, Cordis, OpenCode, pi, models.dev, Kilo, OpenHands, OpenClaw, Hermes,
  `@napi-rs/keyring`, Copilot SDK). Можно копировать и модифицировать. Нужно сохранить
  copyright и текст лицензии в `THIRD_PARTY_NOTICES.md` и NOTICE. DSH уже генерирует
  такой файл автоматически, это стоит перенять [V].
- **Apache-2.0** (Codex, goose, Gemini CLI, Cline, AI SDK, ACP и адаптеры, A2A, Agent
  Skills, Bifrost). Совместима с MIT при включении в проект. Нужно сохранить NOTICE и
  пометить изменённые файлы (§4b/§4d). Действует patent grant с patent-retaliation.
- **MPL-2.0** (`@deepseek-ai/libreoffice-kit` в DSH). Копилефт на уровне файла: можно
  использовать без модификации, изменённые файлы MPL раскрываются [V/I].
- **FSL-1.1-MIT** (Crush). Не OSI. Ограничен «Competing Use» до конверсии через 2 года.
  **Не включать.**
- **AGPL-3.0** (Claude Squad, Xum). Нельзя включать в MIT-проект без перелицензирования.
  Запускать как отдельный процесс можно, но лучше не связываться [I].
- **Проприетарные:**
  - Claude Agent SDK и бинарник Claude Code — Commercial Terms;
  - Copilot CLI;
  - Antigravity CLI.
  Только как **опциональные внешние зависимости, которые пользователь ставит сам**. В
  дистрибутив Guanxi их не включать: условие «preinstalling or running Claude Code in
  your products» требует принятия Commercial Terms и неизменённого бинарника [V].
- **Открытое ядро с `ee/` или `enterprise/`** (LiteLLM, Mastra). Использовать только
  OSS-часть.

---

## 14. Реестр ToS-рисков

| # | Риск | Вероятность / вред | Основание | Митигация [I] |
|---|---|---|---|---|
| R1 | Трафик Claude Code из-под Guanxi классифицируется как «third-party harness» и списывается с extra usage или блокируется | Средняя / высокий: деньги, неожиданный биллинг | Политика от 2026-04-04 [S], сообщения о серверном гейтинге по prompt [S] | Только бинарник пользователя, никакой мимикрии; предупреждение в UI; лимит расходов; fallback на API key; обратиться в Anthropic за одобрением как open-source-проект |
| R2 | Бан аккаунта за переиспользование OAuth (Anthropic или Google) | Низкая при соблюдении правил / критический | Legal-страница Anthropic [V]; Gemini FAQ, ToS, баны [V/S] | Не включать Anthropic и Google OAuth-модули из `pi-ai`, OpenCode и других; CI-проверка запрещённых client ID |
| R3 | `--bare` станет поведением по умолчанию для `claude -p` и логин подписки перестанет читаться | Средняя / средний | Docs headless [V] | Явно передавать нужные флаги; закреплять версию CLI; контракт-тест |
| R4 | SIWC остаётся preview: меняются scopes и ограничения | Средняя / средний | Preview limitations [V] | Изолировать в одном провайдере; fallback на API key или Codex app-server |
| R5 | Нагрузка выходит за «ordinary, individual usage» | Средняя / средний | Legal-страница Anthropic: «Advertised usage limits… assume ordinary, individual usage» [V] | Глобальная очередь и rate limiter по подпискам (B4) |
| R6 | Подписка Gemini недоступна без закрытого Antigravity CLI | Высокая / низкий | Discussion #27274 [V] | Gemini через API key |
| R7 | Supply chain (npm и PyPI) | Средняя / высокий | Инцидент LiteLLM 2026-03 [S] | lockfile, `--ignore-scripts`, cooldown, SBOM |
| R8 | Товарный знак DeepSeek в производном продукте | Низкая / средний | BRAND_GUIDELINES [V] | Полностью свой бренд; формулировка «built on DSH» |

---

## 15. Открытые вопросы владельцу

1. **База.** Принимаете ли вы модель «Guanxi = downstream-дистрибутив DSH» с upstream,
   который контролирует DeepSeek, не принимает PR и находится в preview? Это требует ADR,
   отменяющего ADR-0001/0010 и инвариант «`packages/contract` — единый контракт».
   Подтвердите и переход npm → pnpm, Electron для desktop.
2. **Claude.** Готовы ли принять серый риск R1 (Claude Code в headless или ACP под вашим
   логином, возможный extra usage)? Или «думалку» Fable держим на API key, а подписку
   используем только интерактивно? Писать ли в Anthropic за одобрением?
3. **ChatGPT.** Какой у вас тариф: Plus, Pro или Business? Для Business право на SIWC plan
   usage в документации не подтверждено. Устраивает ли, что computer-use на ChatGPT-
   подписке будет нашими function tools, а не hosted computer-use OpenAI?
4. **Gemini.** Есть ли у вас Google AI Pro/Ultra? Если да, нужно отдельно исследовать
   Antigravity CLI (headless или ACP). Иначе Gemini — только API key.
5. **Секреты на общей установке.** Разрешаете ли хранить секреты «unattended»-подключений
   под мастер-ключом хоста, чтобы фоновые jobs работали без входа пользователя? Или
   некоторые подключения будут работать только при разблокированном аккаунте?
6. **Проприетарные адаптеры.** Допустимы ли Claude Agent SDK, Copilot CLI и Antigravity
   CLI как опциональные плагины, которые пользователь ставит сам, без включения в
   дистрибутив?
7. **Telemetry DSH.** Отключить все product-analytics-плагины DeepSeek по умолчанию и
   провести аудит endpoints?
8. **Gateway-sidecar.** Нужен ли Bifrost или аналог для бюджетов по аккаунтам (A6/J2)?
   Или хватит учёта внутри Guanxi?

---

## 16. Научные и индустриальные обоснования (L3)

- **Cordis.** Spatiotemporal composability: revertible effects и reactive coeffects —
  arXiv:2608.25512 [V].
- **Agent-Computer Interface** как ключевой фактор качества coding-агентов — SWE-agent,
  arXiv:2405.15793 [V].
- **OpenHands:** event-sourced платформа (arXiv:2407.16741) и composable SDK
  (arXiv:2511.03690) [V].
- **Иерархическая память и паджинация контекста** — MemGPT, arXiv:2310.08560 [V].
- **Компакция контекста для long-horizon агентов** — ACON, arXiv:2510.00615 [V].
  Эволюционирующие контексты (playbooks) — ACE, arXiv:2510.04618 [V]. Оба важны для C5 и K.
- **Безопасность:** OWASP Top 10 for LLM Applications 2025 [V]; раздел Security and Trust
  & Safety спецификации MCP [V].

---

## 17. Источники

Все источники открыты 2026-10-19. Пометки: [V] — первичный, [S] — вторичный.

1. DeepSeek Harness — https://github.com/deepseek-ai/deepseek-harness. Commit `687f282`:
   README, LICENSE, CONTRIBUTING.md, BRAND_GUIDELINES.md, THIRD_PARTY_NOTICES.md,
   packages/README.md, docs/architecture.md, docs/subsystems/{persistence,compaction,otel,
   session-telemetry,product-telemetry,permission-presets,claude-code-mods,agent-team,
   voice-input}.md, packages/subagent/*/README.md, packages/llm/llm-pi-ai/{README.md,
   src/login.ts}, packages/credentials/README.md [V]
2. Cordis — https://github.com/cordiverse/cordis (commit `df4431e`, v4.0.0-rc.11) [V]
3. Shi, Zhang, Cui. *A Programming Paradigm for Spatiotemporal Composability*.
   arXiv:2608.25512 — https://arxiv.org/abs/2608.25512 [V]
4. OpenCode — https://github.com/anomalyco/opencode (commit `b56e253`; AGENTS.md,
   packages/*, packages/core/src/plugin/provider/chatgpt.ts,
   packages/core/src/session/compaction.ts, packages/plugin/README.md) [V]
5. pi — https://github.com/earendil-works/pi (commit `e86b054`; README,
   packages/ai/README.md, packages/ai/src/auth/oauth/*,
   packages/coding-agent/docs/{providers,compaction,mcp}.md) [V]
6. OpenAI Codex — https://github.com/openai/codex (commit `d70c2c2`;
   codex-rs/app-server-protocol/src/protocol/common.rs,
   codex-rs/core-plugins/src/{manifest,marketplace}.rs, sdk/typescript/README.md, docs/) [V]
7. goose — https://github.com/aaif-goose/goose (README, crates/, ui/,
   crates/goose-sdk/README.md) [V]
8. goose ACP providers — https://goose-docs.ai/docs/guides/acp-providers [V]
9. Gemini CLI — https://github.com/google-gemini/gemini-cli (README,
   docs/resources/tos-privacy.md) [V]
10. Gemini CLI FAQ — https://geminicli.com/docs/resources/faq/ [V]
11. Transitioning Gemini CLI to Antigravity CLI —
    https://github.com/google-gemini/gemini-cli/discussions/27274 [V]
12. Баны Antigravity и Gemini — https://github.com/google-gemini/gemini-cli/discussions/20632 [S]
13. The Register, «Bye-bye, Gemini CLI» —
    https://www.theregister.com/ai-ml/2026/05/20/bye-bye-gemini-cli-google-nudges-devs-toward-antigravity/5243605 [S]
14. Cline — https://github.com/cline/cline [V]
15. Roo Code (archived) — https://github.com/RooCodeInc/Roo-Code [V]
16. Kilo Code — https://github.com/Kilo-Org/kilocode [V]
17. OpenHands — https://github.com/OpenHands/OpenHands [V]
18. OpenHands SDK — https://github.com/OpenHands/software-agent-sdk [V]
19. Wang et al. *OpenHands*. arXiv:2407.16741 — https://arxiv.org/abs/2407.16741 [V]
20. *The OpenHands Software Agent SDK*. arXiv:2511.03690 — https://arxiv.org/abs/2511.03690 [V]
21. Crush, LICENSE.md (FSL-1.1-MIT) — https://github.com/charmbracelet/crush [V]
22. Aider — https://github.com/Aider-AI/aider [V]
23. Letta — https://github.com/letta-ai/letta; Letta Code — https://github.com/letta-ai/letta-code [V]
24. Packer et al. *MemGPT*. arXiv:2310.08560 — https://arxiv.org/abs/2310.08560 [V]
25. Claude Agent SDK overview — https://code.claude.com/docs/en/agent-sdk/overview [V]
26. Claude Code Legal and compliance — https://code.claude.com/docs/en/legal-and-compliance [V]
27. Claude Code headless — https://code.claude.com/docs/en/headless [V]
28. Claude Code statusline — https://code.claude.com/docs/en/statusline [V]
29. Agent SDK TypeScript reference — https://code.claude.com/docs/en/agent-sdk/typescript [V]
30. Anthropic Consumer Terms (effective 2025-10-08) — https://www.anthropic.com/legal/consumer-terms [V]
31. TechCrunch, 2026-04-04 —
    https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/ [S]
32. The Register, 2026-04-06 —
    https://www.theregister.com/2026/04/06/anthropic_closes_door_on_subscription/ [S]
33. WinBuzzer, 2026-02-19 —
    https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/ [S]
34. OpenClaw issue #65399 — https://github.com/openclaw/openclaw/issues/65399 [S]
35. HN «Anthropic says OpenClaw-style Claude CLI usage is allowed again» —
    https://news.ycombinator.com/item?id=47844269 [S]
36. OpenAI Agents SDK — https://github.com/openai/openai-agents-js,
    https://github.com/openai/openai-agents-python [V]
37. OpenClaw — https://github.com/openclaw/openclaw;
    https://docs.openclaw.ai/concepts/agent-runtimes;
    https://docs.openclaw.ai/gateway/authentication [V]
38. Hermes Agent — https://github.com/NousResearch/hermes-agent [V]
39. Kimi Code — https://github.com/MoonshotAI/kimi-code; Qwen Code —
    https://github.com/QwenLM/qwen-code; Mastra — https://github.com/mastra-ai/mastra [V]
40. ACP — https://github.com/agentclientprotocol/agent-client-protocol
    (README, schema/v1/meta.json, meta.unstable.json, releases) [V]
41. ACP overview — https://agentclientprotocol.com/protocol/overview [V]
42. claude-agent-acp — https://github.com/agentclientprotocol/claude-agent-acp [V]
43. codex-acp — https://github.com/agentclientprotocol/codex-acp; archived
    https://github.com/zed-industries/codex-acp [V]
44. Copilot CLI ACP —
    https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/ [V]
45. Copilot + OpenCode —
    https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/ [V]
46. Copilot SDK — https://github.com/github/copilot-sdk; Copilot CLI —
    https://github.com/github/copilot-cli [V]
47. SIWC Quickstart — https://developers.openai.com/siwc/quickstart [V]
48. SIWC ChatGPT plan usage overview —
    https://developers.openai.com/siwc/token-sharing-open-source [V]
49. SIWC Preview limitations —
    https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations [V]
50. SIWC Models and inference —
    https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference [V]
51. SIWC Codex app-server —
    https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server [V]
52. SIWC Self-hosted VMs —
    https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms [V]
53. Cookbook «Integrating Sign in with ChatGPT in your Opensource App» —
    https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt [V]
54. Help «Using your ChatGPT plan in other apps and sites» —
    https://help.openai.com/en/articles/20001542 (403 при fetch, содержание по поисковой выдаче) [S]
55. Codex authentication — https://learn.chatgpt.com/docs/auth [V]
56. Vibe Kanban — https://github.com/BloopAI/vibe-kanban; Crystal —
    https://github.com/stravu/crystal; Sculptor — https://github.com/imbue-ai/sculptor;
    Claude Squad — https://github.com/smtg-ai/claude-squad; Xum — https://github.com/coder/xum;
    Emdash — https://github.com/generalaction/emdash; Conductor — https://www.conductor.build/ [V]
57. Vercel AI SDK — https://github.com/vercel/ai (LICENSE Apache-2.0, ai@7.0.143);
    https://ai-sdk.dev/llms.txt (Harness Adapters, HarnessAgent, Claude Code) [V]
58. models.dev — https://github.com/anomalyco/models.dev; https://models.dev/api.json [V]
59. LiteLLM (LICENSE) — https://github.com/BerriAI/litellm [V]
60. Компрометация LiteLLM PyPI —
    https://futuresearch.ai/blog/litellm-pypi-supply-chain-attack/;
    https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/ [S]
61. any-llm — https://github.com/mozilla-ai/any-llm; Bifrost — https://github.com/maximhq/bifrost;
    Portkey — https://github.com/Portkey-AI/gateway [V]
62. OpenRouter limits — https://openrouter.ai/docs/api/reference/limits [V]
63. DeepSeek Get User Balance — https://api-docs.deepseek.com/api/get-user-balance [V]
64. Anthropic Usage and Cost API —
    https://platform.claude.com/docs/en/manage-claude/usage-cost-api [V]
65. OpenAI Costs API —
    https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
    (содержание по выдаче поиска с официальной страницы) [S]
66. MCP specification 2026-07-28 и changelog —
    https://modelcontextprotocol.io/specification/latest;
    https://modelcontextprotocol.io/specification/2026-07-28/changelog [V]
67. MCP releases — https://github.com/modelcontextprotocol/modelcontextprotocol/releases [V]
68. A2A specification — https://a2a-protocol.org/latest/specification/;
    https://github.com/a2aproject/A2A/releases [V]
69. Forbes, «Agent2Agent Joins The Agentic AI Foundation» —
    https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/ [S]
70. Agent Skills specification — https://agentskills.io/specification;
    https://github.com/agentskills/agentskills [V]
71. AGENTS.md — https://github.com/agentsmd/agents.md [V]
72. `@napi-rs/keyring` — https://github.com/Brooooooklyn/keyring-node;
    npm registry и downloads API (`api.npmjs.org/downloads/point/last-week/...`) [V]
73. node-keytar (archived) — https://github.com/atom/node-keytar [V]
74. Bun secrets — https://bun.com/docs/runtime/secrets [V по выдаче поиска с официального сайта]
75. OWASP Top 10 for LLM Applications 2025 — https://genai.owasp.org/llm-top-10/ [V]
76. Yang et al. *SWE-agent*. arXiv:2405.15793 — https://arxiv.org/abs/2405.15793 [V]
77. *ACON*. arXiv:2510.00615 — https://arxiv.org/abs/2510.00615 [V]
78. *Agentic Context Engineering*. arXiv:2510.04618 — https://arxiv.org/abs/2510.04618 [V]
79. OpenTelemetry GenAI semantic conventions —
    https://github.com/open-telemetry/semantic-conventions-genai;
    https://opentelemetry.io/docs/specs/semconv/gen-ai/ [V]
80. О релизе DSH: https://thenewstack.io/deepseek-harness-open-source-plugins/;
    https://venturebeat.com/technology/deepseek-harness-launches-as-open-source-rival-to-claude-code-alongside-v4-pro-on-api-with-higher-prices;
    https://incrypted.com/en/deepseek-harness-how-to-launch-an-ai-agent/;
    https://www.deepseek.com/en/harness/ [S]
81. Guanxi — the Guanxi repository (LICENSE MIT, package.json,
    docs/decisions/0008, 0010) [V, локально]
