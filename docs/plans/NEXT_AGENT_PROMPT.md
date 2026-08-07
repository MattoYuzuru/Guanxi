# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-07

**Назначение:** Phase 2, slice P2-J — Hugging Face search и repository metadata,
GGUF-only

## Контекст

Работай в `/Users/m.ryabushkin/Projects/alamo-ui` на текущей ветке. Сначала
прочитай `AGENTS.md` и маршрут из `docs/NAVIGATION.md`; для code change обязательны
`PRODUCT.md`, `DOMAIN_MODEL.md`, `UX_IA.md`, `DEVELOPMENT.md`, `TESTING.md`, HLD,
LLD, ADR-0003, **ADR-0006 (`decisions/0006-catalog-sources-and-compliance.md`)**,
**`research/EVIDENCE.md` раздел Hugging Face**, `plans/PHASE_STATUS.md`,
`plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted owner decisions, а также
обязательный протокол `plans/WORKFLOW.md`.

Implementation не делегируется: contract, server, Web, migration и tests пишешь
ты сам. Но независимая verification в конце slice — обязательный отдельный шаг
через reviewer-субагента (см. «Независимая verification» в `WORKFLOW.md`).
Не используй субагентов для написания production code.

Не считай target/proposed реализованным. Код определяет current behavior,
accepted ADR/decision — целевую границу, ROADMAP — порядок перехода. Не трогай
`.idea/`, пользовательские данные, real Ollama model store, `node_modules`,
generated outputs или unrelated worktree changes.

P2-A–P2-I уже реализованы. P2-I code commits:

- `6b98d37` — additive override contract, migration 9, store, exact-identity
  server ownership и descriptor projection;
- `8f5b5d5` — Installed Web management и safe export;
- `d478f65`, `ea97be0` — server и Web failure-matrix tests;
- review fixes: `09b3c00` (symmetric read/write key, committed-mutation truth,
  partial-row tolerance, canonical reference, typed decode error), `c8ef1b8`
  (label ↔ control), `a177b14` (export URL lifetime), `6cc4504` (remove-path
  dialog focus).

Подтверждённый baseline (перепроверен 2026-08-07): typecheck clean; core 401/401;
Web 117/117; mocked Chromium 25/25; build, markdownlint 31 files/0 issues и diff
check — всё зелёное. P2-I net new — 52 server tests / 401 core envelope.

Полный исторический ledger повторов хранится в `PHASE_STATUS.md` и здесь больше
не дублируется. Repeat-политика: повторяй 10× **только** новую P2-J group и те
файлы, которые твой diff реально задевает. Не повторяй по 10 раз всю
унаследованную цепочку P1-E…P2-I. Flaky результат фиксируй, диагностируй и только
потом переходи дальше.

## Уроки P2-I, которые сэкономят тебе время

- `npm test | grep` под memory pressure даёт exit 137 без вывода. Пиши вывод в
  файл (`npm test > /tmp/out.txt 2>&1`), потом читай файл. Это окружение, а не
  продукт;
- browser gate запускается только из корня или `packages/web`; прямой
  `npx playwright` из корня получает `Cannot navigate to invalid URL`;
- любая новая migration ломает inherited fixtures: version expectations и
  downgrade helpers в `migration.test.ts`, `job-migration.test.ts`,
  `observation-migration.test.ts`, `installed-evidence-migration.test.ts`,
  `completion-probe-migration.test.ts` придётся обновить. Это не product
  regression, но зафиксируй как первый failure;
- `toBeDisabled` отсутствует в текущем matcher setup — используй `.disabled` плюс
  явную проверку инертности;
- reviewer-субагент может создать файлы в worktree. Проверяй `git status` перед
  commit и явно запрещай reviewer-у писать в дерево;
- проверяй каждый свой fix мутацией исходника: в P2-I один «исправленный» дефект
  остался в коде именно потому, что mutation-правка не была откатана.

Owner session 2026-08-07 закрыла Q-25–Q-36 (см. `plans/OPEN_QUESTIONS.md`). Ни
один вопрос больше не блокирует slice. Что из этого важно **для P2-J**:

- **Q-25 accepted: только exact GGUF file/revision.** Safetensors conversion и
  GGUF adapters вне scope и не обещаются. Non-GGUF repository получает explicit
  unsupported state, а не пустой список;
- HF URL нельзя обещать как direct `ollama pull`. Полный pipeline — metadata →
  exact GGUF → download/checksum → local Ollama import → probe — разбит на
  P2-J..P2-M. **P2-J делает только первый шаг**;
- `apps=ollama` — hint, не доказательство. `EVIDENCE.md` фиксирует, что metadata
  optional, заполняется автором и требует runtime validation;
- CI пока нет: все gates — твоя ответственность, включая browser gate;
- Открыт только Q-27a (`wrap up and report` как durable state) — это Phase 5/8, к
  P2-J не относится.

## Current gap

Строк кода для Hugging Face нет: `huggingface`/`gguf` дают 0 файлов в `src`.
Current import — только P2-D/P2-E bounded mutable-tag pull из local Ollama, и
Marketplace знает исключительно stale local cache либо dated bundled snapshot.
ADR-0006 и MOD-010 требуют HF discovery как отдельного provider с явной
provenance, но ни contract, ни server, ни Web такого provider не имеют.

P2-J — **read-only discovery slice**. Он не выбирает файл, не качает, не считает
checksum и не импортирует: это P2-K, P2-L и P2-M. Без exact GGUF selection
repository остаётся candidate, а не installable target.

## Цель P2-J

Пользователь ищет модели в Hugging Face из Marketplace, видит truthful repository
metadata с явным source/time, и для каждого repository видит одно из трёх
состояний: содержит exact GGUF files (candidate для P2-K), не содержит GGUF
(explicit unsupported), либо metadata недоступна/неоднозначна (unknown). Ни одно
состояние не обещает `ollama pull`, installation, capability или fit.

## Обязательный scope

### Additive contract и provider identity

- Добавь strict versioned HF discovery contract: search query (текст, bounded
  page/pageSize по образцу P2-H), repository identity (`owner/name`), revision
  reference, gated state, license state, GGUF-file inventory и explicit
  `supported | unsupported | unknown` verdict с reason.
- Repository identity нормализуется одним pure server-side parser, как P2-D
  `ollama-reference.ts`. Разреши только strict `owner/name` shapes и exact HTTPS
  `huggingface.co` model-page URL. Whitespace/control, credentials, port,
  query/fragment, arbitrary/lookalike host, encoded separator, literal traversal
  и ambiguous grammar fail-closed.
- Unknown/future enum, extra field, malformed identity/revision/timestamp
  fail-closed. Отсутствие GGUF не означает «модель плохая»; отсутствие metadata
  не означает unsupported — это разные states.
- Не смешивай HF facts с P2-E catalog variants и P2-A installed descriptor. HF
  repository — отдельный provider с собственной provenance, а не catalog row.

### Bounded server-owned HF access

- Только server обращается к HF. Web не делает cross-origin request и не получает
  HF endpoint. Используй документированный public Hub API, никакого scraping
  HTML.
- Один explicit search — один bounded request: fixed timeout, response byte
  limit, максимум страниц, caller AbortSignal. Malformed/oversized/slow/
  unavailable/rate-limited ответы дают typed redacted states, а не guessed
  metadata.
- Никаких credentials в этом slice: только anonymous public access. Gated
  repository распознаётся и показывается как gated, но token flow, acceptance и
  authenticated download — **не** этот slice.
- Не кэшируй persistent-но в SQLite, если не докажешь необходимость: P2-J может
  остаться request-scoped. Если добавляешь migration 10 — она append-only, без
  backfill, с fresh/v9→v10/reopen/failed/rollback tests.
- HF request не запускает Ollama chat/pull/load/unload, Governor admission,
  probe, catalog refresh или background Job.

### Marketplace Web

- Добавь HF discovery как явно отдельный source внутри Marketplace, не
  подмешивая результаты в существующий catalog list. Пользователь всегда видит,
  что это Hugging Face, когда metadata получена и что она может быть неполной.
- Search требует explicit action (submit/Enter), bounded debounce, AbortSignal и
  late-response guard. Mount, hover, focus, navigation и reload не выполняют
  network request.
- Для каждого repository покажи owner/name, revision basis, gated state, license
  state, GGUF inventory и explicit verdict. `unsupported` объясняет, что scope —
  GGUF-only, а не что модель нерабочая. `unknown` не показывается как supported.
- Никакой кнопки Install/Pull в этом slice: exact GGUF selection — P2-K. Явно
  скажи пользователю, что дальше требуется выбор файла, и не обещай one-click.
- Loading/empty/no-results/error/rate-limited/offline/retry states различимы. Все
  новые strings через locale keys: English source/fallback и curated Russian.
- Keyboard/screen reader, focus containment и restore для любого нового
  dialog/disclosure, 390 px, 200%, no horizontal overflow, reduced motion.

## Failure matrix и тесты

Минимальные deterministic cases:

- strict identity parser: valid `owner/name`, valid HTTPS model page, case
  normalization, и fail-closed для whitespace/control, credentials, port,
  query/fragment, foreign/lookalike host, encoded separator, traversal, пустых
  segments и multi-slash;
- strict query/response contract, legacy-safe additive defaults, unknown/future
  enum, extra field;
- GGUF inventory: repository только с GGUF, смешанный, без GGUF, с 0 files, с
  malformed file entries, с очень большим числом files внутри bounded page;
- verdict matrix: `supported` только при exact GGUF evidence; `unsupported`
  только при доказанном отсутствии GGUF; всё остальное — `unknown` с reason;
- gated repository и license absent/present не меняют verdict сами по себе;
- transport: unavailable, timeout, malformed JSON, oversized body, rate-limited,
  partial page — все дают typed redacted states без raw body, endpoint и token;
- AbortSignal: caller abort прекращает own wait и не пишет ничего;
- отсутствие pull/probe/prewarm/load/unload/catalog fetch/Governor action;
- Web: no request на mount/hover/focus/navigation/reload; explicit search делает
  ровно один request; double submit — один intent; late response игнорируется;
- English/Russian, keyboard/focus/Escape, 390 px, 200%, overflow, reduced motion;
- HF результаты не попадают в installed list и не меняют P2-A descriptor или
  P2-E catalog rows.

Не используй live HF network, live Ollama, GPU в обязательных tests. Fake HTTP
transport, recorded safe fixtures и mocked browser routes должны доказать
boundaries. Если добавишь live-network integration test — только за explicit
opt-in envelope, вне default `npm test`.

## Не входит в P2-J

- выбор exact GGUF file/revision, size/license/fit preview — это P2-K;
- download, checksum, provenance, resume, disk reservation — это P2-L;
- local Ollama import через `/api/create` и probe — это P2-M;
- token/authenticated download, gated acceptance flow;
- safetensors conversion, GGUF adapters, quantization на стороне приложения;
- feature flags и estimated parallel-admission — это P2-N/P2-O;
- full Capability Registry, OperationResolution/Task Adapter wiring;
- negative capability override, confidence, audit history — вне P2-I scope;
- HTML scraping HF или Ollama, live catalog provider для существующего
  Marketplace list;
- persistent HF cache/history, saved searches, recommendations, ranking;
- NVIDIA calibration, NVML/MIG, scheduler/parallelism.

## Проверка

Сначала зафиксируй clean inherited baseline. После implementation выполни как
минимум:

```bash
npm run typecheck
node --test packages/server/test/capability-override-contract.test.ts \
  packages/server/test/capability-override-migration.test.ts \
  packages/server/test/capability-override-store.test.ts \
  packages/server/test/capability-override-service.test.ts \
  packages/server/test/capability-override-routes.test.ts
