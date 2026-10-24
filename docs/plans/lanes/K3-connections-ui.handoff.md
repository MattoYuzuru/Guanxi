# K3 connections centre and model picker handoff

**Status:** implemented and locally validated; independent review fix round applied; browser/visual gates not run.
**Date:** 2026-10-24 · **Branch:** `lead/k3-connections-ui` · **Base:** `6fac2923` · no push.

## What exists

- **Server removal.** `DELETE /api/connections/:id` returns `{ id }`, hides the connection from
  snapshots, model/connection pickers and the cost projection, and keeps the append-only cost
  ledger row. Migration 4 appends the dotenv name family; migration 5 adds only
  `removed_connections`; versions 1–3 are unchanged. A lane data directory created by the
  pre-merge lane build, where version 4 meant `removed_connections`, is lane-only and never
  shipped: discard such lane data dirs; there is no repair code. The dotenv mapping is deleted,
  so a later trusted import creates a new identity. The vault record
  is retained and the node-key copy is deleted; a fresh activation still registers the retired
  value with the egress scrubber. The route refuses with `connection_in_use` (409) while this
  registry has an active `complete()`, `localChat()` or `dispatchAgent()` call. It does not inspect
  durable relay/lead/session state owned outside this process. Budget checks read the complete
  append-only receipt ledger, so removing a connection never resets side-chat spend; only the
  public cost projection hides the removed rows.
- **Auto Ollama removal.** A removed `origin: local_runtime_auto` row suppresses recreation on
  every later apply, including after restart. The catalog card then offers Connect, which
  re-creates an ordinary local-runtime row through `POST /api/connections`; the remove dialog
  says the row stays gone until that catalog action.
- **K5 bindings.** `capabilities()` skips installations whose connection was removed instead of
  throwing for every caller; a project role that still names that connection fails only when
  resolved.
- **Contract.** `connection_in_use` joins the connection error codes (and the legacy
  `apiError`/`turnError` projections), `deleteConnectionResponseSchema` names the removed id,
  and `connectionModelsSchema` validates the `GET /:id/models` response.
- **Endpoint models.** `GET /:id/models` now returns discovered IDs for a pinned endpoint,
  local `/api/tags` models for a local runtime and pi-ai catalog facts otherwise.
- **C1 Connections centre (web).** `/connections` is a route and a shell destination (Settings
  still links to it). The view is catalog-driven: a desktop button rail and phone segmented control
  in `providerCategoryOrder`, provider cards with a monogram, connection count, key hint, docs
  link, Add key/Connect, and per-connection test, rotate, models and remove actions. Removal
  confirms in a Dialog and warns that bound sessions, roles and leads will fail. Add/rotate uses
  a Dialog with show/hide, typed inline errors, a key cleared before the request and again on
  close, and the contract's exact minimum key length. A failed create is rolled back with DELETE;
  a failed rotation never deletes the existing row. A failed removal keeps one alert inside its
  dialog. Successful add/rotate/remove focus the provider card heading. Models open in a
  searchable popover with a typed auto-recovering error. The base-URL field appears only for
  `optional`/`required` catalog entries and is read-only because HTTP cannot set a trusted
  endpoint (D-208); custom roots remain a key-file import.
- **E1 New session picker (web).** Connections are grouped by catalog category; choosing one
  lists `GET /:id/models` with search, arrow keys, Home/End, Enter and Escape; the current model
  is marked. Enter in the search commits nothing until the user moves the highlight to an option
  with ArrowDown/Home/End, for any query; Enter then commits that option, never the first filtered
  match. One option stays tabbable when a custom ID is set. "Other model ID…" is the only typed
  fallback. The trigger uses two spans, never a middle-dot string. The last explicit choice is stored under
  `<PRODUCT_FILE_PREFIX>.newSession.modelChoice.v1`; a local runtime still requires context.
  `(dotenv)` names are never rendered.

## Commands and evidence

- `npm exec --workspace @guanxi/web -- vitest run test/component/connections.test.tsx
  test/component/connections-key-dialog.test.tsx test/component/new-session.test.tsx
  test/component/localization.test.tsx test/component/localized-copy-inventory.test.tsx`
  — 5 files, 73 tests, 73 pass.
