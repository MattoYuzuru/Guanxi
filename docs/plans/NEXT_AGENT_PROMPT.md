# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-11

**Назначение:** продолжить Phase 3 bounded slice P3-F — заложить typed
Reasoning Artifact persistence и отделить новые terminal thinking records от
final answer; не расширять slice до expiry deletion, generic binary Artifact
store или Chat search/archive

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current HLD/LLD, `DEVELOPMENT.md`, `TESTING.md`,
`architecture/RUNTIME_LIFECYCLE.md`, ADR-0005/0007,
`plans/PHASE_STATUS.md`, `plans/ROADMAP.md`, `plans/OPEN_QUESTIONS.md` и accepted
owner decision D-010/Q-10.

Зафиксируй clean starting revision/status и последние commits. P3-E реализован
commits `01c8b3f`, `da7519a`, review fix `fed4ac6`: **9 new / 589 core**, **6
new / 197 Web**, **1 new / 33 mocked Chromium**. Full typecheck, tests, browser
gate, build, markdownlint и diff-check прошли; follow-up independent reviewer
дал READY. Это synthetic/mock evidence, не production migration corpus,
concurrent-client, real screen-reader/device или live Ollama/GPU validation.

## Bounded outcome P3-F

Реализовать минимальный diagnostic Reasoning Artifact vertical slice:

- append-only migration начинается поверх v15 и не переписывает migrations
  1–15;
- contract вводит versioned sourced reasoning Artifact projection с immutable
  identity, source Job/Message/Chat, media type, byte size, checksum, createdAt,
  retention basis `7 days`, parent-retention relationship и storage kind;
- новые terminal assistant reasoning bytes сохраняются отдельно от final answer
  в атомарной Message/Job terminal transaction; один Job/Message владеет не
  более чем одним canonical reasoning Artifact;
- final answer остаётся в Message content. Новые terminal rows не дублируют
  reasoning bytes в `messages.thinking`; legacy rows с existing thinking
  продолжают читаться без destructive backfill;
- raw legacy Message REST/SSE shape остаётся совместимым: для нового terminal
  Message поле `thinking` проецируется из Artifact, для legacy — из прежнего
  column. Versioned Artifact boundary является canonical additive read surface;
- pending/replay streaming продолжает показывать thinking из bounded private Job
  output; terminal reload сходится на persisted Artifact без duplicate bytes;
- Chat Info отдельно показывает generated answers и reasoning Artifacts с exact
  sourced expiry, copy/export-safe text и truthful state `automatic deletion not
  implemented`;
- Artifact read/list строго scoped к exact Chat и immutable ownership, включая
  Project/projectless isolation; Trash Chat не протекает в active Chat surface;
- malformed/future/cross-Chat identity fail closed и ничего не меняют;
- ни persist/read/copy, ни Chat Info не запускают Ollama, Governor, tools,
  filesystem, network provider, analytics или cleanup side effects;
- EN source/fallback и curated RU используют locale keys; loading/empty/error/
  retry, keyboard/focus, long content, 390 px, 200%, forced colors и reduced
  motion доступны.

До edits инвентаризируй terminal Message/Job transaction, private output replay,
все Message serializers, compaction inputs, Chat Info ownership checks и текущую
semantics `messages.thinking`. Явно опиши compatibility read policy и checksum/
byte-size algorithm. Не вводи скрытый reasoning size ceiling: limits должны
приходить из runtime/policy, а persistence обязана fail atomically.

## Non-goals

- automatic reasoning expiry/deletion, Maintenance integration и Trash/grace;
- удаление legacy `messages.thinking` column или массовый backfill старой БД;
- arbitrary user delete/rename reasoning Artifact;
- generic content-addressed filesystem/blob GC, attachments или media preview;
- text/file/image/audio/video/document/checkpoint/report Artifact types кроме
  contract-safe foundation, необходимой reasoning;
- изменение Chat retention, Session leave/24-hour recovery или hard deletion;
- Quick Run persistence, Recipe, Project defaults, search/archive/move/reparent;
- reasoning export с tool credentials/secrets или unrestricted host paths;
- final navigation shell, brand rename, Phase 4 service/CLI/TUI и live provider.

Не называй reasoning cleanup реализованным: P3-F делает новые reasoning bytes
отдельно persisted и независимо адресуемыми, но не удаляет их по времени.

## Обязательные assertions

Минимум должны падать при нарушении:

- fresh, v15→next, reopen и retry создают schema ровно один раз; mid-migration
  failure откатывает schema/data и сохраняет exact legacy payload;
- legacy terminal Message с `thinking` читается literal compatible без Artifact;
- новый terminal Message атомарно создаёт ровно один reasoning Artifact, хранит
  final answer отдельно и не дублирует reasoning в Message column;
- zero-thinking terminal Message не создаёт пустой Artifact;
- failed/cancelled/interrupted terminal partial reasoning policy определена
  явно и проверена для каждого state;
- injected Artifact write/checksum failure не публикует terminal Job/Message и
  retry создаёт один canonical Artifact;
- duplicate terminalization/replay/reload не создаёт второй Artifact и не
  меняет checksum/timestamps;
- byte size/checksum считаются по exact UTF-8 bytes для ASCII, Unicode и long
  reasoning без произвольного truncation;
- legacy Message projection нового row берёт exact Artifact bytes, versioned
  Artifact boundary возвращает source/provenance/expiry без private Job input;
- Project/projectless и Chat A/Chat B list/read isolation имеют exact count/order;
- Trash Chat не виден через active nested surface, но lifecycle не удаляет
  Artifact;
- compaction/context сохраняет текущее явно принятое поведение и не теряет final
  answer при отсутствии/ошибке Artifact;
- hard reload сходится с streamed thinking на один terminal Artifact; UI
  различает answers/reasoning, exact expiry и no-cleanup state;
- loading/error получают focused safe retry; copy не включает final answer,
  prompt, tool credentials или другой Chat;
- persistence/read/UI не вызывают provider, Governor, tool, filesystem, network,
  analytics или cleanup effects.

Сделай mutation checks минимум для migration rollback, terminal atomicity,
reasoning/final swap, duplicate Artifact, checksum bytes, legacy projection и
cross-Chat leakage. Каждое свойство, заявленное в docs/ROADMAP, должно иметь
direct assertion.

## Gates

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

Browser gate обязателен. Не выдавай jsdom/Chromium fixtures за real device,
screen-reader, production migration corpus или user validation.

## Workflow и handoff

После implementation запусти отдельную read-only independent verification по
`plans/WORKFLOW.md`: reviewer проверяет exact diff, migration/rollback,
terminal transaction, compatibility projection, duplicate ownership,
checksum/size, Chat isolation и Web accessibility. Findings исправляет автор
отдельным `fix(...)`/`test(...)` commit.

Сделай небольшие conventional commits: contract/migration/application,
Web/tests, review fix и current-state docs. Обнови `plans/PHASE_STATUS.md` с real
new/regression envelope, first failures, independent verdict и residual risks.
Перепиши этот файл на следующий незавершённый P3 slice; при blocker оставь P3-F
с exact evidence и recovery steps.
