# Инструкции для агентов

**Статус:** implemented  
**Проверено:** 2026-08-12
**Область:** весь репозиторий

Alamo UI — ранний local-first интерфейс и runtime-control layer поверх Ollama. Не
считайте документы с пометкой `proposed` уже реализованными.

## Что читать

1. Начните с [`docs/NAVIGATION.md`](docs/NAVIGATION.md).
2. Для продуктовой задачи прочитайте `PRODUCT.md`, `DOMAIN_MODEL.md` и `UX_IA.md`.
3. Для изменения кода прочитайте `DEVELOPMENT.md`, `TESTING.md`, HLD и LLD.
4. Для streaming, памяти, очередей и моделей обязательно прочитайте
   `architecture/RUNTIME_LIFECYCLE.md` и связанные ADR.
5. Для запланированной работы прочитайте `plans/PHASE_STATUS.md`, затем
   `plans/ROADMAP.md`; открытые решения не закрывайте молча — сверяйтесь с
   `plans/OPEN_QUESTIONS.md`.
6. **Обязательно прочитайте [`plans/WORKFLOW.md`](docs/plans/WORKFLOW.md)** — это
   канонический протокол одного slice: orientation, план, vertical implementation,
   независимая verification, docs/commits. Без него slice считается неполным.
7. Принятые ответы владельца находятся в
   `decisions/2026-08-02-product-decisions.md`; они выше старого proposal.
8. После каждого bounded slice обновите `plans/PHASE_STATUS.md` и перепишите
   `plans/NEXT_AGENT_PROMPT.md` для следующего незавершённого slice. Если работа
   заблокирована, оставьте prompt на текущий slice с blocker и recovery steps.

## Статусы знаний

- `proposed` — предложение, ещё не одобренное и не реализованное;
- `accepted` — решение явно принято, но может быть ещё не реализовано;
- `implemented` — существует в коде;
- `locally validated` — проверено локальными тестами или наблюдением;
- `validated` — подтверждено эксплуатационными или пользовательскими данными;
- `superseded` — заменено другим решением.

При противоречии код описывает текущее поведение, принятый ADR — целевое решение,
а roadmap — порядок перехода. Исправьте противоречащий документ в той же задаче.

## Текущие инварианты

- `packages/contract` — единый runtime-контракт REST и SSE. Согласованно меняйте
  contract, server, web и тесты.
- Сервер владеет доступом к SQLite, filesystem, shell и Ollama; web не обращается
  к ним напрямую.
- По умолчанию сервер должен оставаться loopback-only. Не выставляйте agent/tool
  API в сеть без отдельного security profile, authentication, TLS и allowed roots.
- SQLite migrations только добавляются; не переписывайте миграции, уже применённые
  пользовательской базой.
- Проект использует ESM и явные `.js`-суффиксы в TypeScript imports там, где этого
  требует существующий стиль.
- Текущий POST+SSE turn привязан к соединению и не является durable/replayable.
  Не описывайте его как фоновую работу.
- До реализации Resource Governor разные threads способны одновременно загрузить
  разные модели. Любое изменение model lifecycle должно учитывать весь host, а
  не только открытую страницу.
- Не выводите capability, hardware fit или runtime status как факт без источника,
  времени наблюдения и уровня уверенности.
- Не вводите произвольные UI-ceilings для context, thinking, output, media size
  или числа accelerator devices. Limits приходят из adapter/runtime/policy и
  объясняются; safe default не становится скрытым hard cap.
- Не добавляйте новые жёстко прошитые варианты имени продукта. Используйте
  централизуемый brand/config boundary согласно ADR-0007.
- MCP/Skills выключены по default. Auto agent mode действует только внутри
  immutable Project/Run policy и не равен unrestricted host access.
- User-facing strings проходят locale keys: English source/fallback и curated
  Russian. Не добавляйте новый bilingual hardcode прямо в component.

## Команды

