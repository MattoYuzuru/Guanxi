# Handoff: Phase 3 / P3-O attachment upload, download and export

**Статус:** ready for implementation
**Проверено:** 2026-08-14
**Назначение:** реализовать первый public vertical slice поверх P3-N: безопасно
загрузить local attachment в exact Project/projectless scope, увидеть committed
metadata, скачать/export-нуть ровно этот Artifact и пережить retry/reload без
raw filesystem доступа или ложного обещания model consumption.

## Сначала прочитать

1. `AGENTS.md`, `docs/NAVIGATION.md`, `docs/plans/WORKFLOW.md`.
2. `docs/PRODUCT.md`, `docs/DOMAIN_MODEL.md`, `docs/UX_IA.md`.
3. `docs/DEVELOPMENT.md`, `docs/TESTING.md`, `docs/architecture/HLD.md`,
   `docs/architecture/LLD.md`, `docs/architecture/RUNTIME_LIFECYCLE.md`.
4. `docs/plans/PHASE_STATUS.md`, `docs/plans/ROADMAP.md`,
   `docs/plans/OPEN_QUESTIONS.md` и accepted owner decisions.
5. P3-N commits `172e1ac..0fef5a1`, generic contract/store/tests и SRE finding
   про prefix-directory TOCTOU. Не ослабляй descriptor-relative boundary.

Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
`sde-agent:implementation-evidence`, `architecture-agent:architecture-migration`
и `sre-agent:verification-strategy`. После candidate обязателен отдельный
read-only reviewer; findings исправляются отдельным commit.

## Current state и границы

- SQLite schema version 26; migrations только append-only.
- `ArtifactStore` принимает strict metadata + bytes, вычисляет hash/size/storage
  key сам, deduplicate-ит blob и хранит immutable Artifact identity.
- Post-publish/pre-DB orphan явно нечитабелен и виден только bounded inventory;
  generic GC всё ещё `not_implemented`.
- Один short-lived Node helper на store read/write закрывает directory-swap race,
  но требует bounded admission перед public high-volume endpoint.
- `reasoning_artifacts`, context checkpoints и HF staging остаются отдельными
  compatibility/lifecycle boundaries.
- Server loopback-only и один владеет filesystem/SQLite. Web не получает raw
  path. Authentication/TLS/remote exposure вне Phase 3.
- Chat/Recipe/Quick Run adapters ещё не потребляют generic attachment. UI не
  должен утверждать, что upload уже добавил файл в model context.

## Bounded outcome P3-O

- Добавь strict versioned REST contract для upload, scoped metadata read/list и
  download/export. Transport принимает bytes как body/stream и typed metadata
  отдельно; client не задаёт trusted checksum, storage key или filesystem path.
- Введи явную server storage/upload policy projection с source и наблюдаемым
  `maxBytes`; это resource-policy bound, а не model capability или скрытый UI
  ceiling. Unknown/disabled policy должен быть видим и fail-closed.
- Ограничь одновременно активные upload/download helpers bounded admission.
  Отмена/disconnect освобождает permit и temp; queued request не запускает
  helper. Не называй endpoint resumable или durable.
- Если user filename нужен для export, храни только sanitized display metadata в
  новой append-only migration 27/immutable side table. Filename никогда не
  участвует в storage path; control characters, separators, bidi controls и
  header injection отклоняются либо канонически заменяются с visible result.
- POST использует stable UUID intent. Lost response/retry exact bytes+metadata
  возвращает один Artifact; changed body/metadata конфликтует. Upload не
  оставляет public row до полного commit.
- GET/list требуют exact Project/projectless scope. Download/export принимает
  только validated Artifact ID, возвращает exact `Content-Type`,
  `Content-Length`, `Digest`, `ETag`, safe `Content-Disposition` и bytes once.
  Cross-scope/unknown/corrupt/missing blob выглядит недоступным и не раскрывает
  existence/path. Range остаётся explicit unsupported, если не реализован.
- Добавь локализованный Web attachment library/tray для exact current scope:
  pick/drop, progress/cancel, success/error/retry, empty/loading/offline, reload,
  download/export и truthful «не добавлено в model context». Не связывай upload
  с Chat send либо Recipe execution молча.
- Keyboard, focus return, 390 px/200%, forced colors, reduced motion и duplicate
  count должны иметь direct component/browser assertions.

## Non-goals

- фактическое добавление attachment в Chat prompt/model context;
- OCR/STT/caption/conversion, preview generation или media inference;
- Recipe/Quick Run execution и Workbench/OperationDescriptor routing;
- resumable/chunked session protocol, Range, remote/object storage;
- generic GC/deletion/TTL, Project deletion или orphan cleanup scheduler;
- migration existing Reasoning Artifact/checkpoint/HF staging;
- arbitrary path serving, shell calls, network fetch или trusting MIME/filename
  as verified content semantics.

## Обязательные assertions

- migration 27 fresh/v26→v27/reopen/retry/true rollback с exact v26 rows;
- strict REST/header/query contract rejects extra/future/path/checksum/storage,
  malformed UUID/scope/media/filename/size and duplicate parameters;
- empty/Unicode/binary/exact policy boundary/over-bound upload; streamed count,
  server checksum и committed size совпадают;
- same intent exact retry → one metadata/blob; changed bytes/metadata → conflict;
  concurrent duplicate/different intents converge deterministically;
- disconnect/cancel/queue/full-admission/helper failure освобождает permit/temp и
  не создаёт false metadata; no unbounded waiter/listener/process growth;
- scope isolation, unknown ID, corrupt/missing/symlink blob, directory swap и
  absolute-path/header redaction fail closed;
- exact headers/content and safe Content-Disposition; no CRLF/path separator;
  Range rejection проверена, если Range не реализован;
- Web counts one uploaded item after lost POST response, retry and hard reload;
  download activated once; focus/progress/error/cancel/mobile/a11y direct asserts;
- zero Ollama/Governor/Job execution/tool/workspace/user-file/network effects;
- P3-N security suite, reasoning retention/deletion, HF staging/import,
  checkpoint и current full gates остаются green.

Mutation-check минимум: size counter, idempotency body comparison, scope
predicate, admission release, Content-Disposition sanitizer, directory identity
check и duplicate DOM count.

## Gates и handoff

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

После independent `READY` обнови current-state docs, `PHASE_STATUS.md` с
new/regression envelope и перепиши этот prompt на следующий ещё не закрытый
Phase 3 slice. Не называй mocked Chromium production validation и не выдавай
upload за model attachment consumption.
