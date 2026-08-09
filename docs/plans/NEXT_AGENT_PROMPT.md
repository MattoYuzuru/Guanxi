# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-09

**Назначение:** Phase 2 slice P2-N — централизованная local-first
feature-flag infrastructure с безопасными defaults, provenance и наблюдаемой
effective policy; P2-O estimated parallel admission и любой measured behavior не
начинать

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current-state HLD/LLD, `DEVELOPMENT.md`,
`TESTING.md`, `architecture/RUNTIME_LIFECYCLE.md`, ADR-0003/0006/0007,
`research/EVIDENCE.md`, `plans/PHASE_STATUS.md`, `plans/ROADMAP.md`,
`plans/OPEN_QUESTIONS.md` и accepted owner decisions, особенно Q-34/Q-34a.

Зафиксируй clean starting revision после P2-M docs commit, status и последние
commits. P2-M implementation/review-fix — `62a41c6` и `5b3d71d`. До edits
составь bounded plan по `WORKFLOW.md`. Проверь текущие settings/config/contract/
context boundaries и актуальные первичные источники выбранной технологии. Не
добавляй SaaS flag provider или dependency без доказанной необходимости.

## Baseline P2-M

- P2-J–P2-M public GGUF chain independently verified mocked evidence;
- core 520/520, Web 173/173, Chromium 28/28;
- P2-M connection/process-owned, loopback-only, без Job/SQLite replay;
- live Ollama/HF/GPU и production hardware не validated;
- Phase 2 осталось два bounded slices: P2-N flag infrastructure и P2-O
  **estimated** parallel-admission policy.

P2-N не должен менять Resource Governor, добавлять второй permit, запускать две
модели, реализовывать STT либо публиковать fit/admission verdict. Его outcome —
только инфраструктура, которой P2-O сможет безопасно владеть.

## Outcome P2-N

В проекте существует один server-owned typed registry feature flags. Для каждого
известного flag он вычисляет effective value по явно документированному
precedence, сохраняет safe default, source и observation time, отдаёт redacted
read-only projection clients и fail-closed обрабатывает неизвестные/сломанные
значения. Первый зарезервированный consumer для P2-O присутствует как
default-off declaration, но не меняет runtime behavior.

Перед кодом выбери и зафиксируй ADR/LLD-решение:

- какие scopes нужны сейчас: build, process/operator, persisted local setting;
- нужен ли persistence. Если да — только append-only migration с rollback/reopen
  tests; если нет — не симулируй durability;
- precedence и restart semantics;
- кто может мутировать flag и нужен ли в этом slice write API/UI;
- какие поля безопасно публиковать Web/CLI и какие остаются server-only.

Если это требует нового owner choice, которого нет в Q-34/Q-34a, не закрывай его
молча: оставь typed blocker и recovery steps. Простая implementation detail в
рамках accepted local-first/default-safe policy не требует расширения scope.

## Обязательные границы

1. Registry и keys централизованы в одном typed boundary. Не разбрасывай
   `process.env`, localStorage или строковые flag names по components/services.
2. Unknown flag, invalid value, unavailable source и future schema fail closed.
   Experimental parallel-admission declaration по default выключена.
3. Effective projection содержит source, observedAt и schema/version basis.
   Default не выдаётся за user choice, runtime observation или measured fact.
4. Server остаётся authority. Web не принимает решение о runtime admission и не
   может скрытым localStorage override включить server behavior.
5. Не добавляй remote flag SaaS, analytics/telemetry, device/user fingerprint,
   network fetch, секреты или plaintext credential fields.
6. Если env/operator override разрешён, parser принимает только exact
   documented values, не логирует raw environment и имеет deterministic
   precedence. Изменение env после startup не притворяется live update.
7. Если persistence разрешён, migration append-only, store strict, mutation
   atomic/idempotent, а corrupt row не включает feature. Compatibility старой DB
   и rollback/reopen обязательны.
8. Read API не раскрывает server-only flags или arbitrary config. Write API, если
   он действительно нужен, требует strict allowlist/schema и typed outcomes.
9. Не вводи флаг вокруг security checks, authentication, filesystem ownership,
   data migrations или других safety invariants.
10. Не реализуй P2-O calculations, measured parallelism, second Governor permit,
    pin/TTL, STT/audio, live hardware experiment или remote configuration.

## Contract и наблюдаемость

- Название первого declaration должно описывать feature/policy, а не обещать
  measured parallelism. Оно является reserved/default-off infrastructure input.
- Contract различает declared key, effective boolean/value, source, observedAt и
  unavailable/invalid state; arbitrary keys и future enums rejected.
- Health/settings/UI не должны говорить «enabled by measurement» без measured
  evidence. Если Web surface добавлен, он только объясняет effective flag и
  source, с English fallback и curated Russian locale keys.
- Нужна диагностируемость без секретов: tests или safe projection позволяют
  понять, почему effective value on/off.

## Тестовый envelope

Нужны deterministic assertions минимум для:

- registry completeness, unique keys и default-off reserved P2-O declaration;
- exact parser и rejection unknown key/value/extra field/future version;
- precedence каждой выбранной source и stable startup snapshot;
- invalid/corrupt/unavailable source → safe default, не optimistic enable;
- old DB/reopen/rollback, если есть migration;
- read projection redaction и отсутствие server-only flags;
- mutation idempotency/conflict/cancellation, если есть write boundary;
- два независимых AppContext/requests без global mutable test leakage;
- no network/analytics/localStorage/runtime model/Governor side effects;
- compatibility существующих settings/health/CLI/Web;
- exact count assertions для единственного registry entry/projection и
  отсутствия duplicate keys/rows.

Каждое заявленное свойство получает assertion, который падает при нарушении.
Сделай mutation checks для default-off, unknown fail-closed, precedence,
projection redaction и отсутствия runtime side effects.

Если Web меняется, обязательны component/browser cases: keyboard/focus/live,
390 px, 200%, reduced motion, English/Russian и отсутствие скрытого enable.

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
`plans/WORKFLOW.md`: contract/config/persistence/security и Web/CLI/operational
projection (если затронуты). Findings исправляет автор отдельным fix commit.

Сделай небольшие conventional commits: feature, verification fix и current-state
docs. Обнови `plans/PHASE_STATUS.md` с real new/regression envelope, first
failures и residual risks. Полностью перепиши этот prompt на P2-O только если все
gates green; иначе оставь P2-N blocked с recovery steps.

В финале сообщи `status successful` только если implementation, independent
verification, browser/root gates, docs и commits реально завершены.
