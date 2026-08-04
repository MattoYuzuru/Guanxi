# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-04

**Назначение:** Phase 2, slice P2-H — catalog scale, explicit server pagination
и bounded Marketplace rendering

## Контекст

Работай в `/Users/m.ryabushkin/Projects/alamo-ui` на текущей ветке. Сначала
прочитай `AGENTS.md` и маршрут из `docs/NAVIGATION.md`; для code change обязательны
`PRODUCT.md`, `DOMAIN_MODEL.md`, `UX_IA.md`, `DEVELOPMENT.md`, `TESTING.md`, HLD,
LLD, `architecture/RUNTIME_LIFECYCLE.md`, ADR-0002, `plans/PHASE_STATUS.md`,
`plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted owner decisions. Не
создавай subagents и не делегируй работу.

Не считай target/proposed реализованным. Код определяет current behavior,
accepted ADR/decision — целевую границу, ROADMAP — порядок перехода. Не трогай
`.idea/`, пользовательские данные, real Ollama model store, `node_modules`,
generated outputs или unrelated worktree changes.

P2-A–P2-G уже реализованы. Последние commits P2-G:

- `a4a3ead` — additive NVIDIA contract, fixed adapter и parser;
- `3f1a533` — localized per-device Runtime Bar projection;
- `6ceae50` — strict failure-provenance fixtures.

Подтверждённый current baseline: typecheck; P2-G server/identity 38/38;
P2-F server 10/10; P2-E server 12/12; P1-L+M с Linux unknown case 33/33;
P1-H fit/telemetry 25/25; core 339/339; Web 88/88; mocked Chromium 22/22;
build, markdownlint и diff check. Repeats: P2-G server 10×38/38, targeted Web
10×20/20, Chromium 10×1/1, affected Web 10×88/88, P2-F server/Web
10×10/10 и 10×8/8, P2-E server/Web 10×12/12 и 10×10/10, P1-H
10×25/25, P1-L+M 10×33/33, P1-K 10×37/37, P1-J 10×11/11, P1-I
10×3/3 и P1-E 10×8/8.

Q-25 остаётся открытым и блокирует первый Hugging Face slice. Не начинай HF
API/download/import, не выбирай formats и не закрывай Q-25 молча. P2-G —
prototype, а не full NVIDIA calibration; не расширяй этот slice до NVML,
MIG/topology, scheduler или второго Governor permit.

## Current gap

`GET /api/models/catalog` сейчас возвращает весь filtered local/bundled catalog.
Web превращает все rows в один `ModelCarousel`, а `ModelCarousel` создаёт slide и
dot для каждой model. Это приемлемо для текущего маленького bundled fixture, но
противоречит accepted UX для сотен моделей и не имеет catalog-scale evidence.

P2-F filters применяются server-side и fail-closed, но response не сообщает
total matching/page boundary. Header использует `models.length`, поэтому после
pagination нельзя молча назвать page length полным count. Compare хранит targets
только относительно текущего response и сейчас удаляет selection как vanished,
если row исчезла из массива; при page navigation это было бы ложным исчезновением.

Legacy clients ожидают отсутствие pagination query и полный `models` array.
Нельзя молча превратить прежний запрос в first page. При этом новый Web должен
explicitly использовать paged mode, не рендерить сотни slides/dots и не вводить
total catalog ceiling. Per-page safety bound допустим только как именованная,
объяснимая application/render policy, а не hidden product limit.

## Цель P2-H

Для catalog с сотнями и тысячами deterministic rows server возвращает stable
explicit pages после P2-F filtering, а Marketplace рендерит только одну bounded
page и accessible bounded pager. Пользователь видит exact total/page state,
может сравнить две exact variants с разных pages и не теряет truthful source,
installation/fit или active-pull semantics.

## Обязательный scope

### Capacity evidence до выбора policy

- Сначала измерь current pure catalog projection и Web DOM на synthetic catalog
  минимум 1,000 models с multiple variants. Зафиксируй response bytes, model/
  variant count, elapsed time как diagnostic evidence и число rendered slides/
  pager controls; timing не делай хрупким CI assertion.
- На основании evidence выбери небольшой default Web page size и explicit server
  maximum page size. Документируй constants и basis. Maximum ограничивает только
  одну response/render page, не total matching catalog и не число provider rows.
- Не добавляй arbitrary total models/variants ceiling, silent truncation или
  carousel dots/buttons пропорционально общему total.

### Additive contract и server pagination

- Расширь `ListCatalogQuery` explicit paged mode. Предпочтительная совместимая
  форма: positive safe-integer `page` + `pageSize`; repeated/unknown/fractional/
  non-positive/unsafe/over-policy values дают controlled 400 до source/Ollama.
  Не clamp-ь silently и не принимай ambiguous partially specified mode.
- Запрос без pagination keys сохраняет legacy full-list behavior и response
  semantics. Новый Web всегда отправляет explicit page/pageSize. Старый client
  может игнорировать additive metadata и по-прежнему получить полный list.
- Additive response metadata минимум различает paged/legacy mode, requested
  page, applied page size, exact `totalItems`, exact `totalPages`, previous/next.
  Zero results и page за текущим last page имеют explicit deterministic policy;
  не подменяй requested page молча.
- Filtering/search/normalization выполняются до count/page slice. P2-E exact
  variants и P2-F same-row AND/OR semantics, provenance, source times,
  installation и fit не меняются. Count относится к returned model rows после
  всех filters, не к variants и не к unfiltered source.
- Ordering должен быть deterministic с documented stable tie-breaker, чтобы один
  неизменный source/query snapshot не давал duplicate/omitted rows между pages.
  Не используй locale-sensitive или random ordering. Duplicate canonical
  identity остаётся fail-closed по текущей policy.
- Один request читает разрешённый local/bundled source не более одного раза и
  делает не более одного bounded `/api/tags` sample. Pagination не создаёт remote
  provider, cache history, background prefetch или multiple concurrent page
  fan-out. Caller AbortSignal и safe source failures сохраняются.
- Page-size bound и pagination metadata должны быть видимы в contract/docs/tests;
  это transport/render policy, не capability, hardware fact или safe universal
  catalog size.

### Marketplace Web

- Catalog query хранит explicit page state и сбрасывается на page 1 при accepted
  search/filter/context changes. Late response старой page/query не заменяет
  current state; один request/AbortSignal ownership сохраняется.
- Header показывает exact total matching из metadata, отдельно от number on
  current page. Loading, filtered empty, source unavailable, page-empty-after-
  source-change и retry остаются различимыми.
- Рендери только current page. Pager имеет bounded число controls независимо от
  total pages: Previous/Next и current/total достаточно; если добавляешь
  First/Last или nearby pages, control count остаётся constant. Не создавай dot
  на каждую model или page.
- Pager доступен с keyboard и screen reader, объявляет current page/total,
  disabled boundaries и loading. Page change сохраняет predictable focus без
  scroll/focus steal. На 390 px и 200% нет horizontal overflow; reduced motion
  не теряется.
- P2-F compare должен хранить не более двух exact selected row snapshots вне
  current page, чтобы A на page 1 и B на page N сравнивались без hidden refetch.
  Page navigation не означает `vanished`. Query/filter/context/source refresh,
  который действительно invalidates snapshot basis, очищает/revalidates selection
  с явным localized notice. Duplicate exact target и stale late response
  fail-closed.
- Active P2-D/P2-E pull нельзя silently отменить простым page change. Либо
  удерживай connection-owned operation вне page subtree, либо блокируй pager на
  время exact active pull с accessible localized explanation. Не запускай второй
  pull, probe, prewarm/load или Installed refresh из pagination.
- Все новые strings идут через locale keys: English source/fallback и curated
  Russian. Не добавляй bilingual hardcode в component.

### Benchmark и observability

- Добавь deterministic large synthetic fixture, доказывающий отсутствие total
  ceiling, exact totals/pages, stable first/middle/last/out-of-range pages и
  response length не больше requested policy page size.
- Добавь reproducible non-live benchmark command либо отдельно документированную
  test invocation. Сохрани measured fixture size, output bytes и local elapsed
  time как local evidence без заявления production SLA.
- Browser fixture должна содержать сотни logical catalog rows, но отдавать их
  page-by-page; assertion проверяет bounded rendered cards/slides и bounded pager
  controls, а не materializes весь dataset в DOM.

## Failure matrix и тесты

Минимальные deterministic cases:

- legacy query/response round-trip без pagination metadata fabrication;
- first/middle/last/empty/out-of-range page, one-page и exact page boundary;
- page/pageSize missing pair, zero, negative, fractional, unsafe, over-policy,
  duplicate и unknown keys rejected before source/tags access;
- 1,000+ models, multiple variants, stable ordering, no duplicate/omitted model
  across pages for unchanged source/query;
- text + every P2-F facet combination counts/slices after exact same-row filter;
- unavailable/stale/bundled source, installed tags unavailable, AbortSignal и
  source shrink between requests without optimistic count;
- page change aborts/ignores late old response and starts no resource action;
- query/filter/context change resets page and handles compare invalidation;
- compare exact A/B across different pages, duplicate/third/remove/swap/focus;
- active pull page boundary has explicit no-silent-cancel behavior;
- English/Russian, keyboard, screen reader, 390 px, 200%, no overflow and
  reduced motion;
- no total-proportional slides, dots, page buttons, retained listeners or
  background prefetch.

Не используй live Ollama/GPU/network в обязательных tests. Synthetic catalog,
fake tags и mocked browser routes должны доказать boundaries. Non-gating local
profiling не заменяет deterministic assertions.

## Не входит в P2-H

- remote catalog provider, live scrape, stale-while-revalidate или provider auth;
- Hugging Face API/import, GGUF format/revision/license/checksum и Q-25 decision;
- saved filters, URL persistence, inferred task/license/quantization facts;
- infinite scroll, speculative prefetch, full generic virtualization framework;
- installed-model carousel redesign, long Chat windowing или icon pagination;
- durable pull/resume, disk reservation, immutable tag resolution или recent list;
- NVIDIA calibration, NVML/MIG, `/api/ps` device binding, scheduler/parallelism;
- DB migration или durable catalog/search history.

## Проверка

Сначала зафиксируй clean inherited baseline. После implementation выполни как
минимум:

```bash
npm run typecheck
node --test packages/server/test/catalog-facets-contract.test.ts \
  packages/server/test/catalog-facets.test.ts
