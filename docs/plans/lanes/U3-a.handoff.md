# U3-a handoff — authorization core

**Status:** author-complete, locally validated, independent review pending. U3 stays in
progress. Branch `codex/u3a-authorization-core`; base `17973f89` (Guanxi main).

## What exists

- `packages/server/src/auth/types.ts` — principals, resources, grants, all 17 actions and the
  snapshot entry shape.
- `packages/server/src/auth/policy.ts` — pure `can()` and `permissionSnapshot()`. Private by
  default, strongest-relation grants, expiry, groups, explicit link grants, project→session/run
  inheritance with no upward leak, D-155 admin limits, D-190 subscription binding and the
  D-154/D-190 prompt payer.
- `packages/server/src/auth/grants.ts` — `GrantStore` on its own `<dataDir>/auth.sqlite`, WAL,
  foreign keys, `u3_migrations` v1, unique tuple, resource/subject indexes, transactional
  grant/revoke/purge, provenance from actor/clock and rejected owner grants.
- `packages/server/src/auth/remote-guard.ts` — pure `assertBindAllowed()` with typed
  `RemoteBindError` and one stable code per missing remote-profile requirement.
- `packages/server/src/auth/README.md` — current-state model, action matrix, policy, store and
  guard documentation.

No authentication library, route, contract, boot or web change is included.

## Decisions and defaults

- `node.admin` belongs to a node's owner and to the server `admin` role for any node; the global
  `account.invite` and `account.ban` are admin-only. Admins still need a normal owner/grant
  relation for user data.
- Account actions are global and accept any resource argument; `node.admin` requires the `node`
  resource type.
- Connection grant administration maps to `connection.manage` because no `connection.share`
  action exists. `run` and `node` direct grants are deferred: runs inherit project grants and
  nodes are server-administered. Ownership transfer is rejected.
- `forResource()`/`forSubject()` return expired rows too; `can()` owns expiry filtering and
  `purgeExpired()` performs physical cleanup.
- `grant()` overrides caller-supplied `createdBy`/`createdAt` with the actor and clock.
- `connection.use` by a non-owner needs a direct `editor`/`owner` grant; subscription
  connections remain owner-only even with such a grant.

## Commands and result lines

```bash
nice -n 10 node --test packages/server/test/auth/*.test.ts
# tests 21 / pass 21 / fail 0
nice -n 10 npx tsc --noEmit -p packages/server
# exit 0, no output
npx markdownlint-cli2 packages/server/src/auth/README.md docs/plans/lanes/U3-a.handoff.md
# Summary: 0 error(s)
```

## New / regression envelope

- **New:** 3 test files, 21 tests (`policy-matrix` 6, `grants-store` 8, `remote-guard` 7).
  The matrix asserts 10 principals × 5 resource types × 17 actions = 850 explicit cells plus
  inheritance, D-155, D-154/D-190, direct-grant and snapshot assertions.
- **Regression envelope:** the auth test directory and the full `@guanxi/server` typecheck only.
  Per lane rules no `npm test`, browser, server or network run was used; the integrator owns the
  full gates. No shared edits.

## Verification and residual risk

Self-review covered transaction rollback, expiry boundaries, snapshot/matrix equality, duplicate
and owner grants, subscription bypass attempts, TLS IP hostnames and lookalike loopback names.
Independent cross-family review has not run in this sandbox and remains an integrator duty.
Residuals for later U3 slices:

- Better Auth integration with the license check and pinned plugins;
- sessions, passkeys, two-factor and device authorization;
- wiring `can()` into every route with authoritative stored projections and prompt origin/payer
  logging;
- permission snapshot API and web projection;
- per-account connections, vault and cost ledger;
- wiring the remote guard into server boot (not done in this slice);
- audit of remote execution;
- run/node direct grants, ownership transfer and non-literal loopback spellings remain
  deferred/fail-closed.
