# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-09

**Назначение:** Phase 2 exit/recovery — явно разрешить расхождение между exact
variant calibration и Marketplace fit, затем выполнить полный release-readiness
gate; Phase 3 не начинать до зелёного exit verdict

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0002/0003/0006/0011/0012,
`research/EVIDENCE.md`, `plans/PHASE_STATUS.md`, `plans/ROADMAP.md`,
`plans/OPEN_QUESTIONS.md` и accepted owner decisions.

Зафиксируй clean starting revision/status и последние commits. Последний
independently verified slice P2-O состоит из:

- `0dc5c71` — strict estimated parallel-admission query;
- `2f08b78` — evidence/identity/provenance review fixes;
- `7b5101c` — coherent exact-calibration allow contract;
- current docs commit — current-state evidence и этот handoff.

Baseline после P2-O: **14 new / 546 full core envelope**, **0 new / 173 full Web
envelope**, **0 new / 28 full mocked Chromium envelope**; final independent
review — PASS. P2-O не добавляет второй Governor permit, Web consumer или
production allow. До edits составь bounded plan по `WORKFLOW.md` и сначала
перепроверь фактическое расхождение ниже по code, contract, tests и accepted
requirements.

## Подтверждённый exit blocker

Phase 2 всё ещё `no-go`, хотя именованных P2 slices больше нет:

- `ModelService.listLocal/detail` читает exact `CalibrationStore` и показывает
  calibration только при полном совпадении reference, digest, context,
  runtime/backend и hardware observation key;
- Marketplace exact variant fit в `packages/server/src/models/catalog.ts`
  использует catalog-claimed bytes/context и host capacity, но calibration не
  читает вовсе;
- поэтому требование MOD-004/ROADMAP «variant-level selection and calibration»
  закрыто только наполовину. Нельзя молча объявить его выполненным и перейти к
  Phase 3.

## Bounded outcome

Сначала выбери по существующим accepted требованиям и архитектуре один честный
вариант:

1. Additive связать exact installed Marketplace variant с exact calibration и
   учитывать её в variant fit с полной provenance/unknown semantics; либо
2. доказать, что calibration не должна участвовать в Marketplace fit, и получить
   явное owner/ADR/ROADMAP решение, которое изменяет exit criterion.

Не подменяй второй вариант собственным предположением. Если product choice
действительно отсутствует и оба поведения существенно различаются, оставь
точный blocker и recovery steps. Если current requirements однозначно требуют
первый вариант, реализуй его vertical slice и независимо проверь.

При implementation сохраняй:

- exact canonical reference + installed digest + requested context;
- exact runtime/backend version/fingerprint и hardware fingerprint;
- calibration timestamp/source/confidence/basis без cross-variant, cross-digest,
  cross-context или stale credit;
- distinct catalog claim, current host observation и historical calibration;
- offline/stale/unavailable/ambiguous states как typed unknown, не optimistic
  green fit;
- compatibility старых clients и legacy catalog response;
- server authority; Web не читает SQLite/Ollama напрямую;
- отсутствие произвольного context/device/memory ceiling;
- отсутствие model load/probe, Governor, queue, import или persistence side
  effects у read-only Marketplace query.

Historical exact calibration может улучшить estimate, но не становится
`measured` будущего запуска и не доказывает parallel admission. Не переиспользуй
P2-O admission margin или legacy 70/80% fit threshold без явной действующей
policy. Не расширяй задачу до live hardware, durable import Job, Phase 3 UI или
post-Phase-4 measured parallelism.

## Требуемые assertions при code change

Минимум должны падать при нарушении:

- exact variant/digest/context/runtime/hardware calibration получает только свой
  credit;
- соседний tag, другой digest/context/runtime/backend/hardware, stale/future или
  corrupt row не получает credit;
- catalog claim и calibration не double-count-ятся;
- missing calibration сохраняет совместимое claimed/unknown поведение;
- calibration source/time/confidence/basis видимы и не повышаются до measured;
- offline/provider failure не маскируется исторической row;
- duplicate/ambiguous exact variants остаются fail closed;
- filters, stable sort, total/page metadata и legacy full response используют
  один и тот же variant-fit predicate;
- request cancellation и repeated reads не запускают load/probe/import;
- нет новых Governor, queue, SQLite write, analytics, remote flag или Web
  localStorage side effects;
- contract/server/Web locale states согласованы, если меняется public projection.

Сделай mutation checks для exact-key drift, stale calibration, double-count и
confidence promotion. Каждое свойство, заявленное в docs или Phase 2 exit gate,
должно иметь assertion, который реально падает при его нарушении.

## Полный Phase 2 release-readiness gate

После blocker fix либо явного owner decision составь evidence matrix для
**каждого** актуального Phase 2 exit bullet из `ROADMAP.md`: requirement → code
boundary → failing assertion → gate evidence → residual risk/status. Не считай
hardware-dependent items, явно перенесённые accepted decisions за Phase 4,
текущим Phase 2 blocker; не выдавай mocked/local evidence за production
validation.

Отдельно проверь, что `PHASE_STATUS.md`, ROADMAP, HLD/LLD, Runtime Lifecycle,
DEVELOPMENT/TESTING и UI copy не противоречат коду. Если хоть один обязательный
exit property не реализован или не имеет direct assertion, verdict остаётся
`no-go`, а следующий prompt снова должен быть Phase 2 recovery, не Phase 3.

## Gates

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Если меняется Web, browser gate обязателен и новые/изменённые states должны иметь
locale keys, keyboard/focus/live, 390 px, 200% и reduced-motion assertions по
реальному scope.

## Workflow и handoff

После vertical implementation запусти отдельную read-only independent
verification по `plans/WORKFLOW.md`. Reviewer проверяет exact identity,
provenance/freshness, catalog filter/page coherence, no-effects, compatibility и
полную Phase 2 exit matrix. Findings исправляет автор отдельным fix commit.

Сделай небольшие conventional commits: implementation, verification fix и
current-state docs. Обнови `plans/PHASE_STATUS.md` с real new/regression envelope,
first failures, independent verdict и residual risks. Только если вся exit matrix
зелёная, можно закрыть Phase 2 и переписать следующий prompt на первый bounded
slice Phase 3. Иначе оставь prompt на конкретный Phase 2 blocker с recovery
steps.

В финале сообщи `status successful` только если blocker/decision,
implementation при необходимости, independent verification, full gates, docs и
commits реально завершены.
