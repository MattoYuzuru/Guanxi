# U3-route-authz — plan

**Status:** plan, committed before implementation · **Updated:** 2026-11-01 · **Lane:**
`U3-route-authz` · **Branch:** `lane/u3-route-authz` (from `lead/wave8` `2b8cf843`) · **Ports:**
`GUANXI_WEB_PORT=5243`, `GUANXI_API_PORT=4443`, `GUANXI_DATA_DIR=$PWD/.lane-data`

## Outcome and non-goals

Outcome: the authorization core of U3-a (`can()`, grants, remote-bind guard) is enforced by the
running server.

1. One central hook decides every `/api/*` request from a route policy map. A registered route
   without a declared policy is refused (fail closed) and listed at boot.
2. Loopback single-owner mode behaves exactly as today: the implicit owner principal passes every
   declared policy.
3. A non-loopback bind refuses to start unless the remote security profile is satisfied. The
   refusal has one fixed exit code and message and runs before any file, database or listener
   exists. A satisfied profile is served over TLS.

Non-goals (next slice): Better Auth (sessions, passkeys, device authorization, API keys), a real
account store, per-account stores (`owner_user_id` on threads, projects, connections), a
permission-snapshot endpoint, web projection of permissions, allowed-root enforcement on
workspace and project registration, audit of remote execution.

## Design

### Policy kinds

| Kind | Meaning | Passes |
| --- | --- | --- |
| `public` | Needs no principal. | everyone, including `anonymous` |
| `authenticated` | Read-only node information with no per-user content. | any `user` principal |
| `account` | Data of the single account the handler is bound to (`LOCAL_ACCOUNT_ID`). | the `user` whose id is that account |
| `node-signed` | The handler authenticates a federation node by its signed request. | everyone; the handler refuses unsigned or unknown nodes |
| `authorize` | `can(principal, action, resource)` on a resource named by the route. | per the U3-a matrix |

`authorize` carries `resource` (a `ResourceType`), `action`, and optionally `idParam`, the route
parameter that names the resource id. **No `idParam` means a collection or create route**, which
is authorized against the node's *root* resource of that type. A root resource is owned by the
node owner, never carries grants and is private by default, so only the node owner passes. The
reason: until per-account stores exist, everything the API creates or lists is attributed to the
node owner, and a member must not list or create into the owner's data.

### Principal and resources

- **Local mode** (no `remote` start option): the principal is the implicit owner
  `{ kind: 'user', userId: 'local', role: 'admin', groups: [] }` for every request that passed the
  Host allowlist. Loopback is guaranteed by the boot bind guard and the existing per-route peer
  guards, which stay in place and still produce their own error bodies.
- **Remote mode** (`remote` start option): the principal comes from an injected
  `AccountsAdapter.principal(request)`; Better Auth is that adapter in the next slice. Absence of
  an adapter means accounts are not enabled and the remote guard refuses the bind.
- A resource is projected by `AccountsAdapter.resource(type, id)`; the default projection is
  `{ type, id, ownerUserId: <node owner> }`. Grants come from `AccountsAdapter.grants(resource)`
  (default none). Unknown ids still project to the owner's resource, so a non-owner gets `403`
  for both missing and foreign resources (no existence oracle).

### Enforcement

`createApp` registers one `/api/*` hook before any route. It reads the first endpoint route Hono
matched for the request (`hono/route` `matchedRoutes`; endpoint handlers answer without calling
`next()`, so the first match is the one that responds, and a static route registered before a
parameterized one shadows it), looks the pattern up in the table, extracts the route parameters
with Hono's own router, resolves the principal and resource, calls `can()` and refuses with
`401 unauthenticated` (anonymous) or `403 forbidden`. A matched endpoint pattern without a policy
answers `403 route_unmapped` before the handler runs. A matched `ALL` route is an endpoint unless
it is one of the known middleware or fallback patterns, so a new `.all('/api/x')` cannot slip past.

`start()` runs the registration check after the last route is mounted: any `/api/*` endpoint
route without a policy aborts boot with `RouteAuthzError('routes_unmapped')` listing the
patterns, and a policy for a route that no longer exists is reported as stale by the unit test.

### Remote bind at boot

