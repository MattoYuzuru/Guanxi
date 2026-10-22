# Authorization core

**Status:** implemented and locally validated by unit tests. Better Auth, route guards, the
permission snapshot API and server-boot wiring are not part of U3-a.

This directory implements the authorization model of
[ADR-0027](../../../../docs/decisions/0027-accounts-sharing-and-access-modes.md) that a later
authentication layer will call. It has no authentication provider, no HTTP surface and no
dependency outside `node:` builtins.

## Principals and resources

A `Principal` is an authenticated `user` (with a global `admin` or `member` role and group
memberships), an `anonymous` request, or the holder of an explicit share `link`.

Every `Resource` has an `ownerUserId`. A session or run may name its project in `parent`, which
is the only inheritance edge in this slice. Sessions may carry a `share` policy and connections
carry a `connectionKind`; both drive billing and subscription rules.

| Resource type | Meaning |
| --- | --- |
| `project` | A workspace with roots, configuration and child sessions/runs. |
| `session` | A conversation. Private even inside a shared project unless granted. |
| `connection` | A model/runtime/service connection. Its secret material is never part of this model. |
| `run` | One durable agent execution. |
| `node` | A compute node. Node administration is a server capability, not ownership. |

## Actions

The canonical list is `ACTIONS` in `types.ts`. Every action is checked against exactly one
resource type, except `account.invite` and `account.ban`, which are global.

| Action | Resource | Viewer | Editor | Owner | Notes |
| --- | --- | --- | --- | --- | --- |
| `session.read` | session | yes | yes | yes | Includes events and the sub-agent view. |
| `session.prompt` | session | no | yes | yes | Payer follows D-154/D-190. |
| `session.stop` | session | no | yes | yes | Stop the active turn or run. |
| `session.share` | session | no | no | yes | Manage grants. |
| `session.delete` | session | no | no | yes | Permanent deletion. |
| `project.read` | project | yes | yes | yes | Metadata and configuration. |
| `project.write` | project | no | yes | yes | Metadata, roots and configuration. |
| `project.share` | project | no | no | yes | Manage grants. |
| `project.delete` | project | no | no | yes | Permanent deletion. |
| `connection.use` | connection | no | yes | yes | Editor needs a direct grant; subscriptions are owner-only. |
| `connection.read` | connection | yes | yes | yes | Metadata only, never secrets. |
| `connection.manage` | connection | no | no | yes | Change, test, share or delete. |
| `run.read` | run | yes | yes | yes | Run events and attempts. |
| `run.cancel` | run | no | yes | yes | Cancel the run. |
| `node.admin` | node | no | no | yes | Node owner; a server `admin` may administer any node. |
| `account.invite` | global | no | no | no | Server `admin` role only. |
| `account.ban` | global | no | no | no | Server `admin` role only. |

## Policy

`can(principal, action, resource, grants, now)` is pure: it reads no storage and mutates no
input. Its result is `{ allowed, reason, payer? }`. Callers must pass the authoritative stored
resource projection and the grants for it; the policy trusts `ownerUserId`, ids, `share` and
`connectionKind` rather than re-reading storage.

- **Private by default.** Only the resource owner and explicit unexpired grants count.
  Anonymous principals and share links without a link grant get nothing.
- **Strongest relation wins.** Relation strength is `owner > editor > viewer`. Ownership comes
  only from `resource.ownerUserId`; a stored `owner` grant is capped at `editor` until ownership
  transfer exists. A direct grant and an inherited project grant are combined by taking the
  strongest relation.
- **Expiry.** A grant with `expiresAt !== null && expiresAt <= now` is ignored. `null` never
  expires. A non-finite or non-integer stored value (for example a legacy `NaN`) is treated as
  expired rather than permanent.
- **Subjects.** A user grant matches `userId`; a group grant matches one of `groups`; a link
  grant matches `linkId`. A link grant is explicit: there is no public-link default, and link
  grants are capped at `viewer`; a link can never prompt, spend or manage.
- **Inheritance.** A project grant reaches its sessions and runs through `parent`. Session and
  run grants never leak upward, to siblings, or to connections.
- **Admin limits (D-155).** The `admin` role receives `node.admin` on any node, plus the global
  `account.invite` and `account.ban`. A node owner also administers their own node. The admin
  role has no override for another user's sessions, projects, runs or connections. An admin
  still sees data when the normal owner or grant rules allow it; explicit sharing is not an
  override path.
- **Subscriptions (D-190).** `connection.use` on a connection with
  `connectionKind: 'subscription'` is allowed only to `resource.ownerUserId`, regardless of
  grants. Non-owner use of any other connection requires a direct `editor` or `owner` grant on
  that connection; a project grant does not suffice.
