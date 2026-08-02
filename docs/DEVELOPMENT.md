# Разработка

**Статус:** implemented  
**Проверено:** 2026-08-02  
**Область:** фактическая структура и команды текущего репозитория

## Репозиторий

```text
packages/
  contract/  Zod domain, REST paths, SSE events
  server/    Hono composition, SQLite, Ollama, agent, tools
  web/       React SPA, typed API/SSE client
  cli/       foreground launcher and browser reuse
```

Root npm workspaces связывают пакеты. Production server раздаёт собранный web.

## Требования

- Node.js >= 22.5;
- npm;
- Ollama для ручного inference;
- браузер для UI-проверок.

## Команды

```bash
npm install
npm run dev:server
npm run dev:web
npm run typecheck
npm test
npm run test:web:browser
npm run build
npm run link:cli
```

| Команда            | Фактическая область                                 |
| ------------------ | --------------------------------------------------- |
| `dev:server`       | Node/Hono на loopback:4310                          |
| `dev:web`          | Vite:5173 с API proxy                               |
| `typecheck`        | TypeScript workspaces                               |
| `test`             | server + CLI + узкие web component regression tests |
| `test:web:browser` | deterministic Chromium P0-A–P0-D с mocked REST/SSE  |
| `build`            | contract, web, server и CLI production artifacts    |
| `link:cli`         | глобальная локальная ссылка `alamo-ui`              |

`packages/web` содержит script `dev:mock`, но целевой `mock/server.mjs` отсутствует.
Считайте команду неработающей до отдельного решения: восстановить fixture server
либо удалить script.

## Current runtime conventions

- Current UI создаёт Chat с `num_ctx=8192`, Agent thread с `num_ctx=32768` и
  передаёт context в Ollama явно. Это текущее поведение, не универсальный safe
  default: target Governor должен учитывать exact model/hardware/runtime.
- Не все модели возвращают structured `tool_calls`. Current parser поддерживает
  native field и JSON/text fallback; сохраняйте оба пути и тесты при изменениях.
- Current agent turn отправляет `keep_alive=10m`; это известный lifecycle risk, а
  не рекомендуемый target default.
- Current P0-C bridge сериализует Chat turn, compaction и explicit model
  warm/load одним process-local permit. FIFO wait connection-owned и не является
  durable Job queue или Resource Governor.
- Current P0-D adapter различает connect, load и stream-idle deadlines.
  Caller-owned Stop/disconnect имеет приоритет; timeout/provider/abort
  освобождает P0-C permit.
- Health/catalog/running facts — sampled observations с source/time. Installed
  models приходят из `/api/tags`, loaded rows из `/api/ps`; current catalog
  использует stale local cache или dated bundled fallback без remote endpoint.

## Карта current-state

### Contract

- `schemas.ts` — domain Zod schemas;
- `api.ts` — route constants и request/response schemas;
- `events.ts` — SSE event union;
- `index.ts` — public exports.
- Message terminal bridge использует additive/defaulted fields; точные новые SSE
  terminal details остаются optional для старого strict client.

### Server

- `app.ts` — routes/composition/static serving;
- `context.ts` — зависимости, per-thread controllers и host-wide bridge owner;
- `runtime/exclusive-inference.ts` — временный process-local FIFO permit;
- `ollama/` — client, status и wire types;
- `models/` — installed/running details и sourced catalog fallback;
- `hardware/` — host probe и fit;
- `http/` — models, threads, workspaces, SSE;
- `store/` — SQLite migrations и stores;
- migration 3 добавляет nullable `turn_status/turn_error/stop_reason` и не
  переписывает старые migrations;
- `agent/` — turn loop, prompts, approvals и parser;
- `tools/` — registry, filesystem, shell и jail.

### Web

- `App.tsx` — current three-tab IA;
- `components/ErrorBoundary.tsx` — root/Chat containment и safe diagnostics;
- `lib/router.tsx` — History API router;
- `lib/api.ts` — typed API calls;
- `lib/sse.ts` — POST/SSE parser;
- `lib/locale.ts` — English fallback и curated Russian для новых boundary strings;
- `features/launcher` и `features/models` — installed/catalog/profile;
- `features/chat` — creation, timeline, composer и stream state;
- `features/context` — context/cache/compaction;
- `features/agent` — workspace, approval и tool projections;
- `features/settings` — current settings.
- `test/component` — Vitest/jsdom P0-A/P0-B/P0-D projection regression;
- `test/browser` — Playwright Chromium first-stream, failure/reload и boundary
  smoke, включая degraded Runtime/catalog state.
