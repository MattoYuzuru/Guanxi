# Federation private-network guidance

**Status:** implementation guidance; no real network configured · **Updated:** 2026-10-21

Follow D-146 and [ADR-0018](../decisions/0018-federation-ownership-and-leases.md): hosted
Tailscale is the first private mesh. Self-hosted Headscale is the documented alternative.
Guanxi's signed node credentials are required in either case; private-network membership alone
never authenticates a Guanxi node or assigns its account, trust class, home or scopes.

## Fleet and roles

D-185/D-186 supersede the earlier Mac Mini plan:

| Machine | Intended role | Enrollment policy |
| --- | --- | --- |
| MacBook M5 Pro, 24 GB | interactive owner device; its own local sessions work offline | owner device; admin only after interactive owner approval |
| Fedora PC, Ryzen 5 3600, 32 GB, RTX 3060 | always-on session/run home while booted into Fedora | owner device; always-on assertion is explicit, not inferred from telemetry |
| Fedora laptop, Ryzen 7 4800H, 15 GB, RTX 2060 | additional interactive owner node | owner device with foreground headroom reserved by future placement |
| `keykomi` VPS, 1 vCPU, 2 GB | future U4 encrypted relay only | no owner session replica, vault or reasoning data |

These are owner-provided facts, not F1 runtime measurements. No machine was contacted by this
lane. Booting the PC into Windows pauses its Fedora home; peers wait or explicitly fork, and
do not steal its writer or leases. The VPS is not a mandatory hub or a model gateway.

## Tailscale first

The integrator, separately authorized to configure the fleet, should:

1. Enroll each owned machine into the owner's private mesh using its normal device approval.
2. Keep the Guanxi application listener on loopback. Expose a dedicated node-only route or a
   private encrypted proxy that forwards **only** `/api/federation/**`; deny every other path.
   Forward the configured local Host authority; do not trust arbitrary forwarded headers.
3. Restrict that private route to the intended devices at the mesh policy boundary. Do not
   publish it to a public interface or use a broad listener as a shortcut.
4. Generate a separate node key on each machine. Approve the displayed device code/key at an
   interactive admin node; pin the resulting public-key identity at the other peers. Give only
   the needed scopes. Keep private keys in a protected host credential source.
5. Explicitly select owner session/run stream bindings and synchronize each peer independently
   on reconnection. A cloud/shared node or another account must not get those bindings.
6. Test unauthenticated access, old-major writes, revocation, clock-drift refusals, partitions
   and restart before using real sessions. Check the home/version on commands; never replace a
   stale command's version automatically.

No Tailscale plan limits, routes, DNS names, firewall rules or service installation commands
are prescribed here. Those depend on the separately reviewed deployment configuration.
F1 contains no VPN management, SSH enrollment automation or network discovery.

## Headscale alternative

Headscale can replace the hosted coordination service while keeping the same Guanxi node
channel, per-device credentials and replication policy. The integrator must separately review
its control-plane TLS, identity provider, ACLs, key rotation, backups and update procedure.
If coordination is hosted on `keykomi`, it remains distinct from the future U4 ciphertext relay;
neither service is permitted to store Guanxi session plaintext or vault records. Do not alter
the existing Caddy, VPN, SSH routes or workstation services as part of F1 testing.

## Subscription ownership and staged work

D-190 requires each owned node to use the owner's unmodified installed vendor CLI and its own
local login. Guanxi does not transfer vendor token files. A subscription connection belongs to
one person; another account's session/editor cannot prompt through it. Model traffic leaves
from the machine holding the login and never passes through the future phone relay.

F1 supplies authenticated metadata/log synchronization and version-bound commands. Remote
attempts, target-governor admission, fenced handover, power assertions and restored-home epoch
recovery are F2. Host pressure collection, residency/headroom accounting and placement are
F3. The phone relay/pairing is U4. No live-network or cross-host test is claimed here.

See the [implemented API and storage guide](../../packages/server/src/federation/README.md)
and [F1 handoff](../plans/evidence/F1.md) for scope, local assertions and remaining risks.
