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
- **No `session.update`/`project.update` action exists.** Owner-level session metadata changes
  (PATCH thread, retention, restore, leave, agent leave/retention) use `session.delete`, the
  weakest owner-only session action. Needs a dedicated action in the policy core.
- **`account` kind** (layouts, notifications, voice glossary, recipes, attachments, vault,
  approvals) passes only the node owner's account because those stores are single-account.
- **Reasoning artifacts** use `session.read` (viewers can read them). Product decision pending
  against D-113 export rules; owner-only would need a new action.
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
- Dedicated session/project update actions and the reasoning-artifact policy (see above).
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
