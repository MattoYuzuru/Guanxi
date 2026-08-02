# Prompt следующему агенту

**Назначение:** Phase 0, slice P0-D — Runtime/catalog health
**Статус:** ready
**Проверено:** 2026-08-02

Скопируйте текст ниже в новую coding-agent сессию.

---

Работай в репозитории Alamo UI. Продолжи текущую Phase 0, но реализуй только
bounded slice `P0-D Runtime/catalog health`.

P0-A независимо проверен в commits `f038b5c` и `d05a906`. P0-B реализован и
проверен в commits `c673227`, `21115c5`, `ad6c2b4` и `7721ca0`. P0-C реализован
и проверен в commits `0ca72d8` и `7a626f6`. Не откатывай Error Boundaries,
deterministic web harness, SQLite migration 3, Message terminal CAS, truthful
Chat projection, process-local exclusive inference bridge или persisted-seq
compaction fix.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 0 в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD, `docs/TESTING.md` и
   accepted ADR-0002/0003/0004.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй:
   - `sde-agent:implementation-planning` и `sde-agent:sde-agent` как owner;
   - `sre-agent:verification-strategy` для health/timeout state model;
   - `sre-agent:reliability-testing` для deterministic slow/unavailable/stalled
     Ollama envelope;
   - `sre-agent:finding-validation` для проверки dead endpoint, timeout
     classification и release нового P0-C permit;
   - `frontend-agent:frontend-agent` и
     `frontend-agent:frontend-verification` для truthful Runtime/Chat
     projection, locale, accessibility и responsive states.
4. До правок воспроизведи current false/dead health signals, запрос к
   несуществующему catalog endpoint, отсутствие `/api/ps` projection в Chat и
   зависание fake Ollama до headers/первого chunk/между chunks. Составь bounded
   plan с source/freshness model, timeout ownership, cancellation precedence,
   UI states и точными validation commands.

Scope P0-D:

- сделать current health наблюдаемым и правдивым: application, Ollama runtime и
  catalog/network source не должны выводиться healthy/reachable без реальной
  проверки;
- для каждого внешнего health факта указать source и observation time; stale,
  unavailable и unknown не смешивать с healthy;
- убрать runtime-вызов несуществующего Ollama catalog endpoint; сохранить
  local/bundled fallback и явно показать его provenance/freshness;
- не заменять dead endpoint HTML scraping или недокументированным private API;
- использовать существующий `/api/ps` running-model source и показать текущие
  loaded models в минимальной согласованной Chat/Runtime projection;
- различать installed и running models; не выводить ownership, fit или memory
  safety без подтверждённого источника;
- ввести отдельные bounded Ollama connect/load/stream-idle timeout semantics;
  timeout должен иметь stable safe category/message и не становиться completed
  или generic empty success;
- continuous healthy stream не должен падать только из-за общей длительности:
  idle timeout обновляется наблюдаемым provider progress;
- explicit Stop/connection abort должны сохранять authoritative cancellation
  reason и не ошибочно классифицироваться как timeout/provider failure;
- любой timeout/provider/abort path обязан освободить P0-C exclusive permit и
  допустить следующего waiter;
- согласованно изменить contract, server, Web, tests и current-state docs только
  в объёме observable health/running/timeout behavior;
- сохранить loopback-only default, public route/DB/localStorage identifiers,
  forward-only migrations и существующий POST/SSE ownership.

Health model:

- application health не зависит от доступности catalog и Ollama history UI
  остаётся usable в degraded state;
- Ollama state как минимум различает checking, reachable, unavailable и
  incompatible/invalid response, если последнее доказано protocol check;
- catalog source различает fresh remote, stale cache, bundled fallback,
  unavailable и unknown;
- running model row содержит только поля, реально полученные из `/api/ps`, с
  `observedAt`; отсутствие row не доказывает unload между observations;
- Web показывает loading/empty/degraded/error и keyboard/accessibility states,
  не блокирует всю application shell из-за optional source.

