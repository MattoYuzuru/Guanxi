# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-03

**Назначение:** Phase 2, slice P2-C — explicit controlled completion probe

## Контекст

Работай в `/Users/m.ryabushkin/Projects/alamo-ui` на текущей ветке. Сначала
прочитай `AGENTS.md` и маршрут из `docs/NAVIGATION.md`; для code change обязательны
`PRODUCT.md`, `DOMAIN_MODEL.md`, `DEVELOPMENT.md`, `TESTING.md`, HLD, LLD,
`architecture/RUNTIME_LIFECYCLE.md`, связанные ADR, `plans/PHASE_STATUS.md`,
`plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted owner decisions.

Не считай target/proposed уже реализованным. Код определяет current behavior,
accepted ADR — целевую границу, ROADMAP — порядок перехода. Не трогай `.idea/`,
пользовательские данные, real Ollama model store, `node_modules`, generated
outputs или unrelated worktree changes.

P2-A/P2-B уже реализованы коммитами:

- `d750a3e`, `6a5c43d`, `d42b791`, `282c82e` — installed descriptor и truthful
  provider evidence;
- `a1ead74` — migration 7 и safe exact installed-evidence store;
- `597c130` — persistent exact cache, validation, single-flight и four-worker
  collection;
- `c22c435` — localized Web freshness projection.

Подтверждённый inherited baseline: typecheck; P1 exact 98/98; P1-L+M 32/32;
prewarm 7/7; routes/Governor/concurrency 33/33; runtime/provider 19/19;
fit/telemetry 19/19; P2-A descriptor 9/9; P2-B persistent 17/17; core 274/274;
Web 52/52; mocked Chromium 18/18; build, markdownlint и diff check. Повторы P2-B:
persistent 10×17/17, descriptor 10×9/9, P1-L+M 10×32/32, Web 10×52/52, P1-K
10×37/37, P1-J 10×11/11, P1-I 10×3/3, P1-E 10×8/8.

## Цель P2-C

Добавь первый controlled runtime probe с минимальным blast radius: только
явный user-triggered probe базовой `completion` capability для одной exact
installed Ollama variant. Успешный bounded provider response может дать
`verified` evidence для этого exact fingerprint и probe version. Любая ошибка,
отмена или identity drift остаётся degraded/unknown и никогда не превращается в
`unsupported`.

Это foundation для будущего Capability Registry, а не полный registry. Slice не
должен проверять tools, thinking, vision, embedding, semantic quality, скорость,
fit, parallelism или media reliability.

## Обязательный scope

### Contract и identity

- Добавь additive strict request/response/evidence schemas в `packages/contract`.
  Legacy descriptor/models responses должны продолжить parse без probe fields.
- Probe request выбирает только `completion`, exact expected installed digest и
  explicit context. Context проходит существующий positive-safe-integer и
  sourced context-limit boundary; не вводи новый UI maximum.
- Exact fingerprint включает как минимум provider, canonical reference,
  installed digest, sourced Ollama runtime version, context и versioned probe
  definition. Missing/ambiguous reference, digest или runtime version означает
  controlled skip, не guessed identity.
- Различай `verified`, `degraded`, `unknown`, `cancelled` и `skipped` так, чтобы
  transient provider failure не выглядел как capability rejection. Публикуй
  source, original observation time, confidence, exact basis и safe reason.
- Не расширяй существующий `declared | degraded | unknown` aggregate так, чтобы
  cached provider declaration внезапно стала runtime proof. Если добавляешь
  resolved projection, precedence и конфликт должны быть явными и tested.

### Probe execution

- Probe запускается только explicit user action из installed model profile.
  Никаких mount/hover/selection/background/automatic probes.
- Используй server-owned fixed probe definition и deterministic request. Не
  принимай arbitrary prompt, system message, tools, images, files, URLs или
  provider options от Web.
- Выполняй provider call через существующий `OllamaClient` и один canonical
  `ResourceGovernor` с typed normal-priority operation owner. Probe не может
  обходить active/queued Chat, compaction или warm/load и не получает parallel
  lane.
- До admission повтори P1-K safety eligibility: cloud, red fit и unknown fit не
  загружаются probe-ом. Не превращай static estimate в observed hardware proof.
- До и после call проверь `/api/tags` installation identity и `/api/version`.
  Результат сохраняется только если exact fingerprint не изменился.
- Probe имеет central bounded deadline/cancellation, bounded generated output и
  short explained keep-alive policy. Эти protocol/safety bounds не выдавай за
  product output ceiling. Не auto-unload-ь модель и не останавливай Ollama.
- HTTP connection владеет caller wait. Navigation/unmount/Cancel abort-ит только
  этот недолговечный probe. Не описывай его как durable/background/replayable Job.
  Если выбранная реализация не может безопасно завершиться в request envelope,
  остановись и зафиксируй blocker вместо псевдо-durability.
- Runtime Bar показывает typed probe operation/queue owner, но не предлагает
  P1-J Job Stop для process-local operation. Cleanup обязан освобождать ticket,
  lease, timers и listeners на success/failure/cancel/timeout/provider EOF.

### Persistence и redaction

- Добавь только append-only migration 8. Не переписывай migrations 1–7 и не
  backfill-ь provider declarations как verified probes.
- Persist result keyed exact fingerprint + probe definition version. Повтор без
  force может вернуть historical exact result с исходным `observedAt`; UI обязан
  назвать его historical/cached, а не current. Explicit force создаёт новый
  observation либо заменяет только документированную latest projection без
  выдачи старого результата за новый.
- Store только normalized outcome, safe reason, timing/provenance и exact key.
  Никогда не сохраняй provider response text, fixed probe prompt, reasoning,
  template/system content, raw body, endpoint, credentials, paths или private
  workspace data. Route error также не должен раскрывать их.
- Incompatible schema/key/row fail closed. Failed migration остаётся на v7 и
  повторяется после устранения conflicting schema; old code может игнорировать
  новую table.

### Web

- Добавь localized English source/fallback и curated Russian keys. Не добавляй
  bilingual hardcode в component.
- Installed profile объясняет, что manual probe кратко загружает exact model и
  проверяет только базовую completion response. Покажи idle/queued/running/
  verified/degraded/cancelled/error и cached-historical states.
- Нужны keyboard action, accessible name/status, focus-safe confirmation и Cancel,
  mobile/200% zoom/no-horizontal-overflow/reduced-motion behavior. Не запускай
  action из карточки одним случайным click без объяснения side effect.
- Marketplace не меняй и не смешивай с installed state. Unknown/degraded остаются
  видимыми; не используй verified-green для provider declaration или failed
  probe.

## Failure matrix и тесты

Минимальные deterministic fake-transport cases:

- contract legacy defaults, exact round-trip и unknown future enum rejection;
- migration 8 fresh/v7/reopen/failed transaction/recovery;
- exact key isolation по reference/digest/runtime/context/probe version;
- no backfill from migration 7/provider declarations;
- one explicit successful probe, cached historical reuse и forced rerun;
- ambiguous/missing installation, changed digest/version before/after;
- sourced context over-maximum refusal и unknown limit without guessed cap;
- cloud/red/unknown-fit safe skip без provider load;
- Governor active/queued admission, exact operation projection и cleanup;
- connect/load/response timeout, caller cancel, malformed/empty/non-terminal
  response, provider error и persistence failure;
- no response/prompt/reasoning/raw body/secret/path persistence or route leak;
- double click/same-key single-flight or explicit idempotent rejection;
- Web loading/queue/success/cached/failure/cancel/unmount, English/Russian,
  keyboard/focus, 390 px, 200%, overflow и reduced motion;
- assertion that no probe runs on mount, hover, selection, navigation or reload.

Не используй live installed model в обязательных tests. Fake transport должен
проверять точный provider request и limits. Если добавляешь concurrency, повтори
новый migration/store/execution group 10 раз последовательно с проверкой exit
status; не запускай десятки Node test processes одновременно.

## Не входит в P2-C

- automatic/scheduled probes или policy editor;
- tool-call, thinking, vision, embedding, insert, media или semantic-quality
  probes;
- arbitrary user prompt и сохранение generated content;
- full evidence history UI, user override, Adapter Registry или generic probe DSL;
- Add from Ollama, pull/delete/import, HF API/download/GGUF/checksum/license;
- Marketplace redesign, catalog scraping или arbitrary server-side URL fetch;
- Linux/NVIDIA telemetry, measured parallel, generic eviction или multi-process
  locking;
- output-budget/media UI, Project/Agent/MCP/Skills, retention или rebrand.

Q-25 и Q-26 остаются открытыми и блокируют первый import slice. Не закрывай их
молча и не начинай import как часть P2-C.

## Проверка

Сначала зафиксируй чистый inherited baseline. После implementation выполни как
минимум:

```bash
npm run typecheck
node --test packages/server/test/job-contract.test.ts \
  packages/server/test/job-migration.test.ts \
  packages/server/test/job-store.test.ts \
  packages/server/test/job-service.test.ts \
  packages/server/test/job-routes.test.ts \
  packages/server/test/chat-job-execution.test.ts \
  packages/server/test/chat-job-recovery.test.ts \
  packages/server/test/resource-governor.test.ts \
  packages/server/test/runtime-reconciliation.test.ts \
  packages/server/test/host-telemetry.test.ts