node --test packages/server/test/ollama-reference.test.ts \
  packages/server/test/ollama-reference-contract.test.ts \
  packages/server/test/ollama-reference-routes.test.ts
node --test packages/server/test/catalog-pagination.test.ts \
  packages/server/test/catalog-facets.test.ts \
  packages/server/test/catalog-variant-contract.test.ts
node --test packages/server/test/migration.test.ts \
  packages/server/test/model-descriptor.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Browser gate требует заранее установленный Chromium
(`npx playwright install chromium`) и запускается из корня либо из
`packages/web`; прямой `npx playwright` из корня не получает workspace `baseURL`.

Добавь exact P2-J parser/transport/route/Web/Chromium commands. Повтори 10×
только новую P2-J group и файлы, реально затронутые твоим diff, с exit/count
checking. Первый failing/flaky result сохрани, диагностируй и исправь; повторный
green не скрывает первую ошибку. Не запускай десятки Node/Vitest processes
одновременно — под memory pressure Vitest даёт exit 137 без вывода.

## Completion и handoff

После bounded slice:

- **вызови reviewer-субагента** (`sde-agent:implementation-reviewer` для
  contract/parser/transport/routes, `frontend-agent:accessibility-reviewer` для
  Marketplace Web; при желании `sre-agent:defensive-security-review` для внешнего
  network boundary), передай ему точный diff и заявленные свойства, исправь
  findings отдельным `fix(...)`/`test(...)` commit и запусти browser gate после
  фикса. Явно запрети reviewer-у создавать файлы в worktree;
