# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-09

**Назначение:** Phase 2 slice P2-O — объяснимый conservative
`estimated` parallel-admission verdict поверх P2-N feature flag; measured
parallelism, второй Governor permit и фактический parallel execution не начинать

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0002/0003/0011,
`research/EVIDENCE.md`, `plans/PHASE_STATUS.md`, `plans/ROADMAP.md`,
`plans/OPEN_QUESTIONS.md` и accepted owner decisions, особенно D-003 и Q-34a.

Зафиксируй clean starting revision/status/последние commits. P2-N implementation
и review-fix — `ac928a3` и `b0b7248`. До edits составь bounded plan по
`WORKFLOW.md`, проверь реальные fit/calibration/runtime/host/flag contracts и
актуальные первичные Ollama/Node/platform sources. Не начинай Phase 3 и не
закрывай variant-calibration debt молча.

## Baseline P2-N

- один server-owned typed registry, один
  `estimated_parallel_admission_policy`, default-off;
- exact startup env `enabled | disabled`, operator > safe default, restart-only;
- invalid/unavailable/unknown/future input fail closed;
- strict read-only redacted `/api/feature-flags`, без migration/write API/Web;
- P2-N: 12 new / 532 core envelope; Web 173/173; mocked Chromium 28/28;
- feature flag ещё не имеет consumer и не меняет Governor/runtime behavior;
- live Ollama/GPU/hardware, service restart и production operator flow не
  validated.

## Outcome P2-O

Server-owned policy может для конкретного конфликтующего pair/request вернуть
объяснимый verdict, помеченный только `estimated`, используя исключительно
доступные sourced facts и P2-N effective flag. Verdict имеет observation time,
confidence, полный input/basis breakdown и conservative unknown/denied states.
Он не выдаётся за measured факт или гарантию будущего admission и не добавляет
второй permit.

Перед кодом зафиксируй ADR/LLD-решение:

- exact request/pair identity: active/queued owner, model reference/digest,
  runtime fingerprint и context;
- какие inputs действительно доступны сейчас: declared model bytes,
  `estimateKvCacheBytes`/`computeFit`, exact `CalibrationStore`, observed
  `/api/ps` VRAM и host sample;
- freshness/identity coherence и поведение при mixed timestamps;
- safe arithmetic, unknown overhead, safety margin и double-counting rules;
- flag-off/invalid/unavailable semantics;
- read contract/consumer: отдельная query или additive Runtime projection;
- cache/single-flight/cancellation, если они нужны;
- почему persistence и write UI нужны либо не нужны.

Если margin, admissible confidence или policy threshold требуют нового owner
choice, которого нет в Q-34a/D-003, не выбирай число молча: оставь typed blocker
и recovery steps. Implementation detail, которая лишь сохраняет conservative
unknown, owner choice не требует.

## Обязательные границы

1. P2-N flag читается только через typed registry. Raw env и string key не
   появляются в calculator/Governor/Web.
2. Default-off, invalid/unavailable flag, unknown identity, stale/conflicting
   facts, unsafe arithmetic и future schema fail closed.
3. Basis различает declared, estimated, calibrated/observed и unknown; observed
   component не превращает весь future verdict в measured.
4. Не суммируй несвязанные NVIDIA devices, Apple free pages, legacy calibration
   или ambiguous `/api/ps` rows как safe available capacity.
5. Не учитывай одни и те же model/KV/runtime bytes дважды. Любой исключённый
   overhead видим в explanation и снижает confidence.
6. Verdict read-only: он не acquire/release lease, не запускает load/probe,
   не меняет queue, не отменяет Job и не вызывает Ollama/model lifecycle.
7. `ResourceGovernor` сохраняет ровно один permit. Никакой второй ticket/lease,
   pin/TTL, measured calibration run или automatic parallel dispatch.
8. Server остаётся authority; Web/localStorage не может включить behavior.
9. Нет remote flags, analytics, telemetry export, fingerprinting, secrets или
   новых plaintext settings.
10. Не начинай STT/audio, live hardware experiment, Phase 3 UI либо Phase 4
    service lifecycle.

## Contract и наблюдаемость

- closed/versioned request и response; arbitrary keys/future enums rejected;
- verdict минимум различает `disabled | estimated_allow | estimated_deny |
  unknown`, но naming должен соответствовать реальной semantics;
- source, observedAt, confidence и exact basis обязательны для каждого числового
  input; unavailable reason typed/redacted;
- `estimated_allow` никогда не называется safe/measured/verified и не означает,
  что текущий single-permit Governor пропустит второй Job;
- clients могут понять flag state, missing/stale fact, расчет и причину отказа
  без raw provider/environment content.

## Тестовый envelope

Нужны deterministic assertions минимум для:

- flag default-off/invalid/unavailable → disabled без calculator side effect;
- exact enabled path и один typed consumer P2-N key;
- request/parser unknown/extra/future/duplicate/unsafe numeric rejection;
- каждый доступный source отдельно и coherent combined estimate;
- missing/stale/conflicting/identity-drift inputs → unknown/deny, не allow;
- overflow/underflow/NaN/negative/zero, boundary equality и no double count;
- declared/calibrated/observed provenance не повышается до measured verdict;
- два независимых contexts/requests, cancellation и stable observation basis;
- exact projection redaction;
- no DB/network/analytics/localStorage/load/probe/model/Governor/queue side
  effects и неизменный one-permit snapshot;
- compatibility settings/health/runtime/CLI/Web;
- exact count assertions для единственного verdict/flag consumer и отсутствия
  duplicate rows/keys.

Сделай mutation checks для flag fail-close, stale/identity rejection,
double-count protection, estimated-not-measured и отсутствия Governor side
effects. Каждое свойство docs/ROADMAP должно иметь падающий assertion.

Web surface не добавляй без доказанной необходимости. Если Web всё же меняется,
обязательны locale keys, keyboard/focus/live, 390 px, 200%, reduced motion и
полный browser gate.

## Gates

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

## Workflow и handoff

После vertical implementation запусти независимую read-only verification по
`plans/WORKFLOW.md`: contract/arithmetic/freshness/identity, security/no-effects
и compatibility. Findings исправляет автор отдельным fix commit.

Сделай небольшие conventional commits: feature, verification fix и current-state
docs. Обнови `plans/PHASE_STATUS.md` с real new/regression envelope, first
failures и residual risks. После P2-O отдельно переоцени весь Phase 2 exit gate и
не переходи к Phase 3, пока variant-calibration/current ROADMAP discrepancy и
release-readiness не имеют явного verdict. Если gate неполон, следующий prompt
остаётся на Phase 2 exit/recovery; только полностью зелёный exit может передать
первый bounded slice Phase 3.

В финале сообщи `status successful` только если implementation, independent
verification, gates, docs и commits реально завершены.
