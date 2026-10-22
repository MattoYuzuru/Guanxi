# U1 complete session search continuation

**Status:** implementation authorized; independent acceptance pending · **Date:** 2026-10-22
**Branch:** `codex/u1-search` · **Base:** frozen shell preparation `b79639d`.

The palette currently filters only loaded session metadata. Make that scope visible and add
an explicit action that reads remaining metadata pages sequentially, keeps the palette open,
and makes older sessions searchable without an item ceiling. Search only the already scrubbed
display metadata; no raw-title server filter, private payload, new endpoint or schema is added.

Loading exposes the number of loaded sessions and a cancel action. Cancel, palette close,
navigation and refresh abort outstanding work; a late response cannot append stale rows or
change a newer request. Failure preserves loaded rows and the failed cursor for retry and
never claims completion. Exhaustion means the currently available pages were loaded, with a
separate warning for withheld/catching-up sessions, not a snapshot or a completeness guarantee
about unavailable data. No total is invented. Repeated cursors fail rather than loop forever.

Verification must assert a matching session beyond 200 becomes searchable, exact order/count
and no duplicates, sequential requests, failure/retry at the same cursor, cancellation and
late-response exclusion, cursor-cycle rejection, visible loaded-only/full-available scope,
and the actual controller-to-palette path while a query stays open. Use EN/RU copy, keyboard
and focus assertions; no AppShellChrome use or host mounting. Run scoped components, types,
lint and actual Chromium under the shared heavy lock, then request separate review. Main and
full U1 acceptance remain root-owned.
