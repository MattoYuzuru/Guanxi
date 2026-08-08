# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-08

**Назначение:** Phase 2, slice P2-K — выбор exact GGUF file/revision и
size/license/fit preview

## Контекст

Работай в `/Users/m.ryabushkin/Projects/alamo-ui` на текущей ветке. Сначала
прочитай `AGENTS.md` и маршрут из `docs/NAVIGATION.md`; для code change обязательны
`PRODUCT.md`, `DOMAIN_MODEL.md`, `UX_IA.md`, `DEVELOPMENT.md`, `TESTING.md`, HLD
(раздел «Import GGUF из Hugging Face»), LLD (раздел «Hugging Face GGUF import»),
ADR-0003, **ADR-0006 (`decisions/0006-catalog-sources-and-compliance.md`)**,
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

P2-A–P2-J уже реализованы. P2-J code commits:

- `e544c7c` — strict versioned HF discovery contract (schemas + routes/bodies);
- `70d7cf9` — pure identity parser `hugging-face-reference.ts`;
- `fb19812`, `59a417b` — bounded transport `hugging-face-transport.ts` и GGUF
  support verdict;
- `1314d5b` — два read-only discovery route и AppContext wiring;
- `ec6b7e3`, `de951f6` — Marketplace Web секция и Chromium spec;
- `985db43`, `4b0d6bc` — NUL-byte cleanup и уточнение семантики `totalFiles`;
- review fixes: `2428475` (bounded published page, единая identity grammar,
  whole-token `rel="next"`, cursor validation), `2f13e31` (сохранение результатов
  при failed странице, retry ровно упавшего intent, dropped rows при empty,
  live region, `role="alert"` на контейнере, malformed vs absent metadata,
  formatted `observedAt`, license caveat, 44 px targets, копирайт без «срез»).

Подтверждённый baseline (перепроверен 2026-08-08): typecheck clean; core 446/446;
Web 144/144; mocked Chromium 26/26; build, markdownlint 31 files/0 issues и diff
check — всё зелёное. P2-J net new — 45 server / 27 Web / 1 Chromium.

Полный исторический ledger повторов хранится в `PHASE_STATUS.md` и здесь больше
не дублируется. Repeat-политика: повторяй 10× **только** новую P2-K group и те
файлы, которые твой diff реально задевает. Не повторяй по 10 раз всю
унаследованную цепочку P1-E…P2-J. Flaky результат фиксируй, диагностируй и только
потом переходи дальше.

## Уроки P2-J, которые сэкономят тебе время

- `npm test | grep` под memory pressure даёт exit 137 без вывода. Пиши вывод в
  файл (`npm test > /tmp/out.txt 2>&1`), потом читай файл. Это окружение, а не
  продукт;
- browser gate запускается только из корня или `packages/web`; прямой
  `npx playwright` из корня получает `Cannot navigate to invalid URL`;
- **Node type-stripping не поддерживает TypeScript parameter properties**
  (`constructor(readonly x: T)`) — объявляй поле явно, иначе `node --test` падает
  с `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` до запуска тестов;
- `HeadersInit` недоступен в server tsconfig lib; используй
  `Record<string, string>`;
- **любое новое поле в `AppContext` ломает шесть inherited fixtures**
  (`routes.test.ts`, `runtime-routes.test.ts`, `job-routes.test.ts`,
  `chat-job-execution.test.ts`, `chat-job-recovery.test.ts`,
  `inference-concurrency.test.ts`). Добавляй inert stub, который **бросает** при
  обращении: тогда unrelated flow, случайно дошедший до новой границы, падает
  громко, а не тихо делает работу;
- любая новая migration ломает inherited fixtures: version expectations и
  downgrade helpers в `migration.test.ts`, `job-migration.test.ts`,
  `observation-migration.test.ts`, `installed-evidence-migration.test.ts`,
  `completion-probe-migration.test.ts`, `capability-override-migration.test.ts`
  придётся обновить. Это не product regression, но зафиксируй как первый failure;