- `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test
  packages/server/test/connections/*.test.ts packages/server/test/external-agents/*.test.ts
  packages/server/test/native-agent/side-chat*.test.ts` — 279 tests, 275 pass, 4 fail.
  All four failures are in `external-agents/admission-reconcile.test.ts` and reproduce when
  that file runs alone on this macOS clone (orphan-group start-time probing); they are outside
  this fix round. The touched suites pass: `model-access.test.ts` 57/57, `policy.test.ts` 22/22,
  `side-chat.test.ts` 23/23.
- `npx tsc --noEmit -p packages/web` — pass; `packages/web/tsconfig.test.json` — pass;
  `-p packages/server` — pass.
- `node packages/web/scripts/localized-copy-inventory.mjs` — exit 0.
- `npm run lint:md` — 312 files, 0 errors; 311 files, 819 links, 0 problems.
- `npx eslint` on every changed source/test file — exit 0.
- `packages/web/test/browser/connections.spec.ts` is rewritten for the catalogue centre and
  typechecks; it was not run here (the lead runs browser gates).
- Earlier-round UI gate result, unchanged by this fix round: G11 passes; the command exits 1 on
  G10 (stale catalog manifest, no UI package changed) and G12 (this clone has no `main` base).

## Components and catalog

- Used without modification: `Button`, `Dialog`, `Popover`, `IconButton`, `Input`, `Icon` and
  `SegmentedControl` from `@guanxi/ui` (Tooltip is reached through `IconButton`). All are
  `review` status; this lane changes no component, story or approval record.
- A first implementation used `Tabs` for the desktop category rail. G11 rejected it as a
  `draft` component, so the rail now uses the reviewed `Button` primitive with
  `aria-pressed`. No new draft component was added.

## Mutation checks

Each was applied once, the focused test failed, then the file was restored.

- Delete route hid the connection test: skipping `dotenv_imports` deletion failed the test.
- Delete route hid the connection test: deleting the vault record failed the test.
- Delete route in-use test: removing the `inUse` guard returned 200 instead of 409.
- Category switching: no-op `setCategory` left the wrong cards visible.
- Connection counts: counting rows instead of distinct providers failed.
- Add key: skipping `PUT /:id/secret` failed the create+secret assertion.
- Add key failure: keeping the key in the field and omitting the rollback DELETE both failed.
- Remove: calling DELETE without a confirmation dialog failed.
- Models search: ignoring the query failed; hiding the error state failed the Ollama alert.
- Picker grouping: keeping the `(dotenv)` suffix failed.
- Picker keyboard: removing the search ArrowDown focus move failed.
- Picker preselect: removing the stored last choice failed.
- Picker fallback: hiding "Other model ID…" failed.
- Trigger: replacing the two spans with a middle-dot string failed.
- Failed page read: removing `useAutoRecover` left the alert and blocked recovery.
- Rotation: restoring `createdId = target.id` sent DELETE after a failed PUT; restoring
  `key.length > 0` allowed one character below the contract minimum.
- Removed receipts: reading the public `snapshot().costs` instead of all receipts let the
  budget pass after the spending connection was removed.
- Auto Ollama: the old `ensureLocalOllama` recreated the marked row on restart.
- K5 capabilities: the old mapping threw `connection_not_found` for the removed installation.
- Key close: the old `if (!open) return` left the typed key in mounted dialog state.
- Focus: a no-op heading focus left `document.activeElement` on `<body>`.
- Picker: restoring the empty-search Enter branch selected the first model; the old tabIndex
  expression left no option tabbable for a custom ID.
- Remove failure: setting the page-level error produced two alerts instead of the one dialog alert.
- Russian removal copy: the old "редактирования" wording failed the copy assertion.

## Residuals

- No browser or visual gate was run (per the task). The rewritten
  `packages/web/test/browser/connections.spec.ts` typechecks; the lead runs browser gates.
- The phone segmented control and the rail/underline layout were not observed in a real browser.
- No live Ollama or provider key was used; tests use fake keys and local fixtures.
- The in-use check is process-local. Durable relay/lead state is not queried, as documented.
- Custom API roots cannot be entered through HTTP; the dialog shows the catalog policy read-only.
- The full specified server glob has four unrelated `admission-reconcile` failures on this
  macOS clone, reproducible in isolation. The touched connection, external-agent policy and
  side-chat suites are green.
