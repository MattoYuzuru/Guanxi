# K3 connections centre and model picker handoff

**Status:** implemented and locally validated; browser/visual gates not run.
**Date:** 2026-10-24 · **Branch:** `lead/k3-connections-ui` · **Base:** `6fac2923` · no push.

## What exists

- **Server removal.** `DELETE /api/connections/:id` returns `{ id }`, hides the connection from
  snapshots, model/connection pickers and the cost projection, and keeps the append-only cost
  ledger row. Migration 4 adds only `removed_connections`; versions 1–3 are unchanged. The
  dotenv mapping is deleted, so a later trusted import creates a new identity. The vault record
  is retained and the node-key copy is deleted; a fresh activation still registers the retired
  value with the egress scrubber. The route refuses with `connection_in_use` (409) while this
  registry has an active `complete()`, `localChat()` or `dispatchAgent()` call. It does not inspect
  durable relay/lead/session state owned outside this process.
- **Contract.** `connection_in_use` joins the connection error codes (and the legacy
  `apiError`/`turnError` projections), `deleteConnectionResponseSchema` names the removed id,
  and `connectionModelsSchema` validates the `GET /:id/models` response.
- **Endpoint models.** `GET /:id/models` now returns discovered IDs for a pinned endpoint,
  local `/api/tags` models for a local runtime and pi-ai catalog facts otherwise.
- **C1 Connections centre (web).** `/connections` is a route and a shell destination (Settings
  still links to it). The view is catalog-driven: a desktop button rail and phone segmented control
  in `providerCategoryOrder`, provider cards with a monogram, connection count, key hint, docs
  link, Add key/Connect, and per-connection test, rotate, models and remove actions. Removal
  confirms in a Dialog. Add/rotate uses a Dialog with show/hide, typed inline errors, a key
  cleared before the request and a failed create rolled back with DELETE. Models open in a
  searchable popover with a typed auto-recovering error. The base-URL field appears only for
  `optional`/`required` catalog entries and is read-only because HTTP cannot set a trusted
  endpoint (D-208); custom roots remain a key-file import.
- **E1 New session picker (web).** Connections are grouped by catalog category; choosing one
  lists `GET /:id/models` with search, arrow keys, Home/End, Enter and Escape; the current model
  is marked. "Other model ID…" is the only typed fallback. The trigger uses two spans, never a
  middle-dot string. The last explicit choice is stored under
  `<PRODUCT_FILE_PREFIX>.newSession.modelChoice.v1`; a local runtime still requires context.
  `(dotenv)` names are never rendered.

## Commands and evidence

- `npm exec --workspace @guanxi/web -- vitest run test/component/connections.test.tsx
  test/component/new-session.test.tsx test/component/shell-sidebar.test.tsx
  test/component/localization.test.tsx test/component/localized-copy-inventory.test.tsx`
  — 5 files, 69 tests, 69 pass.
- `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test
  packages/server/test/connections/model-access.test.ts packages/server/test/connections/chat-provider.test.ts`
  — 90 tests, 90 pass (includes 3 new DELETE cases and endpoint-model assertions).
- `npx tsc --noEmit -p packages/web` — pass; `packages/web/tsconfig.test.json` — pass;
  `-p packages/server` — pass; `-p packages/contract` — pass.
- `node packages/web/scripts/localized-copy-inventory.mjs` — exit 0.
- `npm run lint:md` — 312 files, 0 errors; 311 files, 819 links, 0 problems.
- `npx eslint` on the changed source/tests and `npx stylelint` on the two changed stylesheets
  — exit 0.
- `npm run ui:check` — G11 passes after replacing the draft `Tabs` primitive with `Button`.
  The overall command still exits 1 on G10 (stale `packages/ui/catalog/manifest.json`, no UI
  package was changed in this lane) and G12 (the clone has no `main` base branch). G11 reports
  the expected review-component hand-off warnings for `button`, `segmented-control`,
  `status-item` and `workspace-chrome`.

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

## Residuals

- No browser or visual gate was run (per the task). `packages/web/test/browser/connections.spec.ts`
  still tests the retired Settings-embedded form and will need a rewrite.
- The phone segmented control and the rail/underline layout were not observed in a real browser.
- No live Ollama or provider key was used; tests use fake keys and local fixtures.
- The in-use check is process-local. Durable relay/lead state is not queried, as documented.
- Custom API roots cannot be entered through HTTP; the dialog shows the catalog policy read-only.
