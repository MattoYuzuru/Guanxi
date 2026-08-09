# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-09

**Назначение:** Phase 2 slice P2-M — импорт verified P2-L staging GGUF в
локальный Ollama через documented `/api/create`, exact post-create observation и
controlled completion probe; P2-N feature flags не начинать

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current-state HLD/LLD, `DEVELOPMENT.md`,
`TESTING.md`, `architecture/RUNTIME_LIFECYCLE.md`, ADR-0003/0006,
`research/EVIDENCE.md`, `plans/PHASE_STATUS.md`, `plans/ROADMAP.md`,
`plans/OPEN_QUESTIONS.md` и accepted owner decisions.

Зафиксируй clean starting revision после P2-L docs commit, status и последние
commits. P2-L implementation/fixes — `8bb65c9` и `e1d4e66`. До edits составь
bounded plan по `WORKFLOW.md` и явно выбери lifecycle import/cancel/reconcile.
Не называй операцию durable/replayable/resumable без новой доказанной semantics.

До проектирования проверь актуальную официальную Ollama API/import документацию
и текущую local adapter shape. Не копируй CLI syntax в HTTP contract по памяти:
зафиксируй точные `/api/create` request/stream/terminal/cancel semantics и версию
источника. Если они не подтверждаются, оставь typed blocker, а не shell fallback.

## Baseline P2-L

- exact target — HF identity + lowercase 40-hex commit + portable-safe GGUF path;
- server повторно подтверждает target и строит download URL сам;
- P2-L принимает только full HTTP 200 через exact HTTPS/443 host set, stream-ит
  в generated managed staging, считает SHA-256 и проверяет GGUF v2/v3 header;
- completed provenance содержит exact source tuple, sizes, checksum relation,
  GGUF format, artifact UUID и observedAt, но не Installation/capability proof;
- download connection-owned, без Job/SQLite/replay/resume; hard crash может
  оставить orphan partial, duplicate writer только process-local;
- Web показывает verified staging artifact без Install/Create/Pull;
- baseline: 504/504 core, 167/167 Web, 28/28 mocked Chromium.

Live HF/Ollama/GPU и большие файлы P2-L не проверялись. Official HF host set
подтверждён документацией, но live redirect chain заблокирован egress HTTP 503.

## Outcome P2-M

После P2-L completed пользователь отдельным явным действием задаёт/подтверждает
безопасное local Ollama model reference. Server использует только server-owned
verified staging artifact, создаёт внутренний import request/Modelfile через
documented Ollama `/api/create`, наблюдает terminal create, заново подтверждает
exact installed reference/digest через provider facts и выполняет существующий
controlled completion probe. Только после всех наблюдаемых шагов UI может
показать Installed + probe result с provenance.

## Обязательные границы

1. Web не передаёт filesystem path, raw Modelfile, arbitrary create parameters,
   provider URL или shell command. Artifact UUID разрешается только через
   server-owned handoff, связанный с P2-L provenance; claims от Web не являются
   доказательством. Если для этого нужен sidecar/in-memory registry, опиши его
   ownership, restart, tamper и cleanup semantics и покрой assertions.
2. Перед create server заново открывает artifact внутри managed staging без
   symlink/path escape, проверяет identity/manifest, size, SHA-256 и GGUF header.
   TOCTOU replacement или missing/corrupt artifact fail-closed до Ollama call.
3. Target Ollama reference проходит существующую strict normalization boundary.
   Не перезаписывай существующую model/tag молча: pre-existing, changed или
   ambiguous target получает typed conflict/refusal. No-overwrite либо explicit
   confirmation должны быть доказаны contract и tests.
4. Используй documented local Ollama HTTP adapter, не `ollama` shell и не HF
   `pull`. Bounded connect/stream-idle/overall deadlines, response/frame limits,
   terminal protocol validation, redaction и AbortSignal обязательны.
5. `create` terminal status сам по себе не доказывает Installation. После него
   перечитай `/api/tags`/descriptor и свяжи exact normalized reference с новым
   digest. Missing/ambiguous/changed identity не становится success.
