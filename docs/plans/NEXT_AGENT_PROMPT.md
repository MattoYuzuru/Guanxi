# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-04

**Назначение:** Phase 2, slice P2-F — truthful faceted search и pairwise variant compare

## Контекст

Работай в `/Users/m.ryabushkin/Projects/alamo-ui` на текущей ветке. Сначала
прочитай `AGENTS.md` и маршрут из `docs/NAVIGATION.md`; для code change обязательны
`PRODUCT.md`, `DOMAIN_MODEL.md`, `DEVELOPMENT.md`, `TESTING.md`, HLD, LLD,
`architecture/RUNTIME_LIFECYCLE.md`, связанные ADR, `plans/PHASE_STATUS.md`,
`plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted owner decisions.

Не считай target/proposed уже реализованным. Код определяет current behavior,
accepted ADR/decision — целевую границу, ROADMAP — порядок перехода. Не трогай
`.idea/`, пользовательские данные, real Ollama model store, `node_modules`,
generated outputs или unrelated worktree changes.

P2-A–P2-E уже реализованы:

- `d750a3e`..`282c82e` — installed descriptor и truthful provider evidence;
- `a1ead74`, `597c130`, `c22c435` — migration 7 и persistent exact provider cache;
- `ce9ef4b`, `c48799a`, `d1c3c38` — migration 8 и explicit completion probe;
- `21c0404`, `3d129d2`, `0d9aaa6` — strict Add from Ollama preview/confirmed
  connection-owned pull;
- `56b802b`, `2959b98` — exact catalog targets, per-variant fit/installation и
  variant-first selection/confirmation/pull/Installed refresh.

Подтверждённый current baseline: typecheck; P2-E exact server 12/12; P2-D 20/20;
P2-C 34/34; P2-B 17/17; P2-A 9/9; P1-L+M 32/32; P1-K 37/37; core 320/320;
Web 75/75; mocked Chromium 20/20; build, markdownlint и diff check. Repeats:
P2-E server 10×12/12, targeted Web 10×10/10, affected Web 10×75/75, P2-D
10×20/20, P2-C 10×34/34, P2-B 10×17/17, P2-A 10×9/9, P1-L+M
10×32/32, P1-K 10×37/37, P1-J 10×11/11, P1-I 10×3/3 и P1-E
10×8/8.

Q-26 resolved: manual Add from Ollama принимает strict name или official page
URL. Q-25 остаётся открытым и блокирует первый Hugging Face slice. Не начинай HF
API/download/import, не выбирай formats и не закрывай Q-25 молча.

## Current gap

Marketplace имеет только text query по name/description. P2-E показывает exact
variants, но пользователь не может truthfully сузить catalog по fit выбранного
варианта, installation, local/cloud, source/freshness, claimed context/size или
claimed capability. Нельзя выбрать две exact rows и сопоставить их facts рядом.

Top-level `CatalogModel.fit` и `installed` остаются compatibility projections.
Если фильтровать их напрямую, комбинация `installed + green` может ошибочно
сопоставить installed tag A с green tag B. Отсутствующая capability metadata не
равна unsupported. License, quantization, task/operation и immutable revision в
current catalog contract отсутствуют; name/tag heuristics не создают эти facts.

P2-F должен сделать честный bounded subset MOD-004 и compare без remote provider,
новой persistence или import lifecycle. Это не полный Catalog Service, не
virtualization/pagination для 10k rows и не весь Phase 2 exit gate.

## Цель P2-F

Добавь серверные facets по доступным current facts и pairwise compare двух exact
catalog variants. Пользователь должен понимать, какой exact variant удовлетворил
всем variant-level filters, какие значения claimed/unknown, и сравнить две rows
без winner/recommendation или side effect.

## Обязательный scope

### Contract и query semantics

- Additive расширь strict `listCatalogQuery`; старые `q/contextLength` requests и
  response shapes сохраняются. Не удаляй/не переименовывай public keys.
- Введи typed filters только для доступных facts:
  - exact variant installation: `installed | not_installed | unknown`;
  - per-variant fit: `green | yellow | red | unknown`;
  - provider scope: `local | cloud`;
  - source: `local_cache | bundled | remote` с future-compatible response policy;
  - freshness: `fresh | stale | fallback | unknown`;
  - claimed capability или explicit `unknown`, не `unsupported`;
  - minimum claimed context и maximum claimed artifact size как positive safe
    integers без arbitrary UI/server ceiling.
- Определи repeat/multi-select encoding однозначно и детерминированно. Unknown
  query keys/future command enums fail closed; legacy requests получают no-filter
  defaults.
- Text query остаётся case-insensitive name/description search. Не ищи и не
  фильтруй private paths/provider raw content.
- Все variant-level predicates должны совпасть на одной exact valid variant row.
  Нельзя удовлетворить `installed` через A, `green` через B, а size/context через C.
- Model-level local/cloud, source/freshness и claimed capabilities применяются
  отдельно и объясняются. Empty capabilities остаются unknown, не unsupported.
- Не вводи filter по license, quantization, task/modality, immutable digest или
  runtime-verified capability, пока соответствующего fact нет в contract.
- Если нужен additive match projection, он должен перечислять exact normalized
  matching targets/reasons без превращения legacy aggregate в evidence.

### Server/catalog

- Filtering остаётся server-owned поверх current validated local recommendations
  cache и dated bundled snapshot. Никакого Ollama human catalog scrape, remote
  catalog request или arbitrary URL fetch.
- Сначала построй и провалидируй P2-E exact variants, затем применяй same-row
  predicates. Malformed/duplicate target не становится удобным result.
- Unknown size/context/fit/installation участвует только в explicit unknown
  filter; он не становится zero, false, green или unsupported.
- Exact installed state продолжает приходить только из sampled `/api/tags`.
  Provider failure сохраняет unknown filter semantics и не подменяется legacy
  family aggregate.
- Source/freshness/observed/fetched provenance сохраняется в filtered response и
  compare facts. Не обновляй source timestamp от filtering/access.
- Combined facets используют AND между группами и документированную OR semantics
  внутри multi-select группы. Empty selection означает filter absent.
- Добавь controlled 400 для invalid numeric/enum/query shapes и safe error без raw
  cache/provider content.
- Не добавляй DB migration, remote cache, saved filters, pagination, background
  refresh или persistent comparison в этом slice.

### Web filters

- Сохрани существующий search input и добавь accessible filter disclosure/sheet,
  подходящий desktop и 390 px. Applied filters имеют видимый summary/chips и один
  clear-all action.
- Покажи только доступные facets и честные labels: claimed context/artifact size,
  catalog capability claim, selected-context fit, sampled installation,
  source/freshness. Не называй size memory requirement или fit measured.
- Unknown доступен как явный выбор там, где факт может отсутствовать. Отсутствие
  capability metadata не рисуется как unsupported.
- Query dispatch debounced/bounded, previous request abortable; late response не
  перезаписывает более новый filter state. Reload/navigation не запускает pull,
  probe, prewarm/load или provider fetch.
- Loading, empty-result, source unavailable, validation/transport error и retry
  различимы. Empty result показывает applied summary и clear action.
- Search, filters и clear вызывают catalog query, но никогда P2-D start либо
  manual Add preview. Installed cards/profile/P2-C probe/P2-D/P2-E install
  продолжают работать.
- Все новые strings проходят locale keys: English source/fallback и curated
  Russian. Не добавляй bilingual hardcode в component.

### Pairwise exact variant compare

- Compare — pairwise flow ровно двух explicit exact valid variant rows. Это
  bounded layout/action, не limit модели/runtime/hardware.
- Add/remove selection не запускает pull. Duplicate exact target нельзя выбрать
  дважды; invalid/non-installable legacy row нельзя добавить.
- Compare view показывает рядом: exact target/tag, claimed size/parameters/
  context, per-variant fit+basis, source/freshness/observed/fetched и exact sampled
  installation/digest либо unknown reason.
- Не показывай winner, score, quality, recommended, supported capability,
  quantization или license без evidence. Mutable tag и catalog-claim boundary
  видимы.
- Selection survives ordinary filtering only while the exact target still exists
  in the latest valid response; vanished/changed target is removed with visible
  explanation, не silently rebound по family/tag index.
- Dialog/sheet имеет semantic heading/description, predictable focus,
  containment/restore, Escape/back без side effect, keyboard remove/swap и
  accessible names. На 390 px/200% comparison stacks или scrolls внутри одного
  controlled region без page horizontal overflow; reduced motion соблюдается.

## Failure matrix и тесты

Минимальные deterministic cases:

- legacy query/response round-trip, additive defaults и strict unknown fields;
- valid multi-select encoding, positive-safe integer boundaries и invalid 400;
- text query вместе с facets; AND across groups, OR within group;
- same-row invariant: installed A + green B не даёт ложного match;
- exact installed/not-installed/unknown и соседний tag isolation;
- green/yellow/red/unknown fit, unknown size/context без zero/default;
- local/cloud, local-cache/bundled/future response source, stale/fallback/unknown;
- claimed capability positive и absent metadata as unknown, never unsupported;
- provenance/timestamps preserved through filter/match/compare;
- malformed/duplicate exact variants fail closed;
- filter change abort/late-response race, loading/empty/error/retry/clear;
- no pull/probe/prewarm/load/remote fetch on mount/search/filter/compare/reload;
- pair exact A/B selection, duplicate/invalid rejection, remove/swap/vanish;
- compare facts use exact rows and never legacy top-level fit/installed;
- English fallback/Russian, keyboard/focus, 390 px, 200%, overflow и reduced motion;
- manual Add from Ollama, P2-E install, Installed profile/P2-C probe, current
  cards/carousel/context input remain regression-covered.

Не используй live model/real Ollama store. Fake transport проверяет exact query,
AbortSignal и отсутствие mutating endpoints. Если добавляешь race/concurrency
behavior, повтори новый group 10 раз последовательно с exit-status checking; не
запускай десятки Node/Vitest processes одновременно.

## Не входит в P2-F

- Hugging Face API/search/download, GGUF revision/checksum/license/gated flow;
- Ollama remote catalog, scrape или remote HTML parsing;
- durable/resumable import Job, cache/staging, disk reservation/checksum;
- saved filters/recent catalog, pagination/virtualization/load benchmark;
- inferred quantization/license/task/modality/quality/recommendation;
- immutable tag resolution, registry history или generic Capability Registry;
- semantic/tool/thinking/vision/embedding/media probes и user override;
- delete/import-from-file, Modelfile editor, conversion или adapters;
- Linux/NVIDIA telemetry, measured parallel, Project/Agent/MCP/Skills, service
  lifecycle, retention или rebrand.

## Проверка

Сначала зафиксируй clean inherited baseline. После implementation выполни как
минимум:

```bash
npm run typecheck
node --test packages/server/test/catalog-variant-contract.test.ts \
  packages/server/test/catalog.test.ts \
  packages/server/test/model-descriptor.test.ts \
  packages/server/test/fit.test.ts
