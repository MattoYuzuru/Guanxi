# U3-route-authz handoff — authorization wired into routes and boot

**Status:** author-complete, locally validated; independent review not run in this lane (lead
duty). U3 stays in progress. Branch `lane/u3-route-authz` from `lead/wave8` `2b8cf843`. Plan with
the full route inventory: [`U3-route-authz.plan.md`](U3-route-authz.plan.md).

## What changed

- `packages/server/src/auth/route-policy.ts` — `ROUTE_POLICIES`, one entry per `/api/` endpoint
  (165 rows: kind, resource, action, id parameter), `NON_ENDPOINT_ALL_ROUTES`, `listUnmappedRoutes`,
  `assertRoutesMapped`, `RouteAuthzError`.
- `packages/server/src/auth/route-authz.ts` — the single `/api/*` hook, `AccountsAdapter` seam,
  `LOCAL_OWNER_PRINCIPAL`. Synchronous when the adapter is: locally it adds no scheduling turn
  (an existing runtime-reconciliation test asserts a handler's first call happens inside the
  request call).
- `packages/server/src/auth/remote-profile.ts` — `admitBind()` joins the start options to
  `assertBindAllowed()` and loads TLS; `REMOTE_BIND_EXIT_CODE = 78`; one-line refusal message.
  `remote-guard.ts` gains the code `tls_files_unreadable` (type only; the guard stays pure).
- `packages/server/src/app.ts` — installs the hook in place of the old pass-through stub;
  `CreateAppOptions.authz`.
- `packages/server/src/index.ts` — `StartOptions.remote`; admission after the MS1 live checks and
  before any file, database or listener; boot-time `assertRoutesMapped(app.routes)`; `node:https`
  listener and `https://<hostname>:<port>` URL when a profile is supplied; Host allowlist uses the
  TLS hostname; `start()` now returns `app`; auth exports.
- `packages/server/src/bin.ts`, `packages/cli/src/bin.ts` — a `RemoteBindError` prints one line
  and exits 78.
- `packages/contract/src/schemas.ts` — `apiErrorSchema.code` gains `unauthenticated`, `forbidden`,
  `route_unmapped`; `packages/web/src/lib/api.ts` and `locale.ts` map them (English, Russian).
- Docs: `packages/server/src/auth/README.md` (route authorization, remote bind), ADR-0027
  decision 7 implementation note, the plan.

Response shapes: `401 unauthenticated`, `403 forbidden`, `403 route_unmapped`, all
`{ code, message, details: null }`. Local-owner responses are unchanged.

## Decisions and defaults (name them in review)

- **Node credential = federation identity.** `nodeCredentialConfigured` is true only when
  `federation.identity.id` and `federation.privateKey` are present; no new credential type.
- **Accounts enabled = an `AccountsAdapter` with a `principal` function.** Without Better Auth
  nobody can satisfy this outside tests, so the CLI and `HOST=0.0.0.0` always refuse (exit 78).
- **Roots and collections are owner-only.** A route without an id parameter (list, create) is
  authorized against the per-type root resource (owner: node owner, no grants), because stores
  carry no `owner_user_id` yet. Members therefore see nothing but explicit grants on ids and
  `authenticated` node information.
- **Session metadata uses `session.update`** (PATCH thread, retention, restore, leave, agent
  leave/retention), added to the core in the review round. No `project.update` exists; project
  metadata uses `project.write`.
- **`account` kind** (layouts, notifications, voice glossary, recipes, attachments, vault,
  approvals) passes only the node owner's account because those stores are single-account.
- **Reasoning and event streams are owner-only** (review M2); see the review section.
- **First matched endpoint decides.** Endpoint handlers never call `next()` (checked by grep);
  evaluating every matched pattern would wrongly deny `GET /api/threads/models` as a thread id.
- **`ms1Live` rejects `remote`** (`option_conflict`); the MS1 pairing stays loopback-only and its
  own `listen_not_loopback` refusal still runs first.