- server tests — deterministic P0-C mutex, cross-thread turn/compaction/warm,
  cancellation/release и repeated-compaction regression; P0-D fake provider
  health/catalog/running/timeout envelope.

### CLI

- `bin.ts` — args, foreground start и browser open;
- `existing.ts` — probe/reuse already-running server;
- `scripts/build.mjs` — bundle.

## Change protocol

### REST/SSE

1. Измените Zod schema/path/event в `contract`.
2. Измените server handler и error semantics.
3. Измените web/CLI projection.
4. Добавьте route + parser + UI failure tests.
5. Обновите HLD/LLD, если поменялась граница.

Не добавляйте unvalidated ad-hoc JSON между пакетами.

### SQLite

1. Добавьте новую migration по `user_version`.
2. Сделайте migration forward-only и безопасной для существующих данных.
3. Опишите backfill/default и поведение при прерывании.
4. Тестируйте fresh DB и upgrade с предыдущей схемы.
5. Для destructive cleanup сначала введите совместимый read/write period.

### Model/runtime

1. Опишите Job/lease transition до кода.
2. Учитывайте весь host, browser tabs и внешние Ollama clients.
3. Не используйте route unmount как cancellation.
4. Добавьте timeout, abort и terminal persistence.
5. Ключуйте observations по digest/runtime/backend/hardware/context.

### Catalog/capability

1. Проверьте разрешённость provider API.
2. Добавьте schema validation, timeout, bounded retries и cache policy.
3. Храните provenance/freshness/confidence.
4. Не превращайте model-card claim в runtime fact.
5. Неподдерживаемый provider не должен ломать installed models.

### UI

1. Реализуйте loading/empty/error/offline/partial/terminal states.
2. Сохраняйте keyboard и semantic HTML.
3. Проверяйте narrow viewport, 200% zoom и reduced motion.
4. Не добавляйте page-local lifecycle для durable Jobs.
5. Добавляйте Error Boundary на feature и root boundaries.

## Code conventions

- Сохраняйте TypeScript strictness; не обходите contract через `any`, type
  assertion или повторное ручное описание JSON shape.
- Парсите недоверенные HTTP/provider/DB JSON на границе Zod/schema adapter.
- Передавайте инфраструктурные зависимости через существующий composition
  context; не создавайте Ollama/DB/tool clients внутри route/component.
- Async API принимает `AbortSignal`, задаёт timeout policy и различает cancel,
  timeout и provider error.
- Resource/model side effect выполняется только через владеющий lifecycle service;
  React effect не является владельцем durable operation.
- React effect callback возвращает только cleanup-функцию или `undefined`. Если
  вызываемый callback может вернуть Promise/value, оборачивайте его в block body.
- Не храните canonical server state только в component/localStorage. Local storage
  подходит для theme/temporary view preferences, но не для approvals/Jobs/leases.
- Ошибки имеют stable machine code и безопасное human message; raw provider error
  проходит redaction.
- Комментарий объясняет invariant/tradeoff, а не пересказывает строку кода.
- Публичное изменение сопровождается failure-path test, а не только happy path.

## Local data и безопасность

- пользовательская DB: `~/.alamo/alamo.db`;
- Ollama хранит свои models отдельно;
- agent workspace указывает на реальные user files;
- settings/secrets сейчас сохраняются в SQLite plaintext — известный риск;
- server по умолчанию loopback-only.

Не используйте реальные paths/data в unit tests. Temporary DB/workspace создавайте
в test temp directory. Bind на `0.0.0.0` не превращает текущий сервер в безопасный
remote product: auth middleware пока не реализует защиту, а tools имеют сильные
локальные эффекты.

### Прокси и сертификаты

В исходном development environment `npm install` работал через корпоративный
proxy, а Bun мог падать на self-signed certificate. Если Node/Bun или исходящие
provider requests не доверяют корпоративному CA, используйте утверждённый
root-certificate через `NODE_EXTRA_CA_CERTS`; не отключайте TLS verification и не
коммитьте сертификат в репозиторий.

## Branding

Имя `Alamo` сейчас встречается в packages, CLI, UI, DB path, localStorage и CSS.
Новые места не добавляйте. До rename нужен inventory и compatibility plan:

- display name;
- binary/package identity;
- API/client identifiers;
- data directory/DB;
- localStorage keys;
- config/env prefixes;
- migration aliases.

## Документация

Current behavior обновляется вместе с кодом. Target behavior проходит через ADR
и roadmap. В текстах не используйте «поддерживается», если существует только
enum, mock, proposal или upstream possibility.
