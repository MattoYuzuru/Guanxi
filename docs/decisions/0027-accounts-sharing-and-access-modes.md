# ADR-0027: Accounts, sharing and the two access modes

**Status:** accepted for the two modes (owner decisions D-111, D-118); proposed design · **Date:** 2026-10-19

## Context

Family members or friends may share one installation, each with private sessions and their own
connections (REQ-A6, REQ-E1, REQ-E2), and share sessions read-only or with write access (REQ-D5). Only two
user-facing access modes are wanted: Full access and Read-only (REQ-D3). Remote access means
leaving loopback, which the legacy rules allow only with a security profile (authentication,
TLS, allowed roots).

## Decision

1. **Authentication**: Better Auth embedded in the Hono server on `node:sqlite`, pinned, with
   only these plugins: email/password, passkey, admin (invite, ban, revoke sessions),
   optional two-factor, device authorization (RFC 8628) for phones, CLIs and new nodes, and
   API keys (hashed, scoped, expiring). SSO, SCIM, OAuth-proxy, OAuth-provider and MCP plugins
   stay off (most advisories are there).
2. **Authorization**: global roles `admin` and `member`; a `grant` table in Zanzibar tuple form
   `(resource_type, resource_id, relation ∈ {owner, editor, viewer}, subject_type ∈ {user,
   group, link}, subject_id, created_by, created_at, expires_at)`; one server-side
   `can(principal, action, resource)` function; clients receive a permission snapshot.
3. **Privacy**: every project, session and connection has an `owner_user_id` and is private by
   default. Admins cannot open other users' sessions in the UI; this is policy, not
   cryptography, and is documented as such.
4. **Sharing**: `viewer` sees the live session including sub-agents; `editor` may prompt and
   stop. Editor turns run on the session owner's connections only if the owner allowed it,
   otherwise on the editor's own connections; the origin of every prompt is logged. No public
   link without login by default.
5. **Access modes** (per session, default per project):
   - *Read-only*: file reads within the project roots and attachments; no writes except the
     session scratch directory; shell limited to an allowlist of read-only commands; network
     only through Guanxi's egress proxy, which allows `GET`, `HEAD` and `OPTIONS` and blocks
     every other method and raw sockets (a `network: none` option exists). This prevents side
     effects on other systems; it is not a confidentiality control, since a `GET` can still
     carry data;
   - *Full access*: the agent acts with the user's OS rights inside the project roots and the
     network allowlist, with no approval prompts. A project with **zero roots** gets write
     access only to the session scratch directory (`~/.guanxi/scratch/<session>`) and read
     access to its attachments.
   Both are enforced by the OS sandbox (`sandbox-runtime`: Seatbelt on macOS, bubblewrap on
   Linux, a restricted user plus Windows Filtering Platform on Windows), not by the prompt.
   A **deny-write profile** for protected paths (tests, specs, CI config listed in a run's
   plan) is layered on top of either mode (ADR-0020). Remote clients have the same rights as
   the desktop (REQ-B3).
6. **Confirmations (D-118)**: neither mode prompts. A run stops for a person only through an
   `input_required` escalation or because an action is on the project's
   `requires_confirmation` list (default empty; for example cloud launches or publishing).
7. **Remote security profile**: loopback stays the default; remote binding requires accounts,
   TLS on one canonical hostname (own domain or `*.ts.net`), node credentials, allowed roots
   per node, and audit of remote execution.

## Consequences

Passkeys require a real HTTPS hostname (IP addresses are forbidden by WebAuthn); renaming the
tailnet invalidates them. Better Auth needs advisory monitoring.

## Validation

Authorization matrix tests (owner/editor/viewer/admin/anonymous × every action); sandbox tests
that Read-only cannot write outside scratch, and that a `POST`/`PUT`/`DELETE` or a raw socket
from Read-only is blocked; Full access with zero roots cannot write outside scratch; a
protected path cannot be written in either mode; remote bind refuses to start without TLS,
accounts and allowed roots.

## Evidence

Lane 2 §4, lane 5 §1.5 (sandbox runtime) ([research](../research/README.md)); WebAuthn
Level 3; NIST RBAC/ABAC; Zanzibar (USENIX ATC '19).