`start()` calls `assertBindAllowed()` first, with the configuration derived from its options:
`host`, `remote.tls`, `remote.accounts !== undefined`, `remote.allowedRoots`, and
`federation` (identity plus private key) as the node credential. Unreadable TLS files add the
new code `tls_files_unreadable`. `RemoteBindError` is thrown before the database opens.
The server and CLI entry points print one message and exit with `REMOTE_BIND_EXIT_CODE = 78`
(`EX_CONFIG`). With a satisfied profile the listener is `node:https`, the Host allowlist admits
the canonical TLS hostname and the returned URL is `https://<hostname>:<port>`.

### Contract

`apiErrorSchema.code` gains `unauthenticated`, `forbidden` and `route_unmapped`. The web client
maps them in `API_ERROR_KEYS` to two locale keys (English and Russian).

## Route inventory

Source: a booted `start()` with the `federation` option (the full route set), read from
`app.routes`, plus the MS1 live federation listener. `Role` is the weakest principal that
passes: `any user`, `owner/admin` (node owner or server admin, `node.admin`), `viewer`, `editor`
or `owner` (relation on the resource; roots pass for the node owner only), `account` (the bound
account), `node` (signed node), `none`.
Method `ALL` rows are middleware or fallbacks, not endpoints.

### Health, settings, node information

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| GET | /api/health | authenticated | | | any user (full report: owner and admin only) |
| GET | /api/settings | authorize | node | node.admin | owner only (node.admin) |
| PUT | /api/settings | authorize | node | node.admin | owner only (node.admin) |
| GET | /api/feature-flags | authenticated | | | any user |
| GET | /api/runtime | authenticated | | | any user |
| POST | /api/runtime/estimated-parallel-admission | authenticated | | | any user |
| POST | /api/approvals/:id | account | | | account |
| GET | /api/layouts/context | account | | | account |
| GET | /api/layouts | account | | | account |
| PUT | /api/layouts | account | | | account |
| GET | /api/layouts/geometry | account | | | account |
| PUT | /api/layouts/geometry | account | | | account |
| GET | /api/ui-catalog/review-capability | authenticated | | | any user |
| GET | /api/ui-catalog/components/:id/review | authenticated | | | any user |
| POST | /api/ui-catalog/components/:id/review | authorize | node | node.admin | owner only (node.admin) |

### Models and workspaces (node resources)

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| GET | /api/models | authenticated | | | any user |
| GET | /api/models/catalog | authenticated | | | any user |
| GET | /api/models/running | authenticated | | | any user |
| GET | /api/models/:name{.+} | authenticated | | | any user |
| POST | /api/models/imports/ollama-reference/preview | authorize | node | node.admin | owner only (node.admin) |
| POST | /api/models/imports/ollama-reference/start | authorize | node | node.admin | owner only (node.admin) |
| POST | /api/models/discovery/hugging-face/search | authorize | node | node.admin | owner only (node.admin) |
| POST | /api/models/discovery/hugging-face/repository | authorize | node | node.admin | owner only (node.admin) |
| POST | /api/models/discovery/hugging-face/selection | authorize | node | node.admin | owner only (node.admin) |
| POST | /api/models/discovery/hugging-face/download | authorize | node | node.admin | owner only (node.admin) |
| POST | /api/models/imports/hugging-face-gguf/start | authorize | node | node.admin | owner only (node.admin) |
| POST | /api/models/:name{.+}/capability-overrides | authorize | node | node.admin | owner/admin |
| DELETE | /api/models/:name{.+}/capability-overrides | authorize | node | node.admin | owner/admin |
| DELETE | /api/models/:name{.+} | authorize | node | node.admin | owner/admin |
| POST | /api/models/:name{.+}/warm | authorize | node | node.admin | owner/admin |
| POST | /api/models/:name{.+}/prewarm | authorize | node | node.admin | owner/admin |
| POST | /api/models/:name{.+}/probes/completion | authorize | node | node.admin | owner/admin |
| POST | /api/models/:name{.+}/stop | authorize | node | node.admin | owner/admin |
| POST | /api/models/:name{.+}/pull | authorize | node | node.admin | owner only (node.admin) |
| GET | /api/workspaces | authorize | node | node.admin | owner only (node.admin) |
| GET | /api/workspaces/browse | authorize | node | node.admin | owner only (node.admin) |
| POST | /api/workspaces | authorize | node | node.admin | owner only (node.admin) |
| GET | /api/workspaces/:id | authorize | node | node.admin | owner only (node.admin) |
| DELETE | /api/workspaces/:id | authorize | node | node.admin | owner only (node.admin) |