- **Existing test setup changed, assertions kept.** `session-log-cross-review.test.ts` started a
  `0.0.0.0` server to prove a LAN peer is refused. A `0.0.0.0` bind now needs the full profile, so
  the test boots with TLS, an accounts adapter, roots and a node credential and reads over HTTPS;
  every assertion (loopback 200 with content, LAN 403 without content) is unchanged.

## Commands and result lines

```bash
node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/auth/*.test.ts
# tests 63 / pass 63 / fail 0   (33 U3-a + 30 new)
agent-dev run --cwd <worktree> --node 26 --resource heavy --lock-timeout 3600 -- \
  node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test <71 route/boot test files + auth>
# tests 805 / suites 83 / pass 805 / fail 0 / skipped 0   (receipt ~/.local/state/agent-dev/check-wr81d8zj/result.json)
npm exec --workspace @guanxi/web -- vitest run test/unit            # 20 files, 121 tests pass
npm exec --workspace @guanxi/web -- vitest run test/component/localization.test.tsx   # 15 pass
npx tsc --noEmit -p packages/{server,contract,cli,web}              # exit 0, no output
npx markdownlint-cli2 <auth README, plan, handoff, ADR-0027>        # 0 errors
node scripts/check-doc-links.mjs                                    # 0 problems
```

An earlier run of the same set found two failures that the first implementation caused and that
were fixed before the commit: the MS1 live boot test expected `listen_not_loopback` for
`0.0.0.0` (admission now runs after that check), and the runtime-reconciliation test expected a
handler to start synchronously (the hook is synchronous-first). Both existing tests pass unchanged.

## New / regression envelope

- **New (32 tests, 4 files plus helper):** `auth/route-authz.test.ts` 15 (1,155-cell
  role x route matrix from `ROUTE_POLICIES`, D-155, roots, no existence oracle, shadowing,
  parameter decoding, unmapped GET/POST/ALL in both modes, no scheduling turn, local owner on every
  route), `auth/route-boot.test.ts` 3 (policy map equals the booted route set with no stale rows,
  real loopback socket, boot aborts on an unmapped route), `auth/remote-boot.test.ts` 12 (refusal
  for four hosts with nothing created, partial/unreadable/incomplete profiles, real server and CLI
  processes exit 78 with one line and bind nothing, loopback boot, HTTPS acceptance with
  principal enforcement and signed-node pass-through), `web/test/unit/api-authz-errors.test.ts` 2.
  Helper `auth/tls-fixture.ts` generates a throwaway key pair with `openssl` per run.
- **Regression envelope:** the 805-test server run above (71 route/boot files plus the 33 U3-a
  tests), web unit 121 and localization 15. Not run: root `npm test`, browser gates, Storybook,
  full builds, hosted CI (lead duty).
- **Mutation checks (each reverted, each red):** drop the boot `assertRoutesMapped` (route-boot
  fails on "must refuse an unmapped route"); hook passes unmapped routes (2 fail-closed tests);
  drop `admitBind` (11 of 12 remote-boot tests); serve HTTP instead of HTTPS (2 acceptance tests);
  hook ignores `can()` (5 matrix/D-155/root/oracle tests); local principal anonymous (the new
  local-owner tests, the real-socket test and about a dozen existing route tests in
  `routes.test.ts`); hook made asynchronous (the new no-scheduling-turn test and the existing
  runtime-reconciliation test).

## Verification and residual risk

No independent review ran in this lane. Reviewer focus: the first-match rule, the root-resource
convention, the `account` kind, and whether `GET /api/health` as `authenticated` is acceptable for
a remote node (it carries hardware and Ollama status).

Residuals:

- Better Auth (next slice): implements `AccountsAdapter` (sessions, passkeys, API keys, device
  authorization, invites), adds public auth routes to the policy map, supplies the grant source
  (`GrantStore` plus project inheritance) and attaches `AuthzContext.principal` to prompt origin
  and payer logging.
- Per-account stores: `owner_user_id` on threads, projects, connections, quick runs; then
  collection routes filter by permission instead of root-owner-only, and `account` routes bind to
  the principal.
- Allowed roots are validated at boot but not enforced when a workspace or project root is
  registered (`/api/workspaces`, `/api/agent/projects/:id/roots`).
