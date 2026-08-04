# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-04

**Назначение:** Phase 2, slice P2-I — exact installed capability user override
foundation

## Контекст

Работай в `/Users/m.ryabushkin/Projects/alamo-ui` на текущей ветке. Сначала
прочитай `AGENTS.md` и маршрут из `docs/NAVIGATION.md`; для code change обязательны
`PRODUCT.md`, `DOMAIN_MODEL.md`, `UX_IA.md`, `DEVELOPMENT.md`, `TESTING.md`, HLD,
LLD, `architecture/RUNTIME_LIFECYCLE.md`, ADR-0003,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decisions. Не создавай subagents и не делегируй работу.

Не считай target/proposed реализованным. Код определяет current behavior,
accepted ADR/decision — целевую границу, ROADMAP — порядок перехода. Не трогай
`.idea/`, пользовательские данные, real Ollama model store, `node_modules`,
generated outputs или unrelated worktree changes.

P2-A–P2-H уже реализованы. P2-H code commits:

- `3c4960d` — additive legacy/paged catalog contract и deterministic server
  count/order/slice;
- `cc40d14` — bounded Marketplace pages, cross-page compare и benchmark.

Подтверждённый P2-H baseline: typecheck; P2-H server 10/10; targeted Web 25/25;
P2-H Chromium 1/1; P2-G server 38/38; core 349/349; Web 95/95; mocked Chromium
23/23; build, markdownlint и diff check. Repeats: P2-H server/Web/Chromium
10×10/10, 10×7/7, 10×1/1; affected Web 10×95/95; P2-F server/Web
10×10/10 и 10×8/8; P2-E server/Web 10×12/12 и 10×10/10; P2-G
server/Web/Chromium 10×38/38, 10×20/20 и 10×1/1; P1-H 10×25/25;
P1-L+M 10×33/33; P1-K 10×37/37; P1-J 10×11/11; P1-I 10×3/3;
P1-E 10×8/8.

Catalog diagnostic использует synthetic 1,000 models/4,000 variants: legacy
server response 3,768,624 bytes/10.537 ms, page 12 — 45,513 bytes/4.759 ms;
legacy jsdom 1,000 slides + 1,000 dots/215.759 ms, bounded page — 12 slides +
12 dots + 2 pager buttons/6.222 ms. Это local diagnostic, не production SLA.

Q-25 остаётся открытым и блокирует первый Hugging Face slice. Не начинай HF
API/download/import, не выбирай formats и не закрывай Q-25 молча. P2-G остаётся
prototype, а P2-H — local/bundled response pagination, не remote provider.

## Current gap

P2-A/P2-B descriptor сохраняет только provider evidence
`declared | degraded | unknown`; P2-C completion probe хранится и показывается
отдельно. Accepted `MOD-008`, DOMAIN_MODEL и ADR-0003 требуют, чтобы user override
был видимым, экспортируемым и никогда не выдавался за automatic/provider/runtime
fact. Current contract, SQLite, server и Web такого override не имеют.

Полный Capability Registry/resolver ещё не реализован. Поэтому P2-I не должен
решать precedence всех provider/probe/model-card claims, автоматически включать
Task Adapter или вводить negative `unsupported` semantics. Без explicit positive
override capability остаётся в прежнем declared/degraded/unknown состоянии.

## Цель P2-I

Пользователь на Installed profile может явно добавить или удалить positive
capability assertion для exact installed Ollama reference + digest + sourced
runtime version. Assertion переживает restart, показывается отдельно от provider
declarations/probe, экспортируется как safe typed JSON и никогда не наследуется
другим digest/runtime либо Marketplace row.

## Обязательный scope

### Additive contract и identity

- Добавь strict versioned `ModelCapabilityOverride` с literal source
  `user_override`, state `overridden`, positive value `present`, одной capability
  из current closed enum, canonical Ollama reference, exact artifact digest,
  sourced Ollama runtime version, `createdAt` и `updatedAt`.
- Добавь strict write/clear route contracts и additive descriptor projection,
  например `overrides: []` с legacy default. Старые descriptor responses и clients
  должны parse-иться без fabricated override.
- Unknown/future enum, extra field, malformed reference/digest/runtime/timestamp
  fail-closed. Отсутствие row не означает `unsupported`; negative override и
  free-form capability не вводи в этом slice.
- Provider `capabilities` evidence и completion-probe evidence не переписывай и
  не объединяй с override. UI может показать explicit user assertion рядом, но
  source/state всегда остаются видимыми.

### Append-only persistence

- Добавь migration 9, не переписывая migrations 1–8. Храни по одной latest row
  на exact `(provider, canonical reference, digest, runtime version, capability)`.
  Повторный identical write идемпотентен и не меняет timestamps; clear удаляет
  только exact row.
- Fresh DB, v8→v9, reopen, interrupted/conflicting migration и rollback/read
  compatibility должны иметь deterministic tests. Старый code может игнорировать
  table; schema rollback не удаляет user data.
- Не делай backfill из provider declaration/probe. Не сохраняй prompt/response,
  reasoning, endpoint, credentials, paths, raw provider body или arbitrary note.
- Store обязан fail-closed читать malformed/incompatible rows, возвращать stable
  deterministic order и безопасно работать через существующую SQLite boundary.

### Server ownership и TOCTOU