- `toBeDisabled` отсутствует в текущем matcher setup — используй `.disabled` плюс
  явную проверку инертности;
- **`Button` из `ui.tsx` при `loading` ставит `disabled`, браузер уводит
  фокус на `<body>`, и никто его не возвращает.** Это нашёл reviewer в P2-J.
  Если твой slice добавляет loading-кнопку, восстанавливай фокус явно и проверяй
  это assertion-ом, иначе клавиатурный пользователь теряет позицию на странице;
- **mutation-проверка обязательна и находит реальные дыры.** В P2-J она нашла
  недостижимый late-response guard (in-flight guard блокировал любой повторный
  submit, поэтому guard был мёртвым кодом) и два непокрытых свойства транспорта.
  Но «выживший» мутант не всегда дефект: два выживших в парсере оказались
  дублирующими defense-in-depth гейтами — проверяй, падает ли suite при удалении
  соседнего гейта, прежде чем писать новый тест;
- **проверяй `file` на новых файлах перед commit.** В P2-J два файла попали в
  историю с literal NUL bytes, git считал их binary и `git diff` не показывал
  содержимое. `python3 -c` со сканом байтов < 0x20 ловит это сразу;
- reviewer-субагент может создать файлы в worktree. Проверяй `git status` перед
  commit и явно запрещай reviewer-у писать в дерево (в P2-J оба reviewer-а
  требование выполнили);
- **table rows в markdown должны совпадать по ширине с header**, иначе
  markdownlint даёт `MD060/table-column-style`.

Owner session 2026-08-07 закрыла Q-25–Q-36 (см. `plans/OPEN_QUESTIONS.md`). Ни
один вопрос не блокирует slice. Что важно **для P2-K**:

- **Q-25 accepted: только exact GGUF file/revision.** Safetensors conversion и
  GGUF adapters вне scope и не обещаются;
- HF URL нельзя обещать как direct `ollama pull`. Полный pipeline — metadata →
  exact GGUF → download/checksum → local Ollama import → probe — разбит на
  P2-J..P2-M. **P2-J сделал первый шаг; P2-K делает только второй**;
- `apps=ollama` — hint, не доказательство;
- CI пока нет: все gates — твоя ответственность, включая browser gate;
- Открыт только Q-27a (`wrap up and report` как durable state) — Phase 5/8, к
  P2-K не относится.

## Current gap

P2-J публикует repository-level факты: identity, revision, gated/license state,
GGUF inventory (`files.ggufFiles` с `path`, `sizeBytes`, `sizeSource`) и вердикт
`supported | unsupported | unknown`. Но **выбрать конкретный файл нельзя**:
`requiresExactFileSelection: true` стоит на каждом вердикте, а UI прямо говорит,
что выбор файла — следующий шаг. Ни contract, ни server, ни Web не имеют понятия
«выбранный exact GGUF file + revision».

Кроме того, у P2-J нет size/fit preview: `sizeBytes` показывается как факт файла,
но не превращается в вердикт влезаемости, и `fitVerdictSchema` к HF файлам не
применяется. `dryRun` — 0 файлов в src.

## Цель P2-K

Пользователь выбирает **один exact GGUF file на одной exact revision** внутри
repository, который P2-J признал `supported`, и до любой загрузки видит truthful
preview: точный размер файла, вердикт влезаемости под выбранное окно контекста,
license/gated state и что именно ещё потребуется. Выбор — это **намерение**, а не
установка: P2-K ничего не скачивает и не импортирует.

## Обязательный scope

### Additive contract

- Добавь strict versioned contract выбора: repository identity (переиспользуй
  `huggingFaceRepositoryIdentitySchema`), **exact revision commit** (только
  `state: 'exact_commit'` — mutable branch не является выбираемой целью), exact
  file path из опубликованного inventory, размер и его source.