node --test packages/server/test/ollama-reference-contract.test.ts \
  packages/server/test/ollama-reference-routes.test.ts \
  packages/server/test/ollama-reference.test.ts \
  packages/server/test/ollama-client.test.ts
node --test packages/server/test/completion-probe-contract.test.ts \
  packages/server/test/completion-probe-migration.test.ts \
  packages/server/test/completion-probe-store.test.ts \
  packages/server/test/completion-probe.test.ts \
  packages/server/test/completion-probe-routes.test.ts \
  packages/server/test/ollama-client.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Добавь exact P2-F contract/server/Web commands. Повтори новый P2-F group,
affected Web, P2-E server/Web, P2-D server, P2-C, P2-B, P2-A, P1-L+M, P1-K,
P1-J, P1-I и P1-E по 10 раз последовательно. Первый failing/flaky result сохрани,
диагностируй и исправь; повторный green не скрывает первую ошибку.

## Completion и handoff

После bounded slice:

- согласованно обнови contract, server, Web, tests и current-state docs;
- добавь P2-F evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A–P2-E;
- Phase 2 оставь `in progress`, пока весь ROADMAP exit gate не доказан;
- Q-25 оставь открытым; HF slice остаётся blocked до explicit owner decision;
- полностью перепиши этот файл под следующий незавершённый non-blocked Phase 2
  slice, вероятно Linux/NVIDIA truthful telemetry prototype либо отдельно
  обоснованный catalog scale/pagination slice;
- используй небольшие conventional commits и не включай `.idea/`.

В финале сообщи ровно `status successful` либо `status blocked`, commits, exact
test counts, first failures/fixes, residual risks и подтверждение обоих handoff
docs. Если combined facets нельзя связать с одной exact variant row, fail closed;
не возвращайся к family-level aggregate filtering.
