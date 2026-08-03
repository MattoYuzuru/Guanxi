# Handoff следующему агенту

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 2, slice P2-A — installed Model Descriptor и Capability
Evidence foundation

## Prompt

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Сначала прочитай корневой
`AGENTS.md` и выполни его полностью. Не создавай subagents и не делегируй работу.

Phase 0 и Phase 1 independently verified. P1-M удалил artificial context
ceiling, добавил sourced `ModelContextLimit`, exact custom propagation и
truthful one-permit/device-unknown projection. Реализуй только bounded P2-A:
additive descriptor/evidence contract для уже установленных Ollama models и его
вертикальную server/Web projection. Не начинай import, Marketplace rewrite,
controlled probes или persistent Capability Registry.

### Обязательное чтение и readiness

1. Прочитай полностью:
   - `docs/NAVIGATION.md`;
   - `docs/PRODUCT.md`, особенно `MOD-001..005` и `RES-008..010`;
   - `docs/DOMAIN_MODEL.md`, Model Reference/Variant/Installation/Runtime
     Instance/Observation Key/Context Limit/Operation Descriptor;
   - `docs/UX_IA.md`, Models/Marketplace и evidence copy;
   - `docs/DEVELOPMENT.md` и `docs/TESTING.md`;
   - `docs/architecture/HLD.md`, `LLD.md` и `RUNTIME_LIFECYCLE.md`;
   - `docs/plans/ROADMAP.md` Phase 2 exit gate;
   - `docs/plans/OPEN_QUESTIONS.md`, особенно Q-25/Q-26 — не закрывай их;
   - `docs/decisions/2026-08-02-product-decisions.md`;
   - ADR-0002, ADR-0003 и ADR-0008.
2. Используй `architecture-agent:architecture-agent`,
   `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
   `product-agent:product-acceptance`, `sre-agent:verification-strategy`,
   `sre-agent:finding-validation`, `sde-agent:implementation-evidence` и
   `frontend-agent:frontend-verification` без делегирования.
3. До правок воспроизведи baseline:
   - typecheck;
   - P1 exact 98/98;
   - P1-L+M key/cache/runtime 32/32;
   - prewarm 7/7;
   - routes/Governor/concurrency 33/33;
   - runtime/provider 19/19;
   - fit/telemetry 19/19;
   - core 248/248, Web 46/46, Chromium 17/17;
   - build, markdownlint и diff check.
4. До реализации составь inventory current installed-model facts:
   `/api/tags`, `/api/show`, `/api/ps`, bundled catalog, legacy `capabilities`,
   `contextLimit`, digest, normalized reference, runtime version, cache key и UI
   consumer. Для каждого укажи source, observation time, confidence, artifact
   identity, staleness и failure semantics.

## Scope P2-A

- Добавь additive contract, который явно различает:
  - canonical provider/model reference;
  - exact installed variant/artifact digest либо unknown identity;
  - installation fact;
  - capability evidence с source, observed time, confidence/state и применимым
    fingerprint/identity basis.
- Названия типов и nesting выбери после inventory, но сохрани accepted domain
  distinction. Не называй `/api/tags` или `/api/show` declaration runtime proof.
- Current Ollama adapter использует только documented local endpoints уже
  доступного runtime. Не делай network scraping и не читай model store напрямую.
- Legacy `LocalModel.capabilities`, `contextLength`, `contextLimit`, REST paths и
  old response parsing остаются compatible. Новый contract additive; removal или
  rename требует отдельного migration/compatibility plan.
- Протяни descriptor/evidence через installed list и model detail. Один exact
  installed digest не должен смешиваться с другим digest того же name.
- Provider failure, missing field и conflicting declarations остаются typed
  unknown/degraded evidence, а не `supported:false` и не positive claim.
- Не выводи semantic quality, tool reliability, media support, output limit,
  hardware fit или runtime verification из имени/tag substring.
- Сохрани P1-L digest-aware cache, LRU 64, максимум четыре `/api/show` workers,
  caller cancellation и исходное observation time. Новые waits должны быть
  bounded/cancellable; raw body, endpoint credential, path, prompt и reasoning
  не логируются.
- В installed card/profile покажи evidence state/source/freshness только через
  locale keys: English source/fallback и curated Russian. Unknown должен быть
  видим, но не masquerade-иться как unsupported.
- Если vertical UI становится слишком широким, оставь Marketplace/catalog
  projection unchanged: P2-A относится к installed model evidence.
- SQLite migration не добавляй без доказанной необходимости. Persistent
  provider cache/TTL/SWR и registry history — следующий slice, не скрытая часть
  P2-A.

## Required behavior model

```text
installed Ollama row
  → canonical provider/model reference
  → exact digest identity | explicit unknown
  → collect documented declarations
      ├─ sourced declaration → declared evidence + time/confidence
      ├─ unavailable/missing → unknown/degraded evidence
      └─ conflict → preserve conflict; do not choose a convenient claim
  → additive REST projection
  → localized installed card/profile explanation