- Per-route loopback guards (`localGuard`, session inspector, UI catalog review) still refuse
  remote peers with `loopback_only`; each family needs a decision when accounts land.
- A `session.read_reasoning` decision (viewer or editor access to reasoning); until then owner-only.
- Permission snapshot API and web projection; web handling of `401` (sign-in prompt).
- TLS is configured through `StartOptions` only; there is no env or CLI flag, so no operator can
  run a remote node from the command line yet (by design until accounts exist).
- The MS1 live federation listener is not behind the hook (signed-node routes only, loopback).
- Plain-HTTP port redirect, certificate reload and rotation are not implemented.
- `ROUTE_POLICIES` is a static map: a route added without a row fails boot and the route-boot
  test, which is the intended friction.

## Next slice

U3 Better Auth: pinned Better Auth on `node:sqlite` with the ADR-0027 plugin list and licence
check, an `AccountsAdapter` backed by it, the account/grant stores wired into
`resource()`/`grants()`, public auth routes in the policy map, then per-account stores. Shared
edits outside the lane's own paths: `packages/contract` (error codes), `packages/web`
(`api.ts`, `locale.ts`), `packages/cli/src/bin.ts`, and the setup of
`packages/server/test/session-log-cross-review.test.ts`.

## Review findings and fixes

Independent security review of the branch. The code and test fixes are in `4178c54d`
(`fix(auth): review fixes`); the documentation follows in the next commit.

