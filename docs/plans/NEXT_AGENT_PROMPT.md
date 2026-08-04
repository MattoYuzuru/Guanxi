# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-04

**Назначение:** Phase 2, slice P2-E — variant-first Marketplace install

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

P2-A–P2-D уже реализованы:

- `d750a3e`..`282c82e` — installed descriptor и truthful provider evidence;
- `a1ead74`, `597c130`, `c22c435` — migration 7 и persistent exact provider cache;
- `ce9ef4b`, `c48799a`, `d1c3c38` — migration 8 и explicit completion probe;
- `21c0404`, `3d129d2`, `0d9aaa6` — strict Add from Ollama preview/confirmed
  connection-owned pull и hardened traversal/unmount boundaries.

Подтверждённый current baseline: typecheck; P1 exact 98/98; P1-L+M 32/32;
prewarm 7/7; routes/Governor/concurrency 33/33; runtime/provider 20/20;
fit/telemetry 19/19; P2-A 9/9; P2-B 17/17; P2-C 34/34; P2-D server 20/20;
core 311/311; Web 65/65; mocked Chromium 19/19; build, markdownlint и diff check.
Repeats: P2-D server 10×20/20, targeted Web 10×7/7, affected Web 10×65/65,
P2-C 10×34/34, P2-B 10×17/17, P2-A 10×9/9, P1-L+M 10×32/32, P1-K
10×37/37, P1-J 10×11/11, P1-I 10×3/3 и P1-E 10×8/8.

Q-26 resolved: manual Add from Ollama принимает strict name или official page
URL. Q-25 остаётся открытым и блокирует первый Hugging Face slice. Не начинай HF
API/download/import, не выбирай formats и не закрывай Q-25 молча.

## Current gap

Current `CatalogModel.variants` показывает только tag/claimed size/parameter size.
Server рассчитывает top-level fit по самому крупному варианту. Web рисует variant
badges, но `PullControl` всегда отправляет base `model.name`; пользователь не
выбирает exact tag до install. Top-level `installed` также может стать true из-за
другого tag того же family. Это не удовлетворяет MOD-002 variant-first boundary и
может связать показанный fit с другим pull target.

P2-D уже даёт strict canonical confirmed pull. P2-E должен использовать ту же
server-owned normalization/terminal lifecycle, но сохранить разные UX surfaces:
manual reference form не является catalog variant selector, а catalog claim не
становится installed/digest evidence до `/api/tags` refresh.

## Цель P2-E

Сделай Marketplace install variant-first: пользователь видит и явно выбирает
конкретный catalog tag, получает fit/size/source именно для выбранного варианта,
подтверждает exact normalized pull target и только затем запускает один local
Ollama pull. После terminal success exact installation/digest truth приходит из
`/api/tags`.

Это bounded curated/local-catalog slice. Он не превращает mutable tag или stale
catalog row в immutable artifact, не реализует HF import и не завершает весь
Capability Registry/search subsystem.

## Обязательный scope

### Contract и catalog variant boundary

- Additive расширь `CatalogModel` так, чтобы каждый variant имел однозначный
  server-derived canonical pull target и собственный fit. Сохрани legacy fields/
  defaults и старых clients; public API/keys не удаляй и не переименовывай.
- Target формируй через один shared server normalizer, а не client string
  concatenation. Base/tag/namespace grammar и implicit/canonical tag должны быть
  согласованы с P2-D.
- Variant отражает только доступные facts: exact normalized name/tag, claimed
  size/parameter/source/freshness и calculated fit basis. Не выдумывай digest,
  quantization, license, context, capability, availability или immutable revision.
- Fit вычисляй для конкретного variant size/context claim. Unknown size остаётся
  unknown/объяснённым, а не нулём или скрытым safe default. Top-level legacy fit
  не должен маскироваться под selected-variant evidence.
- Installed state различай по exact normalized target. Установка одного tag не
  делает другой tag installed; family-level legacy projection можно сохранить
  только как явно compatibility aggregate.
- Invalid/malformed/duplicate variant rows fail-closed и не приводят к pull
  удобного base/default target. Сохраняй catalog provenance/observed/fetched time.
- Unknown fields/future enums соблюдают существующую compatibility policy; новые
  strict command boundaries отклоняют лишние поля.

### Server и pull lifecycle

- Не добавляй remote catalog call и не scrape-и `ollama.com`. Используй только
  current validated local recommendations cache и dated bundled snapshot.
- Confirmation/start обязан повторно доказать exact selected target через P2-D
  normalizer. Web не передаёт endpoint, insecure, headers, auth или provider options.
- Exact selected target достигает одного fake `OllamaClient.pull`; base name или
  соседний tag не должен случайно попасть в request.
- Сохрани P2-D terminal-success, malformed/regressing progress, redaction,
  disconnect/cancel и zero automatic retry semantics.
- Pull остаётся connection-owned, non-durable и non-replayable. Не создавай DB
  migration/Job/resume/cache/disk reservation без отдельного доказанного scope.
