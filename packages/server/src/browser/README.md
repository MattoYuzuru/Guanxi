# Agent browser policy core

**Status:** implemented and locally validated by unit tests. This directory is a pure core
slice: it contains no `playwright-core`, no Chromium, no HTTP route, no socket, no timer and no
storage outside the site-grant SQLite file. The browser host, lease, streamed pane, Bridge
extension, encrypted session bundles, route wiring and MCP tool surface are later work
([ADR-0035](../../../../docs/decisions/0035-agent-browser-and-site-sessions.md)).

`types.ts` holds the shared types. `origin-policy.ts` is pure and deterministic.
`site-grants.ts` owns `<dataDir>/browser.sqlite` and its append-only `c1_migrations` table.

## Origin policy

`normalizeOrigin(url)` accepts an absolute http(s) URL and returns `scheme://host[:port]`:
the host is lowercased, IDN labels become punycode through the WHATWG URL parser, every
trailing dot is removed and default ports (`http:80`, `https:443`) are dropped. Userinfo,
path, query and fragment are not part of an origin. A relative reference, a non-http(s) scheme
or an unparseable value throws `TypeError`.

A `RunBrowserPolicy` carries `mode` (`read_only` or `full`) plus canonical `readable` and
`writable` origins. Policy arrays are a caller precondition; `decide` never normalizes or
mutates them. `decide(policy, action)` returns `{ allowed, code, addReadable? }` and reads no
clock, storage, network or environment.

`via` and `fromOrigin` are assertions supplied by the host. This pure layer cannot prove that a
link was clicked; the route/tool boundary must derive both from its own navigation state and
never from model or tool JSON. Letting a model choose `via: 'policy'` or `'clean_link'` would
bypass the model-data rule.

| Action | Rule |
| --- | --- |
| `navigate`, origin readable | allowed, except a `via: 'model'` URL carrying data (below). |
| `navigate`, `via: 'policy'` | allowed only when the target origin is readable; never mutates the policy. |
| `navigate`, `via: 'clean_link'` | from a readable `fromOrigin` to a new origin: allowed with `addReadable` only when the URL is clean. The added origin is readable, never writable. |
| `navigate`, `via: 'model'` | non-readable origin → `origin_not_allowed`; readable origin carrying data → `data_url_refused`. |
| `type`, `submit`, `upload`, `download` in `read_only` | `read_only` on every origin, readable or not. |
| `click` | readable origin only, in both modes. |
| `type`, `submit`, `upload`, `download` in `full` | target origin must be writable, else `write_not_allowed`. |
| `javascript:`, `data:`, `file:`, `blob:` | always `scheme_refused`; malformed references are `invalid_url`. |
| `navigate` with missing/unknown `via` | `invalid_action`; never falls through to clean-link handling. |
| unknown runtime `mode` | write actions fail closed as `read_only`. |

### Clean-link heuristic (exact)

A URL is clean only when all of these hold:

- scheme is http or https, and it has no username or password;
- it has no query string and no fragment, including an empty `?` or `#`;
- the pathname is percent-decoded first, including its leading `/`, and is at most 200 characters;
- that decoded pathname is split on `/`, and every segment is at most 32 characters **or** is not
  composed solely of `[A-Za-z0-9_+=-]`.

In other words, a path segment longer than 32 characters drawn only from that base64/hex-like
alphabet is data-carrying. This is intentionally conservative: a 33-letter English word is
refused. There is no query allowance at all; `?q=hello` is not a clean link. Malformed percent
escapes are measured as literal text.

### Model-URL data heuristic (exact)

A `via: 'model'` navigate URL is data-carrying when any of these hold:

- it has a username or password;
- any query parameter **name or value** is longer than 64 characters;
- any query parameter name or value is longer than 32 characters and composed solely of
  `[A-Za-z0-9_+=-]`;
- the pathname is percent-decoded first and split on `/`; any resulting segment is longer than
  64 characters;
- any resulting segment is longer than 32 characters and composed solely of the same alphabet.

The query is split on `&` and the first `=`; `+` stays a literal base64 character rather than
becoming a space. Fragments are ignored here and only forbidden by the clean-link rule. The
query-name checks are stricter than the minimum in the decision text, on purpose.

## Site grants

`SiteGrantStore(path, clock)` creates `<dataDir>/browser.sqlite` with directory mode `0700` and
file mode `0600`, WAL, `foreign_keys=ON` and `busy_timeout=5000`. Migration v1 creates:

