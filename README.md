# Alamo UI

> Рабочее название. Проект находится на ранней alpha-стадии.

Alamo UI — local-first web-интерфейс к Ollama. Текущая alpha умеет находить
и импортировать модели, показывать sourced capability/fit evidence,
запускать durable Chat Jobs с replay/cancel/recovery, управлять Project и
retention metadata, а также хранить и скачивать local attachments. Web UI
имеет English source/fallback, curated Russian и searchable Glossary.

Целевое направление шире: ресурсно-безопасный workbench для локальных моделей,
где пользователь видит, какая модель загружена, что выполняется, сколько ресурсов
занято и почему конкретная операция доступна. Целевая архитектура и roadmap
описаны отдельно и пока не являются обещанием текущего кода.

## Текущее устройство

```text
packages/contract  Zod-схемы REST/SSE
packages/server    Hono API, SQLite, Ollama adapter, agent/tools
packages/web       React SPA
packages/cli       foreground launcher
```

Ollama запускается отдельным процессом. Alamo UI по умолчанию слушает loopback и
хранит локальные данные в `~/.alamo/alamo.db`.

## Требования

- Node.js 22.5 или новее: сервер использует `node:sqlite`;
- npm;
- установленный и запущенный Ollama для inference.

## Запуск разработки

```bash
npm install
npm run dev:server
```

Сервер будет доступен на `http://127.0.0.1:4310`.

Для отдельного Vite dev server:

```bash
npm run dev:web
```

Он откроется на `http://127.0.0.1:5173` и проксирует API на порт 4310.

## Проверка

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
```

Важно: `npm test` включает core и Web component/parser tests, но не
Chromium gate. Для `npm run test:web:browser` нужен заранее установленный
Chromium (`npx playwright install chromium`).
Фактическая матрица и пробелы описаны в
[`docs/TESTING.md`](docs/TESTING.md).

## CLI

Локальная связка:

```bash
npm run link:cli
alamo-ui
```

Текущий CLI запускает сервер в foreground и открывает браузер. Daemon, `status`,
`stop`, TUI и полноценный agent client относятся к будущим фазам.

## Известные ограничения

- background service, `status`/`stop`, TUI и autostart ещё не реализованы;
- Resource Governor пока даёт один process-local permit; multi-process и measured
  parallel admission не подтверждены;
- каталог использует offline fallback, потому что прежний
  `ollama.com/api/search` больше не является рабочим API;
- Quick Run/Recipe execution, media Workbench, attachment model consumption и
  generic Artifact GC остаются target-state;
- MCP/Skills выключены по default, а agent/tool boundary ещё не имеет
  target security profile;
- remote bind нельзя считать безопасным для agent/tools API.

## Документация

Карта канонических документов: [`docs/NAVIGATION.md`](docs/NAVIGATION.md).

Ключевые точки входа:

- [продукт и требования](docs/PRODUCT.md);
- [словарь и доменная модель](docs/DOMAIN_MODEL.md);
- [UX и информационная архитектура](docs/UX_IA.md);
- [HLD](docs/architecture/HLD.md);
- [LLD](docs/architecture/LLD.md);
- [runtime и память](docs/architecture/RUNTIME_LIFECYCLE.md);
- [поэтапный roadmap](docs/plans/ROADMAP.md);
- [текущий phase status](docs/plans/PHASE_STATUS.md);
- [как работать по фазам](docs/plans/WORKFLOW.md);
- [готовый prompt следующему агенту](docs/plans/NEXT_AGENT_PROMPT.md);
- [принятые продуктовые решения](docs/decisions/2026-08-02-product-decisions.md);
- [открытые продуктовые решения](docs/plans/OPEN_QUESTIONS.md).

## Лицензия

[MIT](LICENSE)
