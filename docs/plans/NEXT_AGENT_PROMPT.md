# Handoff следующему агенту

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-M — no-artificial-caps audit для context,
output/media и accelerator projection

## Prompt

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Сначала прочитай корневой
`AGENTS.md` и выполни его полностью. Не создавай subagents и не делегируй работу.

Предыдущие slices P1-A–P1-L независимо проверены. P1-L ввёл exact versioned
observation key, migration 6 и digest-aware bounded `/api/show` cache. Реализуй
только bounded slice `P1-M no-artificial-caps audit`. Не расширяй задачу до
Capability Registry, multi-device scheduler или Agent watchdog redesign.

### Обязательное чтение и readiness

1. Прочитай полностью:
   - `docs/NAVIGATION.md`;
   - `docs/PRODUCT.md` (`RES-*`, `MOD-*`, `PLAT-*`);
   - `docs/DOMAIN_MODEL.md`;
   - `docs/UX_IA.md`;
   - `docs/DEVELOPMENT.md`;
   - `docs/TESTING.md`;
   - `docs/architecture/HLD.md`;
   - `docs/architecture/LLD.md`;
   - `docs/architecture/RUNTIME_LIFECYCLE.md`;
   - `docs/plans/ROADMAP.md` Phase 1 и exit gate;
   - `docs/plans/OPEN_QUESTIONS.md`, особенно Q-27;
   - `docs/decisions/2026-08-02-product-decisions.md`, особенно D-007;
   - ADR-0001–0004 и все ADR, которые затрагивает inventory.
2. Используй skills `sde-agent:sde-agent`,
   `sde-agent:implementation-planning`, `product-agent:product-acceptance`,
   `sre-agent:verification-strategy`, `sre-agent:reliability-testing`,
   `sre-agent:finding-validation`, `sde-agent:implementation-evidence` и
   `frontend-agent:frontend-agent` без делегирования.
3. До правок воспроизведи baseline:
   - P1 exact 98/98;
   - P1-L key/migration/cache/runtime 28/28;
   - prewarm 6/6;
   - routes/Governor/concurrency 30/30;
   - runtime/provider 19/19;
   - fit/telemetry 19/19;
   - root 237/237 server/CLI + 43/43 Web;
   - Chromium 16/16.
4. Составь до кода limit inventory с колонками `surface`, `value`, `source`,
   `kind`, `enforcement point`, `user-visible explanation`, `action`.
   Обязательно проверь:
   - `threadOptionsSchema.numCtx.max(1_048_576)`;
   - Settings `max={1_048_576}`;
   - Launcher `CONTEXT_CHOICES`;
   - `ModelService.PROFILE_CONTEXT_STEPS` и `fitByContext`;
   - Chat URL/default context parsing и model max projection;
   - REST query/body schemas и SQLite settings/thread round-trip;
   - output/token/media controls или их отсутствие;
   - `acceleratorSchema`, singular hardware projection и Governor literal one
     permit;
   - safety bounds: tool/host output bytes, parser candidate, pagination,
     timeouts и `MAX_AGENT_STEPS`.
5. До реализации классифицируй каждый limit:
   - `runtime/adapter-reported capability`;
   - `explicit policy/safety bound`;
   - `display suggestion/default`;
   - `transport/storage implementation bound`;
   - `artificial product ceiling`;
   - `unknown/not implemented`.
   Default или suggestion не должны silently становиться validation cap.

## Scope P1-M

- Удали artificial hard ceiling `1_048_576` из thread contract и Settings.
  Boundary должен принимать любой positive safe integer в пределах реально
  представимого/передаваемого значения; malformed, fractional, zero, negative и
  unsafe integer по-прежнему отклоняются controlled validation.
- Не заменяй потолок другим произвольным числом. Если runtime/model сообщает
  context limit, показывай source/time/confidence и объясняй, является ли это
  declared model capability, observed runtime limit или policy refusal.
- `DEFAULT_CHAT_NUM_CTX=8192` и `DEFAULT_NUM_CTX=32768` остаются defaults, а не
  max/recommendation для любого hardware. Copy и aria text должны это отражать.
- Launcher presets остаются быстрыми suggestions только если пользователь может
  ввести валидное custom значение вне списка. Custom context должен пройти
  contract → server → SQLite/Chat/model fit/prewarm без clamp к последнему
  preset.
- Model profile не должен masquerade-ить `PROFILE_CONTEXT_STEPS` как полный
  список разрешённых contexts. Добавь model-reported maximum и текущий/custom
  context в fit projection либо введи другой bounded on-demand calculation.
  Не запускай unbounded `/api/show` concurrency и не создавай огромный массив
  всех возможных contexts.
- Если selected context выше declared model maximum, не silently clamp-ь его.
  Покажи controlled validation/explanation с source. Не выдавай bundled catalog
  claim за runtime-verified limit.
- Проведи output audit. Current отсутствие user-facing output-budget control не
  нужно заполнять guessed max. Если обнаружен hidden inference-output cap,
  убери его либо свяжи с typed adapter/runtime/policy source. Provider stop
  reason `length` остаётся observation, не доказательство универсального max.
- Проведи media audit. Если current product не принимает media upload в этом
  flow, сохрани `not implemented`; не добавляй arbitrary file-count/size UI cap
  и не начинай Phase 4. Existing filesystem/tool security bounds не называй
  model capability limits.
- Проведи accelerator/device audit. Current P1 Governor one permit — явная
  conservative safety policy, а не claim, что host имеет один accelerator.
  UI не должен утверждать число устройств без sourced adapter fact. Не
  реализуй multi-device scheduling; unknown остаётся unknown.