```bash
npm install
npm run dev:server
npm run dev:web
npm run typecheck
npm test
npm run test:web:browser
npm run build
```

`npm test` проверяет server, CLI и web component regression tests.
Deterministic Chromium tests запускаются отдельно через
`npm run test:web:browser`: текущий suite перечисляет 36 mocked тест, покрывающий
P0-A–P3-K (crash containment, first stream, terminal reload, runtime bar,
resource conflict, prewarm, context limits, model evidence, catalog, user
capability overrides, Hugging Face discovery, exact GGUF selection/download и
локальный staged import, logical Project без filesystem root и Project
presentation picker, Project Chat grouping, retention/Trash, reasoning Chat
Info, Session deletion, Quick Run и Recipe revisions). Последний локально
подтверждённый baseline — 36/36 через P3-K на 2026-08-14. Это по-прежнему
mocked gate без live Ollama/GPU/network — не называйте его полным regression
suite и не выдавайте за production validation.

Browser gate требует заранее установленный Chromium: `npx playwright install
chromium` (postinstall hook отсутствует). Запускайте gate только из корня или из
`packages/web`; прямой `npx playwright` из корня не получает workspace `baseURL`
и падает с invalid URL.

## Границы изменений

- Не редактируйте `node_modules`, `dist`, `build` и `*.tsbuildinfo`.
- Не изменяйте пользовательские данные в `~/.alamo`, Ollama model store и реальные
  workspace-файлы в обычных unit/integration tests.
- Не используйте живую установленную модель в тестах без явного integration
  envelope: такие тесты дороги, зависят от железа и могут загрузить память.
- Не логируйте API keys, содержимое закрытых workspace и reasoning/thinking.
- Не храните секреты в новых plaintext-полях; существующее хранение settings в
  SQLite — известный долг, а не прецедент.
- Не удаляйте и не переименовывайте публичные API, DB-поля, localStorage keys,
  package names или data paths без compatibility/migration plan.

## Маршрутизация изменений

| Изменение             | Минимально проверить и обновить                                      |
| --------------------- | -------------------------------------------------------------------- |
| REST/SSE schema       | contract, server route, web client, route tests, docs                |
| DB schema             | append-only migration, store tests, recovery/rollback note           |
| Run/model lifecycle   | Runtime Lifecycle, ADR, concurrency tests, UI states                 |
| Capability/catalog    | provenance, cache/staleness, unknown state, provider policy          |
| Agent/tool/MCP        | permissions, approval, audit, cancellation, security profile         |
| UI flow               | loading/empty/error/offline states, keyboard, reduced motion, mobile |
| CLI/service lifecycle | non-interactive command, exit codes, JSON mode, TUI wrapper          |
| Название/branding     | central manifest, compatibility aliases, data/storage migration      |

## Готовность изменения

Изменение готово, когда:

1. поведение и отказные состояния наблюдаемы;
2. соответствующие типы и границы согласованы;
3. тесты пропорциональны риску и их реальная область указана;
4. **каждое свойство, заявленное в docs или ROADMAP exit gate, имеет assertion,
   который падает при нарушении этого свойства.** `toBeVisible` не доказывает
   отсутствие duplicate; «не дублирует» требует явного count. Если свойство
   заявлено, но не проверено — это не готовность, а долг;
5. **независимая verification выполнена отдельным действием** (см.
   `plans/WORKFLOW.md`), её findings исправлены, а fix виден отдельным commit;
6. **E2E/browser gate `npm run test:web:browser` прошёл** для любого slice,
   меняющего Web;
7. документация отражает новое текущее состояние;
8. остаточный риск явно назван, а `proposed` не выдан за `implemented`;
9. `PHASE_STATUS.md` содержит evidence с разделением **new / regression
   envelope** (см. правило подсчёта в `plans/WORKFLOW.md`), а
   `NEXT_AGENT_PROMPT.md` готов к следующей агентской сессии.