- Write/clear доступны только для current Installed model с одним canonical
  `/api/tags` match, exact expected digest и sourced local `/api/version`.
  Duplicate/missing/changed identity, unavailable runtime version и stale client
  expectation дают controlled conflict/unknown, а не запись по имени.
- Revalidate exact identity в точке mutation. Не наследуй override после same-name
  digest replacement или runtime-version change; старую row можно сохранить как
  non-active data, но current descriptor её не показывает.
- Descriptor read добавляет только exact compatible overrides. Provider failure
  не должен маскироваться старой override как current installation truth.
- Передавай caller AbortSignal и используй typed safe errors/redaction. Mutation
  не запускает Ollama chat/pull/load/unload, Governor admission, probe, catalog
  refresh или background Job.

### Installed Web и export

- Добавь управление только на exact Installed profile, не на Marketplace card.
  User видит exact model, digest, runtime version, capability и объяснение, что
  это его assertion, а не provider/runtime verification.
- Add/remove требуют explicit action и one-intent guard. Mount, hover, focus,
  navigation, reload и export не создают mutation или resource action.
- Покажи provider declaration, completion probe и user override как разные
  labelled regions. Positive override не должен красить provider declaration в
  verified-green и не должен скрывать conflict/degraded/unknown evidence.
- Дай explicit Copy/Download JSON action для typed safe override projection.
  Export не содержит endpoint, auth, local path, provider raw body, prompt,
  response или reasoning. Filename/content type и failure state deterministic.
- Loading/empty/error/conflict/identity-changed/retry/success/clear states
  различимы. Все новые strings используют locale keys: English source/fallback и
  curated Russian.
- Dialog/popover доступен keyboard/screen reader, содержит focus, возвращает его,
  поддерживает Escape, 390 px, 200%, no horizontal overflow и reduced motion.

## Failure matrix и тесты

Минимальные deterministic cases:

- legacy descriptor default `overrides: []`, strict unknown/future contract;
- fresh/v8→v9/reopen/failed migration, no backfill и exact-key isolation;
- idempotent create, stable timestamps/order, exact clear и malformed row;
- two models, same name/new digest, same digest/new runtime, duplicate canonical
  installed rows, missing digest/version и identity drift before mutation;
- unavailable/malformed `/api/tags` или `/api/version` не пишет/не удаляет row;
- provider declared/degraded/unknown и completion-probe projection не меняются;
- positive override visible as `overridden/user_override`; absence remains
  unknown, не unsupported;
- safe JSON copy/download round-trip и private/raw field absence;
- no action on mount/hover/focus/navigation/reload/export, double activation one
  mutation, abort/unmount no late state update;
- English/Russian, keyboard/focus/Escape, 390 px, 200%, overflow и reduced motion;
- no pull/probe/prewarm/load/unload/catalog fetch/Governor action.

Не используй live Ollama/GPU/network в обязательных tests. Temporary SQLite,
fake tags/version transport и mocked browser routes должны доказать boundaries.

## Не входит в P2-I

- Hugging Face API/import, GGUF revision/license/checksum и Q-25 decision;
- full Capability Registry, OperationResolution/Task Adapter wiring или generic
  precedence/conflict resolver;
- negative `unsupported`, confidence slider, arbitrary capability/name, free-form
  note или automatic inference из model name/card;
- new controlled tool/media/semantic probe или promotion P2-C completion result;
- Marketplace/catalog filters based on overrides, remote provider или scraping;
- override sync/cloud export, audit history, multi-user/auth profile;
- NVIDIA calibration, NVML/MIG, `/api/ps` device binding, scheduler/parallelism;
- durable pull/resume, immutable tag resolution или recent catalog list.

## Проверка

Сначала зафиксируй clean inherited baseline. После implementation выполни как
минимум:

```bash
npm run typecheck
node --test packages/server/test/catalog-pagination.test.ts
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

Добавь exact P2-I migration/store/route/Web/Chromium commands. Повтори новый
P2-I group, affected Web, P2-A/P2-B descriptor/cache, P2-C probe, P2-H
server/Web/Chromium, P1-L+M, P1-K, P1-J, P1-I и P1-E по 10 раз последовательно
с exit/count checking. Первый failing/flaky result сохрани, диагностируй и
исправь; повторный green не скрывает первую ошибку. Не запускай десятки Node/
Vitest processes одновременно.

## Completion и handoff

После bounded slice:

- согласованно обнови contract, migration/store, server descriptor/routes,
  Installed Web, locale, tests и current-state docs;
- добавь P2-I evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A–P2-H;
- Phase 2 оставь `in progress`: override foundation не закрывает HF/Q-25,
  verified Linux tier, full Capability Registry или ROADMAP exit gate;
- Q-25 оставь открытым; HF slice остаётся blocked до explicit owner decision;
- полностью перепиши этот файл под следующий незавершённый non-blocked Phase 2
  slice либо оставь P2-I с blocker/recovery steps;
- используй небольшие conventional commits и не включай `.idea/`.

В финале сообщи ровно `status successful` либо `status blocked`, commits, exact
test counts, first failures/fixes, residual risks и подтверждение обоих handoff
docs. Не называй user override provider/runtime verification, отсутствие override
— unsupported, local fake tests — production validation, а Phase 2 — завершённой.
