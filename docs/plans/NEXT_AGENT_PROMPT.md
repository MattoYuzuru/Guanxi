# Handoff: Phase 3 / P3-P localization, Language and Glossary

**Статус:** ready for implementation
**Проверено:** 2026-08-14
**Назначение:** закрыть I18N-001..003 как bounded vertical slice: English
становится реальным primary/fallback locale, curated Russian остаётся полным
переводом, Settings управляет сохранённым Language и searchable Glossary, а
user-facing Web copy больше не обходится hardcoded strings.

## Сначала прочитать

1. `AGENTS.md`, `docs/NAVIGATION.md`, `docs/plans/WORKFLOW.md`.
2. `docs/PRODUCT.md` (I18N-001..003), `docs/GLOSSARY.md`,
   `docs/DOMAIN_MODEL.md`, `docs/UX_IA.md`.
3. `docs/DEVELOPMENT.md`, `docs/TESTING.md`, HLD/LLD и
   `docs/architecture/RUNTIME_LIFECYCLE.md`.
4. `docs/plans/PHASE_STATUS.md`, `docs/plans/ROADMAP.md`,
   `docs/plans/OPEN_QUESTIONS.md`, accepted D-011 и Q-11.
5. Current `packages/web/src/lib/locale.ts`, all `packages/web/src/**/*.tsx`,
   Settings contract/store/route и existing localized P2/P3 tests.

Используй `sde-agent:implementation-planning`, `sde-agent:sde-agent`,
`sde-agent:implementation-evidence`, `frontend-agent:frontend-agent` и
`frontend-agent:frontend-verification`. После candidate обязателен отдельный
read-only reviewer; findings исправляются отдельным commit.

## Current state и границы

- SQLite schema version 28; migrations только append-only. Existing `settings`
  key/value table можно расширять additive contract/store semantics без нового
  schema, если rollback/legacy default доказаны.
- Несколько новых surfaces используют `translate()`, но locale выбирается
  косвенно из `<html lang>`; App/Settings и другие старые screens всё ещё имеют
  user-facing hardcode. Это не выполнение I18N-002.
- English должен быть source/fallback. Missing Russian key не должен скрывать
  English copy или падать; missing English source key — controlled developer
  error/test failure, не пустая UI строка.
- `docs/GLOSSARY.md` — curated vocabulary source, но ещё не Settings UI.
- P3-O независимо подтверждён на `d62d208`; localization не должна менять
  attachment storage/admission либо другие runtime semantics.

## Bounded outcome P3-P

- Введи typed central locale catalog и provider/hook boundary без чтения global
  DOM в каждом вызове. Поддерживаются ровно `en` и `ru`; default/fallback —
  English. Locale меняет `document.documentElement.lang` и доступна всем
  screens без reload.
- Добавь additive strict Settings REST/state field для selected UI locale,
  сохранённый server-owned settings store. Legacy/missing value → `en`;
  malformed/future stored value fail-closed к sourced default и не выдаётся за
  user choice. Save/reload/restart возвращают exact locale.
- Переведи весь current Web user-facing copy на locale keys, включая App shell,
  Settings, errors/empty/loading/confirmations, aria-label/title/placeholder и
  browser-download fallback names. Technical identifiers, provider payload и
  user data не переводятся.
- Добавь Settings Language control с visible English/Russian labels и честным
  saved/pending/error/retry state. Переключение не должно запускать model,
  Governor, Job, tool, filesystem или network effects кроме Settings REST.
- Добавь searchable Glossary в Settings. Каждая entry имеет stable key, English и
  curated Russian term, plain-language definition и concrete example. Search
  locale-aware/case-insensitive, bounded и работает по term/definition/example;
  empty/no-results/error semantics доступны с клавиатуры.
- Сделай automated inventory guard, который падает при новом user-facing
  hardcoded JSX string/aria/title/placeholder в current Web. Исключения должны
  быть узкими, documented и машинно проверяемыми; broad disable запрещён.
- Сохрани responsive/accessibility boundary: keyboard, focus, semantic labels,
  390 px, 200%, forced colors и reduced motion. Locale change не теряет focus и
  не создаёт horizontal overflow.

## Non-goals

- runtime machine translation, browser locale auto-detection или новые locales;
- перевод provider/model/user-generated content, logs, API codes или secrets;
- locale-aware model routing/tokenization;
- desktop/CLI/TUI localization до соответствующего client slice;
- completion notifications, Workbench, Chat search/archive либо Project policy;
- произвольный rich-text glossary editor, remote glossary sync или analytics;
- P3-O storage, Artifact GC или attachment model consumption changes.

## Обязательные assertions

- strict settings contract: legacy missing → sourced `en`, exact `en`/`ru`
  round-trip, malformed/future/extra rejected or fail-closed without partial write;
- save/reload/reopen returns exact locale; lost response/retry does not duplicate
  mutation or show false state;
- every locale key has non-empty English source; Russian curated coverage is
  complete for all current user-facing keys; placeholder interpolation reports
  missing/extra variables deterministically;
- locale switch updates visible shell/current screen/aria labels and root
  `lang` once without full page reload or extra runtime effects;
- hardcoded-copy inventory fails on an injected JSX text, aria-label, title or
  placeholder and passes current source with only explicit technical exceptions;
- glossary entries have unique stable keys, both locales, definition/example;
  exact/mixed-case/no-result search and keyboard focus are asserted;
- English and Russian Settings/Glossary states cover loading, save error/retry,
  empty/no-results and hard reload;
- mocked Chromium proves 390 px/200%, keyboard, focus return, forced colors,
  reduced motion, no overflow and exact Settings request count;
- all current component/browser tests are updated to query localized accessible
  names rather than bypassing the locale boundary;
- exact zero Ollama/Governor/Job/tool/workspace/file/provider effects.

Mutation-check минимум: fallback locale branch, missing-key guard, persisted
locale read, glossary search predicate, hardcoded-copy detector и request-count
assertion.

## Gates и handoff

```bash
npm run typecheck
npm test
npm run test:web:browser
npm run build
npx markdownlint-cli2 AGENTS.md README.md packages/cli/README.md "docs/**/*.md"
git diff --check
```

После independent `READY` обнови current-state docs и `PHASE_STATUS.md` с
new/regression envelope. Следующий slice выбирай из подтверждённых phase-wide
gaps, приоритетно P3-Q terminal Job notifications, а не объявляй Phase 3
завершённой. Mocked Chromium не является production/user validation.