6. Completion probe использует существующий fixed controlled probe и Governor
   semantics; не дублируй probe protocol и не обходи exact digest/runtime/context
   key. Provider declaration, user override и probe evidence остаются разными.
7. Cancel/disconnect race с Ollama create обязан reconciliate provider state.
   Нельзя сообщить чистый `cancelled`, если target уже появился или outcome
   unknown. Не удаляй чужую/pre-existing model. Повторный intent не должен
   запускать второй create для того же artifact/target.
8. Определи staging retention до кода: success cleanup только после exact
   installed observation/provenance commit; failure/cancel/retry не удаляет
   чужие файлы и не оставляет ложный usable artifact. Hard crash и restart
   behavior назови честно. Не добавляй GC/общий Artifact Service сверх slice.
9. Provenance связывает HF identity/commit/path, staging SHA-256/GGUF, target
   Ollama reference, observed installed digest/runtime, create terminal evidence,
   probe outcome и timestamps. Не выводи tools/vision/thinking/media либо
   semantic quality из GGUF header или одного completion probe.
10. Gated/token/license acceptance, safetensors conversion, arbitrary Modelfile,
    remote Ollama, model deletion/overwrite UI, generic Artifact Service и P2-N
    feature flags вне P2-M.

## Contract и UX

- Contract/server/Web меняются согласованно; states strict, redacted и отделяют
  preparing/importing/verifying/probing/completed/cancelled/conflict/failed.
- Import/Create появляется только для current P2-L completed artifact и требует
  отдельного explicit action. Duplicate activation collapses.
- UI показывает target reference, источник staging artifact, create/probe phase,
  typed conflict/reconciliation и terminal provenance. До fresh `/api/tags`
  observation нельзя писать Installed; до probe нельзя писать runtime verified.
- Focus/live region, keyboard cancel/retry, narrow viewport, 200%, reduced motion,
  English fallback и curated Russian обязательны. Все strings — locale keys.
- Local Marketplace/Installed rows сохраняются при Ollama/create/probe failure;
  refresh выполняется только после observed success и не дублирует exact row.

## Тестовый envelope

Не используй live большую модель. Нужны generated temp staging и deterministic
fake Ollama streams с маленьким synthetic GGUF, включая:

- server-owned artifact handoff, missing/foreign/symlink/replaced/corrupt file;
- checksum/size/header revalidation перед единственным create call;
- strict target grammar, pre-existing/changed/ambiguous target и no-overwrite;
- exact documented create body без arbitrary options/path leakage;
- progress, malformed/regressing frames, missing terminal, provider error и
  connect/idle/overall timeout;
- cancel до create, mid-stream, after terminal и during reconciliation; late
  frame/stale retry не меняет новый state;
- post-create `/api/tags` missing/ambiguous/exact digest и descriptor projection;
- controlled probe queued/running/success/failure/cancel с Governor release;
- staging cleanup/retention на каждом terminal edge и restart semantics;
- exact count assertions: one artifact/target → at most one create, one Installed
  row, one probe, no HF download/pull/shell/catalog mutation;
- browser success/failure/conflict/cancel/retry, focus/live, responsive/motion и
  absence of duplicate or premature Installed/runtime claims.

Каждое ROADMAP/документированное свойство получает assertion, которое падает при
нарушении. Добавь mutation checks минимум для path ownership, checksum recheck,
no-overwrite, create terminal validation, post-create identity, cancel reconcile,
probe boundary и no-shell/no-pull.

Если Web меняется, обязательны exact component/browser cases и полный gate:

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
`plans/WORKFLOW.md`: server/Ollama adapter/filesystem lifecycle и Web/a11y.
Validate findings, исправь их отдельным fix commit и повтори gates.

Сделай небольшие conventional commits: feature, отдельный verification fix и
current-state docs. Обнови `plans/PHASE_STATUS.md` с real new/regression envelope,
commit hashes, first failures и residual risks. Полностью перепиши этот prompt
на P2-N только если все gates green; иначе оставь P2-M blocked с recovery steps.

В финале сообщи `status successful` только если implementation, independent
verification, browser/root gates, docs и commits реально завершены.