- **Prompt payer (D-154 as amended by D-190).** Only the real owner (`principal.userId ===
  resource.ownerUserId`) gets `payer: 'owner'`. For everyone else, including a holder of a
  capped `owner` grant, `payer` is `owner` only when `share.ownerPaysForEditors === true`
  **and** `share.ownerConnectionKind` is `api_key` or `local`; a `subscription` connection, a
  declined share or a missing share policy yields `actor`.
- **Reasons.** `reason` is a stable low-cardinality string: `owner`, `editor`, `viewer`,
  `admin`, `anonymous`, `no_grant`, `insufficient_relation`, `action_not_applicable`,
  `admin_required`, `subscription_owner_only` or `connection_use_requires_grant`.

`payer` is present only on an allowed `session.prompt`; denied decisions and all other actions
omit it.

## Permission snapshot

`permissionSnapshot(principal, resources, grants, now)` returns one entry per supplied
resource, in input order, with allowed actions in canonical `ACTIONS` order:

```ts
[
  { resourceType: 'project', resourceId: 'project-1', actions: ['project.read'] },
  { resourceType: 'session', resourceId: 'session-1', actions: ['session.read'] },
]
```

It calls the same `can` decisions clients would get from the API, so the projection cannot
drift from enforcement.

## Grant store

`GrantStore(path, clock)` owns `<dataDir>/auth.sqlite`, a database separate from the main
session store. The clock may return epoch milliseconds or a `Date`; timestamps are stored in
milliseconds. The store creates directories with mode `0700`, the database with mode `0600`,
enables WAL and foreign keys, and uses the `u3_migrations` table. Migration v1 creates:

- `grants(resource_type, resource_id, relation, subject_type, subject_id, created_by,
  created_at, expires_at)`;
- a uniqueness constraint on the five tuple columns;
- `grants_resource(resource_type, resource_id)` and `grants_subject(subject_type, subject_id)`
  indexes.

Methods:

- `grant(actor, input, resource)` — requires `project.share`, `session.share` or
  `connection.manage` on the supplied resource. `createdBy` and `createdAt` are taken from the
  actor and clock, never trusted from `input`. An `owner` grant is rejected: ownership transfer
  is later work. A grant to a `link` subject is viewer-only. `expiresAt` must be `null` or a
  safe integer strictly after `now`; anything else fails with `invalid_expiry` before the
  transaction starts. Inside the transaction an expired row with the same tuple is deleted
  before insertion, so an unpurged expired grant does not block re-granting.
- `revoke(actor, key, resource)` — same permission check; returns whether a row was deleted.
- `forResource(type, id)` and `forSubject(type, id)` — direct rows in insertion order, including
  expired grants. Callers apply `now` through `can`; `purgeExpired` removes them physically.
- `purgeExpired(now)` — deletes grants expiring at or before `now`, returns the count.
- `close()` — closes the database.

All mutations use `BEGIN IMMEDIATE` and roll back on failure. Grants on `run` and `node` are not
shareable in this slice: runs inherit project grants, and node administration belongs to the
server. A duplicate tuple fails with `grant_exists`; other stable codes are `invalid_actor`,
`resource_mismatch`, `owner_grant_forbidden`, `link_grant_forbidden`, `forbidden`,
`resource_not_shareable`, `invalid_expiry` and `write_failed`. Foreign keys are enabled even
though accounts live in another database and no cross-database reference is possible.

## Remote-bind guard

`assertBindAllowed(config)` is pure and is deliberately not wired into server boot. Loopback
hosts (`127.0.0.0/8`, `::1`, `localhost`) always pass. Every other host, including `0.0.0.0`,
`::`, LAN addresses and hostnames, must present the full remote security profile:

- usable TLS with a non-empty certificate path, key path and a canonical RFC 1123 hostname
  (WebAuthn forbids IP addresses; `localhost`, trailing dots, bare integer/hex hosts, ports and
  spaces are also refused);
- accounts enabled;
- a non-empty `allowedRoots` list of absolute, duplicate-free paths that are neither `/` nor
  nested inside one another; on macOS and Windows, paths that differ only by case are
  duplicates;
- a configured node credential.

Failure throws `RemoteBindError` with `code: 'remote_bind_forbidden'` and a `missing` array that
lists every unmet requirement using stable codes: `tls_required`, `tls_hostname_required`,
`tls_hostname_ip_forbidden`, `tls_hostname_invalid`, `accounts_required`,
`allowed_roots_required`, `allowed_roots_must_be_absolute`, `allowed_roots_must_not_be_root`,
`allowed_roots_duplicate`, `allowed_roots_nested`, `node_credential_required`.

## Non-goals

Better Auth and its pinned plugins, sessions/passkeys/device authorization, wiring `can` into
routes, exposing the snapshot over HTTP or in the web client, per-account connections/vault/cost
ledger, boot-time use of the remote guard and audit of remote execution remain for later U3
slices. See [`U3-a.handoff.md`](../../../../docs/plans/lanes/U3-a.handoff.md).
