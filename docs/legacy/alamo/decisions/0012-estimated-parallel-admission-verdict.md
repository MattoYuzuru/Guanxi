# ADR-0012: Explainable estimated parallel-admission verdict

**Статус:** implemented, locally validated

**Проверено:** 2026-08-09

## Context

P2-N добавил default-off server-owned feature flag, но не consumer и не изменение
Resource Governor. Q-34a разрешает отдельный `estimated` verdict из уже доступных
model/runtime/host facts. ADR-0002 при этом сохраняет один permit и требует
measured joint fit до фактического parallel execution.

Текущие facts неоднородны: `/api/ps` наблюдает loaded allocation, `/api/tags`
объявляет размер installed artifact, `/api/show` даёт architecture inputs,
exact `CalibrationStore` хранит historical loaded total, а host adapters не всегда
публикуют current available memory/pressure. NVIDIA rows нельзя суммировать без
topology и runtime-to-device identity; Apple free pages не являются capacity.

## Decision

P2-O вводит отдельный strict version-1 `POST` query для одной уже наблюдаемой
конфликтующей пары `active + queued`. Request фиксирует expected runtime sample,
owners, canonical model references, exact digests и contexts. Server заново
сопоставляет пару с одним `ResourceGovernor` snapshot и тем же internal Ollama
endpoint. Active и candidate обязаны иметь одинаковые runtime/backend и hardware
fingerprints; client не выбирает facts и не может включить policy.

Verdict имеет состояния `disabled | estimated_allow | estimated_deny | unknown`.
Каждый ответ содержит observation time, `estimated | unknown` confidence,
`futureAdmissionGuarantee:false`, exact pair resolution, feature-flag basis,
numeric facts с source/time/confidence/basis, calculation и exclusions. Ни один
компонент не повышает весь verdict до `measured`.

Расчёт сравнивает candidate lower bound с current available-memory advisory:

- current available-memory fact уже отражает active/runtime/другие process
  allocations, поэтому active `/api/ps` bytes показываются в basis, но не
  прибавляются к candidate второй раз;
- exact calibration total для candidate context заменяет, а не дополняет
  declared weights и KV estimate;
- без exact calibration `declared weights + architecture KV` является lower
  bound: он может доказать deny, но unknown runtime/backend overhead запрещает
  allow;
- safety margin version 1 равен нулю и не маскируется под owner policy. Equality
  даёт deny. Процентный threshold catalog fit не переиспользуется;
- unsafe integer arithmetic, negative/zero/NaN, missing pressure/capacity,
  identity drift, stale expected runtime sample и ambiguous device topology дают
  `unknown`, не allow.

Contract резервирует и строго валидирует `estimated_allow` только для exact
candidate calibration с source `exact_calibration_total`, historical exact-key
basis, calibrated candidate fact, estimated reservation, coherent cross-pair
runtime/hardware identity и positive headroom. Реализованный P2-O calculator его
не выпускает: Apple current available-memory остаётся advisory, а owner-approved
admission-capacity/margin policy отсутствует. Поэтому formula positive headroom
даёт `formula_overhead_unknown`, а exact-calibrated positive headroom —
`admission_capacity_policy_unapproved`. Это typed blocker, а не скрытый числовой
threshold. Equality/shortfall остаются conservative `estimated_deny` по
известному lower bound.

Flag проверяется до calculator/runtime/provider access. Missing, disabled,
invalid, unavailable или future flag input возвращает `disabled` без model work.
Policy не имеет cache/persistence/write UI: existing runtime single-flight
ограничивает overlapping sample, а caller AbortSignal отменяет только query wait.

## Invariants

1. Единственный flag consumer использует typed registry key, не raw env/string.
2. Один active и один queued request должны exact-match current Governor state.
3. Declared, estimated, calibrated и observed facts сохраняют собственный source.
4. Calibration и formula не суммируются; active allocation не double-count-ится
   поверх current available memory.
5. Apple free pages, legacy 70% estimate и aggregate NVIDIA free VRAM не дают
   allow.
6. Query не acquire/release-ит lease, не меняет queue, не вызывает load/probe,
   не пишет SQLite и не запускает external analytics/network provider.
7. Governor contract остаётся `acceleratorPermits: 1`.

## Consequences

Плюсы:

- clients получают проверяемое объяснение вместо boolean heuristic;
- deny может быть доказан lower bound даже при неполном overhead;
- insufficient production telemetry остаётся честным `unknown`;
- будущий measured tier сможет использовать другой contract без переименования
  estimated evidence.

Минусы:

- current production calculator не возвращает `estimated_allow` до отдельного
  owner decision об admission capacity/margin;
- request требует свежий Runtime sample и exact installed identity;
- историческая calibration остаётся estimate будущего запуска, а не measurement
  admission outcome.

## Alternatives

- Additive Runtime projection отклонена: verdict относится к выбранной pair и не
  должен вычисляться при каждом polling request.
- Catalog `green/yellow/red` отклонён как policy threshold: его legacy 70%/80%
  assumptions не являются owner-approved parallel margin.
- Второй Governor permit отклонён: это measured post-Phase-4 work.
- Persisted/UI setting отклонён: P2-N operator flag уже задаёт authority.

## Validation

- strict contract rejects unknown/future/extra/duplicate/unsafe input;
- flag fail-close occurs before calculator/provider access;
- each numeric source and coherent combined calculation is asserted;
- stale/identity drift/unknown overhead/topology/unsafe arithmetic never allow;
- synthetic allow requires exact-calibration provenance and cross-pair
  runtime/hardware coherence;
- boundary equality denies and no-double-count mutation fails;
- cancellation preserves one stable observation basis;
- before/after Governor snapshots remain byte-equivalent with one permit.
