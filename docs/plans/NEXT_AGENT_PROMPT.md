# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-04

**Назначение:** Phase 2, slice P2-G — truthful Linux/NVIDIA telemetry prototype

## Контекст

Работай в `/Users/m.ryabushkin/Projects/alamo-ui` на текущей ветке. Сначала
прочитай `AGENTS.md` и маршрут из `docs/NAVIGATION.md`; для code change обязательны
`PRODUCT.md`, `DOMAIN_MODEL.md`, `DEVELOPMENT.md`, `TESTING.md`, HLD, LLD,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0002, `plans/PHASE_STATUS.md`,
`plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted owner decisions.

Не считай target/proposed уже реализованным. Код определяет current behavior,
accepted ADR/decision — целевую границу, ROADMAP — порядок перехода. Не трогай
`.idea/`, пользовательские данные, real Ollama model store, `node_modules`,
generated outputs или unrelated worktree changes.

P2-A–P2-F уже реализованы:

- `d750a3e`..`282c82e` — installed descriptor и truthful provider evidence;
- `a1ead74`, `597c130`, `c22c435` — migration 7 и persistent exact cache;
- `ce9ef4b`, `c48799a`, `d1c3c38` — migration 8 и explicit completion probe;
- `21c0404`, `3d129d2`, `0d9aaa6` — strict Add from Ollama;
- `56b802b`, `2959b98` — exact catalog variants и variant-first install;
- `c769fbd`, `c1495a3`, `1fc3c20` — strict facets и pairwise exact compare.

Подтверждённый current baseline: typecheck; P2-F server 10/10; P2-E server
12/12; P2-F/P2-E targeted Web 18/18; P2-D 20/20; P2-C 34/34; P2-B 17/17;
P2-A 9/9; core 330/330; Web 83/83; mocked Chromium 21/21; build, markdownlint и
diff check. Repeats: P2-F server 10×10/10, targeted Web 10×8/8, affected Web
10×83/83, P2-E server/Web 10×12/12 и 10×10/10, P2-D 10×20/20, P2-C
10×34/34, P2-B 10×17/17, P2-A 10×9/9, P1-L+M 10×32/32, P1-K
10×37/37, P1-J 10×11/11, P1-I 10×3/3 и P1-E 10×8/8.

Q-26 resolved: manual Add from Ollama принимает strict name или official page
URL. Q-25 остаётся открытым и блокирует первый Hugging Face slice. Не начинай HF
API/download/import, не выбирай formats и не закрывай Q-25 молча.

## Current gap

`HostTelemetry` сейчас реализует bounded Apple Silicon `vm_stat`; любой другой
host получает `unsupported`. Legacy `probeHardware` может распознать только
первую NVIDIA row и превращает её VRAM в compatibility `usableMemoryBytes`, но
это startup estimate без current source/time, device identity, per-device total/
free VRAM или truthful failure state. Runtime Bar поэтому не может показать
Linux/NVIDIA как второй evidence-bearing platform.

Current `/api/ps` не публикует backend/device assignment. P1-L observation key
намеренно ограничен local Apple identity, а current-fit calculation требует
доказанные pressure/available-memory facts. Нельзя суммировать devices,
приписывать model row конкретной GPU, считать свободную VRAM safe admission,
поднимать Linux current fit до observed или менять one-permit Governor только по
`nvidia-smi` sample.

P2-G должен добавить bounded read-only Linux/NVIDIA host projection и Runtime Bar
UI. Это prototype PLAT-002, а не verified tier, full calibration, scheduler или
measured parallelism.

## Цель P2-G

На local Linux host с NVIDIA driver пользователь видит sourced/timestamped
per-device identity, total/free VRAM и controlled available/partial/unavailable/
unsupported states. Missing command, malformed/partial output и mixed/duplicate
rows не превращаются в zero, CPU-only, healthy empty или safe-fit claim.

## Обязательный scope

### Contract и evidence semantics

- Additive расширь `RuntimeHostTelemetry`; старые Apple/legacy snapshots должны
  parse-иться с explicit default, а старые clients могут игнорировать новые keys.
- Введи typed per-device projection без hardcoded device-count ceiling. Минимум:
  stable provider device index, NVIDIA UUID или explicit unknown, display name,
  total VRAM, current free VRAM, source, observedAt и confidence.
- Не публикуй raw `nvidia-smi` row, PCI topology, process list, username, paths,
  command stderr или environment. UUID — hardware identity; показывай его в UI
  только в bounded/redacted form, если полное значение не нужно пользователю.
- Units должны быть однозначны и конвертироваться в bytes с safe-integer check.
  Unknown не становится `0`; duplicate index/UUID и inconsistent row fail-closed.
- Сохрани раздельными system total/free/available memory, GPU total/free VRAM,
  pressure, legacy usable estimate и `/api/ps` allocation. Не называй free VRAM
  safe capacity, measured fit или future-admission guarantee.
- Расширяй enums additive. Unknown future enum по-прежнему отклоняется текущим
  strict client contract; legacy snapshot получает понятный unknown/default.
- Не меняй P1-L key на Linux и не создавай calibration row без exact backend/
  device identity. Linux/NVIDIA current model fit остаётся unknown с объяснимым
  reason, пока `/api/ps` нельзя связать с device и pressure/admission facts.

### Linux/NVIDIA adapter

- Добавь отдельный `HostTelemetry` adapter только для local Linux + detected
  CUDA/NVIDIA profile. Apple adapter и unsupported fallback не регрессируют.
- Используй один injected, shell-free, allowlisted command boundary с fixed argv
  для documented `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`.
  Никаких user-supplied binary/args, shell, arbitrary PATH lookup или remote SSH.
- Сохрани current 1 s timeout и 64 KiB output safety bounds либо обоснуй отдельные
  не менее строгие bounds. Output bound — reliability limit, не device ceiling.
- Parser должен быть pure и deterministic: LF/CRLF, whitespace, multiple devices,
  Unicode display names, missing token, duplicate index/UUID, negative/fractional/
  unsafe number, malformed column count и extra line имеют explicit policy.
- Отдельно классифицируй command missing/failure, timeout, output limit,
  malformed all rows и partial usable rows. Safe public error не содержит raw
  command output/stderr/path.
- Если total VRAM доступна только из legacy startup probe, не переиспользуй её как
  current observation. Current per-device total/free должны иметь собственный
  sample source/time или оставаться unknown.
- Не читай NVML/CUDA libraries, `/proc`, sysfs или Ollama internal files в этом
  slice, если без них выполняется минимальный NVIDIA prototype. Любое расширение
  источников требует отдельной provenance/failure model и тестов.
- Sampling остаётся query-time через существующий
  `RuntimeReconciliationService`: один pending single-flight, caller abort не
  отменяет shared source, следующий completed query создаёт новый sample.

### Runtime Bar Web

- Покажи Linux/NVIDIA adapter state и список всех returned devices без UI cap.
  При большом числе rows используй wrapping/contained scroll, не silent truncation.
- Для каждой device различай total VRAM, current free VRAM, source/time и
  confidence. Не объединяй devices в одну «доступную память» и не показывай
  optimistic green/safe parallel.
- Available, partial, unavailable и unsupported имеют разные localized states;
  stale refresh сохраняет последний confirmed snapshot с существующей error
  меткой, не меняя его timestamps.
- Все новые strings проходят locale keys: English source/fallback и curated
  Russian. Не добавляй bilingual hardcode в component.
- Runtime query/retry/navigation не запускают model load/unload, prewarm, probe,
  pull, Job cancel или second polling loop. Existing Apple/P1-I/P1-J UI и focus
  не регрессируют.
- На 390 px и 200% device facts не создают page horizontal overflow; keyboard,
  screen-reader grouping и reduced motion сохраняются.

## Failure matrix и тесты

Минимальные deterministic cases:

- legacy Runtime host snapshot default и additive NVIDIA round-trip;
- exact fixed executable/argv, `shell:false`, env/output/time bounds;
- one/many devices, non-sequential indexes и no arbitrary device ceiling;
- MiB-to-bytes exact conversion, zero-as-observed только если provider реально
  сообщил zero, unknown отдельно;
- LF/CRLF, whitespace и safe Unicode name;
- missing UUID/value, duplicate index/UUID, extra/missing column, negative,
  fractional, unsafe и overflow values;
- all-malformed → unavailable/partial по documented policy; usable+malformed rows
  не становятся silently healthy complete;
- command missing/failure, timeout, output limit и redaction;
- Linux without NVIDIA, non-Linux/non-Apple и Apple routing;
- shared reconciliation call count, common observedAt, independent provider/
  telemetry failure и caller abort;
- Linux current fit/observation key остаются unknown/unavailable без fabricated
  backend/device/pressure link;
- Runtime Bar English/Russian, all source states, multi-device grouping, stale
  retry, no resource actions, 390 px, 200%, overflow и reduced motion.

Не используй live GPU/Ollama в обязательных tests. Fake runner должен доказать
command/parse/error boundary. Live `nvidia-smi` smoke допустим только как отдельно
обозначенный, явно разрешённый integration envelope и не заменяет fixtures.

## Не входит в P2-G

- full NVIDIA calibration, NVML integration или per-process GPU accounting;
- binding `/api/ps` model row к device, MIG topology или multi-GPU placement;
- measured parallel, второй permit, pin/eviction/TTL policy или scheduler change;
- remote Ollama/SSH telemetry, multi-host routing или network security profile;
- Linux service/autostart/package verification и PLAT-002 exit declaration;
- Apple pressure/available-memory redesign или AMD/ROCm telemetry;
- Hugging Face API/import, catalog pagination, saved filters, persistence;
- DB migration, durable telemetry history или capability promotion.

## Проверка

Сначала зафиксируй clean inherited baseline. После implementation выполни как
минимум:

```bash
npm run typecheck
node --test packages/server/test/host-telemetry.test.ts \
  packages/server/test/runtime-contract.test.ts \
  packages/server/test/runtime-reconciliation.test.ts