### Threads (chat sessions), quick runs, jobs

Owner-level metadata changes (retention, restore, leave, patch) use `session.update`, added to the
policy core in the review round; `owner only` rows additionally require the principal to own the
resource (no grant, no admin role).

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| GET | /api/threads/models | authenticated | | | any user |
| GET | /api/threads | authorize | session (root) | session.read | owner |
| POST | /api/threads | authorize | session (root) | session.prompt | owner |
| GET | /api/threads/trash | authorize | session (root) | session.read | owner |
| GET | /api/threads/:id/retention | authorize | session `id` | session.read | viewer |
| PATCH | /api/threads/:id/retention | authorize | session `id` | session.update | owner |
| POST | /api/threads/:id/restore | authorize | session `id` | session.update | owner |
| POST | /api/threads/:id/session-leave | authorize | session `id` | session.update | owner |
| GET | /api/threads/:id/reasoning-artifacts | authorize | session `id` | session.read | owner only |
| GET | /api/threads/:id/reasoning-artifacts/:artifactId | authorize | session `id` | session.read | owner only |
| GET | /api/threads/:id | authorize | session `id` | session.read | viewer |
| PATCH | /api/threads/:id | authorize | session `id` | session.update | owner |
| DELETE | /api/threads/:id | authorize | session `id` | session.delete | owner |
| GET | /api/threads/:id/context | authorize | session `id` | session.read | viewer |
| POST | /api/threads/:id/stop | authorize | session `id` | session.stop | editor |
| POST | /api/threads/:id/messages | authorize | session `id` | session.prompt | editor |
| POST | /api/threads/:id/compact | authorize | session `id` | session.prompt | editor |
| GET | /api/quick-runs | authorize | session (root) | session.read | owner |
| POST | /api/quick-runs | authorize | session (root) | session.prompt | owner |
| PATCH | /api/quick-runs/:id/retention | authorize | session `id` | session.update | owner |
| GET | /api/quick-runs/:id | authorize | session `id` | session.read | viewer |
| POST | /api/jobs | authorize | session (root) | session.prompt | owner |
| GET | /api/jobs/:jobId | authorize | run `jobId` | run.read | viewer |
| GET | /api/jobs/:jobId/events | authorize | run `jobId` | run.read | viewer |
| POST | /api/jobs/:jobId/cancel | authorize | run `jobId` | run.cancel | editor |

### Session inspector (K2)

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| GET | /api/sessions | authorize | session (root) | session.read | owner |
| GET | /api/sessions/list/page | authorize | session (root) | session.read | owner |
| GET | /api/sessions/search | authorize | session (root) | session.read | owner |
| GET | /api/sessions/:sessionId | authorize | session `sessionId` | session.read | viewer |
| GET | /api/sessions/:sessionId/events | authorize | session `sessionId` | session.read | owner only |
| GET | /api/sessions/:sessionId/spans | authorize | session `sessionId` | session.read | owner only |
| GET | /api/sessions/:sessionId/export | authorize | session `sessionId` | session.read | owner only |
| GET | /api/sessions/:sessionId/stream | authorize | session `sessionId` | session.read | owner only |