- проверь, что каждое заявленное свойство имеет падающий assertion, и подтверди
  это мутацией исходника, а не только зелёным прогоном;
- согласованно обнови contract, server, Web, locale, tests и current-state docs;
- обнови таблицу «Phase 2 — что реально осталось» в `PHASE_STATUS.md`;
- запиши counts как `N new / M envelope`, не смешивая regression envelope с новой
  работой;
- добавь P2-J evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A–P2-I;
- обнови статус P2-J в таблице «Планируемая последовательность Phase 2»;
- Phase 2 оставь `in progress`: discovery не закрывает P2-K..P2-M, flag infra
  (P2-N/P2-O) или ROADMAP exit gate;
- полностью перепиши этот файл под **P2-K — выбор exact GGUF file/revision и
  size/license/fit preview**: это следующий slice цепочки. Если P2-J
  заблокирован, оставь файл на P2-J с blocker и recovery steps;
- используй небольшие conventional commits и не включай `.idea/`.

В финале сообщи ровно `status successful` либо `status blocked`, commits, exact
test counts, first failures/fixes, residual risks и подтверждение обоих handoff
docs. Не называй HF metadata доказательством `ollama pull`, `apps=ollama` —
подтверждением совместимости, отсутствие GGUF — сломанной моделью, отсутствие
metadata — unsupported, local fake tests — production validation, а Phase 2 —
завершённой.