- После success refresh `/api/tags` подтверждает exact target и digest. Missing
  target либо refresh failure остаётся truthful unconfirmed state; catalog claim
  не становится installation evidence.
- Не запускай completion probe, load/prewarm, capability promotion или Governor
  admission автоматически.

### Web

- На Marketplace card variant selection обязателен до install; variant badges
  больше не должны выглядеть passive, если именно они определяют pull target.
- Покажи exact selected name/tag, per-variant claimed size/parameter, fit и source/
  freshness. Unknown/stale/fallback states остаются видимыми и не выглядят как
  verified runtime facts.
- До confirmation явно сообщи о network/disk side effect и mutable catalog/tag
  boundary. Никакого pull на mount, focus, hover, selection, carousel navigation,
  reload или variant change.
- Double click/Enter dispatches один UI intent. Поддержи progress/error/cancel/
  explicit retry и exact installed-after-refresh state без optimistic digest.
- Selection change до start обновляет preview/fit; во время active pull не
  подменяет target. Unmount/navigation abort-ит только owned wait и не делает
  late state/refresh update.
- Все новые strings проходят locale keys: English source/fallback и curated
  Russian. Проверь keyboard, accessible names/status/progress, focus containment/
  restore, 390 px, 200% zoom, no horizontal overflow и reduced motion.
- Manual `Add from Ollama`, Installed profile/P2-C probe, search input и current
  local/catalog cards продолжают работать.

## Failure matrix и тесты

Минимальные deterministic cases:

- contract legacy round-trip и additive variant defaults;
- exact targets для base/tag/namespace; malformed/duplicate tag/name rejection;
- two variants с разным size дают разные explained fit; unknown size не становится
  zero/green; stale/fallback provenance сохраняется;
- exact installed tag не отмечает соседний tag installed;
- no pull на mount/selection/focus/hover/navigation/reload и без confirmation;
- selected variant A передаёт ровно target A один раз; base/variant B не вызываются;
- double activation, ordered progress, provider/protocol/transport error, cancel,
  unmount и explicit retry;
- terminal success refreshes `/api/tags`; exact target/digest present, missing и
  refresh-failure states остаются различимыми;
- no automatic completion probe, prewarm/load, capability promotion или catalog
  remote fetch;
- English fallback/Russian, keyboard/focus, 390 px, 200%, overflow и reduced motion.

Не используй live model/real Ollama store. Fake transport должен проверять exact
target/options/cancellation. Если добавляешь concurrency/race behavior, повтори
новый group 10 раз последовательно с exit-status checking; не запускай десятки
Node/Vitest processes одновременно.

## Не входит в P2-E

- Hugging Face API/search/download, GGUF revision/checksum/license/gated flow;
- arbitrary URL fetch, Ollama human catalog scrape или remote HTML parsing;
- durable/resumable import Job, staging/cache, disk reservation или checksum;
- immutable tag resolution до provider pull, registry history или recent catalog;
- semantic/tool/thinking/vision/embedding/media probes и user override;
- full faceted search/filter/compare redesign — это следующий отдельный slice;
- delete/import-from-file, Modelfile editor, safetensors conversion или adapters;
- Linux/NVIDIA telemetry, measured parallel, Project/Agent/MCP/Skills, service
  lifecycle, retention или rebrand.

## Проверка

Сначала зафиксируй clean inherited baseline. После implementation выполни как
минимум:

```bash
npm run typecheck
node --test packages/server/test/ollama-reference-contract.test.ts \
  packages/server/test/ollama-reference-routes.test.ts \
  packages/server/test/ollama-reference.test.ts \
  packages/server/test/ollama-client.test.ts
node --test packages/server/test/catalog.test.ts \
  packages/server/test/model-descriptor.test.ts \
  packages/server/test/fit.test.ts
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

Добавь exact P2-E server/Web commands. Повтори новый P2-E group, affected Web,
P2-D server, P2-C, P2-B, P2-A, P1-L+M, P1-K, P1-J, P1-I и P1-E по 10 раз
последовательно. Первый failing/flaky result сохрани, диагностируй и исправь;
повторный green не скрывает первую ошибку.

## Completion и handoff

После bounded slice:

- согласованно обнови contract, server, Web, tests и current-state docs;
- добавь P2-E evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A–P2-D;
- Phase 2 оставь `in progress`, пока весь ROADMAP exit gate не доказан;
- Q-25 оставь открытым; HF slice остаётся blocked до explicit owner decision;
- полностью перепиши этот файл под следующий незавершённый non-blocked Phase 2
  slice, вероятно bounded faceted search/filter/compare;
- используй небольшие conventional commits и не включай `.idea/`.

В финале сообщи ровно `status successful` либо `status blocked`, commits, exact
test counts, first failures/fixes, residual risks и подтверждение обоих handoff
docs. Если exact variant target нельзя безопасно вывести из current catalog facts,
fail-closed и зафиксируй конкретный blocker; не возвращайся к silent base pull.
