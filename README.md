# Alamo UI

> Рабочее название. Проект находится на ранней alpha-стадии.

Alamo UI — local-first web-интерфейс к Ollama. Сейчас приложение умеет находить
локальные модели, оценивать их fit, создавать chat/agent threads, стримить ответы,
показывать thinking/tool events и выполнять ограниченный набор локальных tools.

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
npm run build
```

Важно: `npm test` пока запускает server- и CLI-тесты, но не browser tests.
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

- первый streaming render способен завершить React белым экраном из-за неверного
  cleanup в effect; причина зафиксирована в roadmap;
- отмена browser stream при навигации отменяет текущий turn;
- очередь и глобальное управление несколькими загруженными моделями отсутствуют;
- каталог использует offline fallback, потому что прежний
  `ollama.com/api/search` больше не является рабочим API;
- model capabilities, MCP, media workbenches и attachments реализованы частично
  либо только представлены типами;
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