- Selection валидна только если file реально присутствует в inventory этой
  revision. Файл «по имени», файл из другой revision, файл из truncated listing и
  файл из repository с вердиктом `unsupported`/`unknown` — fail-closed.
- Fit preview: переиспользуй `fitVerdictSchema` и существующий расчёт, но
  `basis` обязан честно отражать, что считалось по **заявленному размеру файла**,
  а не по загруженной модели. Если размер `not_reported` — вердикт `unknown` с
  reason, а не оптимистичная оценка.
- Не смешивай HF selection с P2-E catalog variants и P2-A installed descriptor.

### Server

- Selection и preview считает server, из тех же bounded transport данных.
  Не добавляй второй outbound путь и не расширяй HF доступ: token/gated
  acceptance по-прежнему **вне scope**.
- Если для проверки файла нужен повторный Hub read — он bounded теми же
  правилами (timeout, byte cap, AbortSignal, redacted failures) и не превращается
  в download.
- Selection не запускает pull/create/probe/load/unload, Governor admission,
  catalog refresh или background Job.
- Persist только если докажешь необходимость. Если добавляешь migration 10 — она
  append-only, без backfill, с fresh/v9→v10/reopen/failed/rollback tests.

### Web

- Внутри HF секции: выбор файла из опубликованного inventory (не текстовый ввод
  пути), показ точного размера, fit вердикта под текущее окно, license/gated и
  явного «что дальше».
- Никакой кнопки Download/Install/Pull: загрузка — P2-L. Скажи прямо, что выбран
  только target и что скачивание пока недоступно.
- `unsupported`/`unknown` repository не даёт выбрать файл вообще.
- Selection требует explicit action, bounded debounce не нужен (данные уже есть),
  но late-response guard нужен, если делаешь server round-trip.
- Все новые strings через locale keys: English source/fallback и curated Russian.
  **Не используй внутренние слова «срез»/«slice» в пользовательском тексте.**
- Keyboard/screen reader, focus containment и restore для любого нового
  dialog/disclosure, 390 px, 200%, no horizontal overflow, reduced motion,
  **44 px touch targets** (в P2-J это был reviewer finding).

## Failure matrix и тесты

Минимальные deterministic cases:

- selection valid только для файла, присутствующего в inventory этой exact
  revision; чужой путь, traversal-подобный путь, файл из другой revision, файл из
  truncated listing, файл из `unsupported`/`unknown` repository — fail-closed;
- mutable branch вместо exact commit — fail-closed;
- **`rfilename` из провайдера не валидируется по форме в P2-J** — reviewer это
  зафиксировал как risk. В P2-K добавь bound/валидацию формы пути, потому что
  P2-L будет качать именно по нему. Покрой hostile path (traversal, absolute,
  очень длинный, с control characters);
- size `not_reported` → fit `unknown` с reason, не оптимистичная оценка;
- fit пересчитывается при смене окна контекста и честно помечен как расчёт по
  заявленному размеру;
- gated/license не превращают selection в разрешение на скачивание;
- strict query/response contract, legacy-safe additive defaults, unknown/future
  enum, extra field;
- отсутствие pull/create/probe/prewarm/load/unload/catalog fetch/Governor action;
- Web: no request на mount/hover/focus/navigation/reload; selection не даёт
  Download; double activation — один intent; late response игнорируется;
- English/Russian, keyboard/focus/Escape, 390 px, 200%, overflow, reduced motion,
  44 px targets;
- HF selection не попадает в installed list и не меняет P2-A descriptor или
  P2-E catalog rows.

Не используй live HF network, live Ollama, GPU в обязательных tests. Fake HTTP
transport, recorded safe fixtures и mocked browser routes должны доказать
boundaries. Если добавишь live-network integration test — только за explicit
opt-in envelope, вне default `npm test`.

## Не входит в P2-K