Timeout/failure evidence:

- deterministic fake transport никогда не отвечает на connect/headers и получает
  connect timeout с release/cleanup;
- cold warm/load превышает load deadline, abort-ится и освобождает permit;
- stream отдаёт первый/несколько chunks, затем замолкает: idle timeout сохраняет
  failed partial outcome, не completed;
- stream продолжает отдавать chunks дольше одного idle interval и не timeout-ится;
- missing terminal `done:true` остаётся `runtime_protocol`, а не timeout;
- explicit Stop и connection abort раньше/одновременно с deadline остаются
  `cancelled` с правильным stop reason;
- timeout первого owner допускает ожидающий cross-thread turn/warm без overlap;
- health проверяет malformed response, unavailable runtime, slow response,
  stale cache и bundled fallback без real network;
- `/api/ps` empty/non-empty/error fixtures дают truthful running projection;
- catalog code не обращается к удалённому dead endpoint;
- P0-A/P0-B/P0-C tests остаются зелёными, включая reload states, CAS,
  cross-thread exclusion, compaction и waiter cancellation.

Non-goals:

- не реализовывать Resource Governor, durable queue/Job Engine, leases,
  priorities, idempotency, replayable GET SSE или restart recovery;
- не разрешать measured parallelism и не вычислять новый hardware fit;
- не менять P0-B/P0-C connection ownership: navigation пока может cancel current
  POST/SSE turn и connection-bound waiter;
- не строить полный target Runtime Bar/Jobs UI или application service;
- не реализовывать model import, Marketplace redesign, capability probes,
  external telemetry или Ollama catalog scraping;
- не реализовывать P0-E полный browser release gate сверх новых узких
  health/running/timeout regression;
- не менять product IA/theme, branding, media, Agent policy или retention;
- не переписывать SQLite migrations 1–3 и не добавлять schema migration без
  доказанной необходимости;
- live Ollama/model и публичная сеть не являются обязательной test dependency.

Validation:

- targeted contract/health/catalog/timeout unit tests;
- deterministic server route tests для unavailable/malformed/slow/stalled fake
  Ollama и `/api/ps`;
- fake-clock либо bounded deterministic timers без flaky wall-clock sleeps;
- component tests для checking/degraded/stale/empty/running/timeout projection;
- узкий mocked Chromium smoke только если observable Web state изменился;
- existing P0-B contract/migration/store/route/web regression;
- existing P0-C 16 mutex/concurrency/release regressions;
- `npm run test:web:browser`;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"`;
- `git diff --check`, self-review и independent SRE timeout/health review;
- не использовать пользовательскую DB, реальные workspace или live model для
  обязательных tests.

После успешной проверки:

- обнови current-state docs и только строку P0-D в `PHASE_STATUS.md`, со ссылками
  на commits и точными tests;
- оставь Phase 0 незавершённой, пока P0-E не закрыт;
- зафиксируй residual risks: health — sampled observation, bridge не Governor,
  POST/SSE connection-owned и не replayable, restart recovery отсутствует,
  live hardware/Ollama не проверены обязательным suite;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под следующий незавершённый slice
  `P0-E Browser regression gate`, включая skills, full
  `create → send → stream → done → reload` browser scope, failure coverage,
  release criteria и ожидаемое обновление только P0-E;
- сделай небольшие conventional commits для contract/runtime behavior,
  health/timeout/UI tests и docs.

Если P0-D заблокирован или обязательная проверка не прошла, не переключай handoff
на P0-E: оставь `NEXT_AGENT_PROMPT.md` на P0-D и добавь blocker, evidence,
затронутые health/timeout ownership paths и безопасные recovery steps.

В финале сообщи commits, health/source model, timeout/cancellation precedence,
test evidence, непройденные проверки, residual risks и slice, для которого
подготовлен `NEXT_AGENT_PROMPT.md`.

---
