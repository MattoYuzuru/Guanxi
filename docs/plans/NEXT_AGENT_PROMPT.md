# Следующий агентский prompt

**Статус:** ready
**Проверено:** 2026-08-03
**Назначение:** Phase 1, slice P1-C — public Job command/query/replay/cancel API

Скопируйте текст ниже в новую агентскую сессию.

---

Работай в репозитории Alamo UI. Phase 0 прошла bounded deterministic exit gate,
P1-A независимо проверил durable Job/event-store foundation, а P1-B — canonical
state transitions и internal persisted-first subscription. Реализуй только slice
`P1-C public Job command/query/replay/cancel API`.

Проверенные commits:

- Phase 0: `f038b5c`..`b2b3088`, evidence сохранено в `PHASE_STATUS.md`;
- P1-A contract/store: `138fb5e`, `91cb21f`, `92b68f0`;
- P1-B store/service: `56b2200`;
- P1-B tests: `55351bc`;
- P1-B docs/status: возьми commit из текущего `git log` после handoff.

Не откатывай Error Boundaries, truthful Message terminal CAS, process-local
exclusive inference bridge, persisted compaction fix, sampled runtime
health/timeouts, SQLite migration 4, scoped Job idempotency, per-Job sequence,
canonical transition CAS или persisted-first `JobService` subscription.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 1/exit gate в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md`, HLD, LLD, `docs/DOMAIN_MODEL.md`,
   `docs/TESTING.md`, accepted ADR-0001/0002/0004 и
   `docs/plans/OPEN_QUESTIONS.md`.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй
   `.idea`, пользовательскую `~/.alamo`, workspace-файлы или реальные Ollama
   models.
3. Используй:
   - `sde-agent:implementation-planning` и `sde-agent:sde-agent` как owner;
   - `architecture-agent:architecture-agent` для HTTP/application boundary;
   - `sre-agent:verification-strategy` для command/query/SSE matrix;
   - `sre-agent:reliability-testing` для reconnect, backpressure и disconnect;
   - `sre-agent:finding-validation` и `sde-agent:implementation-evidence` для
     независимой проверки.
4. До правок воспроизведи current state: exact P1-A/P1-B files дают 30/30,
   internal subscription replay-ит SQLite и продолжает live tail, но Job
   request/response schemas, public routes, HTTP SSE и cancel command
   отсутствуют. Current Chat POST/SSE остаётся connection-owned.
5. До кода составь bounded plan с route/schema table, idempotency scope,
   status/error mapping, Last-Event-ID/`after` policy, SSE framing,
   terminal-close behavior, cancellation state ownership, disconnect cleanup,
   compatibility, failure injection и точными validation commands.

Scope P1-C:

- добавить additive contract schemas/paths для:
  - `POST /api/jobs` — validated create command;
  - `GET /api/jobs/:jobId` — canonical Job query;
  - `GET /api/jobs/:jobId/events` — replayable GET SSE;
  - `POST /api/jobs/:jobId/cancel` — explicit cancel command;
- create принимает только существующие safe Job foundation fields: `kind`,
  `operation`, non-empty `idempotencyKey`; public caller не задаёт произвольный
  storage scope — server использует один документированный local API scope;
- duplicate create с тем же key возвращает тот же Job и не создаёт второй event;
  response правдиво сообщает `created` и stable events URL;
- validation выполняется до Job create; schema/path/error shapes остаются typed
  через `packages/contract`, без ad-hoc JSON;
- GET unknown Job возвращает controlled 404; malformed params/body/sequence —
  controlled 400; storage/malformed persisted data — safe 5xx без raw DB/content;
- event route принимает non-negative integer `after` и reconnect header
  `Last-Event-ID`; если заданы оба разных значения, возвращает controlled 400,
  а одинаковые значения не меняют sequence;
- SSE использует persisted Job event sequence как `id`, отдаёт typed event data
  в ascending order и сначала replay-ит `after+1..M`, затем live `M+1`;
- HTTP handler использует существующий `JobService.subscribe`; не создаёт свою
  in-memory event history и не broadcast-ит до commit;
- terminal Job subscription закрывается после последнего persisted terminal
  event; reconnect после terminal tail не зависает;
- slow HTTP client не блокирует Job mutation: handler уважает response
  backpressure, а service продолжает bounded SQLite page replay;
- client disconnect/AbortSignal освобождает только HTTP subscriber и никогда не
  меняет Job status;
- добавить application cancel operation с canonical diagram semantics:
  - terminal Job возвращается идемпотентно без нового event;
  - `queued` проходит `cancelling → cancelled`, потому что side effect ещё не
    стартовал;
  - cancellable active state переходит только в `cancelling`; terminal
    `cancelled` остаётся будущему execution owner после подтверждённого stop;
  - уже `cancelling` возвращается идемпотентно;
  - state без canonical cancel edge даёт controlled conflict без записи;
- cancel reason остаётся safe metadata/stop reason, без prompt, reasoning,
  provider body, secret или workspace content;
- подключить routes в Hono composition и использовать один `context.jobService`;
- обновить contract/route/service tests и current-state docs только в пределах
  public API foundation.

Этот slice создаёт API для durable records, но не executor. Новый Job правдиво
остаётся `queued`, пока следующий slice не добавит execution owner. Не называй
`202`, SSE или background-looking route доказательством, что Job уже выполняется.

Required deterministic evidence:

- contract round-trip и malformed fixtures для create/query/cancel/event path;
- duplicate POST возвращает один Job и один initial event;
- GET возвращает canonical persisted projection и controlled 404/invalid-data;
- SSE after `N` отдаёт persisted `N+1..M`, затем committed live `M+1` без gap и
  duplicate; каждый frame имеет exact numeric `id`;
- event, committed во время replay/live handoff, наблюдается ровно один раз;
- reconnect через `Last-Event-ID` продолжает с next sequence;
- conflicting `after`/`Last-Event-ID`, negative/fractional/overflow input и
  malformed body отклоняются до mutation/subscription;
- rolled-back mutation не создаёт SSE frame;
- два SSE clients получают одну canonical ordered sequence;
- terminal replay закрывает stream, включая reconnect уже после terminal tail;
- disconnect очищает subscriber без Job state change;
- slow reader не блокирует producer и восстанавливает gap из SQLite;
- cancel queued даёт canonical `cancelling → cancelled`; repeated cancel не
  добавляет event; active cancel остаётся `cancelling`; invalid edge не пишет;
- route/service errors не раскрывают DB SQL, prompt/reasoning/secrets или user
  filesystem paths;
- P1-A/P1-B migration/idempotency/append/transition/terminal races и
  P0-C/P0-D/P0-E gates остаются зелёными.

Non-goals:

- не подключать current Chat execution/messages к Job API;
- не добавлять worker, scheduler, queue admission, Resource Governor, leases,
  prewarm, unload или measured parallelism;
- не изображать queued Job как running/background execution;
- не реализовывать startup recovery non-terminal Jobs;
- не менять connection ownership текущего Chat POST/SSE;
- не добавлять web Job client, Runtime Bar, Jobs UI или notification flow;
- не менять model catalog/capabilities, Agent/MCP/Skills, retention, branding,
  locale или product IA;
- не добавлять migration 5 без нового persistence requirement;
- не переписывать SQLite migrations 1–4;
- не использовать live Ollama, реальную модель, public network или user DB.

Validation:

```bash
npm run typecheck
node --test packages/server/test/job-contract.test.ts \
  packages/server/test/job-migration.test.ts \
  packages/server/test/job-store.test.ts \
  packages/server/test/job-service.test.ts \
  packages/server/test/job-routes.test.ts
