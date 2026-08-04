# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-03

**Назначение:** Phase 2, slice P2-D — user-supplied Add from Ollama

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

P2-A/P2-B/P2-C уже реализованы:

- `d750a3e`..`282c82e` — installed descriptor и truthful provider evidence;
- `a1ead74`, `597c130`, `c22c435` — migration 7 и persistent exact provider
  cache;
- `ce9ef4b`, `c48799a`, `d1c3c38` — migration 8, explicit controlled
  completion probe и localized Web flow.

Подтверждённый current baseline: typecheck; P1 exact 98/98; P1-L+M 32/32;
prewarm 7/7; routes/Governor/concurrency 33/33; runtime/provider 20/20;
fit/telemetry 19/19; P2-A descriptor 9/9; P2-B persistent 17/17; P2-C + Ollama
boundaries 34/34; core 300/300; Web 58/58; mocked Chromium 18/18; build,
markdownlint и diff check. Repeats: P2-C 10×34/34, P2-B 10×17/17, P2-A
10×9/9, P1-L+M 10×32/32, Web 10×58/58, P1-K 10×37/37, P1-J 10×11/11,
P1-I 10×3/3 и P1-E 10×8/8.

Q-26 явно resolved перед этим handoff по accepted D-005: поле принимает model
name (`qwen3:8b`) либо URL официальной Ollama model page, показывает normalized
preview и начинает pull только после confirmation. Произвольный URL не
передаётся Ollama и не fetch-ится server-ом. Q-25 остаётся открытым; не начинай
Hugging Face import и не принимай решение о его formats в P2-D.

## Цель P2-D

Добавь отдельный truthful `Add from Ollama` flow для user-supplied reference:
локально и без network lookup распознать разрешённый model name либо официальный
page URL, показать нормализованный pull target, потребовать явное подтверждение и
только затем использовать documented local Ollama pull API.

Это bounded reference-preview/pull slice, а не весь import subsystem. Existing
Installed и Marketplace остаются разными surfaces. Preview не утверждает, что
model существует, подходит host, имеет конкретный size/license/capabilities или
будет успешно загружена.

## Обязательный scope

### Contract и normalization boundary

- Добавь strict additive request/preview/start schemas в `packages/contract`.
  Не ломай existing model list/detail/pull events и legacy clients.
- Один canonical server-owned normalizer принимает только:
  - допустимый Ollama model name с optional namespace/tag;
  - HTTPS URL официальной Ollama model page, который однозначно сводится к тому
    же model name.
- Зафиксируй grammar и normalization тестами. Reject empty/control/whitespace
  ambiguity, credentials, unexpected port, query/fragment, encoded separators,
  scheme-relative input, non-HTTPS URL, IP/localhost и lookalike/subdomain host.
  Не превращай произвольную строку или URL path в удобный model name.
- Preview возвращает input kind, original-safe display value и normalized model
  name. Не возвращай guessed digest, variant, tag, size, license, fit,
  capabilities или availability.
- Unknown fields/future enums fail closed. Error shape redacted и не включает
  raw provider body, credentials, filesystem path или secret input.

### Server и pull lifecycle

- Preview — pure local parse/validation. Он не делает DNS, HTTP fetch, catalog
  scrape, Ollama pull/show/tags call или filesystem write.
- Start принимает только подтверждённый canonical value либо заново применяет
  тот же normalizer; Web не может подменить preview arbitrary pull target.
- Pull использует existing documented local `OllamaClient.pull`/SSE boundary и
  current progress contract. Не включай `insecure`, arbitrary registry option,
  endpoint, headers, auth или provider options из Web.
- Double click/retry не должен случайно создать два pull-а для одного UI intent.
  Если safe server-side idempotency требует larger durable design, оставь start
  connection-owned и явно ограничь UI intent; не выдавай его за durable Job.
- Caller disconnect/Cancel завершает только этот connection-owned pull wait по
  current semantics. Не описывай pull как background/replayable, не добавляй
  псевдо-durability и не останавливай Ollama daemon.
- Success требует terminal provider completion, затем Installed refresh должен
  получить фактические installation/digest facts из `/api/tags`. Preview/pull
  target сам по себе не становится installed evidence.
- Provider/protocol/network/storage failure остаётся controlled error; partial
  progress не считается success. Cleanup освобождает controller/listener и не
  запускает completion probe автоматически.