- `site_grants(id, account_id, project_id, role, domain, source, sync_mode, scopes, access,
  expires_at, last_used_at, created_by, created_at, revoked_at)`, with `source` checked against
  `login`, `bridge_once`, `bridge_run_start`, `bridge_live`, `live_chrome`, `access` checked
  against `read`/`write`, and scope/project indexes;
- `site_contexts(context_id, grant_id, opened_at, closed_at)` with a foreign key to the grant.

`scopes` is a JSON array of short scope names such as `cookies` or `storage`; it is metadata,
not session material. The name pattern limits length and characters, but it cannot prove that a
short string resembling a name is not a value. The store never has a column, input field or
return field for cookie values, passwords or tokens. Every input is scanned recursively for field names matching
`cookie`, `password`/`passwd`, `token` or `secret`, and such a call is refused with
`secret_material_rejected` before a row is written.

### Methods

- `grant(principal, input, channel)` — account and creator come from an authenticated user
  principal; forged account/time fields are ignored. The safe default channel is `agent`, so a
  caller must pass `'ui'` explicitly. `'agent'` is always refused with `agent_cannot_grant`.
- `revoke(principal, grantId, now)` — only the grant's own account may revoke. Records
  `revoked_at` (first value wins) and returns exactly the still-open `context_id`s for that
  grant. The store does not close them; the browser host must remove them within one lease TTL.
- `grantsFor(accountId, projectId, role, now)` — active grants only: not revoked and
  `expires_at` null or strictly after `now`. A run context therefore sees only its project and
  role.
- `openContext(contextId, grantId, accountId?)` — host-authorized. Refuses an unknown grant, a
  grant owned by another account when `accountId` is supplied, a revoked or expired grant, a
  context id bound to another grant, and a previously closed context id. Reopening the same open
  context is idempotent. The host should pass `accountId` and only ids selected by `grantsFor`.
- `closeContext(contextId, now?)` — closes an open context; returns false when absent or
  already closed. It is keyed by context id only and is an internal host operation.
- `touch(grantId, now, accountId?)` — records `last_used_at` for an active grant; revoked or
  expired grants return false. A mismatching optional account is refused.

### Domain normalization

`normalizeSiteDomain` accepts a bare host or an http(s) URL, lowercases it, uses the URL parser
for punycode, strips trailing dots and returns the registrable host. It rejects non-http(s)
URLs, bare-host ports/paths/userinfo, IP literals, single-label hosts and wildcards (`*`).

The suffix table is a deterministic built-in approximation of the Public Suffix List, not a
complete PSL: `co.uk`, `com.au`, `github.io` and similar known two-label suffixes stay suffixes;
every other host uses its last two labels. A suffix missing from the table, or a three-label
suffix, is not split correctly. This is recorded as residual risk rather than hidden.

### Error codes

`SiteGrantStoreError.code` is one of `invalid_actor`, `agent_cannot_grant`, `invalid_grant`,
`invalid_domain`, `wildcard_domain_forbidden`, `secret_material_rejected`, `invalid_expiry`,
`grant_not_found`, `grant_revoked`, `grant_expired`, `context_foreign`, `context_closed` or
`write_failed`.

## Checks

```bash
nice -n 10 node --test packages/server/test/browser/*.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/browser/README.md docs/plans/lanes/C1-a.handoff.md
```

The two test files cover normalization and each origin rule, clean-link and model heuristics,
the explicit Read-only form-submission block, full-mode writable checks, refused schemes,
missing/unknown `via` and `mode` fail-closed paths, determinism, migration reopen and file
modes, the agent-channel and wildcard refusals, project/role/account scoping, expiry,
revocation context lists, context lifecycle including the optional account guard,
secret-field rejection and `touch`.

## Residuals

- `playwright-core` browser host, per-run contexts, profile encryption and browser leases.
- Streamed pane, takeover/pop-out UI and Connections → Browser page.
- Bridge extension, per-site host permissions, live Chrome delegation and bookmark/history
  import.
- Cookie scrubber rules, encrypted session bundles in the account vault and the
  planted-cookie/injection-page validation from ADR-0035.
- Routes, contract types and the MCP-shaped agent tool surface.
- The per-segment entropy rule has no aggregate budget: data split across many short segments
  is not detected.
- `via` and `fromOrigin` remain host assertions; route/tool validation must enforce them.
- A complete Public Suffix List instead of the documented approximation.
