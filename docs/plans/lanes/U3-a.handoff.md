# U3-a handoff — authorization core

**Status:** author-complete, locally validated, independent review fixes applied; re-review
pending. U3 stays in progress. Branch `codex/u3a-authorization-core`; base `17973f89` (Guanxi
main).

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
# tests 33 / pass 33 / fail 0 (21 before the independent review fixes)
nice -n 10 npx tsc --noEmit -p packages/server
# exit 0, no output
npx markdownlint-cli2 packages/server/src/auth/README.md docs/plans/lanes/U3-a.handoff.md
# Summary: 0 error(s)
```

## New / regression envelope

- **Initial new:** 3 test files, 21 tests (`policy-matrix` 6, `grants-store` 8, `remote-guard`
  7). The matrix asserts 10 principals × 5 resource types × 17 actions = 850 explicit cells plus
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

## Independent review fixes

All eight findings were fixed in separate commits on this branch, each with a regression test
that failed before the fix. For P2-3 the two production guards were mutation-tested: removing
either cross-type check turns the new test red, after which both files were restored
byte-for-byte. P2-2 also adapts the pre-existing purge test to create expiries after `now`,
because `grant()` now rejects an already expired timestamp; the purge assertions are unchanged.

| Finding | Commit | Fix |
| --- | --- | --- |
| P2-1 — `owner` grant treated as ownership | `dfe99f26` | Grants cap at `editor`; only `principal.userId === resource.ownerUserId` gets `payer: 'owner'` and share/delete. The subscription-share prompt is now `editor`/`actor`, with share/delete denied. |
| P2-2 — invalid expiry stored as permanent | `14acb1b6` | `grant()` accepts only `null` or a safe integer after `now` (`invalid_expiry`); `expired()` treats non-finite/non-integer values as expired. |
| P2-3 — cross-type id confusion untested | `44f030da` | Session/project grants no longer authorize colliding project/connection ids; the direct-connection type guard is pinned by test. Both removed-guard mutations were observed red and restored. |
| P3-1 — link grants could spend | `9080ec74` | Link grants cap at `viewer` in `can()`; the store rejects link editor grants (`link_grant_forbidden`) and accepts only link viewers. |
| P3-2 — non-canonical TLS hostnames | `d5861623` | TLS requires a canonical RFC 1123 hostname with a non-numeric last label; `localhost`, trailing dots, integer/hex hosts, ports and spaces fail with `tls_hostname_invalid`. |
| P3-3 — allowed-root gaps | `d445eb99` | `/` is rejected, nested roots are flagged, and case-only duplicates are flagged on `darwin`/`win32` (injectable platform for deterministic tests). |
| P3-4 — expired tuple blocked re-granting | `34004490` | The grant transaction deletes an expired row with the same tuple before inserting the replacement; a live grant still blocks. |
| P3-5 — enum violations surfaced as `write_failed` | `2d6fa63a` | `subjectType` and `relation` are checked against their enums before SQL and fail with `invalid_grant`. |

### Counts and regression envelope

- **New:** 12 tests, 21 → 33 total (`policy-matrix` 6 → 10, `grants-store` 8 → 12,
  `remote-guard` 7 → 11). Every fix commit carries its failing-before test.
- **Regression envelope:** `node --test packages/server/test/auth/*.test.ts` (33 tests),
  `npx tsc --noEmit -p packages/server`, and markdownlint on the auth README plus this handoff.
  Per lane rules no `npm test`, browser, server or network run was used; the integrator owns the
  full gates. No shared edits.