- Не добавляй DB migration без отдельного доказанного durable state. P2-D не
  меняет migrations 1–8, Governor/model lifecycle или capability evidence.

### Web

- Добавь `Add from Ollama` entry на Marketplace, не на Installed card. Existing
  curated/local catalog cards и Installed profile продолжают работать.
- Form принимает paste/type, но preview запускается только explicit submit.
  Покажи validating/invalid/preview/confirm/pulling/progress/success/error/cancel
  и already-installed-after-refresh states без optimistic capability claims.
- Confirmation явно показывает normalized name и сообщает, что Ollama может
  скачать данные и использовать disk/network. Никакого pull на focus, paste,
  mount, hover, reload или preview.
- Keyboard submit/cancel, accessible name/status/progress, focus containment и
  restore обязательны. Проверь 390 px, 200% zoom, no horizontal overflow и
  reduced motion.
- Все strings проходят locale keys: English source/fallback и curated Russian.
  Не добавляй bilingual hardcode в component.
- После terminal success refresh Installed truth; не смешивай card/catalog claim
  с exact installation descriptor и не запускай P2-C probe автоматически.

## Failure matrix и тесты

Минимальные deterministic cases:

- contract exact round-trip, legacy compatibility, unknown field/enum rejection;
- accepted names: base, tag, namespace и documented canonical variants;
- accepted official HTTPS page URL → exact same normalized name;
- rejected arbitrary/lookalike/subdomain/IP/localhost/non-HTTPS/credential/port/
  query/fragment/encoded-separator/traversal/control/ambiguous inputs;
- assertion, что preview не вызывает DNS/fetch/Ollama/filesystem;
- exact confirmed target reaches one fake `OllamaClient.pull` with no user-owned
  insecure/options/endpoint fields;
- no pull on mount/type/paste/preview/cancel/navigation/reload;
- progress ordering, terminal success, provider error, malformed/non-terminal
  stream, caller cancel, unmount cleanup и explicit retry;
- repeated activation/double click dispatches one UI intent;
- success refreshes `/api/tags`; refresh failure remains truthful partial state
  and does not fabricate installed digest;
- no automatic completion probe and no capability promotion after pull;
- route/server errors do not leak input/provider body/secrets/paths;
- English fallback/Russian, keyboard/focus, 390 px, 200%, overflow и reduced
  motion in component plus mocked Chromium coverage.

Не используй live model или real Ollama store в обязательных tests. Fake
transport должен проверять exact pull target и cancellation. Если добавляешь
concurrency/race behavior, повтори новый group 10 раз последовательно с
проверкой exit status; не запускай десятки Node/Vitest processes одновременно.

## Не входит в P2-D

- Hugging Face API/search/download, GGUF revision/checksum/license/gated flow;
- arbitrary URL fetch, Ollama human catalog scrape или remote HTML parsing;
- durable/resumable import Job, download cache, disk reservation или checksum;
- auto probe, tool/thinking/vision/embedding/media/semantic-quality evidence;
- full Capability Registry/history, user override или generic probe DSL;
- delete/import-from-file, Modelfile editor, safetensors conversion или adapters;
- catalog redesign, search/filter/compare, Linux/NVIDIA telemetry или measured
  parallel;
- Project/Agent/MCP/Skills, retention, service lifecycle или rebrand.

## Проверка

Сначала зафиксируй clean inherited baseline. После implementation выполни как
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

Добавь exact P2-D commands для normalization/route/pull/Web files. Повтори новый
P2-D group, affected Web, P2-C, P2-B, P2-A, P1-L+M, P1-K, P1-J, P1-I и P1-E по
10 раз последовательно. Первый failing/flaky result сохрани, диагностируй и
исправь; повторный green не скрывает первую ошибку.

## Completion и handoff

После bounded slice:

- согласованно обнови contract, server, Web, tests и current-state docs;
- добавь P2-D evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A–P2-C;
- Phase 2 оставь `in progress`, пока весь ROADMAP exit gate не доказан;
- Q-25 оставь открытым до отдельного explicit HF decision;
- полностью перепиши этот файл под следующий незавершённый Phase 2 slice;
- используй небольшие conventional commits и не включай `.idea/`.

В финале сообщи ровно `status successful` либо `status blocked`, commits, exact
test counts, первый failure/fix, residual risks и подтверждение обоих handoff
docs. Если official URL нельзя локально и однозначно свести к safe model name без
fetch, fail closed и зафиксируй конкретный blocker; не ослабляй URL policy.