node --test packages/server/test/catalog-facets-contract.test.ts \
  packages/server/test/catalog-facets.test.ts
node --test packages/server/test/catalog-variant-contract.test.ts \
  packages/server/test/catalog.test.ts
node --test packages/server/test/model-service.test.ts \
  packages/server/test/observation-key.test.ts \
  packages/server/test/runtime-reconciliation.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Добавь exact P2-G server/Web/Chromium commands. Повтори новый P2-G group,
affected Web, P2-F server/Web, P2-E server/Web, P1-H runtime/telemetry, P1-L+M,
P1-K, P1-J, P1-I и P1-E по 10 раз последовательно с exit/count checking. Первый
failing/flaky result сохрани, диагностируй и исправь; повторный green не скрывает
первую ошибку. Не запускай десятки Node/Vitest processes одновременно.

## Completion и handoff

После bounded slice:

- согласованно обнови contract, server adapter/composition, Runtime Web, tests и
  current-state docs;
- добавь P2-G evidence в `plans/PHASE_STATUS.md`, сохранив Phase 0/1/P2-A–P2-F;
- Phase 2 оставь `in progress`: prototype не закрывает PLAT-002, HF/Q-25 или весь
  ROADMAP exit gate;
- Q-25 оставь открытым; HF slice остаётся blocked до explicit owner decision;
- полностью перепиши этот файл под следующий незавершённый non-blocked Phase 2
  slice: вероятно catalog scale/pagination benchmark либо отдельно обоснованный
  resource-policy slice, но не full NVIDIA calibration из Phase 9;
- используй небольшие conventional commits и не включай `.idea/`.

В финале сообщи ровно `status successful` либо `status blocked`, commits, exact
test counts, first failures/fixes, residual risks и подтверждение обоих handoff
docs. Если device fact нельзя связать с конкретной sourced row, оставь unknown;
не возвращайся к legacy first-GPU aggregate как evidence.
