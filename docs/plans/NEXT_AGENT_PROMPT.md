# Prompt для следующего агента

**Статус:** ready

**Проверено:** 2026-08-09

**Назначение:** Phase 2 slice P2-L — bounded cancel-safe download exact HF GGUF
с checksum, format inspection и provenance; P2-M local Ollama import ещё не
начинать

## Сначала

Работай в `/Users/m.ryabushkin/Projects/alamo-ui`. Прочитай `AGENTS.md`,
`docs/NAVIGATION.md`, обязательный `plans/WORKFLOW.md`, затем `PRODUCT.md`,
`DOMAIN_MODEL.md`, `UX_IA.md`, current-state HLD/LLD, `DEVELOPMENT.md`,
`TESTING.md`, `architecture/RUNTIME_LIFECYCLE.md`, ADR-0003/0006,
`research/EVIDENCE.md`, `plans/PHASE_STATUS.md`, `plans/ROADMAP.md`,
`plans/OPEN_QUESTIONS.md` и accepted owner decisions.

Зафиксируй clean starting revision после docs commit, `git status --short` и
последние commits. P2-K implementation/verification уже находятся в `9f3990d`
и `9f3f19c`; не переделывай exact-selection contract без доказанного P2-L
требования.

До edits создай bounded plan по `plans/WORKFLOW.md`. Отдельно зафиксируй решение,
какой существующий lifecycle используется для download/cancel/recovery. Не
называй connection-owned операцию durable/resumable после process restart и не
вводи новую persistence semantics молча.

## Baseline P2-K

- strict exact target: canonical HF identity, lowercase 40-hex commit и один
  portable-safe exact `.gguf` path;
- selection re-read использует anonymous bounded exact-revision endpoint с
  `blobs=true` и fail-closed inventory/revision membership;
- claimed size nullable и не является checksum либо measured fit;
- Web требует explicit Select и пока не показывает Download/Install/Pull;
- selection не создаёт Job, staging file, catalog entry, Installation или
  Ollama side effect;
- exact server P2-K 29/29, root core 475/475, Web 161/161, exact browser 2/2,
  полный mocked Chromium 27/27.

Raw live HF JSON 2026-08-09 не получен: внешний egress filter отвечает HTTP 503
HTML-страницей «Сайт заблокирован». Official docs/source подтверждают exact
revision и `files_metadata=True → blobs=true`, но provider wire/redirect hosts
не production-validated.

## Outcome P2-L

Пользователь после подтверждённого P2-K target может явно начать download и
отменить его. Server скачивает только этот exact immutable revision/file в
managed staging/cache boundary, считает checksum во время bounded stream,
проверяет GGUF format и публикует provenance. Успех ещё не устанавливает модель
в Ollama и не делает её runtime-capable.

## Обязательные границы

1. Не принимай arbitrary provider URL от Web. Server строит resolve request из
   validated identity/commit/path; owner/name и каждый path segment кодируются
   отдельно, `/` между segments сохраняется. Raw `rfilename` не интерполируется
   в URL.
2. Commit pin — revision repository tree, не checksum файла. Если exact HF
   metadata содержит trusted-shape LFS SHA-256, различай expected provider claim
   и locally observed digest. Если upstream digest отсутствует, local checksum
   остаётся observed fact, а не upstream verification.
3. Redirect policy должна быть explicit и fail-closed: только HTTPS и
   подтверждённые official HF download/CDN hosts, bounded redirect count, без
   credential forwarding на другой origin. Не разрешай arbitrary redirect по
   одному suffix-match. Если current official host set нельзя подтвердить,
   оставь typed refusal/blocker, а не широкий allowlist.
4. Stream имеет timeout, maximum bytes, expected-size checks и ограниченную
   память; whole GGUF нельзя буферизовать. `Content-Length` optional/untrusted.
   Range/resume разрешён только с доказанной validator/revision coherence;
   иначе безопасно начать заново.
5. Staging filename генерируется server-ом и не происходит от remote path.
   Защити collision/symlink/path normalization, используй temporary write,
   checksum/format validation и atomic finalization. Cancel/error удаляет owned
   partial data; не удаляй чужой или уже committed blob.
6. Минимальная GGUF inspection проверяет magic и bounded header/format version.
   Не обещай semantic/model compatibility, пока P2-M probe не выполнен.
7. Provenance содержит exact identity, revision, remote path, source URL policy,
   expected/observed size, checksum algorithm/digest, verification relation,
   observedAt и terminal state. Capability, fit и installability не выводятся из
   download success.
8. Gated/private/token flows, license acceptance, safetensors conversion,
   direct HF `ollama pull`, `/api/create`, probe, catalog install и Governor —
   вне P2-L.

## Contract и UX

- Contract/server/Web меняются согласованно; все result/failure/cancel states
  strict и redacted.
- Download появляется только после current confirmed P2-K target и отдельного
  explicit action. Duplicate activation не запускает второй writer.
- UI различает preparing/downloading/verifying/completed/cancelled/refused/
  failed, восстанавливает focus, имеет scoped polite live state и сохраняет
  local Marketplace при provider offline.
- Progress не должен симулировать точность без наблюдаемых bytes/total.
  Unknown total остаётся unknown.
- Успех формулируется как downloaded/verified staging artifact, не Installed и
  не ready to run. Никакой Install/Create action до P2-M.
- Новые user-facing strings проходят locale keys: English source/fallback и
  curated Russian. Проверь keyboard, reduced motion, narrow viewport и 200%.

## Тестовый envelope

Не качай большую live-модель. Используй deterministic loopback fixtures с
маленьким synthetic GGUF и отдельными cases для:

- exact segment encoding, spaces/Unicode/percent и traversal regressions;
- allowed redirect и hostile origin/downgrade/redirect-loop refusals;
- known/unknown/mismatched length, over-limit stream и slow timeout;
- expected SHA-256 match/mismatch и locally observed-only checksum;
- bad/truncated GGUF magic/header/version;
- cancel на metadata, redirect, body stream и verification с cleanup;
- duplicate intent, stale selection/context, late response и no side effects;
- generated staging names, collision/symlink defense и atomic finalization;
- absence of Ollama create/pull/probe, catalog mutation, Installation и Governor
  work.

Каждое exit property получает assertion, который падает при его нарушении.
Добавь mutation checks минимум для redirect allowlist, byte limit, checksum,
GGUF validation, cancellation cleanup и no-Ollama boundary. Filesystem tests
используют только generated temp directories.

Если Web меняется, обязательны exact component/browser cases и полный
`npm run test:web:browser`. Затем выполни минимум:

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
`plans/WORKFLOW.md`: server/security/filesystem и frontend reviewers, если Web
затронут. Validate findings, исправь их отдельным fix commit и повтори gates.

Сделай небольшие conventional commits: feature, отдельный verification fix и
current-state docs. Обнови `plans/PHASE_STATUS.md` с real new/regression envelope,
commit hashes, first failures и residual risks. Полностью перепиши этот prompt
на P2-M только если все обязательные gates green; иначе оставь P2-L со статусом
blocked, точной ошибкой и recovery steps.

В финале сообщи `status successful` только если implementation, independent
verification, browser/root gates, docs и commits реально завершены.