node --test packages/server/test/model-service.test.ts \
  packages/server/test/context-limits.test.ts \
  packages/server/test/observation-key.test.ts \
  packages/server/test/runtime-reconciliation.test.ts
node --test packages/server/test/prewarm.test.ts
node --test packages/server/test/routes.test.ts \
  packages/server/test/exclusive-inference.test.ts \
  packages/server/test/inference-concurrency.test.ts
node --test packages/server/test/catalog.test.ts \
  packages/server/test/runtime-contract.test.ts \
  packages/server/test/runtime-routes.test.ts \
  packages/server/test/ollama-client.test.ts
node --test packages/server/test/fit.test.ts \
  packages/server/test/host-telemetry.test.ts
node --test packages/server/test/model-descriptor.test.ts
node --test packages/server/test/installed-evidence-migration.test.ts \
  packages/server/test/installed-evidence-store.test.ts \
  packages/server/test/installed-evidence-cache.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Добавь exact P2-C commands для новых contract/migration/store/execution/Web
files. Повтори новый P2-C group, P2-B persistent, P2-A descriptor, P1-L+M,
affected Web, P1-K, P1-J, P1-I и P1-E по 10 раз. Первый failing/flaky result
сохрани, диагностируй и исправь; повторный green не скрывает первую ошибку.

## Completion и handoff

После bounded slice:

- согласованно обнови contract, server, Web, tests и current-state docs;
- добавь P2-C evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A/P2-B;
- Phase 2 оставь `in progress`, пока весь ROADMAP exit gate не доказан;
- полностью перепиши этот файл под следующий незавершённый Phase 2 slice;
- используй небольшие conventional commits для migration/store,
  server/contract, Web/tests и docs;
- в финале сообщи ровно `status successful` либо `status blocked`, commits,
  exact test counts, первый failure/fix, residual risks и подтверждение обоих
  handoff docs.

Если exact identity, Governor cleanup, no-content persistence или truthful
`verified` semantics невозможно доказать на documented local endpoint, не
сохраняй положительный probe result. Оставь declared/unknown, запиши конкретный
evidence gap и handoff recovery steps.