node --test packages/server/test/exclusive-inference.test.ts \
  packages/server/test/inference-concurrency.test.ts
node --test packages/server/test/catalog.test.ts \
  packages/server/test/runtime-contract.test.ts \
  packages/server/test/runtime-routes.test.ts \
  packages/server/test/ollama-client.test.ts \
  packages/server/test/inference-concurrency.test.ts
npm test --workspace @alamo/web
npm run test:web:browser
npm test
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

В финальном evidence укажи exact test counts, HTTP/SSE fixtures, disconnect и
reconnect envelope, а также число повторений race tests. Не называй mocked Hono
SSE полноценным browser reattach и не называй API durable Job Engine.

После успешной независимой проверки:

- обнови current-state runtime/HLD/LLD/testing docs;
- в `PHASE_STATUS.md` сохрани Phase 0/P1-A/P1-B evidence, добавь только P1-C;
- не отмечай всю Phase 1 завершённой;
- полностью перепиши `NEXT_AGENT_PROMPT.md` под P1-D durable execution owner и
  Chat bridge либо оставь P1-C с blocker/recovery;
- сделай небольшие conventional commits для contract/routes, tests и docs.

Если public idempotency scope, active cancel ownership, SSE terminal-close или
HTTP error semantics конфликтуют с принятым contract/ADR и требуют нового
product decision, не угадывай. Оставь P1-C blocked, укажи конфликтующие
источники, failing test/command и безопасные recovery steps.

В финале сообщи status `successful` либо `blocked`, commits, command/query/cancel
invariants, HTTP replay/live evidence, exact tests, failures, residual risks и
что `NEXT_AGENT_PROMPT.md` полностью переписан.