node --test packages/server/test/catalog-variant-contract.test.ts \
  packages/server/test/catalog.test.ts
node --test packages/server/test/host-telemetry.test.ts \
  packages/server/test/runtime-contract.test.ts \
  packages/server/test/runtime-reconciliation.test.ts \
  packages/server/test/observation-key.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Добавь exact P2-H contract/server/Web/Chromium и benchmark commands. Повтори
новый P2-H group, affected Web, P2-F server/Web, P2-E server/Web, P2-G
server/Web/Chromium, P1-L+M, P1-K, P1-J, P1-I и P1-E по 10 раз последовательно
с exit/count checking. Первый failing/flaky result сохрани, диагностируй и
исправь; повторный green не скрывает первую ошибку. Не запускай десятки Node/
Vitest processes одновременно.

## Completion и handoff

После bounded slice:

- согласованно обнови contract, server catalog/route, Web query/render/compare,
  tests и current-state docs;
- добавь P2-H evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A–P2-G;
- Phase 2 оставь `in progress`: pagination не закрывает HF/Q-25, verified Linux
  tier, full Capability Registry или весь ROADMAP exit gate;
- Q-25 оставь открытым; HF slice остаётся blocked до explicit owner decision;
- полностью перепиши этот файл под следующий незавершённый non-blocked Phase 2
  slice либо оставь P2-H с blocker/recovery steps;
- используй небольшие conventional commits и не включай `.idea/`.

В финале сообщи ровно `status successful` либо `status blocked`, commits, exact
test/benchmark counts, first failures/fixes, residual risks и подтверждение обоих
handoff docs. Не называй page-size policy total catalog limit, benchmark —
production SLA, а current local/bundled rows — complete provider catalog.
