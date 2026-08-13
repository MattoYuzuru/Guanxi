# Handoff: Phase 3 / P3-N generic Artifact and blob foundation

**Статус:** ready for implementation
**Проверено:** 2026-08-14
**Назначение:** реализовать bounded P3-N — общий immutable Artifact metadata и
content-addressed local blob writer, на котором следующие slices смогут строить
attachments/export/results без произвольного filesystem доступа.

## Сначала прочитать

1. `AGENTS.md`, `docs/NAVIGATION.md`, `docs/plans/WORKFLOW.md`.
2. `docs/PRODUCT.md`, `docs/DOMAIN_MODEL.md`, `docs/UX_IA.md`.
3. `docs/DEVELOPMENT.md`, `docs/TESTING.md`, `docs/architecture/HLD.md`,
   `docs/architecture/LLD.md` и `docs/architecture/RUNTIME_LIFECYCLE.md`.
4. `docs/plans/PHASE_STATUS.md`, `docs/plans/ROADMAP.md`,
   `docs/plans/OPEN_QUESTIONS.md` и accepted decisions.
5. Current Reasoning Artifact (`reasoning_artifacts`) и staged GGUF download/
   import paths: это evidence и compatibility boundaries, но не разрешение
   переименовать либо смешать их с новым generic store.

Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
`sde-agent:implementation-evidence`, `architecture-agent:architecture-migration`
и `sre-agent:verification-strategy`. После implementation обязателен отдельный
read-only reviewer по `plans/WORKFLOW.md`; findings исправляются отдельным
commit.

## Current state и границы

- SQLite schema version 25; migrations только append-only.
- `reasoning_artifacts` — специальный SQLite-text diagnostic store с собственным
  expiry/audit. Не мигрируй и не выдавай его за generic blob Artifact.
- Hugging Face staging — connection/process-owned import boundary, не общий
  пользовательский Artifact store.
- Server один владеет SQLite/filesystem. Web не получает raw path.
- Default server loopback-only; никаких новых network/tool/Ollama effects.
- P3-M независимо подтверждён на `1546537`: stored history и context checkpoint
  не входят в P3-N migration.

## Bounded outcome P3-N

- Добавь append-only migration 26 для strict versioned generic Artifact metadata
  и content-addressed blob reference. Минимальные поля: UUID, kind/media type,
  exact byte size, `sha256:<hex>`, immutable storage key, nullable immutable
  Project/Job/source Artifact ownership/derivation, created time и explicit
  retention/reference state. FK/delete policy должна быть намеренной и
  проверенной, без silent cross-Project ownership.
- Реализуй server-owned `ArtifactStore`/writer boundary: bounded stream/bytes
  поступают во временный файл внутри dedicated Alamo data root, SHA-256 и size
  считаются server-side, commit использует atomic rename в content-addressed
  location. Caller не задаёт path/storage key/checksum как факт.
- Blob dedup допустим только по exact bytes/hash; metadata identities остаются
  отдельными. Existing blob никогда не перезаписывается. Interrupted/failed
  write не создаёт committed metadata и не оставляет externally readable partial.
- Согласуй filesystem/SQLite failure order. После crash-like orphan между rename
  и DB commit recovery должен быть bounded и безопасным: либо deterministic
  reconciliation, либо explicit non-readable orphan inventory с последующим
  cleanup owner. Нельзя объявить transaction atomic между FS и SQLite без
  доказательства.
- Добавь strict server-only create/read metadata/content boundary для test/use by
  following slices. Download разрешает только validated Artifact ID и server
  storage key, задаёт exact media type/length/checksum headers, не принимает raw
  filesystem path и не раскрывает absolute data root. Project/projectless scope
  fail-closed; Range/streaming можно оставить отдельным non-goal, если это явно
  отражено.
- Добавь explicit reference/deletion foundation: direct metadata mutation и
  удаление referenced blob запрещены; GC не удаляет blob, пока существует хоть
  одна canonical reference либо in-flight writer. Если full GC вынесен дальше,
  projection честно говорит `gc=not_implemented` и тесты не обещают cleanup.
- Не добавляй Web attachment UI в этом slice. Новый public API допустим только
  если он нужен следующему vertical slice; legacy responses остаются byte-
  compatible.

## Non-goals

- Chat attachment picker/upload UX, drag/drop, image preview и export UI;
- Recipe/Quick Run execution, Workbench routing или OperationDescriptor registry;
- conversion/OCR/STT/image generation;
- migration Reasoning Artifact либо P3-M checkpoint в generic rows;
- TTL Trash hard deletion, Project deletion, generic live GC scheduler;
- remote/object storage, encryption/keychain, network upload, resumable/range
  protocol;
- arbitrary raw-path file serving или client-provided trusted checksum/path.

## Обязательные assertions

- migration 26 fresh/v25→v26/reopen/retry/true rollback с exact v25 rows;
- strict contract rejects future/unknown fields, invalid media/kind/hash/size,
  cross-Project/source derivation и client storage path;
- exact bytes → exact SHA-256/size; Unicode/binary/empty/maximum boundary;
- temp file stays inside dedicated root, symlink/path traversal cannot redirect
  commit/read, absolute path never appears in response/error/log fixture;
- concurrent identical bytes: one immutable blob, distinct intended metadata,
  no overwrite; concurrent same metadata intent is idempotent or conflicts
  deterministically;
- injected temp-write/hash/fsync/rename/DB insert/read failure leaves no readable
  partial or false metadata; retry converges;
- pre-existing hash collision/mismatched size/content fails closed rather than
  trusting filename;
- read by exact scoped Artifact ID returns the committed bytes once with correct
  headers; unknown/cross-scope/raw-path access is rejected;
- referenced/shared blob cannot be deleted; unreferenced/orphan state is honest;
- zero Ollama/Governor/Job execution/tool/workspace/user-file effects;
- current reasoning, Chat retention/deletion, HF staging/import and P3-M context
  checkpoint regression remain green.

Mutation-check минимум: checksum comparison, path containment, rename-before-DB
failure, scope predicate, shared-reference delete guard и response redaction.

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
new/regression envelope и полностью перепиши этот prompt на P3-O attachment
upload/download/export vertical slice. Если atomic filesystem/SQLite ordering
нельзя доказать, оставь P3-N blocked с точным orphan window и recovery plan — не
называй two-resource write атомарным.
