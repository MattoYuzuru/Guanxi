# P1-c hand-off — MCP client core

**Branch:** `codex/p1c-mcp-client` (standalone clone, never pushed)
**Status:** library slice implemented; **P1 remains in progress**.

## What exists

- `packages/server/src/mcp/types.ts` — transport port, project/server policy, error codes, pinned `2026-07-28` version and defaults. No MCP SDK dependency was added; the lockfile entry is only `@google/genai`'s optional peer.
- `packages/server/src/mcp/jsonrpc.ts` — JSON-RPC 2.0 over newline stdio: numeric ids, response matching, notifications, error objects, 4 MiB frame cap, timeout/abort with `notifications/cancelled`, and stderr that is never read.
- `packages/server/src/mcp/client.ts` — spawn port with absolute command, no shell, explicit minimal env, absolute cwd and discarded stderr; pinned handshake with brand client name; optional version allowlist; bounded `tools/list`; validated `tools/call` returning the raw result; manager policy off unless `mcp.enabled: true`.
- `packages/server/src/mcp/budget.ts` — `toolContext`, `countToolContext`, two meta-tools and search/load helpers. Names, titles, descriptions and input schemas are counted; search mode contains exactly the two meta-tools and reports `omitted`, or returns `mode: 'none'` with an empty tool list when even those do not fit.
- `packages/server/src/mcp/README.md` and `packages/server/test/mcp/` — security warning, API, protocol behaviour, fake stdio server, 17 client, 6 JSON-RPC and 5 budget tests.

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
- `close()` kills the POSIX process group and waits for `exited`; repeated close is safe.

## Regression envelope

Only the new MCP library, its tests, the fixture and two docs changed. No contract, database, legacy runtime, UI, dependency or package script changed. Per lane rules only the targeted test files, `tsc -p packages/server` and markdownlint ran; no `npm test` or browser gate claim.

## Independent verification

Two reviewer sub-agents were started first; both stalled before returning findings and were stopped. An independent security review of `0841e190` was completed later with the probes listed under [Independent review fixes](#independent-review-fixes). Its findings are fixed in the commits below. P1 remains in progress.

## Residuals

- K4 sandbox wrapper with declared fs roots and a network allowlist. POSIX process-group teardown is implemented; Windows still falls back to a direct-child kill.
- HTTP/streamable MCP transport through the egress proxy and its allowlist.
- Secret references resolved into the transport environment by the vault/plugin manager.
- Plugin manager integration (install/rollback, per-project enable UI) and UI exposure.
- Agent tool registration, `mcp_search_tools`/`mcp_load_tool` execution in the loop; this slice exports no server route or plugin.

## Independent review fixes

An independent security review of `0841e190` used the probes in
`/private/tmp/claude-501/-Users-yuzuru-Projects-Guanxi/b23e1a50-34d8-4915-b5d2-fde00410babc/scratchpad/`
(`probe.ts`, `gc-server.mjs`, `flood-server.mjs`). Each finding below has a regression test that
was run red against the reviewed code and green after the fix.

### P2-1 — close with a stdio-inheriting grandchild

- The default transport now spawns in a POSIX process group (`detached`), kills the group on
  close (ignoring `ESRCH`), settles `exited` on `exit` rather than `close`, and destroys the
  pipes after the kill.
- Test: a fake server spawns `/bin/sleep 30` with inherited stdio; `close()` resolves within
  2 s and `process.kill(pid, 0)` throws `ESRCH`. Windows skips the test and falls back to a
  direct-child kill.

### P2-2 — budget counted only descriptions

- `parseToolPage` now keeps only `name`, `title`, `description` and `inputSchema`; unknown
  fields no longer pass through.
- `countToolContext` counts `JSON.stringify({ name, title, description, inputSchema })` per
  tool. The property test now randomizes schemas and a dedicated test puts a 2.9 MB
  `inputSchema` on one tool and asserts search mode with the budget respected.
- If even the two meta-tools do not fit, `toolContext` returns `{ mode: 'none', tools: [],
  omitted }`. The tests assert `count('') === 0` and cover the zero-budget case.

### P3

1. A newline-less oversize frame is refused before the stream ends. Removing the buffered-size
   check makes the test fail with `mcp_timeout`.
2. Framing keeps a chunk list plus an absolute scan offset; a frame is concatenated only when
   it spans chunks. A response split across many writes is covered.
3. Server `error.message` is truncated to 200 characters, `error.data` is dropped, and the
   `McpError` type doc marks the message as untrusted.
4. Server request ids longer than 128 characters are a fatal protocol fault; a `-32601` reply
   is skipped while `stdin.writableNeedDrain` is set.
5. `notifications/cancelled` is never sent for `initialize`.
6. `mode: 'none'` and the `count('') === 0` contract are documented and asserted.
7. Tool names are 1–128 characters of `[A-Za-z0-9_.-]`, unique across pages; the reserved
   meta-tool names are refused with `mcp_protocol`.
8. Tool arguments must survive a JSON round-trip without losing type or data; `Date`, `Map`,
   `undefined`, `NaN`, functions and class instances are refused before the request is sent.
9. `McpClientManager` caches a failed start until `close()` or `retry()`; `retry()` is the
   explicit recovery path. `allowedProtocolVersions` moved from manager options into each
   `McpServerConfig`.

Commits after `0841e190`:

```text
79fa59d3 fix(mcp): reap the process group when closing a client
811d09c3 test(mcp): reject an oversized frame before a newline arrives
692d5ac2 fix(mcp): count every tool field against the context budget
47ed0148 perf(mcp): frame buffered chunks without quadratic copies
b8f4bdb3 perf(mcp): resume frame scanning from the last chunk
e4b902fd fix(mcp): bound and sanitize server error details
4ca04f87 fix(mcp): cap echoed request ids and drop backpressured replies
ccc4c49b fix(mcp): do not cancel the initialize request
e900ab71 fix(mcp): validate tool names before exposing them
801858a2 fix(mcp): require tool arguments to round-trip as JSON
8472cd86 fix(mcp): cache a failed start and scope version allowlists
```

The documentation commit for this section follows the code commits.

### Verification after the fixes

```bash
nice -n 10 node --test packages/server/test/mcp/*.test.ts   # tests 28, pass 28, fail 0, skipped 0
nice -n 10 npx tsc --noEmit -p packages/server              # exit 0, no diagnostics
npx markdownlint-cli2 packages/server/src/mcp/README.md docs/plans/lanes/P1-c.handoff.md  # 0 error(s)
```

Reviewer probe output after the fixes:

```text
grandchild close: closed 2 ms
flood rss growth MiB: 1 stdin writableLength MiB: 0
budget mode: none schema bytes in context: 2
counter("")=1, budget 0 -> none 0
```

Residuals added by this round:

- Process-group teardown is POSIX-only; Windows uses a direct-child kill and does not reap a
  grandchild that inherits stdio.
- A server-request reply dropped under backpressure is not queued or retried.
- Truncating/dropping server error details removes potentially useful diagnostics; the code,
  RPC code and truncated message remain.