### Projects, recipes, attachments, work ledger

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| GET | /api/projects | authorize | project (root) | project.read | owner |
| POST | /api/projects | authorize | project (root) | project.write | owner |
| GET | /api/projects/:id | authorize | project `id` | project.read | viewer |
| PATCH | /api/projects/:id | authorize | project `id` | project.write | editor |
| PATCH | /api/projects/:id/presentation | authorize | project `id` | project.write | editor |
| GET | /api/projects/:id/chats | authorize | session (root) | session.read | owner |
| POST | /api/projects/:id/chats | authorize | session (root) | session.prompt | owner |
| GET | /api/projects/:id/chats/:threadId | authorize | session `threadId` | session.read | viewer |
| GET | /api/recipes | account | | | account |
| POST | /api/recipes | account | | | account |
| PATCH | /api/recipes/:id/name | account | | | account |
| POST | /api/recipes/:id/revisions | account | | | account |
| POST | /api/recipes/:id/revisions/:revision/jobs | account | | | account |
| GET | /api/recipes/:id/revisions/:revision/jobs/:jobId | account | | | account |
| GET | /api/recipes/:id/revisions/:revision | account | | | account |
| GET | /api/recipes/:id | account | | | account |
| GET | /api/artifacts/policy | authenticated | | | any user |
| GET | /api/artifacts | account | | | account |
| POST | /api/artifacts | account | | | account |
| GET | /api/artifacts/:id/content | account | | | account |
| GET | /api/artifacts/:id | account | | | account |
| GET | /api/work/projects/:projectId/revision | authorize | project `projectId` | project.read | viewer |
| POST | /api/work/projects/:projectId/revisions | authorize | project `projectId` | project.write | editor |
| POST | /api/work/projects/:projectId/events | authorize | project `projectId` | project.write | editor |
| GET | /api/work/projects/:projectId/items | authorize | project `projectId` | project.read | viewer |
| GET | /api/work/projects/:projectId/mode | authorize | project `projectId` | project.read | viewer |
| PUT | /api/work/projects/:projectId/mode | authorize | project `projectId` | project.write | editor |
| GET | /api/work/projects/:projectId/export | authorize | project `projectId` | project.read | viewer |

### Connections, vault

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| GET | /api/connections | authorize | connection (root) | connection.read | owner |
| POST | /api/connections | authorize | connection (root) | connection.manage | owner |
| PATCH | /api/connections/:id | authorize | connection `id` | connection.manage | owner |
| DELETE | /api/connections/:id | authorize | connection `id` | connection.manage | owner |
| POST | /api/connections/vault/unlock | account | | | account |
| POST | /api/connections/vault/lock | account | | | account |
| PUT | /api/connections/:id/secret | authorize | connection `id` | connection.manage | owner |
| GET | /api/connections/:id/models | authorize | connection `id` | connection.use | editor |
| POST | /api/connections/:id/probe | authorize | connection `id` | connection.manage | owner |

### Native agent, relay

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| GET | /api/agent/projects | authorize | project (root) | project.read | owner |
| POST | /api/agent | authorize | session (root) | session.prompt | owner |
| PATCH | /api/agent/projects/:id/roots | authorize | project `id` | project.write | editor |
| POST | /api/agent/:id/leave | authorize | session `id` | session.update | owner |
| PATCH | /api/agent/:id/retention | authorize | session `id` | session.update | owner |
| DELETE | /api/agent/:id | authorize | session `id` | session.delete | owner |
| GET | /api/agent/:id | authorize | session `id` | session.read | viewer |
| GET | /api/agent/:id/result | authorize | session `id` | session.read | viewer |
| POST | /api/agent/:id/prompts | authorize | session `id` | session.prompt | editor |
| POST | /api/agent/:id/stop | authorize | session `id` | session.stop | editor |
| POST | /api/agent/:id/queue | authorize | session `id` | session.prompt | editor |
| POST | /api/agent/:id/side-chat/respond | authorize | session `id` | session.prompt | editor |
| POST | /api/agent/:id/side-chat/save | authorize | session `id` | session.prompt | editor |
| POST | /api/agent/:id/side-chat/send | authorize | session `id` | session.prompt | editor |
| DELETE | /api/agent/:id/queue/:item | authorize | session `id` | session.prompt | editor |
| POST | /api/relay | authorize | node | node.admin | owner only (node.admin) |
| GET | /api/relay/starts/:key | authorize | run `key` | run.read | viewer |
| GET | /api/relay/starts/:key/result | authorize | run `key` | run.read | viewer |
| POST | /api/relay/starts/:key/stop | authorize | run `key` | run.cancel | editor |
| GET | /api/relay/:runId | authorize | run `runId` | run.read | viewer |
| GET | /api/relay/:runId/result | authorize | run `runId` | run.read | viewer |
| POST | /api/relay/:runId/stop | authorize | run `runId` | run.cancel | editor |