```

Evidence levels remain distinct:

```text
catalog claim ≠ provider declaration ≠ controlled probe ≠ runtime observation
```

## Required deterministic evidence

- legacy model responses still parse with additive defaults;
- canonical reference keeps registry/name/tag/digest distinctions already
  protected by P1-L normalization;
- installed exact digest A never receives evidence cached for replacement B;
- tags/show declarations carry exact source/time/confidence and no refreshed
  timestamp on a cache hit;
- missing, malformed, conflicting and unavailable provider data remain visible
  unknown/degraded states without erasing the installed row;
- no model-name/capability substring heuristic appears in contract/server/Web;
- list/detail preserve P1-M custom context and sourced context-limit behavior;
- `/api/show` concurrency remains bounded and caller abort reaches provider;
- UI covers loading, installed empty, unknown/degraded evidence and localized
  explanation; keyboard, focus, 390 px, 200%, no horizontal overflow and
  reduced motion remain safe;
- no live Ollama/model, user DB, workspace file, model store or public network in
  deterministic tests.

## Non-goals

- не реализовывать `Add from Ollama`, Hugging Face/GGUF import или Q-25/Q-26;
- не переписывать Marketplace/search/filter/compare;
- не добавлять persistent Capability Registry, TTL/SWR или controlled probes;
- не обещать semantic capability quality или runtime verification;
- не добавлять Linux/NVIDIA telemetry, multi-device scheduling, extra permits,
  measured parallel, generic eviction или auto-unload;
- не менять migrations 1–6, Job/Governor lifecycle, prewarm priority/TTL,
  P1-J Queue/Stop или no-artificial-caps boundary;
- не начинать Project/Recipe/retention, media, Service/CLI/TUI, Agent или rebrand.

## Validation

Сохрани новые exact counts и отдельно regression counts. Минимум:

```bash
npm run typecheck
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
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Повтори новый descriptor/evidence group 10 раз, P1-L+M key/cache/context group
10 раз, affected Web component files 10 раз, P1-K priority/prewarm/inference 10
раз, P1-J conflict 10 раз, P1-I polling 10 раз и P1-E recovery 10 раз. Первый
failing/flaky result сохрани, диагностируй и исправь; повторный green не скрывает
первую ошибку.

## Completion and handoff

После независимой проверки:

- обнови current-state domain/LLD/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0/1 evidence и добавь только P2-A;
- Phase 2 оставь `in progress`, пока весь её ROADMAP exit gate не доказан;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий незавершённый slice;
- сделай небольшие conventional commits для contract/server, Web/tests и docs.

Если descriptor semantics требуют выбрать Q-25/Q-26, остановись: import не входит
в P2-A. Если documented provider facts недостаточны, сохрани unknown и запиши
конкретный evidence gap вместо heuristic.

В финале сообщи `successful` либо `blocked`, commits, exact tests, первый failure
и исправление, residual risks и подтверждение обновления обоих handoff docs.