- download, checksum, provenance, resume, disk reservation — это P2-L;
- local Ollama import через `/api/create` и probe — это P2-M;
- token/authenticated download, gated acceptance flow;
- safetensors conversion, GGUF adapters, quantization на стороне приложения;
- feature flags и estimated parallel-admission — это P2-N/P2-O;
- full Capability Registry, OperationResolution/Task Adapter wiring;
- HTML scraping HF или Ollama, live catalog provider для существующего
  Marketplace list;
- persistent HF cache/history, saved searches, recommendations, ranking;
- bounded concurrency для HF (известный residual risk P2-J) — реши отдельно, если
  докажешь необходимость, но не выдавай за scope P2-K;
- NVIDIA calibration, NVML/MIG, scheduler/parallelism.

## Проверка

Сначала зафиксируй clean inherited baseline. После implementation выполни как
минимум:

```bash
npm run typecheck
node --test packages/server/test/hugging-face-reference.test.ts \
  packages/server/test/hugging-face-transport.test.ts \
  packages/server/test/hugging-face-routes.test.ts
node --test packages/server/test/capability-override-contract.test.ts \
  packages/server/test/capability-override-routes.test.ts
node --test packages/server/test/ollama-reference.test.ts \
  packages/server/test/ollama-reference-contract.test.ts \
  packages/server/test/ollama-reference-routes.test.ts
node --test packages/server/test/catalog-pagination.test.ts \
  packages/server/test/catalog-facets.test.ts \
  packages/server/test/catalog-variant-contract.test.ts
node --test packages/server/test/migration.test.ts \
  packages/server/test/model-descriptor.test.ts \
  packages/server/test/fit.test.ts
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

Добавь exact P2-K contract/server/Web/Chromium commands. Повтори 10× только новую
P2-K group и файлы, реально затронутые твоим diff, с exit/count checking. Первый
failing/flaky result сохрани, диагностируй и исправь; повторный green не скрывает
первую ошибку. Не запускай десятки Node/Vitest processes одновременно — под
memory pressure Vitest даёт exit 137 без вывода.

## Completion и handoff

После bounded slice:

- **вызови reviewer-субагента** (`sde-agent:implementation-reviewer` для
  contract/server, `frontend-agent:accessibility-reviewer` для Web; при желании
  `sre-agent:test-actor` для path-валидации), передай ему точный diff и
  заявленные свойства, исправь findings отдельным `fix(...)`/`test(...)` commit и
  запусти browser gate после фикса. Явно запрети reviewer-у создавать файлы в
  worktree;
- проверь, что каждое заявленное свойство имеет падающий assertion, и подтверди
  это мутацией исходника, а не только зелёным прогоном;
- согласованно обнови contract, server, Web, locale, tests и current-state docs
  (в P2-J потребовались правки `HLD.md`, `LLD.md`, `UX_IA.md` и счётчика browser
  тестов в `AGENTS.md`);
- обнови таблицу «Phase 2 — что реально осталось» в `PHASE_STATUS.md`;
- запиши counts как `N new / M envelope`, не смешивая regression envelope с новой
  работой;
- добавь P2-K evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A–P2-J;
- обнови статус P2-K в таблице «Планируемая последовательность Phase 2»;
- Phase 2 оставь `in progress`: выбор файла не закрывает P2-L/P2-M, flag infra
  (P2-N/P2-O) или ROADMAP exit gate;
- полностью перепиши этот файл под **P2-L — download с checksum/provenance,
  bounded и cancel-safe**: это следующий slice цепочки. Если P2-K заблокирован,
  оставь файл на P2-K с blocker и recovery steps;
- используй небольшие conventional commits и не включай `.idea/`.

В финале сообщи ровно `status successful` либо `status blocked`, commits, exact
test counts, first failures/fixes, residual risks и подтверждение обоих handoff
docs. Не называй HF metadata доказательством `ollama pull`, `apps=ollama` —
подтверждением совместимости, заявленный размер файла — измеренным fit, selection
— установкой, local fake tests — production validation, а Phase 2 — завершённой.