### Account-bound sidecars

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| GET | /api/notifications | account | | | account |
| GET | /api/notifications/actions | account | | | account |
| GET | /api/notifications/:id | account | | | account |
| POST | /api/notifications/:id/read | account | | | account |
| POST | /api/notifications/:id/snooze | account | | | account |
| POST | /api/notifications/:id/actions | account | | | account |
| GET | /api/voice/glossary | account | | | account |
| POST | /api/voice/glossary | account | | | account |
| POST | /api/voice/glossary/apply-preview | account | | | account |
| PUT | /api/voice/glossary/:id | account | | | account |
| GET | /api/voice/glossary/:id/history | account | | | account |
| POST | /api/voice/glossary/:id/deactivate | account | | | account |
| POST | /api/voice/glossary/:id/reactivate | account | | | account |
| POST | /api/voice/glossary/:id/revert | account | | | account |

### Federation (present only with the `federation` start option)

| Method | Path | Kind | Resource | Action | Role |
| --- | --- | --- | --- | --- | --- |
| POST | /api/federation/device/code | public | | | none (enrollment bootstrap, budgeted) |
| POST | /api/federation/device/token | public | | | none (enrollment bootstrap, budgeted) |
| GET | /api/federation/handshake | node-signed | | | node |
| GET | /api/federation/config | node-signed | | | node |
| POST | /api/federation/config | node-signed | | | node |
| GET | /api/federation/replicas/:stream | node-signed | | | node |
| POST | /api/federation/replicas | node-signed | | | node |
| POST | /api/federation/commands | node-signed | | | node |
| POST | /api/federation/attempts/offers | node-signed | | | node |
| POST | /api/federation/attempts/cancel | node-signed | | | node |
| POST | /api/federation/attempts/dispatch | node-signed | | | node |
| POST | /api/federation/attempts/renew | node-signed | | | node |
| POST | /api/federation/attempts/events | node-signed | | | node |
| POST | /api/federation/attempts/state | node-signed | | | node |
| POST | /api/federation/attempts/dispatch-cancel | node-signed | | | node |
| POST | /api/federation/attempts/runtime/observe | node-signed | | | node |
| POST | /api/federation/attempts/runtime/pin | node-signed | | | node |
| POST | /api/federation/attempts/runtime/count | node-signed | | | node |
| POST | /api/federation/telemetry | node-signed | | | node |
| GET | /api/federation/telemetry | node-signed | | | node |

### Not governed

- `ALL /api/*` fallback (unknown API path, `404 internal_error`) and the per-family
  `ALL /api/<family>/*` middleware: not endpoints. They are an explicit allowlist; any other
  matched `ALL` route under `/api/` needs a policy.
- `GET /*` and the static file middleware: the web bundle, no data, outside `/api/`.
- The MS1 live federation listener (`ms1-live/listener.ts`) mounts only `federationRoutes` on a
  separate loopback-only socket; its routes are the `node-signed` rows above and it has no owner
  API.

## Verification scope

| Claim | Test (fails without the change) |
| --- | --- |
| Every registered route has a policy and no policy is stale | route-map test boots `start()` with `federation` and compares `app.routes` with the table |
| An unmapped route is refused and listed | `createApp` plus a test route: `403 route_unmapped`, handler not run; `listUnmappedRoutes` and boot failure name it |
| Role x (resource, action) matrix | matrix test iterates the table: roles (owner, admin, editor, viewer, member without grant, anonymous, link) against the decision `can()` gives; HTTP check for each role on representative routes of every kind |
| Loopback owner unchanged | the existing route tests in the affected set pass unchanged; a new test asserts every table route admits the implicit owner (never 401/403 from the hook) |
| Remote bind refusal | `start()` rejects with `RemoteBindError` listing codes; real `bin.ts` and CLI processes exit `78` with the message and bind nothing |
| Remote bind acceptance | `start()` with TLS, accounts, roots and federation serves `https` and applies the hook |
| `401`/`403` bodies | contract parse of the bodies; web `API_ERROR_KEYS` covers every code (typecheck) |

Commands: `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test <files>`,
`npx tsc --noEmit -p packages/{server,contract,web,cli}`, web vitest for the api client.
