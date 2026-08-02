# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-02
**Назначение:** Phase 0, slice P0-E — Browser regression gate

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Продолжи текущую Phase 0, но реализуй только
bounded slice `P0-E Browser regression gate`.

P0-A независимо проверен в commits `f038b5c` и `d05a906`. P0-B реализован и
проверен в commits `c673227`, `21115c5`, `ad6c2b4` и `7721ca0`. P0-C реализован
и проверен в commits `0ca72d8` и `7a626f6`. P0-D реализован и проверен в commits
`edf737d` и `5454fc7`. Не откатывай Error Boundaries, deterministic web harness,
SQLite migration 3, Message terminal CAS, truthful Chat projection,
process-local exclusive inference bridge, persisted-seq compaction fix,
sourced health/catalog/running projection или provider timeout semantics.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 0 и exit gate в
   `docs/plans/ROADMAP.md`, `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD,
   `docs/TESTING.md` и accepted ADR-0002/0003/0004.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй:
   - `sde-agent:implementation-planning` и `sde-agent:sde-agent` как owner
     минимальных harness/fixture fixes;
   - `sre-agent:verification-strategy` для browser state/transition matrix;
   - `sre-agent:reliability-testing` для deterministic REST/SSE failure
     envelope;
   - `sre-agent:finding-validation` и `sre-agent:release-readiness` для
     независимого Phase 0 go/no-go;
   - `frontend-agent:frontend-agent` и
     `frontend-agent:frontend-verification` для observable Web, accessibility,
     responsive и reduced-motion проверки.
4. До правок запусти существующие component/browser tests, изучи Playwright
   fixtures и воспроизведи пробел: сейчас happy-path create/first stream и
   terminal reload проверяются разными сценариями, а не одним полным
   `create → send → stream → done → reload` release flow.
5. Составь bounded plan с точными mocked REST/SSE transitions, persisted reload
   source of truth, failure matrix, viewport/accessibility checks и validation
   commands. Не расширяй P0-E до новой product functionality.

Scope P0-E:

- добавить единый deterministic Chromium flow:
  `health → installed models → create Chat → redirect → send → start/thinking/
  content progress → terminal done → reload → persisted history/output`;
- проверить, что новый thread ID берётся из create response, URL и active
  sidebar согласованы, composer проходит sending/streaming/idle, а reload читает
  terminal Message projection, а не оставшийся live buffer;
- поток должен содержать несколько observable phases и длиться достаточно для
  проверки промежуточного состояния без flaky wall-clock sleep;
- сохранить отдельный failure coverage как минимум для:
  provider failure до первого content, failed partial stream, EOF без
  `done:true`, explicit Stop с partial output и connection-owned navigation
  abort;
- для каждого failure после reload подтвердить authoritative
  `failed/cancelled`, safe error/stop reason и отсутствие generic empty success;
- сохранить Error Boundary regression: crash не превращает root в white screen,
  shell/retry/navigation остаются доступны;
- сохранить P0-D degraded runtime/catalog regression: application shell доступен
  при unavailable/incompatible Ollama, `/api/ps` error не выглядит empty, source
  и observation time видимы;
- проверить keyboard focus/accessible names/live regions, narrow viewport,
  отсутствие horizontal overflow, 200% zoom и reduced-motion fallback там, где
  эти состояния наблюдаемы;
- использовать только deterministic mocked browser transport и временные
  fixtures. Обязательный suite не зависит от live Ollama, модели, публичной сети
  или пользовательской DB;
- разрешены только минимальные production fixes, доказанно необходимые для
  browser gate. Contract/server/runtime semantics не меняй без отдельного
  подтверждённого finding и согласованных regression tests.

Non-goals:

- не реализовывать Resource Governor, durable queue/Job Engine, leases,
  priorities, idempotency, replayable GET SSE или restart recovery;
- не менять current POST/SSE connection ownership и не изображать reattach;
- не строить полный Runtime Bar/Jobs UI, application service или model
  Marketplace;
- не менять product IA/theme, branding, media, Agent/MCP/Skills policy,
  retention или locale architecture;
- не переписывать SQLite migrations 1–3 и не добавлять migration без доказанной
  необходимости;
- не вводить live Ollama/model/public-network dependency;
- не расширять gate до полного cross-browser/performance/security suite.

Release criteria:

- единый full-flow Chromium test действительно проходит create, redirect,
  multi-phase stream, terminal done и hard reload с persisted outcome;
- failure fixtures подтверждают failed/cancelled partial projections и
  authoritative error/stop reason после reload;
- missing terminal остаётся `runtime_protocol`, timeout остаётся своим stable
  category, Stop/navigation abort не превращаются в provider failure;
- P0-A cleanup/Error Boundaries, P0-B migration/CAS/reload, P0-C 16 baseline
  mutex/release regressions и P0-D 36 targeted health/timeout tests зелёные;
- browser assertions не опираются на произвольные sleep и дают полезный trace
  при failure;
- обязательные команды проходят:

```bash
npm test --workspace @alamo/web
npm run test:browser --workspace @alamo/web
npm run test:web:browser
npm run typecheck
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

После успешной независимой проверки:

- обнови current-state testing docs только если изменились команды, scope или
  точные counts;
- в `PHASE_STATUS.md` измени только строку P0-E, добавив commits и точные test
  evidence; не переписывай evidence P0-A–P0-D;
- оцени Phase 0 exit gate целиком, но не начинай Phase 1 в этом slice;
- полностью перепиши `NEXT_AGENT_PROMPT.md` для первого действительно
  незавершённого bounded slice либо для конкретного Phase 0 blocker;
- сделай небольшие conventional commits для browser harness/regressions,
  необходимых production fixes и docs.

Если P0-E или любой обязательный Phase 0 gate не прошёл, не отмечай P0-E
завершённым. Оставь `NEXT_AGENT_PROMPT.md` на P0-E и добавь blocker, failing
fixture/command, затронутые transitions и безопасные recovery steps.

В финале сообщи commits, полный browser flow, failure/accessibility evidence,
непройденные проверки, Phase 0 go/no-go, residual risks и slice, для которого
подготовлен `NEXT_AGENT_PROMPT.md`.
