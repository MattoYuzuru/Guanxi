# P1-c hand-off — MCP client core

**Branch:** `codex/p1c-mcp-client` (standalone clone, never pushed)
**Status:** library slice implemented; **P1 remains in progress**.

## What exists

- `packages/server/src/mcp/types.ts` — transport port, project/server policy, error codes, pinned `2026-07-28` version and defaults. No MCP SDK dependency was added; the lockfile entry is only `@google/genai`'s optional peer.
- `packages/server/src/mcp/jsonrpc.ts` — JSON-RPC 2.0 over newline stdio: numeric ids, response matching, notifications, error objects, 4 MiB frame cap, timeout/abort with `notifications/cancelled`, and stderr that is never read.
- `packages/server/src/mcp/client.ts` — spawn port with absolute command, no shell, explicit minimal env, absolute cwd and discarded stderr; pinned handshake with brand client name; optional version allowlist; bounded `tools/list`; validated `tools/call` returning the raw result; manager policy off unless `mcp.enabled: true`.
- `packages/server/src/mcp/budget.ts` — `toolContext`, `countToolContext`, two meta-tools and search/load helpers. Only descriptions are counted; search mode always contains exactly the two meta-tools and reports `omitted`, and the guarantee holds at zero.
- `packages/server/src/mcp/README.md` and `packages/server/test/mcp/` — security warning, API, protocol behaviour, fake stdio server, 13 client tests and 4 budget tests.

## Commits

1. `afdf1d80` feat(mcp): add JSON-RPC stdio transport and MCP client handshake
2. `393acc4c` feat(mcp): add tool listing, calls and the per-session tool budget
3. `10c40cf8` test(mcp): cover the MCP client against a fake stdio server
4. docs(plans): hand off P1-c MCP client core (this commit)

## Commands and result lines

```bash
nice -n 10 node --test packages/server/test/mcp/*.test.ts   # tests 17, pass 17, fail 0, skipped 0
nice -n 10 npx tsc --noEmit -p packages/server              # exit 0, no diagnostics
npx markdownlint-cli2 packages/server/src/mcp/README.md docs/plans/lanes/P1-c.handoff.md  # 0 error(s)
```

## New envelope

- Handshake order `initialize` → `notifications/initialized` → `tools/list`, pinned version, brand client info and minimal capabilities; mismatch refused unless allowlisted.
- Two-page pagination, bounded-loop refusal, tool calls (including `isError` passthrough and JSON-RPC error objects), argument validation before the server sees the call.
- Timeout/abort send `notifications/cancelled` with the matching request id; timeout only rejects that request, leaving the connection usable.
- Malformed/oversize frames kill the server and reject with `mcp_protocol` / `mcp_message_too_large`; planted stderr sentinel never appears in results, errors or stacks.
- Disabled/default policy calls the spawn port zero times and rejects `mcp_disabled`.
- Budget property: 250 seeded random tool sets assert `countToolContext(context, count) <= budget`, full mode only when it fits, search mode's two meta-tools and `omitted` count.
- `close()` kills the child and waits for `exited`; repeated close is safe.

## Regression envelope

Only the new MCP library, its tests, the fixture and two docs changed. No contract, database, legacy runtime, UI, dependency or package script changed. Per lane rules only the targeted test files, `tsc -p packages/server` and markdownlint ran; no `npm test` or browser gate claim.

## Independent verification

Two separate reviewer sub-agents were started; both stalled before returning findings and were stopped. No independent finding is recorded and independent review remains a residual. Author review covered transport/framing, handshake, budget, cleanup and the disabled path. P1 remains in progress.

## Residuals

- K4 sandbox wrapper with declared fs roots, network allowlist and process-group teardown.
- HTTP/streamable MCP transport through the egress proxy and its allowlist.
- Secret references resolved into the transport environment by the vault/plugin manager.
- Plugin manager integration (install/rollback, per-project enable UI) and UI exposure.
- Agent tool registration, `mcp_search_tools`/`mcp_load_tool` execution in the loop; this slice exports no server route or plugin.