- Не удаляй justified safety/transport bounds механически. Tool output 64 KiB,
  host probe output 64 KiB, parser candidate 32k, replay/recovery page bounds,
  timeouts и current Agent 40-step watchdog относятся к security/reliability.
  Зафиксируй source и user-visible failure semantics. Q-27 не закрывай без
  benchmark/owner decision.
- Public contract меняй additive/compatible там, где возможно. Удаление
  arbitrary `max` расширяет принимаемое множество и не требует DB migration.
  Legacy threads/settings/localStorage/URLs должны продолжать читаться.
- User-facing strings добавляй через English source/fallback и curated Russian.
  Проверяй keyboard, focus, 390 px, 200% scaling и reduced motion.
- Все new async provider waits bounded/cancellable. Не логируй raw provider
  body, endpoint credentials, paths, prompts, private workspace или reasoning.
- Обнови current-state docs и Mermaid только если boundary действительно
  изменилась.

## Required behavior model

```text
requested value
  → positive safe-integer syntax validation
  → classify available limit evidence
      ├─ explicit runtime/adapter/policy limit exists
      │    → explain source + reject/allow by that typed boundary
      ├─ only default/preset exists
      │    → keep as suggestion; custom value remains possible
      └─ evidence unavailable
           → unknown; no guessed universal ceiling
  → preserve exact requested value across REST, SQLite, fit and inference
```

Device projection:

```text
Governor permits = 1 conservative application policy
hardware device count = sourced adapter fact | unknown
never infer device count from permit count or singular display row
```

## Required deterministic evidence

- contract accepts values immediately below, equal to and above the old
  `1_048_576` ceiling when they are safe integers, and rejects invalid/unsafe
  numeric inputs;
- Settings saves/reloads a custom value above the old ceiling without clamp,
  reset or precision loss; legacy/default values still parse;
- thread create/update, Chat command, exact Governor request, Ollama `num_ctx`,
  prewarm request and model fit receive the same custom value end to end;
- Launcher exposes presets as suggestions and accepts keyboard-entered custom
  context outside the list with localized hint/error;
- Model profile shows/calculates at model-reported max and a valid custom
  context without treating six `PROFILE_CONTEXT_STEPS` as whitelist;
- value above a sourced model maximum gets truthful controlled behavior and
  does not silently clamp; unavailable maximum stays unknown;
- output/media inventory proves no hidden UI/product ceiling was introduced.
  Justified tool/parser/page/watchdog limits retain safe observable failures;
- Runtime Bar distinguishes one Governor permit policy from device-count fact
  and never renders unsupported device cardinality as fact;
- no regression in P1-L exact key: custom context changes key, creates a
  distinct exact calibration row and cannot reuse another context sample as the
  same observation;
- P1-K prewarm uses the exact custom context while preserving normal-before-
  prewarm, `2m` TTL and explicit warm/turn `10m`;
- P1-J Queue/Stop, P1-I polling, P1-E recovery and durable Chat replay remain
  green;
- Chromium literally enters a custom context beyond the old preset/ceiling,
  saves/reloads or starts the relevant flow, and observes the exact request.
  Include keyboard, 390 px, 200%, no horizontal overflow and reduced motion;
- no live Ollama/model, user DB, workspace file or public network in the
  deterministic suite.

## Non-goals

- не реализовывать multi-device discovery/scheduling или дополнительные permits;
- не менять one-lane Governor admission, P1-J Queue/Stop, P1-K priority/TTL;
- не добавлять Capability Registry/import/Marketplace Phase 2;
- не добавлять media workbenches/uploads Phase 4;
- не проектировать Agent watchdog/budget вместо открытого Q-27;
- не удалять security, pagination, stream chunking, timeout или redaction bounds;
- не добавлять durable runtime history, generic eviction, auto-unload, full Jobs
  UI, Project/Recipe/retention, MCP/Skills, daemon/TUI или rebranding;
- не выполнять live hardware/Ollama tests без отдельного explicit envelope.

## Validation

Сохрани новые exact counts и отдельно regression counts:

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
node --test packages/server/test/observation-key.test.ts \
  packages/server/test/observation-migration.test.ts \
  packages/server/test/model-service.test.ts \
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
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Повтори новые contract/settings/custom-context end-to-end races 10 раз,
затронутые Web component files 10 раз, P1-L key/cache/runtime group 10 раз,
P1-K priority/prewarm/inference 10 раз, P1-J conflict 10 раз, P1-I polling 10
раз и P1-E recovery 10 раз. Первый flaky/failing result сохрани, диагностируй и
исправь; не скрывай повторным green run.

## Completion and handoff

После успешной независимой проверки:

- обнови current-state docs и `docs/TESTING.md`;
- в `PHASE_STATUS.md` сохрани P0/P1-A–P1-L evidence и добавь только P1-M;
- сверь весь Phase 1 exit gate. Не отмечай Phase 1 завершённой только потому,
  что scope list исчерпан: каждый gate должен иметь evidence, а remaining gap —
  отдельный bounded prompt;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий незавершённый slice;
- сделай небольшие conventional commits для contract/behavior, UI/tests и docs.

Если arbitrary ceiling нельзя удалить без отсутствующего runtime capability
source, не подменяй его новым guessed max. Сохрани valid custom input там, где
это безопасно, покажи unknown, оставь P1-M `blocked` только при доказанном
compatibility/security gap и запиши recovery steps.

В финале сообщи status `successful` либо `blocked`, commits, exact tests, первый
failure и исправление, residual risks и что `NEXT_AGENT_PROMPT.md` полностью
переписан.