| Finding | Fix | Proof |
| --- | --- | --- |
| H1 `HEAD` skipped the hook (`req.method` stays `HEAD` while Hono serves the GET handler), and any request with no governed match proceeded: unauthenticated `HEAD /api/settings` 200 and a filesystem existence oracle on `/api/workspaces/browse` | The lookup treats `HEAD` as `GET`. If no governed endpoint matches the method, the hook answers the unknown-path `404` itself and calls nothing behind it (OPTIONS, unknown methods, stray wildcard or `ALL` routes). | The matrix runs `HEAD` for every GET row and role (same status, same handler count). A sweep of every GET row of the booted remote server with `HEAD` as anonymous and stranger (HEAD status equals GET, anonymous 401, at least 60 rows). The `/etc` versus missing-path oracle test. OPTIONS and `PURGE` give 404. A no-fallback test where a family `ALL` route and `GET *` must not run. Mutations: HEAD lookup removed (matrix and HEAD test red); `next()` instead of the 404 (no-fallback test red) |
| M1 implicit owner on any request | Local mode grants the owner only when the socket peer is loopback (127.0.0.0/8, `::1`, `::ffff:127.x`). A non-loopback peer or an address-less socket answers `403 loopback_only` (`details.reason: non_loopback_peer`, so the inspector and UI-catalog tests keep their bodies). `X-Forwarded-For`, `Forwarded` or `X-Real-IP` answers `403 proxied_request_refused` (new contract code, web copy `error.api.notAllowed`). A request with no socket at all (in-process `app.request()`) is the embedding host and stays the owner: hundreds of existing tests call that way. README "Trust boundary of local mode". | Stub tests for each loopback spelling, six non-loopback peers on three routes, three proxy headers on three peer shapes, remote mode unaffected. A real-socket test (`fetch` with each proxy header: 403; plain: 200). Mutation: refusal disabled, both tests red |
| M2 reasoning is person-audience | New policy flag `ownerOnly` (the principal must own the resource on top of `can()`) on `/api/sessions/:id/events`, `spans`, `stream`, `export` and `/api/threads/:id/reasoning-artifacts[/:artifactId]` | Editor, viewer, link, admin and stranger refused, owner allowed; plain `GET /api/sessions/:id` is still readable by a viewer |
| M3 connection models spend the owner key | `GET /api/connections/:id/models` needs `connection.use` | Viewer and link refused; editor with a direct grant and owner allowed |
| M4 node operations ahead of allowed-root enforcement | `ownerOnly` on `/api/settings`, `/api/workspaces*`, `POST /api/relay`, model import (Ollama reference, GGUF), Hugging Face discovery and download, `pull`, UI-catalog review. Warm, prewarm, stop, probes, capability overrides and model delete stay with the admin role | Admin refused and owner allowed on every named row (stub and real server). Mutation: `ownerOnly` check disabled, four tests red |
| L1 `session.update` | Added to the core (types, policy, owner only); policy-matrix expectations and the cell count updated from 850 to 900 (expanded, nothing removed) | Matrix, D-155 and route tests |
| L2 `NON_ENDPOINT_ALL_ROUTES` exempts by path | Resolved by construction, not by a boot count: an exempt `ALL` route is reached only after a governed endpoint matched and was authorized (unknown paths get the hook's 404), so a non-middleware `ALL` hidden under an exempt path cannot be reached by an unauthorized caller or an unknown path. A boot assertion on registration counts would be brittle because the counts depend on options (CORS, federation). | The no-fallback test above |
| L3 health detail | `/api/health` returns `{ ok }` to a signed-in user who is neither the node owner nor an admin; the contract gains `minimalHealthSchema`. The web client still parses the full shape (residual below). | Remote test: stranger gets `{ok:true}`; owner and admin get hardware, Ollama and version |
| L4 SSE authorized at connect only | Not fixed; listed as a residual | |
| L5 mutable `ROUTE_POLICIES` | A sealed map (`set`, `delete`, `clear` throw; entries frozen). Tests no longer mutate it: `StartOptions.routePolicies` is a test seam that supplies the table to enforce and to check at boot | Sealed-map test; the boot test passes a table without one row |
| L6 LAN-peer test proved the Host allowlist, not the peer check | `session-log-cross-review.test.ts` now sends `Host: 127.0.0.1:<port>` over the LAN address and asserts `403 loopback_only` with no content, plus the named-host case; without a LAN interface it records a diagnostic instead of passing silently | The LAN assertions ran on this machine (no diagnostic emitted) |

No assertion was weakened. Every changed existing assertion is an expansion forced by a requested
policy change: `policy-matrix` gains `session.update` and 18 actions, and the D-155 route test now
expects the admin role refused on settings and pull and allowed on `stop`.

New residuals from the review: SSE and other long-lived streams are authorized at connect only (a
grant revoked mid-stream is not re-checked); a non-operator web session needs handling of the
minimal health shape; the local-mode trust boundary treats a socket-less in-process call as the
owner; reasoning access for viewers and editors needs a `session.read_reasoning` decision.

One existing test needed a setup change because M1 makes `Forwarded` a refused proxy header:
`connections/host-allowlist.test.ts` N8 sent `X-Forwarded-Host` and `Forwarded` together and expected
`200` for an allowed Host. It now asserts the original property with `X-Forwarded-Host` alone (forbidden
Host `403`, allowed Host `200`, the header ignored in both directions) and a second request that adds
`Forwarded` and expects `403 proxied_request_refused` for the allowed Host (not `host_denied`).

### Result lines after the review fixes

```bash
node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/auth/*.test.ts packages/server/test/session-log-cross-review.test.ts
# tests 84 / pass 84 / fail 0
agent-dev run --cwd <worktree> --node 26 --resource heavy --lock-timeout 3600 -- node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test <77 route, boot and auth files>
# tests 878 / suites 89 / pass 878 / fail 0 / skipped 0   (the first run found only the N8 test above)
npm exec --workspace @guanxi/web -- vitest run test/unit test/component/localization.test.tsx   # 21 files, 136 tests pass
node --test packages/contract/test/*.test.ts                                                    # 4 pass
npx tsc --noEmit -p packages/{server,contract,cli,web}                                          # exit 0, no output
npx markdownlint-cli2 <auth README, plan, handoff, ADR-0027>                                     # 0 errors
node scripts/check-doc-links.mjs                                                                 # 0 problems
```

New tests in the review round: 16 in `route-authz.test.ts` (27 total), 2 in `remote-boot.test.ts`
(the HEAD sweep, a health case folded into the acceptance test), 1 in `route-boot.test.ts`, and one
web case folded into the existing error-copy test.
